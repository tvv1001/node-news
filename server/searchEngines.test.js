import test from 'node:test';
import assert from 'node:assert/strict';

import {
	buildSearchEngineQueries,
	buildYahooSearchQueries,
	buildGoogleAiCitationResults,
	buildGoogleAiSupportingArticleResults,
	buildGoogleSearchResult,
	extractBingAiResponseFromHtml,
	extractGoogleAiResponseFromHtml,
	extractYahooSearchResultsFromHtmlString,
	sanitizeSearchSnippet,
} from './services/crawler/searchEngines.js';
import { buildDirectSourceResult, toSearchResults } from './routes/search.js';
import { extractOrganizations } from './nlpService.js';

test('buildSearchEngineQueries adds document-heavy variants for research-documents profile', () => {
	const queries = buildSearchEngineQueries({
		searchTerm: 'quantum lattice holography',
		queryProfile: 'research-documents',
		city: 'Austin',
		state: 'TX',
	});

	assert.ok(queries.length >= 4);
	assert.equal(
		queries.some((query) => /filetype:pdf|ext:pdf/i.test(query)),
		true,
	);
	assert.equal(
		queries.some((query) => /site:arxiv\.org|site:sec\.gov|site:nature\.com/i.test(query)),
		true,
	);
	assert.equal(
		queries.some((query) => /site:github\.com|site:readthedocs\.io|site:docs\.rs/i.test(query)),
		true,
	);
	assert.equal(
		queries.every((query) => /quantum lattice holography/i.test(query)),
		true,
	);
});

test('buildYahooSearchQueries uses bounded document-heavy variants for research-documents profile', () => {
	const queries = buildYahooSearchQueries({
		searchTerm: 'deed notice',
		queryProfile: 'research-documents',
	});

	assert.ok(queries.length >= 1);
	assert.ok(queries.length <= 3);
	assert.equal(
		queries.some((query) => /filetype:pdf|ext:pdf/i.test(query)),
		true,
	);
	assert.equal(
		queries.some((query) => /site:gov|site:sec\.gov/i.test(query)),
		true,
	);
	assert.equal(
		queries.some((query) => /paper|report|filing|documentation/i.test(query)),
		true,
	);
});

test('finance-oriented research-documents queries prefer SEC and filing language', () => {
	const queries = buildSearchEngineQueries({
		searchTerm: '$tsla earnings',
		queryProfile: 'research-documents',
	});

	assert.equal(
		queries.some((query) => /site:sec\.gov|annualreports\.com|investor\./i.test(query)),
		true,
	);
	assert.equal(
		queries.some((query) => /10-K|10-Q|8-K|earnings transcript|investor presentation/i.test(query)),
		true,
	);
});

test('science-oriented research-documents queries prefer journals and preprints', () => {
	const queries = buildSearchEngineQueries({
		searchTerm: 'quantum lattice holography',
		queryProfile: 'research-documents',
	});

	assert.equal(
		queries.some((query) => /site:arxiv\.org|site:pubmed\.ncbi\.nlm\.nih\.gov|site:nature\.com|site:science\.org/i.test(query)),
		true,
	);
	assert.equal(
		queries.some((query) => /paper|preprint|journal|supplemental|dataset/i.test(query)),
		true,
	);
});

test('policy-oriented Yahoo research-documents queries prefer government and legal-document sources', () => {
	const queries = buildYahooSearchQueries({
		searchTerm: 'ai policy regulation',
		queryProfile: 'research-documents',
	});

	assert.equal(
		queries.some((query) => /site:congress\.gov|site:regulations\.gov|site:supremecourt\.gov|site:gov/i.test(query)),
		true,
	);
	assert.equal(
		queries.some((query) => /statute|regulation|rule|order|memorandum|guidance/i.test(query)),
		true,
	);
});

test('advanced operator queries stay untouched even with research-documents profile', () => {
	const searchQueries = buildSearchEngineQueries({
		searchTerm: 'site:gov "land records" after:2025-01-01',
		queryProfile: 'research-documents',
	});
	const yahooQueries = buildYahooSearchQueries({
		searchTerm: 'site:gov "land records" after:2025-01-01',
		queryProfile: 'research-documents',
	});

	assert.deepEqual(searchQueries, ['site:gov "land records" after:2025-01-01']);
	assert.deepEqual(yahooQueries, ['site:gov "land records" after:2025-01-01']);
});

