/**
 * searchEngines.js
 *
 * Integrates multiple search engines/APIs:
 *  - Google Custom Search JSON API
 *  - Bing Web Search API (Azure)
 *  - Yahoo HTML search fallback
 *
 * All functions return { source, results: [{ title, url, snippet }] }
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer';
import { extractOrganizations } from '../../nlpService.js';
import { parseDocuments } from './documentParser.js';
import { logger } from '../../utils/logger.js';
import { getKnownStates, normalizeStateValue } from '../../utils/locationIndex.js';

const TIMEOUT = Number(process.env.REQUEST_TIMEOUT_MS) || 15000;
const RESULT_CRAWL_LIMIT = Number(process.env.SEARCH_RESULT_CRAWL_LIMIT) || 40;
const SEARCH_RESULT_ENRICH_CONCURRENCY = Math.max(1, Math.min(12, Number(process.env.SEARCH_RESULT_ENRICH_CONCURRENCY) || 4));
const SEARCH_RESULT_PAGE_LIMIT = Math.max(Number(process.env.SEARCH_RESULT_PAGE_LIMIT) || 0, Math.ceil(RESULT_CRAWL_LIMIT / 10), 3);
const SEARCH_QUERY_VARIANT_LIMIT = Number(process.env.SEARCH_QUERY_VARIANT_LIMIT) || 5;
const STATE_QUERY_CHUNK_SIZE = Number(process.env.STATE_QUERY_CHUNK_SIZE) || 13;
const YAHOO_QUERY_VARIANT_LIMIT = Math.max(1, Math.min(4, Number(process.env.YAHOO_QUERY_VARIANT_LIMIT) || 3));
const YAHOO_SEARCH_PAGE_LIMIT = Math.max(1, Math.min(2, Number(process.env.YAHOO_SEARCH_PAGE_LIMIT) || 1));
const SEARCH_ENGINE_BROWSER_AI_TIMEOUT_MS = Number(process.env.SEARCH_ENGINE_BROWSER_AI_TIMEOUT_MS) || 20000;
const SEARCH_ENGINE_BROWSER_AI_WAIT_MS = Number(process.env.SEARCH_ENGINE_BROWSER_AI_WAIT_MS) || 2200;
const SEARCH_ENGINE_BROWSER_AI_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SEARCH_ENGINE_BROWSER_EXECUTABLE_CANDIDATES = [
	process.env.PUPPETEER_EXECUTABLE_PATH,
	process.env.CHROME_PATH,
	process.env.GOOGLE_CHROME_BIN,
	'/usr/bin/google-chrome',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
].filter(Boolean);
const BLOCKED_BROWSER_RESOURCE_TYPES = new Set(['stylesheet', 'script', 'font']);
const BLOCKED_SEARCH_RESULT_HOST_RE = /quantum/i;
const SEARCH_HEADERS = {
	'User-Agent': 'Mozilla/5.0',
	'Accept': 'text/html',
	'Accept-Language': 'en-US,en;q=0.9',
};
const RESEARCH_DOCUMENT_PROFILE = 'research-documents';
const RESEARCH_DOCUMENT_SOURCE_CLAUSE =
	'(site:arxiv.org OR site:sec.gov OR site:gov OR site:github.com OR site:readthedocs.io OR site:nature.com OR site:science.org OR site:docs.rs)';
const RESEARCH_DOCUMENT_KEYWORD_CLAUSE = '(filetype:pdf OR ext:pdf OR paper OR study OR filing OR report OR documentation)';
const RESEARCH_DOCUMENT_FINANCE_SOURCE_CLAUSE = '(site:sec.gov OR site:investor.apple.com OR site:investor.microsoft.com OR site:annualreports.com)';
const RESEARCH_DOCUMENT_SCIENCE_SOURCE_CLAUSE =
	'(site:arxiv.org OR site:pubmed.ncbi.nlm.nih.gov OR site:biorxiv.org OR site:medrxiv.org OR site:nature.com OR site:science.org OR site:nih.gov)';
const RESEARCH_DOCUMENT_POLICY_SOURCE_CLAUSE = '(site:gov OR site:congress.gov OR site:regulations.gov OR site:supremecourt.gov OR site:courtlistener.com)';
const RESEARCH_DOCUMENT_SOFTWARE_SOURCE_CLAUSE = '(site:github.com OR site:readthedocs.io OR site:docs.rs OR site:developer.mozilla.org)';

// ─── Helpers ────────────────────────────────────────────────────────────────

const COMMON_FIRST_NAME_GROUPS = [
	['william', 'bill', 'billy', 'will'],
	['robert', 'rob', 'bob', 'bobby'],
	['james', 'jim', 'jimmy', 'jamie'],
	['john', 'jon', 'jonathan', 'jonathon'],
	['michael', 'micheal', 'mike'],
	['katherine', 'catherine', 'kathryn', 'katie', 'kate', 'kathy'],
	['jennifer', 'jenifer', 'genifer', 'gennifer', 'jenniffer', 'jen', 'jenn', 'jenny', 'jennie', 'jenni'],
];

const ALL_STATE_ABBREVIATIONS = [
	...new Set(
		getKnownStates()
			.map((stateName) => normalizeStateValue(stateName))
			.filter(Boolean),
	),
];
const DEFAULT_NAME_ONLY_STATE_ABBREVIATIONS = ['TX', 'OK', 'NY', 'NM'];

function normalizeToken(value = '') {
	return String(value || '')
		.toLowerCase()
		.replace(/[^a-z]/g, '')
		.trim();
}

function titleCase(value = '') {
	const normalized = String(value || '').trim();
	return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : '';
}

function isNearMiss(candidate = '', target = '') {
	const left = normalizeToken(candidate);
	const right = normalizeToken(target);

	if (!left || !right) return false;
	if (left === right) return true;
	if (left[0] !== right[0]) return false;
	if (Math.abs(left.length - right.length) > 1) return false;

	let mismatches = 0;
	let i = 0;
	let j = 0;

	while (i < left.length && j < right.length) {
		if (left[i] === right[j]) {
			i += 1;
			j += 1;
			continue;
		}

		mismatches += 1;
		if (mismatches > 1) return false;

		if (left.length > right.length) {
			i += 1;
		} else if (right.length > left.length) {
			j += 1;
		} else {
			i += 1;
			j += 1;
		}
	}

	return true;
}

function getNameVariants(name = '', groupedVariants = []) {
	const base = normalizeToken(name);
	if (!base) return [];

	const variants = new Set([base]);

	for (const group of groupedVariants) {
		if (group.includes(base)) {
			group.forEach((entry) => variants.add(entry));
		}
	}

	const collapsed = base.replace(/(.)\1+/g, '$1');
	if (collapsed) variants.add(collapsed);
	if (base.endsWith('y')) variants.add(`${base.slice(0, -1)}ie`);
	if (base.endsWith('ie')) variants.add(`${base.slice(0, -2)}y`);
	if (base.endsWith('y')) variants.add(`${base.slice(0, -1)}ey`);
	if (base.endsWith('ey')) variants.add(`${base.slice(0, -2)}y`);
	if (base.endsWith('ly')) variants.add(`${base.slice(0, -2)}ley`);
	if (base.endsWith('ley')) variants.add(`${base.slice(0, -3)}ly`);
	if (base.includes('ph')) variants.add(base.replace(/ph/g, 'f'));
	if (base.includes('f')) variants.add(base.replace(/f/g, 'ph'));
	if (base.startsWith('j')) variants.add(`g${base.slice(1)}`);
	if (base.startsWith('g')) variants.add(`j${base.slice(1)}`);
	if (base.includes('ck')) variants.add(base.replace(/ck/g, 'k'));
	if (base.includes('k')) variants.add(base.replace(/k/g, 'ck'));

	return [...variants].filter(Boolean).slice(0, 12);
}

function getFirstNameVariants(name = '') {
	return getNameVariants(name, COMMON_FIRST_NAME_GROUPS);
}

function getMiddleNameVariants(name = '') {
	const base = normalizeToken(name);
	if (!base) return [''];

	const variants = new Set(['', base, base.charAt(0), `${base.charAt(0)}.`]);
	getNameVariants(base).forEach((entry) => variants.add(entry));
	return [...variants].slice(0, 8);
}

function getLastNameVariants(name = '') {
	return getNameVariants(name);
}

function getStateSearchTerms(state = '') {
	const normalizedState = normalizeStateValue(state);

	if (normalizedState) {
		return [normalizedState];
	}

	return [...new Set([...DEFAULT_NAME_ONLY_STATE_ABBREVIATIONS, ...ALL_STATE_ABBREVIATIONS])].filter(Boolean);
}

function buildStateOrClauses(state = '') {
	const normalizedState = normalizeStateValue(state);
	const preferredTerms = [];

	if (state && String(state).trim().length > 2) {
		preferredTerms.push(`"${titleCase(state)}"`);
	}
	if (normalizedState) {
		preferredTerms.push(normalizedState);
	}

	const remainingStates = getStateSearchTerms(state).filter((abbr) => abbr !== normalizedState);
	const clauses = [];

	if (preferredTerms.length) {
		clauses.push(`(${[...new Set(preferredTerms)].join(' OR ')})`);
	}

	for (let index = 0; index < remainingStates.length && clauses.length < SEARCH_QUERY_VARIANT_LIMIT; index += STATE_QUERY_CHUNK_SIZE) {
		const chunk = remainingStates.slice(index, index + STATE_QUERY_CHUNK_SIZE);
		if (chunk.length) {
			clauses.push(`(${chunk.join(' OR ')})`);
		}
	}

	if (!clauses.length && remainingStates.length) {
		clauses.push(`(${remainingStates.slice(0, STATE_QUERY_CHUNK_SIZE).join(' OR ')})`);
	}

	return clauses;
}

function buildNameQueries(params) {
	if (!params.firstName && !params.lastName) return [];

	const firstVariants = getFirstNameVariants(params.firstName);
	const middleVariants = getMiddleNameVariants(params.middleName);
	const lastVariants = getLastNameVariants(params.lastName);
	const firstOptions = firstVariants.length ? firstVariants : [params.firstName];
	const lastOptions = lastVariants.length ? lastVariants : [params.lastName];

	const queries = [];

	for (const first of firstOptions) {
		for (const last of lastOptions) {
			const looseFullName = [titleCase(first), titleCase(last)].filter(Boolean).join(' ');
			if (looseFullName) {
				queries.push(`"${looseFullName}"`);
			}

			for (const middle of middleVariants) {
				const fullName = [titleCase(first), titleCase(middle), titleCase(last)].filter(Boolean).join(' ');
				if (fullName) {
					queries.push(`"${fullName}"`);
				}
			}
		}
	}

	return [...new Set(queries.filter(Boolean))].slice(0, 24);
}

function hasAdvancedSearchOperators(value = '') {
	const rawValue = String(value || '').trim();
	if (!rawValue) return false;

	return (
		/["()*]/.test(rawValue) ||
		/(^|\s)\|(?=\s|$)/.test(rawValue) ||
		/(^|[\s(])(?:or|and)(?=[\s)])/i.test(rawValue) ||
		/(^|[\s(])-(?=\S)/.test(rawValue) ||
		/\b(?:site|source|filetype|ext|intitle|allintitle|inurl|allinurl|intext|allintext|before|after|stocks|weather|map|movie|define|cache|related):/i.test(rawValue)
	);
}

function usesResearchDocumentProfile(params = {}) {
	return (
		String(params?.queryProfile || '')
			.trim()
			.toLowerCase() === RESEARCH_DOCUMENT_PROFILE
	);
}

function inferResearchDocumentCategory(searchTerm = '') {
	const normalized = String(searchTerm || '').toLowerCase();
	if (!normalized) return 'general';

	if (
		/$[a-z]{1,5}\b/i.test(searchTerm) ||
		/\b(?:stock|stocks|shares|earnings|10-k|10-q|8-k|ipo|etf|investor|analyst|guidance|dividend|treasury|bond|sec|finance|financial|merger)\b/i.test(normalized)
	) {
		return 'finance';
	}

	if (/\b(?:quantum|physics|holography|lattice|biology|biotech|genomics|chemistry|materials|preprint|journal|clinical|trial|neuroscience|research)\b/i.test(normalized)) {
		return 'science';
	}

	if (/\b(?:policy|law|legal|regulation|regulatory|bill|statute|court|ordinance|deed|land records?|filing|guidance|compliance|zoning|permit|government)\b/i.test(normalized)) {
		return 'policy';
	}

	if (/\b(?:api|sdk|docs?|documentation|typescript|javascript|react|node|rust|python|developer|framework|library|package)\b/i.test(normalized)) {
		return 'software';
	}

	return 'general';
}

function getResearchDocumentCategoryClauses(searchTerm = '') {
	switch (inferResearchDocumentCategory(searchTerm)) {
		case 'finance':
			return {
				sourceClause: RESEARCH_DOCUMENT_FINANCE_SOURCE_CLAUSE,
				keywordClause: '(filetype:pdf OR ext:pdf OR filing OR "10-K" OR "10-Q" OR "8-K" OR "earnings transcript" OR "investor presentation")',
				themeClause: '(filing OR "10-K" OR "10-Q" OR "8-K" OR prospectus OR transcript OR "investor presentation")',
			};
		case 'science':
			return {
				sourceClause: RESEARCH_DOCUMENT_SCIENCE_SOURCE_CLAUSE,
				keywordClause: '(filetype:pdf OR ext:pdf OR paper OR preprint OR journal OR study OR dataset OR supplemental)',
				themeClause: '(paper OR preprint OR journal OR abstract OR supplemental OR dataset)',
			};
		case 'policy':
			return {
				sourceClause: RESEARCH_DOCUMENT_POLICY_SOURCE_CLAUSE,
				keywordClause: '(filetype:pdf OR ext:pdf OR filing OR statute OR rule OR order OR memorandum OR guidance)',
				themeClause: '(statute OR regulation OR rule OR order OR memorandum OR guidance OR filing)',
			};
		case 'software':
			return {
				sourceClause: RESEARCH_DOCUMENT_SOFTWARE_SOURCE_CLAUSE,
				keywordClause: '(filetype:pdf OR ext:pdf OR documentation OR guide OR reference OR specification)',
				themeClause: '(documentation OR guide OR reference OR specification OR repository)',
			};
		default:
			return {
				sourceClause: RESEARCH_DOCUMENT_SOURCE_CLAUSE,
				keywordClause: RESEARCH_DOCUMENT_KEYWORD_CLAUSE,
				themeClause: '(paper OR report OR filing OR documentation OR repository)',
			};
	}
}

function buildResearchDocumentQueries(params = {}, { limit = SEARCH_QUERY_VARIANT_LIMIT } = {}) {
	const genericSearchTerm = String(params.searchTerm || '').trim();
	if (!genericSearchTerm) return [];

	const location = [params.city, params.state].filter(Boolean).join(' ');
	const baseQuery = [genericSearchTerm, location].filter(Boolean).join(' ');
	const quotedBaseQuery = /["()]/.test(genericSearchTerm) ? genericSearchTerm : `"${genericSearchTerm}"`;
	const { sourceClause, keywordClause, themeClause } = getResearchDocumentCategoryClauses(genericSearchTerm);

	return [
		`${quotedBaseQuery} ${keywordClause}`,
		`${quotedBaseQuery} ${sourceClause}`,
		`${baseQuery} filetype:pdf`,
		`${baseQuery} ${themeClause}`,
		`${baseQuery} (site:github.com OR site:readthedocs.io OR site:docs.rs)`,
	]
		.filter(Boolean)
		.slice(0, limit);
}

export function buildSearchEngineQueries(params) {
	const genericSearchTerm = String(params.searchTerm || '').trim();
	if (genericSearchTerm) {
		if (hasAdvancedSearchOperators(genericSearchTerm)) {
			return [genericSearchTerm];
		}

		if (usesResearchDocumentProfile(params)) {
			return buildResearchDocumentQueries(params, { limit: SEARCH_QUERY_VARIANT_LIMIT });
		}

		const location = [params.city, params.state].filter(Boolean).join(' ');

		return [[genericSearchTerm, location].filter(Boolean).join(' '), genericSearchTerm].filter(Boolean).slice(0, SEARCH_QUERY_VARIANT_LIMIT);
	}

	const nameQueries = buildNameQueries(params);
	const stateClauses = buildStateOrClauses(params.state);
	const exactName = [params.firstName, params.middleName, params.lastName].filter(Boolean).join(' ').trim();
	const looseName = [params.firstName, params.lastName].filter(Boolean).join(' ').trim();
	const broadNameClause =
		nameQueries.length ? `(${nameQueries.join(' OR ')})`
		: exactName ? `"${exactName}"`
		: '';
	const cityTerm = params.city ? `"${params.city}"` : '';
	const addressTerm = params.address ? `"${params.address}"` : '';
	const primaryStateClause = stateClauses[0] || '';

	if (!exactName && !looseName && addressTerm) {
		const addressLocationQuery = [addressTerm, cityTerm, primaryStateClause].filter(Boolean).join(' ');

		return [
			[addressLocationQuery, '("previous occupants" OR residents OR "address history")'].filter(Boolean).join(' '),
			// Directory site-specific queries removed
		]
			.filter(Boolean)
			.slice(0, SEARCH_QUERY_VARIANT_LIMIT);
	}
	const directStateQueries =
		!params.city && !params.address ?
			getStateSearchTerms(params.state)
				.slice(0, 4)
				.flatMap((abbr) => [[exactName ? `"${exactName}"` : broadNameClause, abbr].filter(Boolean).join(' '), [looseName ? `"${looseName}"` : '', abbr].filter(Boolean).join(' ')])
		:	[];
	const directorySiteQueries = [];

	const queries = [
		[broadNameClause, addressTerm, cityTerm, primaryStateClause].filter(Boolean).join(' '),
		...directorySiteQueries,
		...directStateQueries,
		[exactName ? `"${exactName}"` : '', cityTerm, primaryStateClause].filter(Boolean).join(' '),
		[looseName ? `"${looseName}"` : '', cityTerm, primaryStateClause].filter(Boolean).join(' '),
	];

	// Add property/land records/deeds PDF search variants
	const propertyPdfVariants = ['(land records pdf)', '(land deeds pdf)', '(property records pdf)', '(property deeds pdf)'];
	for (const variant of propertyPdfVariants) {
		queries.push([broadNameClause, addressTerm, cityTerm, primaryStateClause, variant].filter(Boolean).join(' '));
	}

	for (const clause of stateClauses.slice(1)) {
		queries.push([broadNameClause, addressTerm, cityTerm, clause].filter(Boolean).join(' '));
	}

	if (params.aliases?.length) {
		const aliasStr = params.aliases.map((a) => `"${[a.firstName, a.middleName, a.lastName].filter(Boolean).join(' ')}"`).join(' OR ');
		queries.push([`(${aliasStr})`, cityTerm, primaryStateClause].filter(Boolean).join(' '));
	}

	return [...new Set(queries.filter(Boolean))].slice(0, SEARCH_QUERY_VARIANT_LIMIT);
}

function buildPersonQuery(params) {
	return buildSearchEngineQueries(params)[0] || '';
}

export function buildYahooSearchQueries(params) {
	return buildSearchEngineQueries(params).slice(0, YAHOO_QUERY_VARIANT_LIMIT);
}

function isInternalSearchUrl(url = '') {
	return /(?:google\.|bing\.|yahoo\.)/.test(url) && /\/(?:search|url|imgres|preferences|setprefs|advanced_search|account)/.test(url);
}

export function isBlockedSearchResultUrl(url = '') {
	try {
		return BLOCKED_SEARCH_RESULT_HOST_RE.test(new URL(String(url || '')).hostname);
	} catch {
		return false;
	}
}

function decodeBingTarget(value = '') {
	const raw = String(value || '').trim();
	if (!raw) return '';

	try {
		if (/^a1/i.test(raw)) {
			return Buffer.from(raw.slice(2), 'base64').toString('utf8');
		}
		return Buffer.from(raw, 'base64').toString('utf8');
	} catch {
		return '';
	}
}

function normalizeRedirectUrl(value = '', baseUrl = '') {
	const decoded = decodeHtml(value);
	const absolute =
		decoded.startsWith('//') ? `https:${decoded}`
		: decoded.startsWith('/') && baseUrl ? new URL(decoded, baseUrl).toString()
		: decoded;

	try {
		const url = new URL(absolute);
		const yahooRedirectTarget = url.hostname.endsWith('search.yahoo.com') || url.hostname.endsWith('r.search.yahoo.com') ? url.pathname.match(/\/RU=([^/]+)\//i)?.[1] || '' : '';
		const redirectTarget = yahooRedirectTarget || url.searchParams.get('q') || url.searchParams.get('uddg') || decodeBingTarget(url.searchParams.get('u'));
		const finalUrl = redirectTarget ? decodeURIComponent(redirectTarget) : absolute;
		return /^https?:/i.test(finalUrl) ? finalUrl : '';
	} catch {
		return /^https?:/i.test(absolute) ? absolute : '';
	}
}

function textHasApproximateToken(text = '', wantedValues = []) {
	const tokens = String(text || '')
		.split(/[^a-z]+/i)
		.map((value) => normalizeToken(value))
		.filter(Boolean);

	return wantedValues
		.filter(Boolean)
		.map((value) => normalizeToken(value))
		.some((wanted) => tokens.some((token) => token === wanted || token.includes(wanted) || isNearMiss(token, wanted)));
}

function resultMentionsPerson(result, params) {
	const haystack = String([result.title, result.snippet, result.url].filter(Boolean).join(' ')).toLowerCase();

	const firstVariants = [params.firstName, ...getFirstNameVariants(params.firstName)].filter(Boolean);
	const lastName = String(params.lastName || '');
	const city = String(params.city || '').toLowerCase();
	const state = String(params.state || '').toLowerCase();

	const hasFirst = !firstVariants.length || textHasApproximateToken(haystack, firstVariants);
	const hasLast = !lastName || textHasApproximateToken(haystack, [lastName]);
	const hasLocation = (!city && !state) || haystack.includes(city) || haystack.includes(state);

	return hasFirst && hasLast && hasLocation;
}

function filterSearchResultsByPerson(results, params) {
	const filtered = results.filter((result) => resultMentionsPerson(result, params));
	return filtered.length ? filtered : results;
}

function normalizeExtractedAiText(value = '') {
	let normalized = String(value || '')
		.replace(/\s+/g, ' ')
		.replace(/\s*([:;,.!?])\s*/g, '$1 ')
		.trim();

	if (!normalized) return '';

	normalized = normalized
		.replace(/^AI\s+Overview\s*/i, '')
		.replace(/\bShow\s+more\s*$/i, '')
		.replace(/\bShow\s+all\s*$/i, '')
		.replace(/\s{2,}/g, ' ')
		.trim();

	return normalized;
}

