import { useMemo, useState } from 'react';

function formatSourceLabel(value = '') {
	const normalized = String(value || '').trim();
	if (!normalized) return 'Web';
	return normalized
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' · ');
}

function formatResultType(value = '') {
	const normalized = String(value || '').trim();
	if (!normalized) return 'Source page';
	return normalized
		.split('-')
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}

function toParagraphs(value = '') {
	return String(value || '')
		.split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z])/)
		.map((part) => part.trim())
		.filter(Boolean)
		.slice(0, 4);
}

function normalizeBlockText(value = '') {
	return String(value || '')
		.replace(/\r/g, '\n')
		.replace(/\u00a0/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function createSearchTokens(searchTerm = '') {
	return [
		...new Set(
			String(searchTerm || '')
				.toLowerCase()
				.split(/[^a-z0-9]+/i)
				.map((part) => part.trim())
				.filter((part) => part.length >= 3),
		),
	];
}

function scoreTextRelevance(value = '', searchTokens: any[] = []) {
	const normalized = String(value || '').toLowerCase();
	if (!normalized || !searchTokens.length) return 0;
	return searchTokens.reduce((score, token) => score + (normalized.includes(token) ? 1 : 0), 0);
}

function dedupeImages(images: any[] = []) {
	const seen = new Set();
	return (Array.isArray(images) ? images : []).filter((image) => {
		const src = String(image?.src || '').trim();
		if (!src || seen.has(src)) return false;
		seen.add(src);
		return true;
	});
}

const CORPORATE_ORGANIZATION_RE =
	/\b(?:corporation|corp\.?|company|co\.?|inc\.?|ltd\.?|llc|plc|limited|holdings?|group|firm|solutions|ventures|partners|technologies|systems|global|international|associates|capital|management|industries)\b/i;

function filterOrganizations(values: any[] = []) {
	return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))].filter((value) => !CORPORATE_ORGANIZATION_RE.test(value));
}

const NON_CONTENT_IMAGE_TEXT_RE =
	/\b(?:logo|logomark|icon|favicon|avatar|profile image|homepage|home page|brand|branding|header|navigation|nav|menu|footer|breadcrumb|pager|pagination|subscribe|donate|sponsored|sponsor|advertisement|copyright|privacy policy|contact us|help)\b/i;
const NON_CONTENT_IMAGE_SRC_RE =
	/(?:^data:|\/logo(?:[\-_./]|$)|\/logos?(?:[\-_./]|$)|\/icon(?:s)?(?:[\-_./]|$)|favicon|apple-touch-icon|\/social\/(?:|[^/]+$)|\/share(?:[\-_./]|$)|\/nav(?:igation)?(?:[\-_./]|$)|\/header(?:[\-_./]|$)|\/footer(?:[\-_./]|$)|bibsonomy|arxiv-logo|cornell-reduced|logomark|avatar|sponsor|sponsored|advert(?:isement)?)/i;
const NON_CONTENT_IMAGE_FILENAME_RE = /(?:^|[\s/])[^\s/]+\.(?:jpe?g|png|gif|webp|svg|avif)(?:\?.*)?$/i;

function isNonContentImage(image: any = {}) {
	const src = String(image?.src || '').trim();
	const alt = String(image?.alt || '').trim();
	const title = String(image?.title || '').trim();
	const caption = String(image?.caption || '').trim();
	const metadata = [alt, title, caption].filter(Boolean).join(' ').trim();

	if (!metadata && !src) return true;
	if (metadata && NON_CONTENT_IMAGE_TEXT_RE.test(metadata)) return true;
	if (NON_CONTENT_IMAGE_SRC_RE.test(src)) return true;
	if (NON_CONTENT_IMAGE_FILENAME_RE.test(src) && !caption && !String(image?.alt || image?.title || '').trim()) return true;
	return false;
}

function filterRenderableImages(images: any[] = []) {
	return dedupeImages(images).filter((image) => !isNonContentImage(image));
}