test('extracts Google AI Overview text from processed result blocks', () => {
	const html = `
		<div data-processed="true">
			<div role="heading">AI Overview</div>
			<div>
				Quantum lattice holography explores how quantum information, structured on a discrete lattice, maps to a higher-dimensional spacetime using holographic principles.
				Core Concepts and Applications
				Holographic Tensor Networks: Quantum lattice states are efficiently described by tensor networks like MERA.
				Key Findings Research suggests that quantum entanglement among bulk bits leads to the holographic principle.
				Lattice holography on a quantum computer | Phys. Rev. D
				Show all
			</div>
		</div>
		<div data-processed="true">
			<div role="heading">People also ask</div>
			<div>What is holography?</div>
		</div>
	`;

	const result = extractGoogleAiResponseFromHtml(html);

	assert.ok(result);
	assert.match(result, /Quantum lattice holography explores how quantum information/i);
	assert.match(result, /Core Concepts and Applications/i);
	assert.match(result, /Phys\. Rev\. D/i);
	assert.doesNotMatch(result, /^AI Overview/i);
	assert.doesNotMatch(result, /Show all\s*$/i);
	assert.doesNotMatch(result, /People also ask/i);
});

test('extracts Google AI Overview text from fallback selector blocks', () => {
	const html = `
		<div id="kAp9Ze">
			AI Overview
			Quantum lattice holography connects discrete quantum systems to higher-dimensional spacetime through holographic duality.
			Applications include tensor-network models, AdS/CFT simulations, and quantum-computing studies of entanglement structure.
			Show all
		</div>
		<div class="wDYxhc">Short unrelated answer</div>
	`;

	const result = extractGoogleAiResponseFromHtml(html);

	assert.ok(result);
	assert.match(result, /Quantum lattice holography connects discrete quantum systems/i);
	assert.match(result, /tensor-network models, AdS\/CFT simulations, and quantum-computing studies/i);
	assert.doesNotMatch(result, /^AI Overview/i);
	assert.doesNotMatch(result, /Show all\s*$/i);
	assert.doesNotMatch(result, /Short unrelated answer/i);
});

test('extracts Google AI Overview text from the expanded m-x-content container', () => {
	const html = `
		<div id="m-x-content">
			AI Overview
			Quantum lattice holography is a theoretical framework that applies quantum computing and tensor networks to simulate the holographic principle.
			It uses discretized lattice systems to study quantum gravity, entanglement structure, and higher-dimensional bulk/boundary mappings.
			Show more
		</div>
	`;

	const result = extractGoogleAiResponseFromHtml(html);

	assert.ok(result);
	assert.match(result, /Quantum lattice holography is a theoretical framework/i);
	assert.match(result, /discretized lattice systems to study quantum gravity/i);
	assert.doesNotMatch(result, /^AI Overview/i);
	assert.doesNotMatch(result, /Show more\s*$/i);
});

test('captures Bing AI text from the full answer block shape', () => {
	const html = `
		<ul>
			<li class="b_ans">
				Like Dislike
				Quantum Lattice Holography is an approach that combines lattice field theory with holography to study strongly coupled quantum systems.
				Core Idea In the AdS/CFT correspondence, a strongly coupled quantum field theory on a boundary is dual to gravity in a higher-dimensional bulk.
				Read all
			</li>
		</ul>
	`;

	const result = extractBingAiResponseFromHtml(html);

	assert.ok(result);
	assert.match(result, /Quantum Lattice Holography is an approach/i);
	assert.match(result, /Core Idea In the AdS\/CFT correspondence/i);
	assert.doesNotMatch(result, /^Like\s+Dislike/i);
	assert.doesNotMatch(result, /Read all\s*$/i);
});

test('extracts Yahoo search results from HTML fallback markup', () => {
	const html = `
		<div id="web">
			<ol class="searchCenterMiddle">
				<li>
					<div class="algo">
						<h3 class="title"><a href="https://r.search.yahoo.com/_ylt=test/RU=https%3A%2F%2Fexample.com%2Fpaper/RK=2/RS=abc">Lattice holography on a quantum computer</a></h3>
						<div class="compText"><p>We explore the potential application of quantum computers to the examination of lattice holography.</p></div>
					</div>
				</li>
			</ol>
		</div>
	`;

	const result = extractYahooSearchResultsFromHtmlString(html);

	assert.equal(result.length, 1);
	assert.equal(result[0].url, 'https://example.com/paper');
	assert.match(result[0].title, /Lattice holography on a quantum computer/i);
	assert.match(result[0].snippet, /quantum computers to the examination of lattice holography/i);
});

