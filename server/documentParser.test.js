import test from 'node:test';
import assert from 'node:assert/strict';

import {
	createEmbeddedImageAsset,
	detectBlockedDocument,
	detectLikelyTextLanguage,
	extractArxivAbstractDetails,
	extractArxivHtmlUrlFromAbsHtml,
	extractDataLayerMetadata,
	extractImageContextMetadata,
	extractSupportingDocumentLinks,
} from './services/crawler/documentParser.js';

test('extracts meaningful metadata from inline dataLayer payloads', () => {
	const html = `
		<html>
			<head>
				<script>
					window.dataLayer = [{
						pageTitle: 'Quantum lattice holography on a quantum computer',
						pageCategory: 'Physics',
						authors: ['Ying-Ying Li', 'Judah Unmuth-Yockey'],
						pageType: 'article',
						event: 'page_view',
						pageUrl: 'https://example.com/article'
					}];
					window.dataLayer.push({
						section: 'Research',
						description: 'A study of holography on hyperbolic lattices.',
						gtm: 'internal'
					});
				</script>
			</head>
			<body>
				<article>Body content</article>
			</body>
		</html>
	`;

	const dataLayer = extractDataLayerMetadata(html);

	assert.equal(dataLayer.entries.length, 2);
	assert.match(dataLayer.text, /pageTitle: Quantum lattice holography on a quantum computer/i);
	assert.match(dataLayer.text, /pageCategory: Physics/i);
	assert.match(dataLayer.text, /authors: Ying-Ying Li/i);
	assert.match(dataLayer.text, /section: Research/i);
	assert.match(dataLayer.text, /description: A study of holography on hyperbolic lattices\./i);
	assert.doesNotMatch(dataLayer.text, /event: page_view/i);
	assert.doesNotMatch(dataLayer.text, /pageUrl: https:\/\/example\.com\/article/i);
});

test('finds supporting PDF links including arXiv /pdf routes', () => {
	const html = `
		<html>
			<body>
				<a href="/pdf/2312.10544">View PDF</a>
				<a href="https://example.com/supplement.pdf">Supplement PDF</a>
				<a href="https://surface.syr.edu/cgi/viewcontent.cgi?article=2652&context=etd">Download</a>
				<a href="/html/2312.10544v1">HTML (experimental)</a>
			</body>
		</html>
	`;

	const links = extractSupportingDocumentLinks(html, 'https://arxiv.org/abs/2312.10544');

	assert.deepEqual(links, ['https://arxiv.org/pdf/2312.10544', 'https://surface.syr.edu/cgi/viewcontent.cgi?article=2652&context=etd']);
});

test('finds Digital Commons viewcontent downloads from repository landing pages', () => {
	const html = `
		<html>
			<body>
				<a href="/cgi/viewcontent.cgi?article=2652&context=etd">Download</a>
				<a href="/etd/1651/">Record page</a>
			</body>
		</html>
	`;

	const links = extractSupportingDocumentLinks(html, 'https://surface.syr.edu/etd/1651/');

	assert.deepEqual(links, ['https://surface.syr.edu/cgi/viewcontent.cgi?article=2652&context=etd']);
});

test('extracts image captions and alt text as supporting image context', () => {
	const html = `
		<html>
			<body>
				<figure>
					<img src="/html/2312.10544v1/x1.png" alt="Refer to caption" />
					<figcaption>
						Figure 1: The order-7 triangular lattice with 85 sites.
					</figcaption>
				</figure>
				<img src="https://example.com/diagram.png" title="Phase diagram overview" alt="phase diagram" />
			</body>
		</html>
	`;

	const imageContext = extractImageContextMetadata(html, 'https://arxiv.org/abs/2312.10544');

	assert.equal(imageContext.entries.length, 2);
	assert.equal(imageContext.renderableEntries.length, 2);
	assert.match(imageContext.text, /Figure: Figure 1: The order-7 triangular lattice with 85 sites\./i);
	assert.doesNotMatch(imageContext.text, /Image alt:|Image title:|Image source:/i);
});