const IMAGE_METADATA_LINE_RE = /^\s*Image\s+(?:alt|title|source):.*$/gim;
const IMAGE_FILENAME_LINE_RE = /^\s*(?:[\w.-]+\.(?:jpe?g|png|gif|webp|svg|avif)|(?:wn|pr|ad|promo|banner|hero|cta)-[\w-]+\.(?:jpe?g|png|gif|webp|svg|avif))(?:\s+.*)?\s*$/gim;
const IMAGE_PROMO_LINE_RE =
	/^\s*.{0,50}\b(?:logo|logomark|banner|hero|promo|promotional|advertisement|ad\s*creative|marketing|campaign|sponsored|cta|call to action|webinar|ebook|whitepaper|download now|learn more)\b.{0,50}$/gim;

function sanitizeDisplayText(value = '') {
	return String(value || '')
		.replace(IMAGE_METADATA_LINE_RE, '')
		.replace(IMAGE_FILENAME_LINE_RE, '')
		.replace(/^\s*.*Image\s+(?:alt|title|source):.*$/gim, '')
		.replace(/^\s*.*(?:wn|pr|ad|promo|banner|hero)-[\w-]+\.(?:jpe?g|png|gif|webp|svg|avif).*$/gim, '')
		.replace(IMAGE_PROMO_LINE_RE, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function escapeRegExp(value = '') {
	return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unescapeHtml(text = '') {
	return String(text || '')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

function normalizeInlineText(value = '') {
	return String(value || '')
		.replace(/\r/g, '\n')
		.replace(/\u00a0/g, ' ')
		.trim();
}

function extractYouTubeVideoIdFromUrl(value = '') {
	const normalized = String(value || '').trim();
	if (!normalized) return '';

	try {
		const url = new URL(normalized);
		const host = url.hostname.toLowerCase();
		if (host === 'youtu.be' || host.endsWith('.youtu.be')) {
			return url.pathname.split('/').filter(Boolean)[0] || '';
		}
		if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
			if (url.pathname === '/watch') {
				return url.searchParams.get('v') || '';
			}
			if (url.pathname.startsWith('/embed/')) {
				return url.pathname.split('/')[2] || '';
			}
			if (url.pathname.startsWith('/shorts/')) {
				return url.pathname.split('/')[2] || '';
			}
		}
	} catch {
		return '';
	}

	return '';
}

function splitTextWithYouTubeEmbeds(text = '') {
	const normalizedText = String(text || '');
	if (!normalizedText.trim()) return [];

	const items: Array<{ type: 'text'; text: string } | { type: 'youtube'; id: string; url: string }> = [];
	const matcher = /https?:\/\/[^\s<>")\]]+/gi;
	let lastIndex = 0;
	let match: RegExpExecArray | null = null;

	while ((match = matcher.exec(normalizedText))) {
		const matchedValue = match[0] || '';
		const startIndex = match.index;
		const videoId = extractYouTubeVideoIdFromUrl(matchedValue);
		if (!videoId) continue;

		if (startIndex > lastIndex) {
			items.push({ type: 'text', text: normalizedText.slice(lastIndex, startIndex) });
		}

		items.push({ type: 'youtube', id: videoId, url: matchedValue });
		lastIndex = startIndex + matchedValue.length;
	}

	if (lastIndex < normalizedText.length) {
		items.push({ type: 'text', text: normalizedText.slice(lastIndex) });
	}

	return items.length ? items : [{ type: 'text', text: normalizedText }];
}

const INLINE_METADATA_LABELS = [
	'Journal reference',
	'ACM classification',
	'MSC classification',
	'Report number',
	'arXiv identifier',
	'Journal Title',
	'Access Type',
	'Subject Codes',
	'Date of Award',
	'Degree Type',
	'Degree Name',
	'primarySubject',
	'articleType',
	'pageType',
	'Event Category',
	'Comments',
	'Abstract',
	'Authors',
	'Author',
	'Submitted',
	'Subjects',
	'Subject',
	'Title',
	'Keywords',
	'Department',
	'Advisor(s)',
	'Published',
	'License',
	'Issue date',
	'Page',
	'ORCID',
	'DOI',
	'type',
];

const INLINE_METADATA_REGEX = new RegExp(
	`(${[...INLINE_METADATA_LABELS]
		.sort((left, right) => right.length - left.length)
		.map((label) => escapeRegExp(label))
		.join('|')}):\\s*`,
	'g',
);

function normalizeMetadataLabel(value = '') {
	return String(value || '')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
}

function getMetadataDisplayMode(label = '') {
	switch (normalizeMetadataLabel(label)) {
		case 'title':
			return 'title';
		case 'authors':
		case 'author':
			return 'authors';
		case 'subjects':
		case 'subject':
			return 'subjects';
		case 'submitted':
			return 'submitted';
		default:
			return 'default';
	}
}

function extractStructuredMetadata(text = '') {
	const normalized = normalizeInlineText(text);
	if (!normalized) return null;

	const matches = [...normalized.matchAll(INLINE_METADATA_REGEX)];
	if (!matches.length) return null;

	const startsWithMetadata = matches[0]?.index === 0;
	const hasMultipleFields = matches.length >= 2;
	const hasPrimaryField = matches.some((match) => ['title', 'authors', 'author', 'subjects', 'subject'].includes(normalizeMetadataLabel(match[1])));

	if (!hasMultipleFields && !(startsWithMetadata && hasPrimaryField)) {
		return null;
	}

	const prefix = normalized.slice(0, matches[0].index).trim();
	const entries = matches
		.map((match, index) => {
			const valueStart = (match.index as any) + match[0].length;
			const valueEnd = index + 1 < matches.length ? matches[index + 1].index : normalized.length;
			return {
				label: match[1],
				value: normalized.slice(valueStart, valueEnd).trim(),
			};
		})
		.filter((entry) => entry.value);

	if (!entries.length) return null;

	return {
		prefix,
		entries,
	};
}

function renderMetadataEntryValue(entry: any = {}) {
	const mode = getMetadataDisplayMode(entry.label);

	if (mode === 'title' || mode === 'subjects') {
		return <strong>{entry.value}</strong>;
	}

	if (mode === 'authors') {
		return <em>{entry.value}</em>;
	}

	return entry.value;
}

function renderMetadataEntries(entries: any[] = [], keyPrefix = '') {
	if (!entries.length) return null;

	return (
		<div
			key={keyPrefix}
			className='scan-card-metadata-list'>
			{entries.map((entry, index) => {
				const mode = getMetadataDisplayMode(entry.label);
				const showLabel = mode !== 'title' && mode !== 'subjects';

				return (
					<div
						key={`${keyPrefix}-entry-${index}`}
						className={`scan-card-metadata-row scan-card-metadata-row-${mode} ${showLabel ? 'scan-card-metadata-row-inline' : ''}`}>
						{showLabel && <span className='scan-card-metadata-label'>{entry.label}:</span>}
						<span className={`scan-card-metadata-value scan-card-metadata-value-${mode}`}>{renderMetadataEntryValue(entry)}</span>
					</div>
				);
			})}
		</div>
	);
}

function renderTextChunk(text = '', keyPrefix = '') {
	const sanitizedText = sanitizeDisplayText(text);
	const structuredMetadata = extractStructuredMetadata(sanitizedText);
	if (!structuredMetadata) {
		return (
			<p
				key={keyPrefix}
				className='scan-card-content-paragraph'>
				{sanitizedText}
			</p>
		);
	}

	const items: any[] = [];

	if (structuredMetadata.prefix) {
		items.push(
			<p
				key={`${keyPrefix}-prefix`}
				className='scan-card-content-paragraph'>
				{structuredMetadata.prefix}
			</p>,
		);
	}

	items.push(renderMetadataEntries(structuredMetadata.entries, `${keyPrefix}-metadata`));
	return items;
}

function extractFigureReferenceVariants(image: any = {}) {
	const rawCandidates = [image.caption, image.alt, image.title].map((value) => String(value || '').trim()).filter(Boolean);
	const variants = [];

	for (const candidate of rawCandidates) {
		variants.push(candidate);

		const figureMatch = candidate.match(/\bfig(?:ure)?\.?\s*(\d+[a-z]?)\b/i);
		if (figureMatch?.[1]) {
			const refId = figureMatch[1];
			variants.push(`Figure ${refId}`);
			variants.push(`Figure ${refId}:`);
			variants.push(`FIG. ${refId}`);
			variants.push(`Fig. ${refId}`);
			variants.push(`Fig ${refId}`);
		}

		const firstSentence = candidate.split(/(?<=[.!?])\s+/)[0]?.trim();
		if (firstSentence && firstSentence !== candidate) {
			variants.push(firstSentence);
		}
	}

	return [...new Set(variants.filter((value) => value && value.length >= 6))];
}

function findInlineImageAnchors(text = '', images: any[] = []) {
	const haystack = normalizeInlineText(text);
	const anchors: any[] = [];
	let searchStart = 0;

	for (const image of dedupeImages(images)) {
		const variants = extractFigureReferenceVariants(image);
		let bestMatch: any = null;

		for (const variant of variants) {
			const pattern = new RegExp(escapeRegExp(variant), 'i');
			const sliced = haystack.slice(searchStart);
			const match = sliced.match(pattern);
			if (!match || typeof match.index !== 'number') continue;

			const absoluteIndex = searchStart + match.index;
			if (!bestMatch || absoluteIndex < bestMatch.index) {
				bestMatch = {
					index: absoluteIndex,
					length: match[0].length,
				};
			}
		}

		if (bestMatch) {
			anchors.push({ image, index: bestMatch.index });
			searchStart = bestMatch.index + Math.max(bestMatch.length, 1);
		} else {
			anchors.push({ image, index: Number.POSITIVE_INFINITY });
		}
	}

	return anchors;
}

function buildInlineFlowItems(block: any = {}) {
	const text = normalizeInlineText(block.text);
	const images = filterRenderableImages(block.images || []);
	if (!text && !images.length) return [];
	if (!images.length) {
		return text ? [{ type: 'text', text }] : [];
	}

	const anchors = findInlineImageAnchors(text, images);
	const orderedAnchors = anchors.filter((anchor) => Number.isFinite(anchor.index)).sort((left, right) => left.index - right.index);
	const trailingAnchors = anchors.filter((anchor) => !Number.isFinite(anchor.index));
	const items: any[] = [];
	let cursor = 0;

	for (const anchor of orderedAnchors) {
		const nextText = text.slice(cursor, anchor.index).trim();
		if (nextText) {
			items.push({ type: 'text', text: nextText });
		}
		items.push({ type: 'image', image: anchor.image });
		cursor = anchor.index;
	}

	const remainingText = text.slice(cursor).trim();
	if (remainingText) {
		items.push({ type: 'text', text: remainingText });
	}

	if (trailingAnchors.length) {
		const unmatchedImages = trailingAnchors.map((anchor) => ({ type: 'image', image: anchor.image }));
		if (!items.length) {
			items.push(...unmatchedImages);
		} else {
			const firstTextIndex = items.findIndex((item) => item.type === 'text' && item.text);
			if (firstTextIndex === -1) {
				items.unshift(...unmatchedImages);
			} else {
				const firstText = items[firstTextIndex].text;
				const paragraphs = String(firstText || '')
					.split(/\n{2,}/)
					.map((paragraph) => paragraph.trim())
					.filter(Boolean);

				if (paragraphs.length > 1) {
					items[firstTextIndex] = { type: 'text', text: paragraphs[0] };
					items.splice(firstTextIndex + 1, 0, ...unmatchedImages, {
						type: 'text',
						text: paragraphs.slice(1).join('\n\n'),
					});
				} else {
					items.splice(firstTextIndex + 1, 0, ...unmatchedImages);
				}
			}
		}
	}

	return items.length ? items : images.map((image) => ({ type: 'image', image }));
}

function renderInlineText(text = '', keyPrefix = '') {
	const segments = splitTextWithYouTubeEmbeds(text);
	const items: any[] = [];

	segments.forEach((segment, segmentIndex) => {
		if (segment.type === 'youtube') {
			const sanitizedId = segment.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
			if (!sanitizedId) return;

			items.push(
				<div
					key={`${keyPrefix}-youtube-${segmentIndex}`}
					className='scan-card-video-embed'>
					<div className='scan-card-video-frame'>
						<iframe
							src={`https://www.youtube.com/embed/${sanitizedId}`}
							title='Embedded YouTube video'
							loading='lazy'
							allow='accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'
							referrerPolicy='strict-origin-when-cross-origin'
							allowFullScreen
						/>
					</div>
					<a
						className='scan-card-video-link'
						href={segment.url}
						target='_blank'
						rel='noopener noreferrer'>
						Open video on YouTube
					</a>
				</div>,
			);
			return;
		}

		String(segment.text || '')
			.split(/\n{2,}/)
			.map((paragraph) => paragraph.trim())
			.filter(Boolean)
			.forEach((paragraph, paragraphIndex) => {
				const rendered = renderTextChunk(paragraph, `${keyPrefix}-paragraph-${segmentIndex}-${paragraphIndex}`);
				if (Array.isArray(rendered)) {
					items.push(...rendered);
				} else if (rendered) {
					items.push(rendered);
				}
			});
	});

	return items;
}

function renderBlockFlow(block: any = {}, keyPrefix = '') {
	const flowItems = buildInlineFlowItems(block);
	if (!flowItems.length) return null;
	let floatedImageCount = 0;

	return (
		<div className='scan-card-content-flow'>
			{flowItems.map((item, index) => {
				if (item.type === 'image') {
					const image = item.image || {};
					const alignmentClass = floatedImageCount % 2 === 0 ? 'scan-card-inline-figure--left' : 'scan-card-inline-figure--right';
					floatedImageCount += 1;
					return (
						<figure
							key={`${keyPrefix}-image-${index}`}
							className={`scan-card-inline-figure ${alignmentClass}`}>
							<img
								className='scan-card-image'
								src={unescapeHtml(image.src)}
								alt={image.alt || image.caption || block.label}
								loading='lazy'
							/>
							{(image.caption || image.originUrl) && <figcaption>{image.caption || image.originUrl}</figcaption>}
						</figure>
					);
				}

				return renderInlineText(item.text, `${keyPrefix}-text-${index}`);
			})}
		</div>
	);
}

function renderContentBlock(block: any = {}, keyPrefix = '') {
	return (
		<section
			key={keyPrefix}
			className='scan-card-content-block'>
			<div className='scan-card-content-header'>
				<h4>{block.label}</h4>
				{block.relevance > 0 && <span className='result-pill result-pill-success'>Relevant</span>}
			</div>
			{renderBlockFlow(block, keyPrefix)}
		</section>
	);
}

function buildBlockImages(result: any = {}, block: any = {}) {
	if (block.label === 'Scanned page content') {
		const figureImages = filterRenderableImages(result.imageContext?.renderableEntries || result.imageContext?.entries || []);
		if (figureImages.length) return figureImages;
		return result.previewImage?.src ? [result.previewImage] : [];
	}

	if (block.label.startsWith('Supporting document')) {
		const doc = block.document;
		const hasDocumentFigures = (doc?.imageContext?.renderableEntries || doc?.imageContext?.entries || []).length > 0;
		return filterRenderableImages([
			...(!hasDocumentFigures && doc?.previewImage?.src ? [doc.previewImage] : []),
			...(doc?.imageContext?.renderableEntries || doc?.imageContext?.entries || []).map((image: any) => ({
				src: image?.src,
				alt: image?.alt || image?.caption || image?.title || 'Supporting document image',
				caption: image?.caption || image?.title || image?.alt || '',
				originUrl: image?.originUrl || doc?.url || '',
			})),
		]);
	}

	return [];
}

function buildCardContent(result: any = {}, searchTerm = '') {
	const searchTokens = createSearchTokens(searchTerm);
	const scannedContentText = normalizeBlockText(result.content || result.contentPreview || result.snippet || '');
	const blocks = [
		scannedContentText || result.previewImage?.src || result.imageContext?.renderableEntries?.length || result.imageContext?.entries?.length ?
			{ label: 'Scanned page content', text: scannedContentText, priority: 5 }
		:	null,
		result.dataLayer?.text ? { label: 'Data layer context', text: result.dataLayer.text, priority: 2 } : null,
		...(Array.isArray(result.supportingDocuments?.documents) ?
			result.supportingDocuments.documents.map((document: any, index: number) => ({
				label: `Supporting document ${index + 1}${document?.url ? ` · ${getHostname(document.url) || document.url}` : ''}`,
				text: document?.text || '',
				document,
				priority: 4,
			}))
		:	[]),
	]
		.filter(Boolean)
		.map((block: any) => ({
			...block,
			text: normalizeBlockText(block.text),
			images: buildBlockImages(result, block),
			relevance: scoreTextRelevance(block.text, searchTokens),
		}))
		.filter((block) => block.text || block.images?.length);

	const sortedBlocks = [...blocks].sort((left: any, right: any) => right.relevance - left.relevance || right.priority - left.priority || right.text.length - left.text.length);

	return {
		blocks: sortedBlocks,
		combined: sortedBlocks
			.map((block) => [block.label, block.text].filter(Boolean).join('\n'))
			.filter(Boolean)
			.join('\n\n'),
	};
}

function getHostname(value = '') {
	try {
		return new URL(value).hostname.replace(/^www\./, '');
	} catch {
		return '';
	}
}

function isRedditCommentOrPostUrl(value = '') {
	const normalized = String(value || '').trim();
	if (!normalized) return false;
	if (/^https?:\/\/(?:www\.)?redd\.it\//i.test(normalized)) return true;
	return /^https?:\/\/(?:[^/]+\.)?reddit\.com\/r\/[^/]+\/comments\//i.test(normalized);
}

function getOriginalLinkLabel(value = '') {
	return isRedditCommentOrPostUrl(value) ? 'Open original Reddit post/comment' : 'Open original source';
}

function getDirectUrlPriority(result: any = {}) {
	return Number(result?.sourceLabel === 'Direct URL' || result?.source === 'source-url');
}

function getDiscoveryOrder(result: any = {}) {
	const latestDiscoveryOrder = Number(result?.latestDiscoveryOrder);
	if (Number.isFinite(latestDiscoveryOrder)) return latestDiscoveryOrder;

	const discoveryOrder = Number(result?.discoveryOrder);
	if (Number.isFinite(discoveryOrder)) return discoveryOrder;

	return -1;
}

function normalizeGroupedResults(result: any = {}) {
	const grouped = Array.isArray(result?.groupedResults) && result.groupedResults.length ? result.groupedResults : [result];
	const seen = new Set();

	return grouped
		.filter((entry) => entry?.url || entry?.title)
		.filter((entry) => {
			const key = entry?.url || `${entry?.source || ''}:${entry?.title || ''}`;
			if (!key || seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort(
			(left: any, right: any) =>
				getDiscoveryOrder(right) - getDiscoveryOrder(left) ||
				getDirectUrlPriority(right) - getDirectUrlPriority(left) ||
				Number(Boolean(right?.crawled)) - Number(Boolean(left?.crawled)) ||
				String(left?.title || '').localeCompare(String(right?.title || '')),
		);
}

function buildGroupedCardContent(result: any = {}, searchTerm = '') {
	const entries = normalizeGroupedResults(result).map((entry, index) => ({
		result: entry,
		entryKey: `${entry.url || entry.title || 'entry'}-${index}`,
		content: buildCardContent(entry, searchTerm),
	}));

	return {
		entries,
		totalEntries: entries.length,
		totalBlocks: entries.reduce((sum, entry) => sum + entry.content.blocks.length, 0),
		visibleEntries: entries.slice(0, Math.min(entries.length, 2)),
	};
}

function ResultsList({
	results,
	loading,
	error,
	searchTerm,
	loadingTitle = 'Scanning sources…',
	loadingDescription = 'Collecting crawled pages and source previews.',
	emptyTitle = 'No crawler results yet',
	emptyDescription = 'Select a tag or start a crawl to populate scanned source cards.',
	resultsSectionKicker = 'Scanned pages',
	resultsSectionTitle = 'Same-domain pages are grouped into one card',
	resultsSectionDescription = 'Cards below combine related pages from the same domain while keeping each scanned page readable inside the group.',
	showResultsCount = true,
}: any) {
	const [revealedCardKeys, setRevealedCardKeys] = useState(() => new Set<string>());
	const [revealedBlockKeys, setRevealedBlockKeys] = useState(() => new Set<string>());
	const safeResults = Array.isArray(results) ? results : [];
	const scannedResults = useMemo(
		() =>
			safeResults
				.filter((result) => result?.resultType !== 'ai-answer' && result?.url)
				.sort(
					(left, right) =>
						getDiscoveryOrder(right) - getDiscoveryOrder(left) ||
						getDirectUrlPriority(right) - getDirectUrlPriority(left) ||
						Number(Boolean(right?.crawled)) - Number(Boolean(left?.crawled)) ||
						String(left?.title || '').localeCompare(String(right?.title || '')),
				),
		[safeResults],
	);
	const cardsWithContent = useMemo(
		() =>
			scannedResults.map((result, index) => {
				const cardKey = `${result.domain || getHostname(result.url) || result.url}-${index}`;
				return {
					result,
					cardKey,
					content: buildGroupedCardContent(result, searchTerm),
				};
			}),
		[scannedResults, searchTerm],
	);

	const toggleCardReveal = (cardKey: string) => {
		setRevealedCardKeys((current) => {
			const next = new Set(current);
			if (next.has(cardKey)) {
				next.delete(cardKey);
			} else {
				next.add(cardKey);
			}
			return next;
		});
	};

	const toggleBlockReveal = (blockKey: string) => {
		setRevealedBlockKeys((current) => {
			const next = new Set(current);
			if (next.has(blockKey)) {
				next.delete(blockKey);
			} else {
				next.add(blockKey);
			}
			return next;
		});
	};

	function renderContentBlockWithReveal(block: any = {}, keyPrefix = '') {
		const isExpanded = revealedBlockKeys.has(keyPrefix);
		return (
			<div
				key={keyPrefix}
				className={`scan-card-block-container ${isExpanded ? 'scan-card-block-expanded' : 'scan-card-block-collapsed'}`}>
				{renderContentBlock(block, keyPrefix)}
				{!isExpanded && <div className='scan-card-block-fade'></div>}
				<button
					type='button'
					className='scan-card-block-toggle'
					onClick={() => toggleBlockReveal(keyPrefix)}>
					{isExpanded ? 'Show less' : 'Reveal more'}
				</button>
			</div>
		);
	}

	function renderGroupedResultSectionInternal(entry: any = {}, keyPrefix = '', options: any = {}) {
		const result = entry.result || {};
		const content = entry.content || { blocks: [] };
		const originalUrl = String(result.url || '').trim();
		const showHeader = options.showHeader !== false;
		const showFooter = options.showFooter !== false;

		return (
			<section
				key={keyPrefix}
				className='scan-card-group-section'>
				{showHeader && (
					<div className='scan-card-group-header'>
						<div>
							<div className='scan-card-badges'>
								<span className='result-pill'>{result.sourceLabel || getHostname(result.url) || formatSourceLabel(result.source)}</span>
								<span className='result-pill'>{formatResultType(result.resultType)}</span>
								<span className={`result-pill ${result.crawled ? 'result-pill-success' : 'result-pill-muted'}`}>{result.crawled ? 'Scanned' : 'Snippet only'}</span>
							</div>
							<h4>
								<a
									className='scan-card-group-title-link'
									href={result.url}
									target='_blank'
									rel='noopener noreferrer'>
									{result.title || result.url || 'Untitled result'}
								</a>
							</h4>
							{result.url && <p className='scan-card-group-url'>{result.url}</p>}
						</div>
					</div>
				)}

				<div className='scan-card-group-body'>
					{content.blocks.length ?
						content.blocks.map((block: any, blockIndex: number) => renderContentBlockWithReveal(block, `${keyPrefix}-block-${blockIndex}`))
					:	<p>No scanned excerpt available for this page.</p>}
				</div>

				{Array.isArray(result.organizations) && result.organizations.length > 0 && (
					<div className='scan-card-organizations'>
						{filterOrganizations(result.organizations).map((organization: any, orgIndex: number) => (
							<span
								key={`${organization}-${orgIndex}`}
								className='organization-pill'>
								{organization}
							</span>
						))}
					</div>
				)}

				{showFooter && originalUrl && (
					<div className='scan-card-footer'>
						<span className='scan-card-url'>{getHostname(originalUrl) || originalUrl}</span>
						<a
							className='scan-card-link'
							href={originalUrl}
							target='_blank'
							rel='noopener noreferrer'>
							{getOriginalLinkLabel(originalUrl)}
						</a>
					</div>
				)}
			</section>
		);
	}

	if (loading) {
		return (
			<div className='results-shell'>
				<section className='results-state-card'>
					<div className='results-state-icon'>⏳</div>
					<div>
						<h3>{loadingTitle}</h3>
						<p>{loadingDescription}</p>
					</div>
				</section>
			</div>
		);
	}

	if (error) {
		return (
			<div className='results-shell'>
				<section className='results-state-card results-state-card-error'>
					<div className='results-state-icon'>⚠</div>
					<div>
						<h3>Search failed</h3>
						<p>{error}</p>
					</div>
				</section>
			</div>
		);
	}

	if (!results || results.length === 0) {
		return (
			<div className='results-shell'>
				<section className='results-state-card'>
					<div className='results-state-icon'>🔎</div>
					<div>
						<h3>{emptyTitle}</h3>
						<p>{emptyDescription}</p>
					</div>
				</section>
			</div>
		);
	}

	return (
		<div className='results-shell'>
			<section className='results-section'>
				<div className='results-section-header'>
					<div>
						{resultsSectionKicker && <p className='results-kicker'>{resultsSectionKicker}</p>}
						<h2>{resultsSectionTitle}</h2>
						{resultsSectionDescription && <p className='results-subtle'>{resultsSectionDescription}</p>}
					</div>
					{showResultsCount && <span className='results-count'>{scannedResults.length}</span>}
				</div>

				<div className='scan-card-grid'>
					{cardsWithContent.map(({ result, cardKey, content }: any) => {
						const isSinglePageCard = content.totalEntries <= 1;
						const isRevealed = isSinglePageCard || revealedCardKeys.has(cardKey);

						return (
							<article
								key={cardKey}
								className='scan-card'>
								<div className='scan-card-header'>
									<div className='scan-card-badges'>
										<span className='result-pill'>{result.domain || getHostname(result.url) || formatSourceLabel(result.source)}</span>
										<span className='result-pill'>
											{content.totalEntries} page{content.totalEntries === 1 ? '' : 's'}
										</span>
										<span className={`result-pill ${result.crawled ? 'result-pill-success' : 'result-pill-muted'}`}>{result.crawled ? 'Scanned' : 'Snippet only'}</span>
									</div>
									<h3>{content.totalEntries > 1 ? `${result.domain || getHostname(result.url) || 'Grouped source'} grouped results` : result.title || 'Untitled result'}</h3>
									{content.totalEntries > 1 && <p className='scan-card-domain-note'>{result.title || 'Related pages from the same source are combined here.'}</p>}
								</div>

								<div className='scan-card-toolbar'>
									<span className='scan-card-content-count'>
										{content.totalBlocks} content block{content.totalBlocks === 1 ? '' : 's'}
									</span>
								</div>

								<div className={`scan-card-body ${isRevealed ? 'scan-card-body-revealed' : 'scan-card-body-collapsed'}`}>
									{content.visibleEntries.length ?
										content.visibleEntries.map((entry: any, entryIndex: number) =>
											renderGroupedResultSectionInternal(entry, `${cardKey}-entry-${entryIndex}`, {
												showHeader: !isSinglePageCard,
												showFooter: !isSinglePageCard,
											}),
										)
									:	<p>No scanned excerpt available for this source.</p>}
									{content.totalEntries > content.visibleEntries.length && (
										<p className='scan-card-hidden-note'>
											{content.totalEntries - content.visibleEntries.length} more page{content.totalEntries - content.visibleEntries.length === 1 ? '' : 's'} available in this
											grouped card.
										</p>
									)}
									{!isSinglePageCard && !isRevealed && (
										<div
											className='scan-card-collapsed-fade'
											aria-hidden='true'></div>
									)}
									{!isSinglePageCard && !isRevealed && (
										<div className='scan-card-reveal-overlay'>
											<button
												type='button'
												className='scan-card-expand-button'
												onClick={() => toggleCardReveal(cardKey)}
												aria-expanded={isRevealed}>
												Reveal more
											</button>
										</div>
									)}
									{!isSinglePageCard && isRevealed && (
										<div className='scan-card-reveal-overlay'>
											<button
												type='button'
												className='scan-card-expand-button'
												onClick={() => toggleCardReveal(cardKey)}
												aria-expanded={isRevealed}>
												Collapse
											</button>
										</div>
									)}
								</div>

								<div className='scan-card-footer'>
									<span className='scan-card-url'>{result.domain || result.url}</span>
									<a
										className='scan-card-link'
										href={result.url}
										target='_blank'
										rel='noopener noreferrer'>
										Open lead page
									</a>
								</div>
							</article>
						);
					})}
				</div>
			</section>
		</div>
	);
}

export default ResultsList;
