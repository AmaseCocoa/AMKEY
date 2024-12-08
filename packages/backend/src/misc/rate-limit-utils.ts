/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { FastifyReply } from 'fastify';

export type RateLimit = BucketRateLimit | LegacyRateLimit;

/**
 * Rate limit based on "leaky bucket" logic.
 * The bucket count increases with each call, and decreases gradually at a given rate.
 * The subject is blocked until the bucket count drops below the limit.
 */
export interface BucketRateLimit {
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

/**
 * Legacy rate limit based on a "request window" with a maximum number of requests within a given time box.
 * These will be translated into a bucket with linear drip rate.
 */
export interface LegacyRateLimit {
	/**
	 * Unique key identifying the particular resource (or resource group) being limited.
	 */
	key: string;

	/**
	 * Constant value identifying the type of rate limit.
	 * Must be excluded or explicitly set to undefined
	 */
	type?: undefined;

	/**
	 * Duration of the request window, in milliseconds.
	 * If present, then "max" must also be included.
	 */
	duration?: number;

	/**
	 * Maximum number of requests allowed in the request window.
	 * If present, then "duration" must also be included.
	 */
	max?: number;

	/**
	 * Optional minimum interval between consecutive requests.
	 * Will apply in addition to the primary rate limit.
	 */
	minInterval?: number;
}

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

export function isLegacyRateLimit(limit: RateLimit): limit is LegacyRateLimit {
	return limit.type === undefined;
}

export function hasMinLimit(limit: LegacyRateLimit): limit is LegacyRateLimit & { minInterval: number } {
	return !!limit.minInterval;
}

export function sendRateLimitHeaders(reply: FastifyReply, info: LimitInfo): void {
	// Number of seconds until the limit has fully reset.
	reply.header('X-RateLimit-Clear', info.fullResetSec.toString());
	// Number of calls that can be made before being limited.
	reply.header('X-RateLimit-Remaining', info.remaining.toString());

	if (info.blocked) {
		// Number of seconds to wait before trying again. Left for backwards compatibility.
		reply.header('Retry-After', info.resetSec.toString());
		// Number of milliseconds to wait before trying again.
		reply.header('X-RateLimit-Reset', info.resetMs.toString());
	}
}