function normalizeBingAiText(value = '') {
	return String(value || '')
		.replace(/\s+/g, ' ')
		.replace(/^\s*Like\s+Dislike\s*/i, '')
		.replace(/\b(Read all|See all)\s*$/i, '')
		.trim();
}

/**
 * Strip AI Overview boilerplate, multi-source suffixes, and Google's safety
 * disclaimer footer that sometimes bleed into regular SERP result snippets.
 */
export function sanitizeSearchSnippet(value = '') {
	let text = String(value || '')
		.replace(/\s+/g, ' ')
		.trim();

	if (!text) return '';

	// Strip the Google AI disclaimer that sometimes appears at the end
	text = text
		.replace(/\s*AI can make mistakes[^]*$/i, '')
		.replace(/\s*Generative AI is experimental[^]*$/i, '')
		.trim();

	// Strip inline AI Overview / Show all / Show more labels
	text = text
		.replace(/^AI\s+Overview\s*/i, '')
		.replace(/\bShow\s+(?:more|all)\s*$/i, '')
		.trim();

	// Strip trailing source-label suffixes that the AI overview appends
	// e.g. "… APS Journals arXiv SURFACE at Syracuse University"
	text = text
		.replace(
			/\s*(?:APS\s+Journals|arXiv|Harvard\s+University|SURFACE\s+at\s+Syracuse\s+University|Reddit(?:\s*·[^\n]*)?|YouTube(?:\s*·[^\n]*)?|UBC\s+Library\s+Open\s+Collections|Frontiers(?:\s+in\s+Physics)?|IEEE\s+Xplore|ResearchGate|Springer|Nature(?:\s+Journals)?|Science\s+Direct|PubMed|Oxford\s+University\s+Press|Cambridge\s+University\s+Press)\s*$/i,
			'',
		)
		.trim();

	// If the snippet still looks like a stitched AI multi-source summary
	// (contains bracketed arXiv IDs like [2312.10544] or [2312. 10544] or multi-source labels inline)
	// truncate to just the first sentence/clause that doesn't contain those patterns.
	if (/\[\d{4}\.\s*\d{4,}\]/.test(text) || /\b(?:Submission history|From:\s+\w+\s+\w+\s+\[view email\])/.test(text)) {
		const firstClause = text.split(/(?:\.\s{2,}|\.{2,}|\[\d{4}\.\s*\d{4,}\]|Submission history)/)[0];
		text = firstClause.replace(/[.…]+$/, '').trim();
	}

	return text;
}

