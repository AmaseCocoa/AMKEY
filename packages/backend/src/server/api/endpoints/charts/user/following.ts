/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { getJsonSchema } from '@/core/chart/core.js';
import PerUserFollowingChart from '@/core/chart/charts/per-user-following.js';
import { schema } from '@/core/chart/charts/entities/per-user-following.js';

export const meta = {
	tags: ['charts', 'users', 'following'],

	res: getJsonSchema(schema),

	allowGet: true,
	cacheSec: 60 * 60,

	// Burst up to 100, then 2/sec average
	limit: {
		type: 'bucket',
		size: 100,
		dripRate: 500,
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		span: { type: 'string', enum: ['day', 'hour'] },
		limit: { type: 'integer', minimum: 1, maximum: 500, default: 30 },
		offset: { type: 'integer', nullable: true, default: null },
		userId: { type: 'string', format: 'misskey:id' },
	},
	required: ['span', 'userId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private perUserFollowingChart: PerUserFollowingChart,
	) {
		super(meta, paramDef, async (ps, me) => {
			return await this.perUserFollowingChart.getChart(ps.span, ps.limit, ps.offset ? new Date(ps.offset) : null, ps.userId);
		});
	}
}