test('skips non-renderable inline data-uri images from previewable image entries', () => {
	const html = `
		<html>
			<body>
				<img src="data:image/png;base64,AAAA" alt="Tracker pixel" />
				<figure>
					<img src="/figures/main-diagram.png" alt="Main diagram" />
					<figcaption>Key result diagram</figcaption>
				</figure>
			</body>
		</html>
	`;

	const imageContext = extractImageContextMetadata(html, 'https://example.com/paper');

	assert.equal(imageContext.entries.length, 1);
	assert.equal(imageContext.renderableEntries.length, 1);
	assert.equal(imageContext.renderableEntries[0].src, 'https://example.com/figures/main-diagram.png');
	assert.match(imageContext.renderableEntries[0].caption, /Key result diagram/i);
	assert.doesNotMatch(imageContext.text, /Tracker pixel/i);
});

test('filters logos, navigation, footer, and social images from extracted image context', () => {
	const html = `
		<html>
			<body>
				<header>
					<img src="/static/arxiv-logo.svg" alt="arXiv logo" />
				</header>
				<nav>
					<img src="/icons/menu.svg" alt="Navigation menu" />
				</nav>
				<main>
					<figure>
						<img src="/html/2312.10544v1/x2.png" alt="Hyperbolic tiling circuit diagram" />
						<figcaption>Figure 2: Hyperbolic tiling used for the encoded circuit.</figcaption>
					</figure>
					<div class="social-links">
						<img src="https://example.com/social/reddit.png" alt="Share on Reddit" />
					</div>
				</main>
				<footer>
					<img src="https://example.com/cornell-reduced-white.svg" alt="Cornell University logo" />
				</footer>
			</body>
		</html>
	`;

	const imageContext = extractImageContextMetadata(html, 'https://arxiv.org/html/2312.10544v1');

	assert.equal(imageContext.entries.length, 1);
	assert.equal(imageContext.renderableEntries.length, 1);
	assert.equal(imageContext.renderableEntries[0].src, 'https://arxiv.org/html/2312.10544v1/x2.png');
	assert.match(imageContext.text, /Figure 2: Hyperbolic tiling/i);
	assert.doesNotMatch(imageContext.text, /arXiv logo|Navigation menu|Reddit|Cornell University/i);
});

test('filters promotional marketing images and filename-only ad assets from image context', () => {
	const html = `
		<html>
			<body>
				<main>
					<figure>
						<img src="https://www.quantum.com/contentassets/a80f232c6ed64a5a9401a9def9bfd22a/quantum_logo_blue.png" alt="End-to-End Data Management Solutions Designed for the AI Era" title="End-to-End Data Management Solutions Designed for the AI Era" />
					</figure>
					<img src="https://www.quantum.com/globalassets/resources/events/isc-high-performance/wn-isc-2026-min.jpg" alt="WN-ISC-2026-min.jpg" />
					<img src="https://www.quantum.com/globalassets/home/redesignjuly2023/wn-pr-nab2026-min.jpg" alt="WN-PR-NAB2026-min.jpg" />
				</main>
			</body>
		</html>
	`;

	const imageContext = extractImageContextMetadata(html, 'https://www.quantum.com/');

	assert.equal(imageContext.entries.length, 0);
	assert.equal(imageContext.renderableEntries.length, 0);
	assert.equal(imageContext.text, '');
});

test('detects likely English and non-English page text', () => {
	assert.equal(detectLikelyTextLanguage('This page explains security services for small businesses and enterprise teams.'), 'en');
	assert.equal(detectLikelyTextLanguage('Alarmas para Empresas Expertos en diseñar proyectos de seguridad adaptados a las necesidades de PYMES y grandes empresas.'), 'non-en');
});

test('embeds photo-like assets as base64 data URIs', () => {
	const photoAsset = createEmbeddedImageAsset(
		{
			src: 'https://example.com/headshot.jpg',
			alt: 'Researcher headshot',
		},
		{
			buffer: Buffer.from('fake-jpeg-binary'),
			contentType: 'image/jpeg',
		},
	);

	assert.ok(photoAsset);
	assert.match(photoAsset.src, /^data:image\/jpeg;base64,/i);
	assert.equal(photoAsset.embedded, true);
	assert.equal(photoAsset.embeddedFormat, 'base64');
	assert.equal(photoAsset.originUrl, 'https://example.com/headshot.jpg');
});