function isGooglePolicyUrl(value = '') {
	return /https?:\/\/(?:policies|support)\.google\.com\//i.test(String(value || ''));
}

function cleanGoogleAiCitationValue(value = '') {
	return String(value || '')
		.replace(/\s+/g, ' ')
		.replace(/\s*Opens in new tab\.?$/i, '')
		.replace(/\s*URL:\s*https?:\/\/\S+\.?$/i, '')
		.trim();
}

function buildGoogleAiSupportingSnippet(parentText = '', title = '') {
	const normalizedParent = cleanGoogleAiCitationValue(parentText);
	if (!normalizedParent) return '';

	let snippet = normalizedParent;
	if (title) {
		snippet = snippet.replace(new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '').trim();
	}

	snippet = snippet
		.replace(/\s*(?:APS Journals|arXiv|Harvard University|SURFACE at Syracuse University|Reddit(?:·[^\s].*)?|YouTube(?:·[^\s].*)?|UBC Library Open Collections)\s*$/i, '')
		.trim();
	return snippet;
}

export function buildGoogleAiSupportingArticleResults(cards = [], seenUrls = new Set()) {
	const results = [];

	for (const card of Array.isArray(cards) ? cards : []) {
		const url = normalizeRedirectUrl(card?.url || card?.href || '', 'https://www.google.com');
		if (!url || seenUrls.has(url) || isInternalSearchUrl(url) || isGooglePolicyUrl(url)) {
			continue;
		}

		const title =
			cleanGoogleAiCitationValue(card?.title || '') ||
			cleanGoogleAiCitationValue(card?.ariaLabel || '')
				.replace(/\.\s*Opens in new tab\.?$/i, '')
				.trim() ||
			cleanGoogleAiCitationValue(card?.parentText || '')
				.split(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b|—/)[0]
				.trim() ||
			new URL(url).hostname.replace(/^www\./i, '');
		const snippet = buildGoogleAiSupportingSnippet(card?.parentText || '', title);
		const sourceLabel = cleanGoogleAiCitationValue(card?.sourceLabel || '') || new URL(url).hostname.replace(/^www\./i, '');

		seenUrls.add(url);
		results.push({
			title: title || url,
			url,
			snippet,
			resultType: 'ai-supporting-article',
			forceCrawl: true,
			fromGoogleAiSupportingArticle: true,
			sourceLabel,
		});
	}

	return results;
}

