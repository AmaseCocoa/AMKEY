/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import type { IEndpointMeta } from '@/server/api/endpoints.js';
import { LoggerService } from '@/core/LoggerService.js';
import { TimeService } from '@/core/TimeService.js';
import { EnvService } from '@/core/EnvService.js';
import { DI } from '@/di-symbols.js';
import type Logger from '@/logger.js';

/**
 * Metadata about the current status of a rate limiter
 */
export interface LimitInfo {
	/**
	 * True if the limit has been reached, and the call should be blocked.
	 */
	blocked: boolean;

	/**
	 * Number of calls that can be made before the limit is triggered.
	 */
	remaining: number;

	/**
	 * Time in seconds until the next call can be made, or zero if the next call can be made immediately.
	 * Rounded up to the nearest second.
	 */
	resetSec: number;

	/**
	 * Time in milliseconds until the next call can be made, or zero if the next call can be made immediately.
	 * Rounded up to the nearest milliseconds.
	 */
	resetMs: number;

	/**
	 * Time in seconds until the limit has fully reset.
	 * Rounded up to the nearest second.
	 */
	fullResetSec: number;

	/**
	 * Time in milliseconds until the limit has fully reset.
	 * Rounded up to the nearest millisecond.
	 */
	fullResetMs: number;
}

/**
 * Rate limit based on "leaky bucket" logic.
 * The bucket count increases with each call, and decreases gradually at a given rate.
 * The subject is blocked until the bucket count drops below the limit.
 */
export interface RateLimit {
	/**
	 * Unique key identifying the particular resource (or resource group) being limited.
	 */
	key: string;

	/**
	 * Constant value identifying the type of rate limit.
	 */
	type: 'bucket';

	/**
	 * Size of the bucket, in number of requests.
	 * The subject will be blocked when the number of calls exceeds this size.
	 */
	size: number;

	/**
	 * How often the bucket should "drip" and reduce the counter, measured in milliseconds.
	 * Defaults to 1000 (1 second).
	 */
	dripRate?: number;

	/**
	 * Amount to reduce the counter on each drip.
	 * Defaults to 1.
	 */
	dripSize?: number;
}

export type SupportedRateLimit = RateLimit | LegacyRateLimit;
export type LegacyRateLimit = IEndpointMeta['limit'] & { key: NonNullable<string>, type?: undefined };

export function isLegacyRateLimit(limit: SupportedRateLimit): limit is LegacyRateLimit {
	return limit.type === undefined;
}

export function hasMinLimit(limit: LegacyRateLimit): limit is LegacyRateLimit & { minInterval: number } {
	return !!limit.minInterval;
}

@Injectable()
export class SkRateLimiterService {
	private readonly logger: Logger;
	private readonly disabled: boolean;

	constructor(
		@Inject(TimeService)
		private readonly timeService: TimeService,

		@Inject(DI.redis)
		private readonly redisClient: Redis.Redis,

		@Inject(LoggerService)
		loggerService: LoggerService,

		@Inject(EnvService)
		envService: EnvService,
	) {
		this.logger = loggerService.getLogger('limiter');
		this.disabled = envService.env.NODE_ENV !== 'production';
	}

	public async limit(limit: SupportedRateLimit, actor: string, factor = 1): Promise<LimitInfo> {
		if (this.disabled) {
			return {
				blocked: false,
				remaining: Number.MAX_SAFE_INTEGER,
				resetSec: 0,
				resetMs: 0,
				fullResetSec: 0,
				fullResetMs: 0,
			};
		}

		if (factor <= 0) {
			throw new Error(`Rate limit factor is zero or negative: ${factor}`);
		}

		if (isLegacyRateLimit(limit)) {
			return await this.limitLegacy(limit, actor, factor);
		} else {
			return await this.limitBucket(limit, actor, factor);
		}
	}

	private async limitLegacy(limit: LegacyRateLimit, actor: string, factor: number): Promise<LimitInfo> {
		const promises: Promise<LimitInfo | null>[] = [];

		// The "min" limit - if present - is handled directly.
		if (hasMinLimit(limit)) {
			promises.push(
				this.limitMin(limit, actor, factor),
			);
		}

		// Convert the "max" limit into a leaky bucket with 1 drip / second rate.
		if (limit.max != null && limit.duration != null) {
			promises.push(
				this.limitBucket({
					type: 'bucket',
					key: limit.key,
					size: limit.max,
					dripRate: Math.max(Math.round(limit.duration / limit.max), 1),
				}, actor, factor),
			);
		}

		const [lim1, lim2] = await Promise.all(promises);
		return {
			blocked: (lim1?.blocked || lim2?.blocked) ?? false,
			remaining: Math.min(lim1?.remaining ?? Number.MAX_SAFE_INTEGER, lim2?.remaining ?? Number.MAX_SAFE_INTEGER),
			resetSec: Math.max(lim1?.resetSec ?? 0, lim2?.resetSec ?? 0),
			resetMs: Math.max(lim1?.resetMs ?? 0, lim2?.resetMs ?? 0),
			fullResetSec: Math.max(lim1?.fullResetSec ?? 0, lim2?.fullResetSec ?? 0),
			fullResetMs: Math.max(lim1?.fullResetMs ?? 0, lim2?.fullResetMs ?? 0),
		};
	}

