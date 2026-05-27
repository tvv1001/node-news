import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMediaArticleItems } from './ResultsList';

test('builds media article cards only when key terms match the article', () => {
	const items = buildMediaArticleItems(
		[
			{
				source: 'google',
				sourceLabel: 'APS Journals',
				title: 'Lattice holography on a quantum computer | Phys. Rev. D',
				url: 'https://link.aps.org/doi/10.1103/PhysRevD.110.034507',
				snippet: 'We explore the potential application of quantum computers to the examination of lattice holography.',
				resultType: 'ai-supporting-article',
				crawled: true,
			},
			{
				source: 'bing',
				title: 'Completely unrelated article',
				url: 'https://example.com/unrelated-paper',
				snippet: 'This article is about airport parking and travel guides.',
				resultType: 'ai-supporting-article',
				crawled: false,
			},
		],
		{ searchTerm: 'lattice holography quantum computer' },
	);

	assert.equal(items.length, 1);
	assert.equal(items[0].url, 'https://link.aps.org/doi/10.1103/PhysRevD.110.034507');
	assert.equal(items[0].source, 'google');
	assert.equal(items[0].crawled, true);
});