export function buildGoogleAiCitationResults(citations = [], seenUrls = new Set()) {
	const results = [];

	for (const citation of Array.isArray(citations) ? citations : []) {
		const url = normalizeRedirectUrl(citation?.url || citation?.href || '', 'https://www.google.com');
		if (!url || seenUrls.has(url) || isInternalSearchUrl(url) || isGooglePolicyUrl(url)) {
			continue;
		}

		const ariaLabel = cleanGoogleAiCitationValue(citation?.ariaLabel || '');
		const text = cleanGoogleAiCitationValue(citation?.text || '');
		const parentText = cleanGoogleAiCitationValue(citation?.parentText || '');
		const title =
			text ||
			ariaLabel.split(/\.\s+URL:|\s+-\s+View related links|\.\s+Opens in new tab/i)[0].trim() ||
			parentText.split(/\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b|\s+—\s+/)[0].trim() ||
			new URL(url).hostname.replace(/^www\./i, '');
		const snippet =
			parentText && parentText !== title ? parentText
			: ariaLabel && ariaLabel !== title ? ariaLabel
			: '';

		seenUrls.add(url);
		results.push({
			title: title || url,
			url,
			snippet,
			resultType: 'ai-citation',
			hiddenFromUi: true,
			forceCrawl: true,
			fromGoogleAiCitation: true,
		});
	}

	return results;
}