	private async limitMin(limit: LegacyRateLimit & { minInterval: number }, actor: string, factor: number): Promise<LimitInfo | null> {
		if (limit.minInterval === 0) return null;
		if (limit.minInterval < 0) throw new Error(`Invalid rate limit ${limit.key}: minInterval is negative (${limit.minInterval})`);

		const counter = await this.getLimitCounter(limit, actor, 'min');
		const minInterval = Math.max(Math.ceil(limit.minInterval / factor), 0);

		// Update expiration
		if (counter.c > 0) {
			const isCleared = this.timeService.now - counter.t >= minInterval;
			if (isCleared) {
				counter.c = 0;
			}
		}

		const blocked = counter.c > 0;
		if (!blocked) {
			counter.c++;
			counter.t = this.timeService.now;
		}

		// Calculate limit status
		const resetMs = Math.max(Math.ceil(minInterval - (this.timeService.now - counter.t)), 0);
		const resetSec = Math.ceil(resetMs / 1000);
		const limitInfo: LimitInfo = { blocked, remaining: 0, resetSec, resetMs, fullResetSec: resetSec, fullResetMs: resetMs };

		// Update the limit counter, but not if blocked
		if (!blocked) {
			// Don't await, or we will slow down the API.
			this.setLimitCounter(limit, actor, counter, resetSec, 'min')
				.catch(err => this.logger.error(`Failed to update limit ${limit.key}:min for ${actor}:`, err));
		}

		return limitInfo;
	}

	private async limitBucket(limit: RateLimit, actor: string, factor: number): Promise<LimitInfo> {
		if (limit.size < 1) throw new Error(`Invalid rate limit ${limit.key}: size is less than 1 (${limit.size})`);
		if (limit.dripRate != null && limit.dripRate < 1) throw new Error(`Invalid rate limit ${limit.key}: dripRate is less than 1 (${limit.dripRate})`);
		if (limit.dripSize != null && limit.dripSize < 1) throw new Error(`Invalid rate limit ${limit.key}: dripSize is less than 1 (${limit.dripSize})`);

		const counter = await this.getLimitCounter(limit, actor, 'bucket');
		const bucketSize = Math.max(Math.ceil(limit.size * factor), 1);
		const dripRate = Math.ceil(limit.dripRate ?? 1000);
		const dripSize = Math.ceil(limit.dripSize ?? 1);

		// Update drips
		if (counter.c > 0) {
			const dripsSinceLastTick = Math.floor((this.timeService.now - counter.t) / dripRate) * dripSize;
			counter.c = Math.max(counter.c - dripsSinceLastTick, 0);
		}

		const blocked = counter.c >= bucketSize;
		if (!blocked) {
			counter.c++;
			counter.t = this.timeService.now;
		}

		// Calculate limit status
		const remaining = Math.max(bucketSize - counter.c, 0);
		const resetMs = remaining > 0 ? 0 : Math.max(dripRate - (this.timeService.now - counter.t), 0);
		const resetSec = Math.ceil(resetMs / 1000);
		const fullResetMs = Math.ceil(counter.c / dripSize) * dripRate;
		const fullResetSec = Math.ceil(fullResetMs / 1000);
		const limitInfo: LimitInfo = { blocked, remaining, resetSec, resetMs, fullResetSec, fullResetMs };

		// Update the limit counter, but not if blocked
		if (!blocked) {
			// Don't await, or we will slow down the API.
			this.setLimitCounter(limit, actor, counter, fullResetSec, 'bucket')
				.catch(err => this.logger.error(`Failed to update limit ${limit.key} for ${actor}:`, err));
		}

		return limitInfo;
	}

	private async getLimitCounter(limit: SupportedRateLimit, actor: string, subject: string): Promise<LimitCounter> {
		const key = createLimitKey(limit, actor, subject);

		const value = await this.redisClient.get(key);
		if (value == null) {
			return { t: 0, c: 0 };
		}

		return JSON.parse(value);
	}

	private async setLimitCounter(limit: SupportedRateLimit, actor: string, counter: LimitCounter, expiration: number, subject: string): Promise<void> {
		const key = createLimitKey(limit, actor, subject);
		const value = JSON.stringify(counter);
		const expirationSec = Math.max(expiration, 1);
		await this.redisClient.set(key, value, 'EX', expirationSec);
	}
}

function createLimitKey(limit: SupportedRateLimit, actor: string, subject: string): string {
	return `rl_${actor}_${limit.key}_${subject}`;
}

export interface LimitCounter {
	/** Timestamp */
	t: number;

	/** Counter */
	c: number;
}