test('preserves Google AI when fallback web results are used', () => {
	const result = buildGoogleSearchResult({
		htmlResults: [],
		htmlAiResponse: 'Quantum lattice holography maps boundary quantum states to a higher-dimensional bulk geometry.',
		fallbackResults: [
			{
				title: 'Fallback result',
				url: 'https://example.com/fallback',
				snippet: 'Fallback snippet',
			},
		],
	});

	assert.equal(result.source, 'google');
	assert.equal(result.results.length, 1);
	assert.equal(result.results[0].url, 'https://example.com/fallback');
	assert.match(result.aiResponse, /Quantum lattice holography maps boundary quantum states/i);
});

test('keeps hidden Google AI citation results while still falling back to visible web results', () => {
	const result = buildGoogleSearchResult({
		htmlResults: [
			{
				title: 'AI citation source',
				url: 'https://example.com/citation',
				snippet: 'Citation snippet',
				hiddenFromUi: true,
				forceCrawl: true,
			},
		],
		htmlAiResponse: 'Quantum lattice holography maps boundary quantum states to a higher-dimensional bulk geometry.',
		fallbackResults: [
			{
				title: 'Fallback result',
				url: 'https://example.com/fallback',
				snippet: 'Fallback snippet',
			},
		],
	});

	assert.equal(result.source, 'google');
	assert.equal(result.results.length, 2);
	assert.equal(result.results[0].url, 'https://example.com/fallback');
	assert.equal(result.results[1].url, 'https://example.com/citation');
	assert.equal(result.results[1].hiddenFromUi, true);
});

test('keeps Google AI supporting article results while still falling back to visible web results', () => {
	const result = buildGoogleSearchResult({
		htmlResults: [
			{
				title: 'Supporting article',
				url: 'https://example.com/supporting-article',
				snippet: 'Supporting snippet',
				resultType: 'ai-supporting-article',
				forceCrawl: true,
			},
		],
		htmlAiResponse: 'Quantum lattice holography maps boundary quantum states to a higher-dimensional bulk geometry.',
		fallbackResults: [
			{
				title: 'Fallback result',
				url: 'https://example.com/fallback',
				snippet: 'Fallback snippet',
			},
		],
	});

	assert.equal(result.results.length, 2);
	assert.equal(result.results[0].url, 'https://example.com/fallback');
	assert.equal(result.results[1].url, 'https://example.com/supporting-article');
	assert.equal(result.results[1].resultType, 'ai-supporting-article');
});

test('omits Google AI when none was extracted', () => {
	const result = buildGoogleSearchResult({
		htmlResults: [],
		htmlAiResponse: '',
		fallbackResults: [{ title: 'Fallback result', url: 'https://example.com/fallback', snippet: 'Fallback snippet' }],
	});

	assert.equal(result.source, 'google');
	assert.equal(result.results.length, 1);
	assert.equal('aiResponse' in result, false);
});

test('builds crawlable but hidden Google AI citation results and ignores policy links', () => {
	const result = buildGoogleAiCitationResults([
		{
			url: 'https://policies.google.com/privacy?hl=en',
			text: 'Privacy Policy',
			parentText: 'Your feedback helps Google improve. See our Privacy Policy.',
		},
		{
			url: 'https://inspirehep.net/literature/2738120',
			text: '',
			parentText: 'Lattice holography on a quantum computer - Inspire HEP Dec 16, 2023 — Citations per year. Inspire HEP',
			ariaLabel: 'Lattice holography on a quantum computer - Inspire HEP. URL: https://inspirehep.net/literature/2738120. Opens in new tab.',
		},
	]);

	assert.equal(result.length, 1);
	assert.equal(result[0].url, 'https://inspirehep.net/literature/2738120');
	assert.equal(result[0].hiddenFromUi, true);
	assert.equal(result[0].forceCrawl, true);
	assert.equal(result[0].fromGoogleAiCitation, true);
	assert.match(result[0].title, /Lattice holography on a quantum computer/i);
});

test('builds visible crawlable Google AI supporting article results from rhs-col cards', () => {
	const result = buildGoogleAiSupportingArticleResults([
		{
			url: 'https://link.aps.org/doi/10.1103/PhysRevD.110.034507',
			ariaLabel: 'Lattice holography on a quantum computer | Phys. Rev. D. Opens in new tab.',
			parentText:
				'Lattice holography on a quantum computer | Phys. Rev. D Aug 6, 2024 — Abstract. We explore the potential application of quantum computers to the examination of lattice holography, which extends to the... APS Journals',
			sourceLabel: 'APS Journals',
		},
	]);

	assert.equal(result.length, 1);
	assert.equal(result[0].url, 'https://link.aps.org/doi/10.1103/PhysRevD.110.034507');
	assert.equal(result[0].resultType, 'ai-supporting-article');
	assert.equal(result[0].forceCrawl, true);
	assert.equal(result[0].fromGoogleAiSupportingArticle, true);
	assert.equal(result[0].sourceLabel, 'APS Journals');
	assert.match(result[0].title, /Lattice holography on a quantum computer/i);
	assert.doesNotMatch(result[0].title, /\+\d+/i);
});