function looksLikeStylesheetText(value = '') {
	const normalized = String(value || '').trim();
	if (!normalized) return false;
	const head = normalized.slice(0, 240);
	return /^[.#@]/.test(head) && /[{}]/.test(head);
}

function resolveSearchEngineBrowserExecutablePath() {
	return (
		SEARCH_ENGINE_BROWSER_EXECUTABLE_CANDIDATES.find((candidate) => {
			try {
				return candidate && existsSync(candidate);
			} catch {
				return false;
			}
		}) || null
	);
}

async function blockBrowserAssetRequests(page) {
	await page.setRequestInterception(true);
	page.on('request', (request) => {
		if (BLOCKED_BROWSER_RESOURCE_TYPES.has(request.resourceType())) {
			request.abort();
			return;
		}
		request.continue();
	});
}

function scoreGoogleAiCandidate(text = '') {
	const value = String(text || '');
	if (!value) return 0;

	let score = 0;
	if (/AI\s+Overview/i.test(value)) score += 10;
	if (/\bquantum\b|\bholographic\b|\blattice\b/i.test(value)) score += 2;
	if (/\bcore concepts\b|\bapplications\b|\bkey findings\b/i.test(value)) score += 3;
	if (/\bShow\s+all\b/i.test(value)) score += 2;
	if (/\b[A-Z][a-z]+\s+Journals\b|arXiv|Phys\.\s+Rev\./i.test(value)) score += 2;
	if (value.length > 250) score += 2;
	if (value.length > 600) score += 2;

	return score;
}

/**
 * Extract Google's AI Overview / featured snippet / knowledge panel text.
 * Tries several CSS selectors in priority order; returns the first non-empty hit.
 * Selectors are best-effort — Google's HTML changes frequently.
 */
function extractGoogleAiResponse($) {
	const processedCandidates = [];

	$('div[data-processed="true"]').each((_, element) => {
		try {
			const root = $(element);
			const text = normalizeExtractedAiText(root.text());
			if (!text || text.length < 80) return;

			const headingText = normalizeExtractedAiText(root.find('[role="heading"], h1, h2, h3').first().text());
			const combined = headingText && !text.startsWith(headingText) ? `${headingText} ${text}` : text;
			processedCandidates.push({
				text: combined,
				score: scoreGoogleAiCandidate(combined),
			});
		} catch {
			// ignore selector errors
		}
	});

	const bestProcessedCandidate = processedCandidates.sort((left, right) => right.score - left.score || right.text.length - left.text.length).find((entry) => entry.score >= 4);

	if (bestProcessedCandidate?.text) {
		return normalizeExtractedAiText(bestProcessedCandidate.text);
	}

	const candidates = [
		// AI Overview block (2024-2025)
		'#m-x-content',
		'#kAp9Ze',
		"div[jsname='yEVEwb']",
		'div[data-processed="true"]',
		'div[data-processed="true"] [data-attrid]',
		// Featured snippet
		'div.xpdbox .LGOjhe',
		'div.c2xzTb',
		// Knowledge panel description
		'div.kno-rdesc span',
		"[data-attrid='wa:/description'] span",
		// Fallback: first answer block
		'div.wDYxhc',
	];

	for (const sel of candidates) {
		try {
			const text = normalizeExtractedAiText($(sel).first().text());
			if (text && text.length > 40) return text;
		} catch {
			// ignore selector errors
		}
	}
	return null;
}

export function extractGoogleAiResponseFromHtml(html = '') {
	return extractGoogleAiResponse(cheerio.load(String(html || '')));
}

async function googleHtmlSearch(params) {
	const queries = buildSearchEngineQueries(params);
	const parsed = [];
	const seenUrls = new Set();
	let pagesScanned = 0;
	let aiResponse = null;
	let aiSupportingArticleResults = [];
	let aiCitationResults = [];

	try {
		for (const query of queries) {
			for (let pageIndex = 0; pageIndex < SEARCH_RESULT_PAGE_LIMIT; pageIndex += 1) {
				const { data } = await axios.get('https://www.google.com/search', {
					params: {
						q: query,
						num: 10,
						newwindow: 1,
						ie: 'UTF-8',
						hl: 'en',
						start: pageIndex * 10,
					},
					timeout: TIMEOUT,
					headers: {
						...SEARCH_HEADERS,
						Referer: 'https://www.google.com/',
					},
				});

				const $ = cheerio.load(String(data || ''));

				// Capture AI response only from the first page of the first query
				if (!aiResponse && pageIndex === 0) {
					aiResponse = extractGoogleAiResponse($);
				}

				let pageResults = 0;

				$("a[href^='/url?q=']").each((_, element) => {
					const anchor = $(element);
					const titleNode = anchor.find('h3').first();
					const title = stripHtml(titleNode.text());
					const url = normalizeRedirectUrl(anchor.attr('href') || '', 'https://www.google.com');
					const snippet = sanitizeSearchSnippet(stripHtml(anchor.closest('div').parent().find('.VwiC3b, .yXK7lf, .MUxGbd').first().text()));

					if (!title || !url || seenUrls.has(url) || isInternalSearchUrl(url)) {
						return;
					}

					seenUrls.add(url);
					pageResults += 1;
					parsed.push({ title, url, snippet, resultPage: pageIndex + 1 });
				});

				if (!pageResults) break;
				pagesScanned += 1;
				if (parsed.length >= RESULT_CRAWL_LIMIT) break;
			}

			if (parsed.length >= RESULT_CRAWL_LIMIT) break;
		}
	} catch (err) {
		logger.error('Google HTML fallback error', { error: err.message });
	}

	const browserOverview = await fetchBrowserRenderedSearchAi('google', queries[0] || buildPersonQuery(params), { includeOverview: true });
	if (browserOverview?.aiText) {
		aiResponse = browserOverview.aiText;
	}
	if (Array.isArray(browserOverview?.supportingArticleResults) && browserOverview.supportingArticleResults.length) {
		aiSupportingArticleResults = browserOverview.supportingArticleResults;
	}
	if (Array.isArray(browserOverview?.citationResults) && browserOverview.citationResults.length) {
		aiCitationResults = browserOverview.citationResults;
	}

	parsed.push(...aiSupportingArticleResults);

	const filteredResults = filterSearchResultsByPerson(parsed, params);
	const enrichedResults = await enrichResultsWithPageContent(filteredResults);
	logger.debug('Google HTML fallback results', {
		count: enrichedResults.length,
		pagesScanned,
	});
	return { results: enrichedResults, aiResponse, citationResults: aiCitationResults };
}

async function bingHtmlSearch(params) {
	const queries = buildSearchEngineQueries(params);
	const parsed = [];
	const seenUrls = new Set();
	let pagesScanned = 0;
	let aiResponse = null;

	try {
		for (const query of queries) {
			for (let pageIndex = 0; pageIndex < SEARCH_RESULT_PAGE_LIMIT; pageIndex += 1) {
				const { data } = await axios.get('https://www.bing.com/search', {
					params: {
						q: query,
						count: 10,
						first: pageIndex * 10 + 1,
						setlang: 'en-US',
					},
					timeout: TIMEOUT,
					headers: {
						...SEARCH_HEADERS,
						Referer: 'https://www.bing.com/',
					},
				});

				const $ = cheerio.load(String(data || ''));

				// Capture AI / Copilot response only from the first page of the first query
				if (!aiResponse && pageIndex === 0) {
					aiResponse = extractBingAiResponse($);
				}

				let pageResults = 0;

				$('li.b_algo').each((_, element) => {
					const anchor = $(element).find('h2 a').first();
					const title = stripHtml(anchor.text());
					const url = normalizeRedirectUrl(anchor.attr('href') || '');
					const snippet = sanitizeSearchSnippet(stripHtml($(element).find('.b_caption p, .b_snippet').first().text()));

					if (!title || !url || seenUrls.has(url) || isInternalSearchUrl(url)) {
						return;
					}

					seenUrls.add(url);
					pageResults += 1;
					parsed.push({ title, url, snippet, resultPage: pageIndex + 1 });
				});

				if (!pageResults) break;
				pagesScanned += 1;
				if (parsed.length >= RESULT_CRAWL_LIMIT) break;
			}

			if (parsed.length >= RESULT_CRAWL_LIMIT) break;
		}
	} catch (err) {
		logger.error('Bing HTML fallback error', { error: err.message });
	}

	if (!aiResponse) {
		aiResponse = await fetchBrowserRenderedSearchAi('bing', queries[0] || buildPersonQuery(params));
	}

	const filteredResults = filterSearchResultsByPerson(parsed, params);
	const enrichedResults = await enrichResultsWithPageContent(filteredResults);
	logger.debug('Bing HTML fallback results', {
		count: enrichedResults.length,
		pagesScanned,
	});
	return { results: enrichedResults, aiResponse };
}

function extractYahooSearchResultsFromHtml(html = '', resultPage = 1, seenUrls = new Set()) {
	const parsed = [];
	const $ = cheerio.load(String(html || ''));

	for (const selector of ['#web .algo', '#results .algo', 'ol.searchCenterMiddle > li', '.searchCenterMiddle li']) {
		$(selector).each((_, element) => {
			const root = $(element);
			const anchor = root
				.find('h3.title a, h3 a, a')
				.filter((__, el) => stripHtml($(el).text()).length > 2)
				.first();
			const title = stripHtml(anchor.text());
			const url = normalizeRedirectUrl(anchor.attr('href') || '', 'https://search.yahoo.com');
			const snippet = sanitizeSearchSnippet(stripHtml(root.find('.compText p, .compText, p').first().text()));

			if (!title || !url || seenUrls.has(url) || isInternalSearchUrl(url)) {
				return;
			}

			seenUrls.add(url);
			parsed.push({ title, url, snippet, resultPage });
		});

		if (parsed.length) {
			break;
		}
	}

	return parsed;
}

export function extractYahooSearchResultsFromHtmlString(html = '') {
	return extractYahooSearchResultsFromHtml(html, 1, new Set());
}

async function yahooHtmlSearch(params) {
	const queries = buildYahooSearchQueries(params);
	const parsed = [];
	const seenUrls = new Set();
	let pagesScanned = 0;

	try {
		for (const query of queries) {
			for (let pageIndex = 0; pageIndex < YAHOO_SEARCH_PAGE_LIMIT; pageIndex += 1) {
				const { data } = await axios.get('https://search.yahoo.com/search', {
					params: {
						p: query,
						b: pageIndex * 10 + 1,
						n: 10,
						pz: 10,
						vl: 'lang_en-US',
					},
					timeout: TIMEOUT,
					headers: {
						...SEARCH_HEADERS,
						Referer: 'https://search.yahoo.com/',
					},
				});

				const pageResults = extractYahooSearchResultsFromHtml(data, pageIndex + 1, seenUrls);
				parsed.push(...pageResults);

				if (!pageResults.length) break;
				pagesScanned += 1;
				if (parsed.length >= RESULT_CRAWL_LIMIT) break;
			}

			if (parsed.length >= RESULT_CRAWL_LIMIT) break;
		}
	} catch (err) {
		logger.error('Yahoo HTML fallback error', { error: err.message, queriesAttempted: queries.length });
	}

	if (!parsed.length) {
		const browserResults = await fetchBrowserRenderedYahooSearchResults(queries[0] || buildPersonQuery(params));
		parsed.push(...browserResults);
	}

	const filteredResults = filterSearchResultsByPerson(parsed, params);
	const enrichedResults = await enrichResultsWithPageContent(filteredResults);
	logger.debug('Yahoo HTML fallback results', {
		count: enrichedResults.length,
		pagesScanned,
	});
	return { results: enrichedResults };
}

async function fetchBrowserRenderedYahooSearchResults(query = '') {
	const normalizedQuery = String(query || '').trim();
	if (!normalizedQuery) return [];

	let browser;

	try {
		const executablePath = resolveSearchEngineBrowserExecutablePath();
		browser = await puppeteer.launch({
			headless: true,
			executablePath: executablePath || undefined,
			args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
		});

		const page = await browser.newPage();
		await blockBrowserAssetRequests(page);
		await page.setUserAgent(SEARCH_ENGINE_BROWSER_AI_USER_AGENT);
		await page.setExtraHTTPHeaders({
			'Accept-Language': SEARCH_HEADERS['Accept-Language'],
			'Accept': SEARCH_HEADERS.Accept,
			'Referer': 'https://search.yahoo.com/',
		});

		await page.goto(`https://search.yahoo.com/search?p=${encodeURIComponent(normalizedQuery)}&vl=lang_en-US`, {
			waitUntil: 'domcontentloaded',
			timeout: SEARCH_ENGINE_BROWSER_AI_TIMEOUT_MS,
		});

		await page.waitForSelector('#web, #results, .searchCenterMiddle, .algo', { timeout: 7000 }).catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, SEARCH_ENGINE_BROWSER_AI_WAIT_MS));

		const html = await page.content();
		const results = extractYahooSearchResultsFromHtml(html, 1, new Set());
		if (results.length) {
			logger.debug('Browser-rendered Yahoo search fallback results', { query: normalizedQuery, count: results.length });
		}
		return results;
	} catch (error) {
		logger.debug('Browser-rendered Yahoo search fetch skipped', {
			error: error.message,
		});
		return [];
	} finally {
		if (browser) {
			await browser.close().catch(() => {});
		}
	}
}

/**
 * Extract Bing's Copilot / AI response / featured snippet.
 * Tries several selectors in priority order; returns the first non-empty hit.
 */
function extractBingAiResponse($) {
	const candidates = [
		// Copilot / Sydney response at page top
		'#b_sydtop',
		// Rich answer cards sometimes store the useful text on the entire block
		'li.b_ans.b_top',
		'li.b_ans',
		// Answer boxes
		'li.b_ans.b_top .b_no',
		'li.b_ans:first-of-type .b_no',
		// "What is" style knowledge card
		'.b_wc .b_ptxt',
		// Generic answer caption
		'li.b_ans .b_caption',
		// Sidebar entity description
		'.b_subModule .b_subTxt',
	];

	for (const sel of candidates) {
		try {
			const text = normalizeBingAiText($(sel).first().text());
			if (text && text.length > 40) return text;
		} catch {
			// ignore selector errors
		}
	}
	return null;
}

export function extractBingAiResponseFromHtml(html = '') {
	return extractBingAiResponse(cheerio.load(String(html || '')));
}

export function buildGoogleSearchResult({ htmlResults = [], htmlAiResponse = null, fallbackResults = [] } = {}) {
	const normalizedHtmlResults = Array.isArray(htmlResults) ? htmlResults : [];
	const normalizedFallbackResults = Array.isArray(fallbackResults) ? fallbackResults : [];
	const primaryVisibleHtmlResults = normalizedHtmlResults.filter((result) => !result?.hiddenFromUi && result?.resultType !== 'ai-supporting-article');
	const secondaryVisibleHtmlResults = normalizedHtmlResults.filter((result) => !result?.hiddenFromUi && result?.resultType === 'ai-supporting-article');
	const hiddenHtmlResults = normalizedHtmlResults.filter((result) => result?.hiddenFromUi);
	const result = {
		source: 'google',
		results: primaryVisibleHtmlResults.length ? normalizedHtmlResults : [...normalizedFallbackResults, ...secondaryVisibleHtmlResults, ...hiddenHtmlResults],
	};

	if (htmlAiResponse) {
		result.aiResponse = htmlAiResponse;
	}

	return result;
}

