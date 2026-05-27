import test from 'node:test';
import assert from 'node:assert/strict';

import { toSearchResults } from './routes/search.js';

test('toSearchResults groups same-domain pages into one card while preserving individual pages', () => {
	const results = toSearchResults([
		{
			source: 'google',
			results: [
				{
					title: 'Example article',
					url: 'https://example.com/articles/one',
					snippet: 'First snippet',
					content: 'First content',
					crawled: true,
				},
				{
					title: 'Example article two',
					url: 'https://example.com/articles/two',
					snippet: 'Second snippet',
					content: 'Second content',
					crawled: true,
				},
			],
		},
		{
			source: 'bing',
			results: [
				{
					title: 'Other site article',
					url: 'https://other.example.org/post',
					snippet: 'Other snippet',
					content: 'Other content',
					crawled: true,
				},
			],
		},
	]);

	assert.equal(results.length, 2);
	assert.equal(results[0].domain, 'example.com');
	assert.equal(results[0].groupedResultCount, 2);
	assert.equal(Array.isArray(results[0].groupedResults), true);
	assert.deepEqual(
		results[0].groupedResults.map((entry) => entry.url),
		['https://example.com/articles/one', 'https://example.com/articles/two'],
	);
	assert.equal(results[1].domain, 'other.example.org');
	assert.equal(results[1].groupedResultCount, 1);
});
