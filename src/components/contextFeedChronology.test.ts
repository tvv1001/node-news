import test from 'node:test';
import assert from 'node:assert/strict';

import { isFutureDatedFeedItem, sortFeedItemsNewestFirst } from './contextFeedChronology';

test('sortFeedItemsNewestFirst keeps published items in reverse chronological order', () => {
	const sorted = sortFeedItemsNewestFirst([
		{ id: 'older', publishedAt: '2026-05-14T09:00:00.000Z', source: 'Source A' },
		{ id: 'newest', publishedAt: '2026-05-14T11:00:00.000Z', source: 'Source B' },
		{ id: 'middle', publishedAt: '2026-05-14T10:00:00.000Z', source: 'Source C' },
	]);

	assert.deepEqual(
		sorted.map((item) => item.id),
		['newest', 'middle', 'older'],
	);
});

test('sortFeedItemsNewestFirst keeps published items ahead of fresher discovery-only items', () => {
	const sorted = sortFeedItemsNewestFirst([
		{ id: 'published', publishedAt: '2026-05-14T10:00:00.000Z', discoveredAt: '2026-05-14T10:05:00.000Z', source: 'Source A' },
		{ id: 'undated', discoveredAt: '2026-05-14T11:59:00.000Z', source: 'Source B' },
		{ id: 'older-undated', discoveredAt: '2026-05-14T08:00:00.000Z', source: 'Source C' },
	]);

	assert.deepEqual(
		sorted.map((item) => item.id),
		['published', 'undated', 'older-undated'],
	);
});

test('sortFeedItemsNewestFirst uses discovery time when neither item has a published timestamp', () => {
	const sorted = sortFeedItemsNewestFirst([
		{ id: 'older-discovered', discoveredAt: '2026-05-14T08:00:00.000Z', source: 'Source A' },
		{ id: 'newer-discovered', discoveredAt: '2026-05-14T09:00:00.000Z', source: 'Source B' },
	]);

	assert.deepEqual(
		sorted.map((item) => item.id),
		['newer-discovered', 'older-discovered'],
	);
});

test('isFutureDatedFeedItem flags cards with published dates beyond the tolerance window', () => {
	assert.equal(isFutureDatedFeedItem({ publishedAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString() }), true);
	assert.equal(isFutureDatedFeedItem({ publishedAt: new Date(Date.now() - 60 * 1000).toISOString() }), false);
	assert.equal(isFutureDatedFeedItem({ discoveredAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString() }), false);
});