function hasVisibleSearchResults(results = []) {
	return Array.isArray(results) && results.some((result) => result?.url && !result?.hiddenFromUi && result?.resultType !== 'ai-supporting-article');
}

async function expandGoogleAiOverview(page) {
	if (!page) return;

	const selectors = ["div[jsname='rPRdsc'][role='button']", "[aria-label='Show more AI Overview']", "[aria-controls='m-x-content'][role='button']"];

	for (const selector of selectors) {
		const handles = await page.$$(selector);
		for (const handle of handles) {
			const isCollapsed = await handle.evaluate((element) => element.getAttribute('aria-expanded') !== 'true').catch(() => false);

			if (!isCollapsed) continue;

			await handle
				.evaluate((element) => {
					if (element instanceof HTMLElement) {
						element.scrollIntoView({ block: 'center', inline: 'nearest' });
					}
				})
				.catch(() => {});

			await handle.click({ delay: 40 }).catch(async () => {
				await handle
					.evaluate((element) => {
						if (!(element instanceof HTMLElement)) return;
						element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
						element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
						element.click();
						element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
					})
					.catch(() => {});
			});

			await page
				.waitForFunction(
					() => {
						const control = document.querySelector("div[jsname='rPRdsc'], [aria-controls='m-x-content']");
						const content = document.querySelector('#m-x-content');
						const expanded = control?.getAttribute('aria-expanded') === 'true';
						const visibleText = String(content instanceof HTMLElement ? content.innerText : content?.textContent || '')
							.replace(/\s+/g, ' ')
							.trim();
						return expanded || visibleText.length > 2600;
					},
					{ timeout: 3500 },
				)
				.catch(() => {});

			await new Promise((resolve) => setTimeout(resolve, 600));
			return;
		}
	}
}

async function fetchBrowserRenderedSearchAi(source = '', query = '', options = {}) {
	const normalizedSource = String(source || '')
		.trim()
		.toLowerCase();
	const normalizedQuery = String(query || '').trim();

	if (!normalizedQuery || !['google', 'bing'].includes(normalizedSource)) {
		return null;
	}

	let browser;

	try {
		const executablePath = resolveSearchEngineBrowserExecutablePath();
		browser = await puppeteer.launch({
			headless: true,
			executablePath: executablePath || undefined,
			args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
		});

		const page = await browser.newPage();
		await blockBrowserAssetRequests(page);
		await page.setUserAgent(SEARCH_ENGINE_BROWSER_AI_USER_AGENT);
		await page.setExtraHTTPHeaders({
			'Accept-Language': SEARCH_HEADERS['Accept-Language'],
			'Accept': SEARCH_HEADERS.Accept,
			'Referer': normalizedSource === 'google' ? 'https://www.google.com/' : 'https://www.bing.com/',
		});
		await page.evaluateOnNewDocument(() => {
			Object.defineProperty(navigator, 'webdriver', { get: () => false });
		});

		const searchUrl =
			normalizedSource === 'google' ?
				`https://www.google.com/search?q=${encodeURIComponent(normalizedQuery)}&num=10&newwindow=1&ie=UTF-8&hl=en`
			:	`https://www.bing.com/search?q=${encodeURIComponent(normalizedQuery)}&setlang=en-US`;

		await page.goto(searchUrl, {
			waitUntil: 'domcontentloaded',
			timeout: SEARCH_ENGINE_BROWSER_AI_TIMEOUT_MS,
		});

		await page
			.waitForSelector(normalizedSource === 'google' ? 'body, #search, div[data-processed="true"], #kAp9Ze' : 'body, #b_results, #b_sydtop, li.b_ans', { timeout: 7000 })
			.catch(() => {});

		await new Promise((resolve) => setTimeout(resolve, SEARCH_ENGINE_BROWSER_AI_WAIT_MS));
		if (normalizedSource === 'google') {
			await expandGoogleAiOverview(page);
		}
		await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
		await page.waitForNetworkIdle({ idleTime: 700, timeout: 5000 }).catch(() => {});

		const renderedData = await page.evaluate((activeSource) => {
			const clean = (value = '') =>
				String(value || '')
					.replace(/\s+/g, ' ')
					.trim();
			if (activeSource === 'google') {
				const content = document.querySelector('#m-x-content');
				const selectors = [
					'#m-x-content',
					'div[data-processed="true"]',
					'#kAp9Ze',
					"div[jsname='yEVEwb']",
					"[aria-controls='m-x-content']",
					'div.xpdbox .LGOjhe',
					'div.c2xzTb',
					'div.kno-rdesc span',
					"[data-attrid='wa:/description'] span",
					'div.wDYxhc',
				];
				const candidateTexts = [];

				if (content instanceof HTMLElement) {
					const rhsColumn = content.querySelector('[data-container-id="rhs-col"]') || document.querySelector('[data-container-id="rhs-col"]');
					const blocks = Array.from(content.querySelectorAll('div, section, article'))
						.map((element) => {
							const text = clean(element instanceof HTMLElement ? element.innerText : element.textContent || '');
							const linkCount = element.querySelectorAll('a[href]').length;
							if (!text || text.length < 250) return null;
							let score = text.length - linkCount * 120;
							if (/privacy policy/i.test(text)) score -= 1200;
							if (linkCount > 10) score -= 800;
							if (linkCount >= 1 && linkCount <= 8) score += 220;
							if (/key aspects|applications|conclusion|researchers use/i.test(text)) score += 160;
							return { html: element.outerHTML || '', score };
						})
						.filter(Boolean)
						.sort((left, right) => right.score - left.score);

					if (blocks[0]?.html) {
						const wrapper = document.createElement('div');
						wrapper.innerHTML = blocks[0].html;
						wrapper.querySelectorAll('a[href], button, [role="button"]').forEach((element) => {
							const text = clean(element instanceof HTMLElement ? element.innerText : element.textContent || '');
							const parentText = clean(element.parentElement instanceof HTMLElement ? element.parentElement.innerText : element.parentElement?.textContent || '');
							const ariaLabel = clean(element.getAttribute?.('aria-label') || '');
							const href = clean(element.getAttribute?.('href') || '');
							if (
								!text ||
								/\+\d+/.test(parentText) ||
								/view related links|opens in new tab|privacy policy/i.test(`${ariaLabel} ${parentText}`) ||
								/policies\.google\.com/i.test(href)
							) {
								element.remove();
							}
						});
						candidateTexts.push(clean(wrapper.innerText || wrapper.textContent || ''));
					}

					const supportingCards =
						rhsColumn instanceof HTMLElement ?
							Array.from(rhsColumn.querySelectorAll('div.MFrAxb.BKnikc a.NDNGvf[href]'))
								.map((anchor) => ({
									url: anchor.href || anchor.getAttribute('href') || '',
									ariaLabel: clean(anchor.getAttribute('aria-label') || ''),
									parentText: clean(anchor.parentElement instanceof HTMLElement ? anchor.parentElement.innerText : anchor.parentElement?.textContent || ''),
									title: clean(anchor.getAttribute('aria-label') || '')
										.replace(/\.\s*Opens in new tab\.?$/i, '')
										.trim(),
									sourceLabel:
										clean(anchor.parentElement instanceof HTMLElement ? anchor.parentElement.innerText : '')
											.split(/\.{3}|—/)
											.pop()
											?.trim() || '',
								}))
								.filter((item) => item.url && !/\/search\?/i.test(item.url))
						:	[];

					const citationCards = [];
					const citationAnchors = [];
					if (content instanceof HTMLElement) {
						citationAnchors.push(...Array.from(content.querySelectorAll('a[href]')));
					}
					if (rhsColumn instanceof HTMLElement) {
						citationAnchors.push(...Array.from(rhsColumn.querySelectorAll('a[href]')));
					}

					for (const anchor of citationAnchors) {
						const href = clean(anchor.getAttribute('href') || '');
						if (!href || /\/search\?/i.test(href) || /policies\.google\.com/i.test(href)) continue;

						const text = clean(anchor instanceof HTMLElement ? anchor.innerText : anchor.textContent || '');
						const ariaLabel = clean(anchor.getAttribute('aria-label') || '');
						const parentText = clean(anchor.parentElement instanceof HTMLElement ? anchor.parentElement.innerText : anchor.parentElement?.textContent || '');

						citationCards.push({
							url: href,
							text,
							ariaLabel,
							parentText,
						});
					}

					for (const selector of selectors) {
						const element = document.querySelector(selector);
						const text = clean(element instanceof HTMLElement ? element.innerText : element?.textContent || '');
						if (text) {
							candidateTexts.push(text);
						}
					}

					return { candidateTexts, supportingCards, citationCards };
				}

				const fallbackTexts = selectors
					.map((selector) => {
						const element = document.querySelector(selector);
						return clean(element instanceof HTMLElement ? element.innerText : element?.textContent || '');
					})
					.filter(Boolean);

				return { candidateTexts: fallbackTexts, supportingCards: [], citationCards: [] };
			}

			const selectors = [
				'#b_sydtop',
				'li.b_ans.b_top',
				'li.b_ans',
				'li.b_ans.b_top .b_no',
				'li.b_ans:first-of-type .b_no',
				'.b_wc .b_ptxt',
				'li.b_ans .b_caption',
				'.b_subModule .b_subTxt',
			];
			const candidateTexts = [];
			for (const selector of selectors) {
				const elements = Array.from(document.querySelectorAll(selector));
				for (const element of elements) {
					const text = clean(element instanceof HTMLElement ? element.innerText : element.textContent || '');
					if (text) {
						candidateTexts.push(text);
					}
				}
			}

			return { candidateTexts, supportingCards: [], citationCards: [] };
		}, normalizedSource);

		const candidateTexts = Array.isArray(renderedData?.candidateTexts) ? renderedData.candidateTexts : [];

		const aiText =
			normalizedSource === 'google' ?
				candidateTexts
					.map((entry) => normalizeExtractedAiText(entry))
					.filter((entry) => entry && entry.length > 40 && !looksLikeStylesheetText(entry))
					.sort((left, right) => scoreGoogleAiCandidate(right) - scoreGoogleAiCandidate(left) || right.length - left.length)[0] || null
			:	candidateTexts
					.map((entry) => normalizeBingAiText(entry))
					.filter((entry) => entry && entry.length > 40 && !looksLikeStylesheetText(entry))
					.sort((left, right) => right.length - left.length)[0] || null;

		if (aiText) {
			logger.debug('Browser-rendered AI response extracted', {
				source: normalizedSource,
				length: aiText.length,
			});
		}

		if (normalizedSource === 'google' && options?.includeOverview) {
			const supportingArticleResults = buildGoogleAiSupportingArticleResults(renderedData?.supportingCards, new Set());
			const citationResults = buildGoogleAiCitationResults(renderedData?.citationCards, new Set(supportingArticleResults.map((item) => item.url).filter(Boolean)));
			return {
				aiText: aiText || null,
				supportingArticleResults,
				citationResults,
			};
		}

		return aiText || null;
	} catch (err) {
		logger.debug('Browser-rendered AI response fetch skipped', {
			source: normalizedSource,
			error: err.message,
		});
		return options?.includeOverview ? { aiText: null, supportingArticleResults: [], citationResults: [] } : null;
	} finally {
		if (browser) {
			await browser.close().catch(() => {});
		}
	}
}