test('prefers crawled page previews over longer raw search snippets for duplicate URLs', () => {
	const result = toSearchResults([
		{
			source: 'google',
			results: [
				{
					title: 'Lattice holography on a quantum computer | Phys. Rev. D',
					url: 'https://link.aps.org/doi/10.1103/PhysRevD.110.034507',
					snippet:
						'Lattice holography on a quantum computer | Phys. Rev. D Abstract. We explore the potential application of quantum computers to the examination of lattice holography, which extends to the... APS Journals APS Journals [2312.10544] Lattice Holography on a Quantum Computer - arXiv Submission history.',
					crawled: false,
				},
			],
		},
		{
			source: 'bing',
			results: [
				{
					title: 'Lattice holography on a quantum computer | Phys. Rev. D',
					url: 'https://link.aps.org/doi/10.1103/PhysRevD.110.034507',
					contentPreview:
						'We explore the potential application of quantum computers to the examination of lattice holography, which extends to the strongly coupled bulk theory regime.',
					crawled: true,
				},
			],
		},
	]);

	assert.equal(result.length, 1);
	assert.equal(result[0].crawled, true);
	assert.match(result[0].snippet, /^We explore the potential application of quantum computers/i);
	assert.doesNotMatch(result[0].snippet, /APS Journals APS Journals \[2312\.10544\]/i);
});

test('still prefers the longer snippet when duplicate results have the same crawl status', () => {
	const result = toSearchResults([
		{
			source: 'google',
			results: [{ title: 'Example', url: 'https://example.com/paper', snippet: 'Short snippet', crawled: false }],
		},
		{
			source: 'bing',
			results: [{ title: 'Example', url: 'https://example.com/paper', snippet: 'A much longer snippet from another engine result', crawled: false }],
		},
	]);

	assert.equal(result.length, 1);
	assert.equal(result[0].snippet, 'A much longer snippet from another engine result');
	assert.equal(result[0].crawled, false);
});

test('preserves full crawled content for merged result cards', () => {
	const result = toSearchResults([
		{
			source: 'google',
			results: [{ title: 'Example', url: 'https://example.com/paper', snippet: 'Short snippet', crawled: false }],
		},
		{
			source: 'bing',
			results: [
				{
					title: 'Example',
					url: 'https://example.com/paper',
					contentPreview: 'Preview from crawled page',
					content: 'Full crawled page content with supporting material and detailed discussion.',
					crawled: true,
				},
			],
		},
	]);

	assert.equal(result.length, 1);
	assert.equal(result[0].crawled, true);
	assert.equal(result[0].content, 'Full crawled page content with supporting material and detailed discussion.');
	assert.equal(result[0].snippet, 'Preview from crawled page');
});

test('sanitizeSearchSnippet strips AI disclaimer footer and source-label suffix', () => {
	const raw =
		'Lattice holography on a quantum computer | Phys. Rev. D Abstract. We explore the potential application of quantum computers to the examination of lattice holography, which extends to the. . . APS Journals [2312. 10544] Lattice Holography on a Quantum Computer - arXiv Submission history. From: Judah Unmuth-Yockey [view email] [v1] Sat, 16 Dec 2023 21: 48: 24 UTC (148 KB) Access Paper: View a PDF of. . . arXiv Investigation of Holographic Lattice Theories Specifically, I have used lattice techniques in Wick-rotated Anti-de Sitter (AdS) spacetime to investigate holography. After a rev. . . SURFACE at Syracuse University Show all AI can make mistakes, so double-check responses';

	const result = sanitizeSearchSnippet(raw);

	assert.doesNotMatch(result, /AI can make mistakes/i);
	assert.doesNotMatch(result, /Show all\s*$/i);
	assert.doesNotMatch(result, /SURFACE at Syracuse University/i);
	assert.doesNotMatch(result, /\[2312\.\s*10544\]/i);
	assert.doesNotMatch(result, /Submission history/i);
	assert.ok(result.length > 0);
	assert.match(result, /Lattice holography/i);
});

