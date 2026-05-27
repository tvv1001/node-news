import test from 'node:test';
import assert from 'node:assert/strict';

import { parseFeedItemTimestamp, sortFeedItemsNewestFirst } from './services/rssIntegrator.js';

test('parseFeedItemTimestamp prefers feed date fields and returns 0 for invalid dates', () => {
	assert.equal(parseFeedItemTimestamp({ isoDate: '2026-05-13T21:00:00.000Z' }) > 0, true);
	assert.equal(parseFeedItemTimestamp({ pubDate: 'Wed, 13 May 2026 20:00:00 GMT' }) > 0, true);
	assert.equal(parseFeedItemTimestamp({ updated: 'not-a-date' }), 0);
});

test('sortFeedItemsNewestFirst orders mixed feed items from newest to oldest', () => {
	const sorted = sortFeedItemsNewestFirst([
		{ title: 'older', pubDate: 'Wed, 13 May 2026 18:00:00 GMT' },
		{ title: 'newest', isoDate: '2026-05-13T21:00:00.000Z' },
		{ title: 'middle', updated: '2026-05-13T19:30:00.000Z' },
		{ title: 'undated' },
	]);

	assert.deepEqual(
		sorted.map((item) => item.title),
		['newest', 'middle', 'older', 'undated'],
	);
});