// ─── Google Custom Search ────────────────────────────────────────────────────

export async function googleSearch(params) {
	const apiKey = process.env.GOOGLE_API_KEY || process.env.GOOGLE_SEARCH_API_KEY || process.env.GOOGLE_CUSTOM_SEARCH_API_KEY;
	const cseId = process.env.GOOGLE_CSE_ID || process.env.GOOGLE_SEARCH_ENGINE_ID || process.env.GOOGLE_CUSTOM_SEARCH_ENGINE_ID;

	if (!apiKey || !cseId) {
		logger.info('Google CSE credentials not configured — using HTML fallback');
		const { results: htmlResults, aiResponse: htmlAi, citationResults: htmlCitations } = await googleHtmlSearch(params);
		if (hasVisibleSearchResults(htmlResults)) {
			return { ...buildGoogleSearchResult({ htmlResults, htmlAiResponse: htmlAi }), citationResults: htmlCitations || [] };
		}

		logger.info('Google HTML fallback returned no results — using Bing web fallback');
		const { results: bingFallback } = await bingHtmlSearch(params);
		return { ...buildGoogleSearchResult({ htmlResults, htmlAiResponse: htmlAi, fallbackResults: bingFallback }), citationResults: htmlCitations || [] };
	}

	const query = buildPersonQuery(params);
	try {
		const { data } = await axios.get('https://www.googleapis.com/customsearch/v1', {
			params: { key: apiKey, cx: cseId, q: query, num: 10 },
			timeout: TIMEOUT,
		});

		const results = (data.items || []).map((item) => ({
			title: item.title,
			url: item.link,
			snippet: item.snippet,
		}));

		const enrichedResults = await enrichResultsWithPageContent(results);
		logger.debug('Google results', { count: enrichedResults.length });
		return { source: 'google', results: enrichedResults };
	} catch (err) {
		logger.error('Google search error', { error: err.message });
		const { results: htmlResults, aiResponse: htmlAi, citationResults: htmlCitations } = await googleHtmlSearch(params);
		if (hasVisibleSearchResults(htmlResults)) {
			return { ...buildGoogleSearchResult({ htmlResults, htmlAiResponse: htmlAi }), citationResults: htmlCitations || [] };
		}

		const { results: bingFallback } = await bingHtmlSearch(params);
		return { ...buildGoogleSearchResult({ htmlResults, htmlAiResponse: htmlAi, fallbackResults: bingFallback }), citationResults: htmlCitations || [] };
	}
}

// ─── Bing Web Search ─────────────────────────────────────────────────────────

export async function bingSearch(params) {
	const apiKey = process.env.BING_API_KEY || process.env.BING_SEARCH_API_KEY || process.env.AZURE_BING_API_KEY;

	if (!apiKey) {
		logger.info('Bing API key not configured — using HTML fallback');
		const { results: htmlResults, aiResponse } = await bingHtmlSearch(params);
		return { source: 'bing', results: htmlResults, aiResponse };
	}

	const query = buildPersonQuery(params);
	try {
		const { data } = await axios.get('https://api.bing.microsoft.com/v7.0/search', {
			params: { q: query, count: 10, responseFilter: 'Webpages' },
			headers: { 'Ocp-Apim-Subscription-Key': apiKey },
			timeout: TIMEOUT,
		});

		const results = (data.webPages?.value || []).map((item) => ({
			title: item.name,
			url: item.url,
			snippet: item.snippet,
		}));

		const enrichedResults = await enrichResultsWithPageContent(results);
		logger.debug('Bing results', { count: enrichedResults.length });
		return { source: 'bing', results: enrichedResults };
	} catch (err) {
		logger.error('Bing search error', { error: err.message });
		const { results: htmlResults, aiResponse } = await bingHtmlSearch(params);
		return { source: 'bing', results: htmlResults, aiResponse };
	}
}

export async function yahooSearch(params) {
	try {
		const { results } = await yahooHtmlSearch(params);
		return { source: 'yahoo', results };
	} catch (err) {
		logger.error('Yahoo search error', { error: err.message });
		return { source: 'yahoo', results: [] };
	}
}

// ─── SerpAPI (currently disabled in runAllSearchEngines) ─────────────────────

export async function serpApiSearch(params, engine = 'google') {
	const apiKey = process.env.SERP_API_KEY;

	if (!apiKey) {
		logger.warn('SerpAPI key not configured — skipping');
		return { source: `serpapi_${engine}`, results: [] };
	}

	const query = buildPersonQuery(params);
	try {
		const { data } = await axios.get('https://serpapi.com/search', {
			params: { api_key: apiKey, engine, q: query, num: 10 },
			timeout: TIMEOUT,
		});

		const results = (data.organic_results || []).map((item) => ({
			title: item.title,
			url: item.link,
			snippet: item.snippet || '',
		}));

		logger.debug(`SerpAPI (${engine}) results`, { count: results.length });
		return { source: `serpapi_${engine}`, results };
	} catch (err) {
		logger.error(`SerpAPI (${engine}) error`, { error: err.message });
		return { source: `serpapi_${engine}`, results: [] };
	}
}

// ─── DuckDuckGo Instant Answers (no API key) ─────────────────────────────────
// Note: DDG's public API returns instant answer data only, not full web results.
// It is suitable as a no-key fallback for definition/entity look-ups.

function stripHtml(value = '') {
	return decodeHtml(String(value || '').replace(/<[^>]+>/g, ' '))
		.replace(/\s+/g, ' ')
		.trim();
}

function normalizeResultUrl(value = '', baseUrl = 'https://search.yahoo.com') {
	return normalizeRedirectUrl(value, baseUrl);
}

function decodeHtml(value = '') {
	return String(value || '')
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>');
}

function toContentPreview(text = '', maxLength = 600) {
	const normalized = String(text || '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!normalized) return '';

	const segments = normalized
		.split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
		.map((segment) => segment.trim())
		.filter(Boolean)
		.filter((segment) => {
			if (segment.length < 30) return false;
			if (/^(skip to main content|about us|contact us|privacy policy|terms of use|all journals|submit your research|sign in|create account)$/i.test(segment)) return false;
			if (/^(aboutpresscopyrightcontact uscreatorsadvertisedevelopers|powered and protected by privacy)/i.test(segment.replace(/\s+/g, '').toLowerCase())) return false;
			return true;
		});

	const preview = (segments.length ? segments : [normalized]).slice(0, 4).join(' ');
	return preview.length <= maxLength ? preview : `${preview.slice(0, maxLength).trimEnd()}…`;
}

function trimFullContent(text = '', maxLength = 20000) {
	const normalized = String(text || '')
		.replace(/\s+/g, ' ')
		.trim();
	return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength);
}