test('sanitizeSearchSnippet leaves a clean ordinary snippet unchanged', () => {
	const clean = 'We explore the potential application of quantum computers to the examination of lattice holography, which extends to the strongly coupled bulk theory regime.';
	assert.equal(sanitizeSearchSnippet(clean), clean);
});

test('keeps matching article results separate instead of merging them by URL', () => {
	const result = toSearchResults([
		{
			source: 'google',
			results: [
				{
					title: 'Lattice holography on a quantum computer | Phys. Rev. D',
					url: 'https://link.aps.org/doi/10.1103/PhysRevD.110.034507',
					snippet: 'APS Journals abstract snippet',
					resultType: 'ai-supporting-article',
					crawled: false,
				},
			],
		},
		{
			source: 'bing',
			results: [
				{
					title: 'Lattice holography on a quantum computer | Phys. Rev. D',
					url: 'https://link.aps.org/doi/10.1103/PhysRevD.110.034507',
					contentPreview: 'We explore the potential application of quantum computers to the examination of lattice holography.',
					resultType: 'ai-supporting-article',
					crawled: true,
				},
			],
		},
	]);

	assert.equal(result.length, 2);
	assert.equal(result[0].source, 'google');
	assert.equal(result[1].source, 'bing');
	assert.equal(result[1].crawled, true);
});

test('builds a direct source result so a provided PDF URL appears in search results', () => {
	const directSource = buildDirectSourceResult('https://arxiv.org/pdf/2312.10544', {
		text: 'We explore the potential application of quantum computers to the examination of lattice holography.',
		previewImage: { src: 'data:image/jpeg;base64,abc', alt: 'PDF preview', caption: 'Page preview' },
		imageContext: {
			entries: [{ src: 'https://arxiv.org/html/2312.10544v1/x1.png', alt: 'Order-7 triangular lattice' }],
			renderableEntries: [{ src: 'https://arxiv.org/html/2312.10544v1/x1.png', alt: 'Order-7 triangular lattice', caption: 'Figure 1' }],
			text: 'Figure: Figure 1: The order-7 triangular lattice with 85 sites.',
		},
		supportingDocuments: { urls: [], documents: [] },
	});

	const results = toSearchResults([
		{
			source: 'source-url',
			results: [directSource],
		},
	]);

	assert.equal(results.length, 1);
	assert.equal(results[0].url, 'https://arxiv.org/pdf/2312.10544');
	assert.equal(results[0].sourceLabel, 'Direct URL');
	assert.equal(results[0].crawled, true);
	assert.match(results[0].content, /quantum computers to the examination of lattice holography/i);
	assert.equal(results[0].previewImage?.src, 'data:image/jpeg;base64,abc');
	assert.equal(results[0].imageContext?.renderableEntries?.[0]?.src, 'https://arxiv.org/html/2312.10544v1/x1.png');
});

test('suppresses non-English direct source pages from search results', () => {
	const directSource = buildDirectSourceResult('https://segurma.com/seguridad/', {
		language: 'non-en',
		text: 'Alarmas para Empresas Expertos en diseñar proyectos de seguridad adaptados a las necesidades de PYMES y grandes empresas.',
	});

	assert.equal(directSource, null);
});

test('omits blocked results from normalized search results', () => {
	const results = toSearchResults([
		{
			source: 'google',
			results: [
				{
					title: 'Blocked article',
					url: 'https://example.com/blocked',
					snippet: 'Subscribe to continue reading',
					blocked: true,
				},
				{
					title: 'Visible article',
					url: 'https://example.com/visible',
					snippet: 'Readable public article snippet',
				},
			],
		},
	]);

	assert.equal(results.length, 1);
	assert.equal(results[0].url, 'https://example.com/visible');
});

test('omits quantum-host results from normalized search results', () => {
	const results = toSearchResults([
		{
			source: 'google',
			results: [
				{
					title: 'Quantum marketing page',
					url: 'https://www.quantumlabs.io/solutions/security/',
					snippet: 'Enterprise storage and data protection solutions.',
				},
			],
		},
	]);

	assert.equal(results.length, 0);
});

test('does not extract corporate suffix organizations', async () => {
	const organizations = await extractOrganizations(
		'Quantum delivers end-to-end data management solutions. Quantum Corporation is listed on Nasdaq, and Quantum Corporation marks its trademarks.',
	);

	assert.equal(organizations.includes('Quantum Corporation'), false);
	assert.equal(
		organizations.some((value) => /corporation|corp\.?|company|inc\.?|llc/i.test(value)),
		false,
	);
});