test('embeds diagrams as svg data URIs containing the original raster bytes', () => {
	const diagramAsset = createEmbeddedImageAsset(
		{
			src: 'https://example.com/figure.png',
			caption: 'Figure 4: Boundary correlation function',
		},
		{
			buffer: Buffer.from('fake-png-binary'),
			contentType: 'image/png',
		},
	);

	assert.ok(diagramAsset);
	assert.match(diagramAsset.src, /^data:image\/svg\+xml;base64,/i);
	assert.equal(diagramAsset.embedded, true);
	assert.equal(diagramAsset.embeddedFormat, 'svg');
	const svgMarkup = Buffer.from(diagramAsset.src.replace(/^data:image\/svg\+xml;base64,/i, ''), 'base64').toString('utf8');
	assert.match(svgMarkup, /Figure 4: Boundary correlation function/i);
	assert.match(svgMarkup, /data:image\/png;base64,/i);
	assert.equal(diagramAsset.originUrl, 'https://example.com/figure.png');
});

test('extracts the related arXiv HTML page from an abstract page for figure harvesting', () => {
	const html = `
		<html>
			<body>
				<section>
					<h2>Access Paper:</h2>
					<a href="/pdf/2312.10544">View PDF</a>
					<a href="/html/2312.10544v1">HTML (experimental)</a>
				</section>
			</body>
		</html>
	`;

	const relatedHtmlUrl = extractArxivHtmlUrlFromAbsHtml(html, 'https://arxiv.org/abs/2312.10544');

	assert.equal(relatedHtmlUrl, 'https://arxiv.org/html/2312.10544v1');
});

test('extracts concise arXiv abstract details and matching same-paper PDF link', () => {
	const html = `
		<html>
			<body>
				<h1 class="title mathjax">Title: Lattice Holography on a Quantum Computer</h1>
				<div class="authors">
					<a href="/search/?searchtype=author&query=Li,+Y">Ying-Ying Li</a>
					<a href="/search/?searchtype=author&query=Sajid,+M+O">Muhammad Omer Sajid</a>
				</div>
				<div class="dateline">Submitted on 16 Dec 2023</div>
				<blockquote class="abstract mathjax">
					Abstract: We explore the potential application of quantum computers to lattice holography.
				</blockquote>
				<table class="metatable">
					<tr><td>Comments:</td><td>six pages, six figures</td></tr>
					<tr><td>Subjects:</td><td>High Energy Physics - Lattice (hep-lat); Quantum Physics (quant-ph)</td></tr>
					<tr><td>Report number:</td><td>USTC-ICTS/PCFT-23-25</td></tr>
					<tr><td>Cite as:</td><td>arXiv:2312.10544 [hep-lat]</td></tr>
				</table>
				<a href="/pdf/2312.10544">View PDF</a>
			</body>
		</html>
	`;

	const details = extractArxivAbstractDetails(html, 'https://arxiv.org/abs/2312.10544');

	assert.equal(details.pdfUrl, 'https://arxiv.org/pdf/2312.10544');
	assert.match(details.text, /Title: Lattice Holography on a Quantum Computer/i);
	assert.match(details.text, /Authors: Ying-Ying Li, Muhammad Omer Sajid/i);
	assert.match(details.text, /Submitted: Submitted on 16 Dec 2023/i);
	assert.match(details.text, /Subjects: High Energy Physics - Lattice/i);
	assert.match(details.text, /Comments: six pages, six figures/i);
	assert.match(details.text, /Report number: USTC-ICTS\/PCFT-23-25/i);
	assert.match(details.text, /Cite as: arXiv:2312.10544 \[hep-lat\]/i);
	assert.match(details.text, /Abstract: We explore the potential application of quantum computers to lattice holography\./i);
});

test('detects blocked anti-bot interstitial pages', () => {
	const blocked = detectBlockedDocument(
		'Just a moment... Please enable JavaScript and cookies to continue. Verify you are human to proceed. Cloudflare Ray ID: 1234abcd',
		'https://example.com/challenge',
	);

	assert.equal(blocked.blocked, true);
	assert.match(blocked.reason, /browser-check-gate|captcha-or-human-verification/i);
});

test('does not flag ordinary article content as blocked', () => {
	const blocked = detectBlockedDocument(
		'Quantum lattice holography studies how information on a discrete boundary system maps to a higher-dimensional bulk spacetime. The article compares several tensor-network approaches and summarizes experimental implications.',
		'https://example.com/article',
	);

	assert.equal(blocked.blocked, false);
	assert.equal(blocked.reason, '');
});