async function mapWithConcurrency(items = [], concurrency = 1, mapper = async (value) => value) {
	const normalizedItems = Array.isArray(items) ? items : [];
	if (!normalizedItems.length) return [];

	const maxConcurrency = Math.max(1, Math.min(Number(concurrency) || 1, normalizedItems.length));
	const output = new Array(normalizedItems.length);
	let nextIndex = 0;

	const workers = Array.from({ length: maxConcurrency }, async () => {
		while (nextIndex < normalizedItems.length) {
			const currentIndex = nextIndex;
			nextIndex += 1;
			output[currentIndex] = await mapper(normalizedItems[currentIndex], currentIndex);
		}
	});

	await Promise.all(workers);
	return output;
}

async function enrichResultsWithPageContent(results = []) {
	const validResults = results.filter((result) => /^https?:/i.test(result.url || ''));
	const forced = validResults.filter((result) => result.forceCrawl);
	const regular = validResults.filter((result) => !result.forceCrawl);
	const crawlable = [];
	const seenUrls = new Set();

	for (const result of [...forced, ...regular]) {
		if (!result?.url || seenUrls.has(result.url)) continue;
		if (!result.forceCrawl && crawlable.length >= Math.max(RESULT_CRAWL_LIMIT, forced.length)) break;
		seenUrls.add(result.url);
		crawlable.push(result);
	}

	if (!crawlable.length) {
		return results;
	}

	const pages = await parseDocuments(crawlable.map((result) => result.url));
	const pagesByUrl = new Map(pages.map((page) => [page.url, page]));

	const enriched = await mapWithConcurrency(results, SEARCH_RESULT_ENRICH_CONCURRENCY, async (result) => {
		const page = pagesByUrl.get(result.url);
		if (page?.blocked) {
			logger.debug('Skipping blocked search result', {
				url: result.url,
				title: result.title,
				reason: page.blockedReason || 'blocked-content-detected',
			});
			return null;
		}
		if (page?.language && page.language !== 'en') {
			logger.debug('Skipping non-English search result', {
				url: result.url,
				title: result.title,
				language: page.language,
			});
			return null;
		}
		if (!page?.text) return result;

		let extractedOrganizations = [];
		if (page.text.length > 50) {
			// Only process if enough text for meaningful extraction
			try {
				extractedOrganizations = await extractOrganizations(page.text);
			} catch (error) {
				logger.error(`Error extracting organizations from ${page.url}: ${error.message}`);
			}
		}

		return {
			...result,
			content: trimFullContent(page.text),
			contentPreview: toContentPreview(page.text),
			organizations: extractedOrganizations,
			entities: page.entities,
			dataLayer: page.dataLayer,
			imageContext: page.imageContext,
			supportingDocuments: page.supportingDocuments,
			previewImage: page.previewImage || null,
			crawled: true,
		};
	});
	const filteredEnriched = enriched.filter(Boolean);

	logger.debug('Search result pages crawled', {
		requested: crawlable.length,
		crawled: filteredEnriched.filter((result) => result.crawled).length,
	});

	return filteredEnriched;
}

// ─── Run all enabled search engines in parallel ───────────────────────────────

const SEARCH_ENGINE_RETRY_LIMIT = Number(process.env.SEARCH_ENGINE_RETRY_LIMIT) || 3;
const SEARCH_ENGINE_RETRY_DELAY_MS = Number(process.env.SEARCH_ENGINE_RETRY_DELAY_MS) || Math.random() * (3000 - 700) + 100;
const SEARCH_ENGINE_RUN_TIMEOUT_MS = Number(process.env.SEARCH_ENGINE_RUN_TIMEOUT_MS) || 45000;

function describeSearchTarget(params = {}) {
	return String(params.searchTerm || '').trim() || [params.firstName, params.middleName, params.lastName].filter(Boolean).join(' ') || String(params.address || '').trim();
}

function waitForRetry(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, message) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);

		Promise.resolve(promise)
			.then((value) => {
				clearTimeout(timer);
				resolve(value);
			})
			.catch((error) => {
				clearTimeout(timer);
				reject(error);
			});
	});
}

async function runSearchEngineJobWithRetry({ source, runner }, params, onProgress, target, location) {
	let lastError;

	for (let attempt = 1; attempt <= SEARCH_ENGINE_RETRY_LIMIT; attempt += 1) {
		onProgress?.({
			source,
			kind: 'search-engine',
			status: 'running',
			percent: attempt > 1 ? 55 : 35,
			message:
				attempt > 1 ?
					`Retry ${attempt}/${SEARCH_ENGINE_RETRY_LIMIT}: searching ${target}${location ? ` in ${location}` : ''}`
				:	`Searching ${target}${location ? ` in ${location}` : ''}`,
		});

		try {
			const result = await withTimeout(runner(params), SEARCH_ENGINE_RUN_TIMEOUT_MS, `${source} search timed out`);
			const itemCount = Array.isArray(result?.results) ? result.results.length : 0;

			onProgress?.({
				source,
				kind: 'search-engine',
				status: itemCount ? 'fetched' : 'no-data',
				itemCount,
				percent: 100,
				message: itemCount ? `Processed ${itemCount} web results` : 'No web results found',
			});

			return result;
		} catch (error) {
			lastError = error;
			const shouldRetry = attempt < SEARCH_ENGINE_RETRY_LIMIT;

			logger.warn('Search engine attempt failed', {
				source,
				attempt,
				retrying: shouldRetry,
				error: error.message,
			});

			if (shouldRetry) {
				onProgress?.({
					source,
					kind: 'search-engine',
					status: 'running',
					percent: 65,
					itemCount: 0,
					message: `Attempt ${attempt} failed, queued to scan again (${attempt + 1}/${SEARCH_ENGINE_RETRY_LIMIT})`,
				});
				await waitForRetry(SEARCH_ENGINE_RETRY_DELAY_MS * attempt);
				continue;
			}

			onProgress?.({
				source,
				kind: 'search-engine',
				status: 'error',
				itemCount: 0,
				percent: 100,
				message: `${error.message || 'Crawler failed'} after ${attempt} attempt${attempt > 1 ? 's' : ''}`,
			});
		}
	}

	throw lastError;
}

export async function runAllSearchEngines(params, onProgress) {
	const target = describeSearchTarget(params) || 'requested person';
	const location = [params.city, params.state].filter(Boolean).join(', ');
	const jobs = [
		{ source: 'google', runner: googleSearch },
		{ source: 'bing', runner: bingSearch },
	];

	// Optionally include SerpAPI job if key is configured (provides consolidated SERP access)
	if (process.env.SERP_API_KEY) {
		jobs.push({ source: 'serpapi_google', runner: (p) => serpApiSearch(p, 'google') });
		jobs.push({ source: 'serpapi_bing', runner: (p) => serpApiSearch(p, 'bing') });
	}

	const mapped = jobs.map((job) => runSearchEngineJobWithRetry(job, params, onProgress, target, location));

	const settled = await Promise.allSettled(mapped);
	return settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
}

/**
 * Crawl an RSS/Atom feed (free feeds) and fetch referenced pages.
 * Returns an array of parsed pages as { url, text, title, chars } using parseDocuments.
 * Only attempts to fetch publicly available feeds (no auth). Caller should respect robots and rate limits.
 */
export async function crawlRssFeed(feedUrl, options = {}) {
	const maxItems = Number(options.maxItems) || 8;
	try {
		const { data } = await axios.get(String(feedUrl || ''), {
			timeout: TIMEOUT,
			headers: { ...SEARCH_HEADERS, Referer: feedUrl },
		});

		const $ = cheerio.load(String(data || ''), { xmlMode: true });
		const links = [];
		$('item link, entry link[href]').each((_, el) => {
			const node = $(el);
			const href = node.attr('href') || node.text() || '';
			if (href && /^https?:\/\//i.test(href)) links.push(href.trim());
		});

		// Fallback: try <link> under <item> that may contain child text
		if (!links.length) {
			$('item').each((_, it) => {
				const link = $(it).find('link').first().text().trim();
				if (link && /^https?:\/\//i.test(link)) links.push(link);
			});
		}

		const unique = [...new Set(links)].slice(0, maxItems);
		if (!unique.length) return [];

		// Use parseDocuments to fetch and parse referenced pages
		const pages = await parseDocuments(unique);
		return pages;
	} catch (err) {
		logger.warn('crawlRssFeed failed', { feedUrl, error: err.message });
		return [];
	}
}
