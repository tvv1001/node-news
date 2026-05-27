/**
 * documentParser.js
 *
 * Fetches and extracts text from remote documents:
 *   - PDF  → pdf-parse
 *   - DOCX → mammoth
 *   - HTML → cheerio (fallback for any URL)
 *
 * Given the extracted text and a person's name, uses regex heuristics
 * to pull out phone numbers, email addresses, and address fragments.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');
import axios from 'axios';
import mammoth from 'mammoth';
import * as cheerio from 'cheerio';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import puppeteer from 'puppeteer';
import { existsSync } from 'node:fs';
import { logger } from '../../utils/logger.js';
import { getKnownStates, normalizeStateValue } from '../../utils/locationIndex.js';

const TIMEOUT = Number(process.env.REQUEST_TIMEOUT_MS) || 15000;
const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10 MB safety cap
const MAX_HTML_PAGINATION_PAGES = Number(process.env.MAX_HTML_PAGINATION_PAGES) || 3;
const MAX_HTML_TEXT_CHARS = Number(process.env.MAX_HTML_TEXT_CHARS) || 120000;
const MAX_PUBLIC_RECORD_ENTRIES = Number(process.env.MAX_PUBLIC_RECORD_ENTRIES) || 120000;
const MAX_SUPPORTING_DOC_LINKS = Number(process.env.MAX_SUPPORTING_DOC_LINKS) || 2;
const MAX_SUPPORTING_DOC_TEXT_CHARS = Number(process.env.MAX_SUPPORTING_DOC_TEXT_CHARS) || 50000;
const MAX_IMAGE_CONTEXT_ENTRIES = Number(process.env.MAX_IMAGE_CONTEXT_ENTRIES) || 8;
const PDF_PREVIEW_TIMEOUT_MS = Number(process.env.PDF_PREVIEW_TIMEOUT_MS) || 12000;
const PDF_PREVIEW_IMAGE_QUALITY = Math.max(40, Math.min(100, Number(process.env.PDF_PREVIEW_IMAGE_QUALITY) || 70));
const BROWSER_EXECUTABLE_CANDIDATES = [
	process.env.PUPPETEER_EXECUTABLE_PATH,
	process.env.CHROME_PATH,
	process.env.GOOGLE_CHROME_BIN,
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
].filter(Boolean);
const BLOCKED_BROWSER_RESOURCE_TYPES = new Set(['stylesheet', 'script', 'font']);
const NON_CONTENT_IMAGE_TEXT_RE =
	/\b(?:logo|logomark|icon|favicon|avatar|profile image|homepage|home page|brand|branding|header|navigation|nav|menu|footer|breadcrumb|pager|pagination|share|sharing|social|social media|facebook|twitter|linkedin|reddit|bibsonomy|mastodon|youtube|instagram|tiktok|subscribe|donate|copyright|privacy policy|contact us|help|cornell university|arxiv logo|ar5iv homepage|mascot)\b/i;
const NON_CONTENT_IMAGE_SRC_RE =
	/(?:^data:|\/logo(?:[\-_./]|$)|\/logos?(?:[\-_./]|$)|\/icon(?:s)?(?:[\-_./]|$)|favicon|apple-touch-icon|\/social\/(?:|[^/]+$)|\/share(?:[\-_./]|$)|\/nav(?:igation)?(?:[\-_./]|$)|\/header(?:[\-_./]|$)|\/footer(?:[\-_./]|$)|bibsonomy|reddit|twitter|linkedin|facebook|instagram|mastodon|youtube|tiktok|arxiv-logo|cornell-reduced|logomark|avatar)/i;
const NON_CONTENT_IMAGE_FILENAME_RE = /(?:^|[\s/])(?:wn|pr|ad|promo|banner|hero|cta)-[\w-]+(?:-min)?\.(?:jpe?g|png|gif|webp|svg|avif)(?:\?.*)?$/i;
const NON_CONTENT_IMAGE_MARKETING_TEXT_RE =
	/\b(?:data management solutions|ai era|download now|learn more|webinar|ebook|whitepaper|promo|promotional|campaign|sponsored|advertisement|marketing|hero image|banner image)\b/i;
const BLOCKED_CONTENT_SIGNALS = [
	{
		pattern: /\b(?:captcha|verify you are human|verification required|prove you(?:'|’)re human|security check|attention required)\b/i,
		score: 3,
		reason: 'captcha-or-human-verification',
	},
	{
		pattern:
			/\b(?:enable javascript and cookies|enable javascript to continue|disable (?:your )?ad blocker|checking your browser before accessing|checking if the site connection is secure|cloudflare ray id|just a moment\.\.\.)\b/i,
		score: 3,
		reason: 'browser-check-gate',
	},
	{
		pattern:
			/\b(?:access denied|request blocked|you have been blocked|sorry, you have been blocked|403 forbidden|forbidden|automated queries|unusual traffic from your computer network)\b/i,
		score: 3,
		reason: 'access-blocked',
	},
	{
		pattern:
			/\b(?:subscribe to continue reading|subscription required|subscriber-only content|for subscribers only|sign in to continue reading|log in to continue reading|purchase a subscription)\b/i,
		score: 2,
		reason: 'paywall',
	},
];

const ENGLISH_HINT_WORDS = ['the', 'and', 'of', 'to', 'in', 'for', 'with', 'that', 'from', 'by', 'this', 'is', 'are', 'as', 'at', 'be', 'we', 'you', 'our', 'more', 'about'];
const SPANISH_HINT_WORDS = [
	'de',
	'la',
	'que',
	'y',
	'en',
	'los',
	'del',
	'para',
	'con',
	'por',
	'las',
	'una',
	'un',
	'al',
	'empresa',
	'empresas',
	'seguridad',
	'experiencia',
	'necesidades',
	'damos',
	'cobertura',
	'personalizado',
];

// ─── Regex extractors ────────────────────────────────────────────────────────

const PHONE_RE = /(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]\d{3}[-.\s]\d{4}/g;
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const ADDR_RE = /\d{1,5}\s[\w\s.]+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Ct|Court|Place|Pl)[,\s]+[\w\s]+,?\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?/gi;
const PUBLIC_RECORD_NAME_RE = /^[A-Z][A-Z'.,&\-]*(?:\s+[A-Z0-9][A-Z0-9'.,&\-]*){1,7}$/;
const PUBLIC_RECORD_ADDRESS_RE =
	/^(?:\d{1,6}\s+.+|P\s*O\s*BOX\s*[\d-]+|PO\s*BOX\s*[\d-]+|RR\s*\d+\s*BOX\s*[\d-]+|RT\s*\d+\s*BOX\s*[\d-]+|ROUTE\s*\d+\s*BOX\s*[\d-]+|C\/O\s+.+|HC\s*\d+\s*BOX\s*[\d-]+|\d+\s*1\/2\s+.+)$/i;
const DOC_LIST_TYPE_PATTERNS = {
	'unclaimed-property': /\bunclaimed\s+property\b/i,
	'deed-sale': /\b(deed\s+sale|tax\s+sale|sheriff\s+sale|foreclosure\s+sale)\b/i,
};
const PUBLIC_RECORD_HEADER_SKIP_RE =
	/^(?:yourmoney\.ok\.gov|notice of latest names|from the desk of|how to search|mail to:|turn page|visit |march \d{4}|newspaper advertising supplement|unclaimed property division|owner name:|current address:|city:\s+state:\s+zip:|daytime phone|email:|signaturedate)$/i;
const ADDRESS_CONTINUATION_TOKEN_RE =
	/^(?:N|S|E|W|NE|NW|SE|SW|ST|STREET|RD|ROAD|AVE|AVENUE|BLVD|BOULEVARD|DR|DRIVE|LN|LANE|CT|COURT|PL|PLACE|TRL|TRAIL|PKWY|PARKWAY|TER|TERRACE|CIR|CIRCLE|HWY|HIGHWAY|WAY|APT|UNIT|STE|SUITE|LOT|BLDG|BUILDING|FL|FLOOR|RM|ROOM|BOX)$/i;
const NON_LOCALITY_TOKENS = new Set([
	'APT',
	'UNIT',
	'STE',
	'SUITE',
	'BOX',
	'ROAD',
	'RD',
	'STREET',
	'ST',
	'AVENUE',
	'AVE',
	'BOULEVARD',
	'BLVD',
	'DRIVE',
	'DR',
	'LANE',
	'LN',
	'COURT',
	'CT',
	'CIRCLE',
	'CIR',
	'TRAIL',
	'TRL',
	'PLACE',
	'PL',
	'TERRACE',
	'TER',
	'EXPRESSWAY',
	'EXPY',
	'PARKWAY',
	'PKWY',
	'WAY',
]);
const NON_LOCALITY_BUSINESS_TOKENS = new Set([
	'LLC',
	'INC',
	'LTD',
	'CORP',
	'CO',
	'COMPANY',
	'BANK',
	'TRUST',
	'ENERGY',
	'AUTO',
	'MOTORS',
	'PROPERTIES',
	'ESTATE',
	'ESTATES',
	'HOLDINGS',
	'SERVICES',
	'GROUP',
]);

const KNOWN_STATE_ABBR = [
	...new Set(
		getKnownStates()
			.map((stateName) => normalizeStateValue(stateName))
			.filter(Boolean),
	),
];

function toTitleCaseWords(value = '') {
	return String(value || '')
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
		.join(' ');
}

function detectPublicRecordListType(text = '', url = '') {
	const haystack = `${String(text || '').slice(0, 25000)} ${String(url || '')}`;

	for (const [type, pattern] of Object.entries(DOC_LIST_TYPE_PATTERNS)) {
		if (pattern.test(haystack)) return type;
	}

	return '';
}

function inferStateFromDocument(text = '', url = '') {
	const urlLower = decodeURIComponent(String(url || '')).toLowerCase();
	const head = String(text || '').slice(0, 50000);

	if (/\boklahoma\.gov\b/i.test(urlLower) || /\bok\.gov\b/i.test(urlLower)) {
		return 'OK';
	}

	for (const stateName of getKnownStates()) {
		const normalizedName = String(stateName || '').toLowerCase();
		if (!normalizedName) continue;

		const slug = normalizedName.replace(/\s+/g, '-');
		const compact = normalizedName.replace(/\s+/g, '');

		if (urlLower.includes(normalizedName) || urlLower.includes(slug) || urlLower.includes(compact)) {
			return normalizeStateValue(stateName) || '';
		}
	}

	const lead = String(text || '').slice(0, 6000);
	const leadStateMention = lead.match(
		/\b(Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming)\b/i,
	);
	if (leadStateMention) {
		return normalizeStateValue(leadStateMention[1]) || '';
	}

	for (const stateName of getKnownStates()) {
		const normalizedName = String(stateName || '').toLowerCase();
		if (!normalizedName) continue;

		const slug = normalizedName.replace(/\s+/g, '-');
		const compact = normalizedName.replace(/\s+/g, '');

		if (
			urlLower.includes(normalizedName) ||
			urlLower.includes(slug) ||
			urlLower.includes(compact) ||
			new RegExp(`\\b${normalizedName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i').test(head)
		) {
			return normalizeStateValue(stateName) || '';
		}
	}

	for (const abbr of KNOWN_STATE_ABBR) {
		if (new RegExp(`\\b${abbr}\\b`, 'i').test(head)) {
			return abbr;
		}
	}

	return '';
}

function looksLikePublicRecordName(line = '') {
	const raw = String(line || '').trim();
	if (!raw) return false;
	if (/\d/.test(raw)) return false;
	if (PUBLIC_RECORD_HEADER_SKIP_RE.test(raw)) return false;
	if (
		/^(?:ADAIR|ALFALFA|ATOKA|BEAVER|BECKHAM|BLAINE|BRYAN|CADDO|CANADIAN|CARTER|CHEROKEE|CHOCTAW|CIMARRON|CLEVELAND|COAL|COMANCHE|COTTON|CRAIG|CREEK|CUSTER|DELAWARE|DEWEY|ELLIS|GARFIELD|GARVIN|GRADY|GRANT|GREER|HARMON|HARPER|HASKELL|HUGHES|JACKSON|JEFFERSON|JOHNSTON|KAY|KINGFISHER|KIOWA|LATIMER|LE FLORE|LINCOLN|LOGAN|LOVE|MCCLAIN|MCCURTAIN|MCINTOSH|MAJOR|MARSHALL|MAYES|MURRAY|MUSKOGEE|NOBLE|NOWATA|OKFUSKEE|OKLAHOMA|OKMULGEE|OSAGE|OTTAWA|PAWNEE|PAYNE|PITTSBURG|PONTOTOC|POTTAWATOMIE|PUSHMATAHA|ROGER MILLS|ROGERS|SEMINOLE|SEQUOYAH|STEPHENS|TEXAS|TILLMAN|TULSA|WAGONER|WASHINGTON|WASHITA|WOODS|WOODWARD)$/i.test(
			raw,
		)
	) {
		return false;
	}

	return PUBLIC_RECORD_NAME_RE.test(raw);
}

function looksLikePublicRecordAddress(line = '') {
	const raw = String(line || '').trim();
	if (!raw) return false;
	if (PUBLIC_RECORD_HEADER_SKIP_RE.test(raw)) return false;

	return PUBLIC_RECORD_ADDRESS_RE.test(raw);
}

function looksLikeLocalityHeader(line = '', nextLine = '', nextNextLine = '') {
	const raw = String(line || '').trim();
	if (!raw) return false;
	if (PUBLIC_RECORD_HEADER_SKIP_RE.test(raw)) return false;
	if (/\.gov\b/i.test(raw)) return false;
	if (/\d/.test(raw)) return false;
	if (!/^[A-Z\s.'-]+$/.test(raw)) return false;

	const words = raw.split(/\s+/).filter(Boolean);
	if (!words.length || words.length > 2) return false;
	if (
		words.some((word) => {
			const normalizedWord = word.toUpperCase().replace(/[^A-Z]/g, '');
			return normalizedWord.length <= 1 || NON_LOCALITY_TOKENS.has(normalizedWord);
		})
	) {
		return false;
	}

	if (
		words.some((word) => {
			const normalizedWord = word.toUpperCase().replace(/[^A-Z]/g, '');
			return NON_LOCALITY_BUSINESS_TOKENS.has(normalizedWord);
		})
	) {
		return false;
	}

	return looksLikePublicRecordName(nextLine) && looksLikePublicRecordAddress(nextNextLine);
}

function looksLikeUppercaseShortHeader(line = '') {
	const raw = String(line || '').trim();
	if (!raw) return false;
	if (/\d/.test(raw)) return false;
	if (!/^[A-Z\s.'-]+$/.test(raw)) return false;

	const words = raw.split(/\s+/).filter(Boolean);
	return words.length >= 1 && words.length <= 3;
}

function looksLikeAddressContinuation(line = '') {
	const raw = String(line || '')
		.trim()
		.replace(/[,.;:]+$/g, '');

	if (!raw) return false;
	if (PUBLIC_RECORD_HEADER_SKIP_RE.test(raw)) return false;
	if (looksLikePublicRecordName(raw)) return false;

	const tokens = raw
		.split(/\s+/)
		.map((token) => token.replace(/[^A-Z0-9-]/gi, ''))
		.filter(Boolean);

	if (!tokens.length || tokens.length > 4) return false;

	return tokens.every((token) => ADDRESS_CONTINUATION_TOKEN_RE.test(token) || /^[A-Z0-9-]{1,6}$/i.test(token));
}

function normalizeLocalityHeader(value = '') {
	const raw = String(value || '').trim();
	if (!raw) return '';
	if (PUBLIC_RECORD_HEADER_SKIP_RE.test(raw)) return '';
	if (/\.gov\b/i.test(raw)) return '';

	const formatted = toTitleCaseWords(raw);
	const words = formatted
		.split(/\s+/)
		.map((word) => word.trim())
		.filter(Boolean);

	if (!words.length) return '';

	const normalizedTokens = words.map((word) => word.toUpperCase().replace(/[^A-Z]/g, ''));
	const isNoiseToken = (token = '') => Boolean(token) && NON_LOCALITY_TOKENS.has(token);

	if (normalizedTokens.every((token) => isNoiseToken(token))) {
		return '';
	}

	if (words.length <= 3 && isNoiseToken(normalizedTokens[0])) {
		return '';
	}

	// Recover likely city from OCR locality labels like "Eufaula St".
	if (words.length >= 2 && !isNoiseToken(normalizedTokens[0]) && isNoiseToken(normalizedTokens[words.length - 1])) {
		return words[0].length >= 3 ? words[0] : '';
	}

	if (words.length >= 3 && !isNoiseToken(normalizedTokens[0]) && isNoiseToken(normalizedTokens[1])) {
		return words[0].length >= 3 ? words[0] : '';
	}

	return formatted;
}

function extractPublicRecordEntries(text = '', url = '') {
	const listType = detectPublicRecordListType(text, url);
	if (!listType) {
		return { listType: '', state: '', entries: [] };
	}

	const lines = String(text || '')
		.split(/\r?\n/)
		.map((line) => line.replace(/\s+/g, ' ').trim())
		.filter(Boolean);

	const state = inferStateFromDocument(text, url);
	const entries = [];
	const seen = new Set();
	let currentLocality = '';

	for (let i = 0; i < lines.length && entries.length < MAX_PUBLIC_RECORD_ENTRIES; i += 1) {
		const line = lines[i];
		const nextLine = lines[i + 1] || '';
		const nextNextLine = lines[i + 2] || '';

		if (looksLikeLocalityHeader(line, nextLine, nextNextLine)) {
			currentLocality = normalizeLocalityHeader(line);
			continue;
		}

		if (!looksLikePublicRecordName(line)) {
			continue;
		}

		let addressStart = -1;
		for (let offset = 1; offset <= 3; offset += 1) {
			if (looksLikePublicRecordAddress(lines[i + offset] || '')) {
				addressStart = i + offset;
				break;
			}
		}

		if (addressStart === -1) {
			continue;
		}

		const nameParts = [];
		for (let index = i; index < addressStart; index += 1) {
			const nameLine = lines[index];
			if (looksLikePublicRecordName(nameLine)) {
				nameParts.push(nameLine);
			}
		}

		const ownerName = nameParts
			.join(' ')
			.trim()
			.replace(/[\s,]+$/g, '');
		if (!ownerName) continue;

		const addressParts = [lines[addressStart]];
		let endIndex = addressStart;

		for (let index = addressStart + 1; index <= addressStart + 2; index += 1) {
			const maybeContinuation = lines[index] || '';
			if (!maybeContinuation) break;
			if (looksLikeLocalityHeader(maybeContinuation, lines[index + 1], lines[index + 2])) break;
			if (looksLikeUppercaseShortHeader(maybeContinuation) && !looksLikeAddressContinuation(maybeContinuation)) {
				break;
			}
			if (looksLikePublicRecordName(maybeContinuation)) break;
			if (PUBLIC_RECORD_HEADER_SKIP_RE.test(maybeContinuation)) break;
			if (!looksLikePublicRecordAddress(maybeContinuation) && !looksLikeAddressContinuation(maybeContinuation)) {
				break;
			}

			addressParts.push(maybeContinuation);
			endIndex = index;
		}

		const streetAddress = addressParts.join(' ').replace(/\s+/g, ' ').trim();
		if (!streetAddress) {
			i = endIndex;
			continue;
		}

		const dedupeKey = `${ownerName.toLowerCase()}|${streetAddress.toLowerCase()}|${currentLocality.toLowerCase()}|${state.toLowerCase()}`;
		if (!seen.has(dedupeKey)) {
			seen.add(dedupeKey);
			entries.push({
				name: ownerName,
				address: streetAddress,
				city: currentLocality,
				state,
			});
		}

		i = endIndex;
	}

	return { listType, state, entries };
}

export function extractEntitiesFromText(text = '') {
	return {
		phones: [...new Set((text.match(PHONE_RE) || []).map((p) => p.trim()))],
		emails: [...new Set((text.match(EMAIL_RE) || []).map((e) => e.toLowerCase()))],
		addresses: [...new Set((text.match(ADDR_RE) || []).map((a) => a.trim()))],
	};
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchBinary(url) {
	const response = await fetchBinaryResponse(url);
	return response.buffer;
}

async function fetchBinaryResponse(url) {
	const resp = await axios.get(url, {
		responseType: 'arraybuffer',
		timeout: TIMEOUT,
		maxContentLength: MAX_DOC_BYTES,
		headers: { 'User-Agent': 'person-search-server/1.0 (research tool)' },
	});
	return {
		buffer: Buffer.from(resp.data),
		contentType: String(resp.headers?.['content-type'] || '')
			.split(';')[0]
			.trim()
			.toLowerCase(),
	};
}

async function fetchText(url) {
	const resp = await axios.get(url, {
		responseType: 'text',
		timeout: TIMEOUT,
		maxContentLength: MAX_DOC_BYTES,
		headers: {
			'User-Agent': 'person-search-server/1.0 (research tool)',
			'Accept': 'text/html,application/xhtml+xml',
		},
	});
	return resp.data;
}

function normalizeExtractedHtmlText(value = '') {
	return String(value || '')
		.replace(/\u00a0/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function stripStyleAndScriptBlocks(value = '') {
	return String(value || '')
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
		.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
}

export function detectLikelyTextLanguage(value = '') {
	const sample = normalizeExtractedHtmlText(value).toLowerCase();
	if (!sample || sample.length < 40) return 'unknown';

	const englishHits = ENGLISH_HINT_WORDS.reduce((count, word) => count + (new RegExp(`\\b${word}\\b`, 'g').test(sample) ? 1 : 0), 0);
	const spanishHits = SPANISH_HINT_WORDS.reduce((count, word) => count + (new RegExp(`\\b${word}\\b`, 'g').test(sample) ? 1 : 0), 0);
	const accentHits = /[áéíóúñü¿¡]/i.test(sample) ? 2 : 0;

	if (spanishHits + accentHits > englishHits + 1) return 'non-en';
	if (englishHits >= spanishHits) return 'en';
	return 'non-en';
}

export function detectBlockedDocument(text = '', url = '') {
	const normalizedText = normalizeExtractedHtmlText(text);
	if (!normalizedText) {
		return { blocked: false, reason: '' };
	}

	const sample = normalizedText.slice(0, 4000);
	const matchedReasons = [];
	let score = 0;

	for (const signal of BLOCKED_CONTENT_SIGNALS) {
		if (!signal.pattern.test(sample)) continue;
		score += signal.score;
		matchedReasons.push(signal.reason);
	}

	if (sample.length < 280) {
		score += 1;
	}

	if (String(url || '').trim() && /\b(?:captcha|challenge|blocked|forbidden|accessdenied|consent)\b/i.test(String(url))) {
		score += 1;
		matchedReasons.push('blocked-url-pattern');
	}

	return {
		blocked: score >= 4,
		reason: [...new Set(matchedReasons)].join(', '),
	};
}

function normalizeArticleText(value = '') {
	return String(value || '')
		.replace(/\u00a0/g, ' ')
		.replace(/[ \t\f\v]+/g, ' ')
		.replace(/\n\s*\n+/g, '\n\n')
		.trim();
}

function appendSupplementalText(primaryText = '', supplementalText = '', options = {}) {
	const normalizedPrimary = normalizeArticleText(primaryText);
	const normalizedSupplemental = normalizeArticleText(supplementalText);
	const { prependWhenPrimaryShort = false, minPrimaryLength = 240 } = options;

	if (!normalizedSupplemental) return normalizedPrimary;
	if (!normalizedPrimary) return normalizedSupplemental;
	if (normalizedPrimary.toLowerCase().includes(normalizedSupplemental.toLowerCase())) {
		return normalizedPrimary;
	}

	if (prependWhenPrimaryShort && normalizedPrimary.length < minPrimaryLength) {
		return `${normalizedSupplemental}\n\n${normalizedPrimary}`.trim();
	}

	return `${normalizedPrimary}\n\n${normalizedSupplemental}`.trim();
}

function extractBalancedSegment(input = '', startIndex = -1, openChar = '{', closeChar = '}') {
	if (startIndex < 0 || input[startIndex] !== openChar) return '';

	let depth = 0;
	let quoteChar = '';
	let escaped = false;

	for (let index = startIndex; index < input.length; index += 1) {
		const char = input[index];

		if (quoteChar) {
			if (escaped) {
				escaped = false;
				continue;
			}

			if (char === '\\') {
				escaped = true;
				continue;
			}

			if (char === quoteChar) {
				quoteChar = '';
			}
			continue;
		}

		if (char === '"' || char === "'" || char === '`') {
			quoteChar = char;
			continue;
		}

		if (char === openChar) depth += 1;
		if (char === closeChar) depth -= 1;

		if (depth === 0) {
			return input.slice(startIndex, index + 1);
		}
	}

	return '';
}

function normalizeDataLayerKey(value = '') {
	return String(value || '')
		.trim()
		.replace(/^["'`]+|["'`]+$/g, '')
		.replace(/^\$+/, '')
		.replace(/\[(\d+)\]/g, '.$1');
}

function parseLooseLiteralValue(value = '') {
	const raw = String(value || '').trim();
	if (!raw) return '';

	if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('`') && raw.endsWith('`'))) {
		return raw
			.slice(1, -1)
			.replace(/\\n/g, ' ')
			.replace(/\\r/g, ' ')
			.replace(/\\t/g, ' ')
			.replace(/\\([\\"'`])/g, '$1')
			.trim();
	}

	if (raw.startsWith('[') && raw.endsWith(']')) {
		const items = [];
		const itemPattern = /"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|-?\d+(?:\.\d+)?|true|false|null/gs;
		for (const match of raw.matchAll(itemPattern)) {
			const parsed = parseLooseLiteralValue(match[0]);
			if (parsed) items.push(parsed);
		}
		return items;
	}

	if (/^(?:true|false|null)$/i.test(raw)) {
		return raw.toLowerCase() === 'null' ? '' : raw.toLowerCase();
	}

	if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
		return raw;
	}

	return '';
}

function extractLooseObjectLiterals(block = '') {
	const literals = [];
	for (let index = 0; index < block.length; index += 1) {
		if (block[index] !== '{') continue;
		const literal = extractBalancedSegment(block, index, '{', '}');
		if (!literal) continue;
		literals.push(literal);
		index += literal.length - 1;
	}
	return literals;
}

function parseLooseDataLayerEntry(literal = '') {
	const entry = {};
	const pairPattern =
		/([A-Za-z_$][\w$.:\-[\]]*|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`)\s*:\s*(\[(?:.|\n|\r)*?\]|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|true|false|null|-?\d+(?:\.\d+)?)/g;

	for (const match of literal.matchAll(pairPattern)) {
		const key = normalizeDataLayerKey(match[1]);
		if (!key) continue;

		const parsedValue = parseLooseLiteralValue(match[2]);
		if (!parsedValue || (Array.isArray(parsedValue) && !parsedValue.length)) continue;

		if (Array.isArray(parsedValue)) {
			entry[key] = [...new Set(parsedValue.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 8);
		} else {
			entry[key] = String(parsedValue).trim();
		}
	}

	return entry;
}

function isMeaningfulDataLayerField(key = '', value = '') {
	const normalizedKey = normalizeDataLayerKey(key).toLowerCase();
	if (!normalizedKey) return false;
	if (
		/^(?:event|gtm|timestamp|time|date|id|pageid|userid|session|client|currency|value|price|quantity|index|position|step|debug|status|path|pathname|url|uri|href|host|hostname|domain|referrer|locale|language|screen|viewport)$/i.test(
			normalizedKey,
		)
	) {
		return false;
	}

	const normalizedValue = String(value || '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!normalizedValue || normalizedValue.length < 3 || normalizedValue.length > 220) return false;
	if (/^https?:\/\//i.test(normalizedValue)) return false;
	if (/^\d+$/.test(normalizedValue)) return false;
	if (/^(?:true|false|null|undefined)$/i.test(normalizedValue)) return false;

	return /(title|name|headline|description|summary|author|category|section|topic|tag|keyword|brand|organization|publisher|article|content|page|template|vertical|subvertical|department|team|subject|type)/i.test(
		normalizedKey,
	);
}

function entryToDataLayerLines(entry = {}) {
	return Object.entries(entry)
		.flatMap(([key, value]) => {
			if (Array.isArray(value)) {
				return value.filter((item) => isMeaningfulDataLayerField(key, item)).map((item) => `${key.replace(/[._-]+/g, ' ')}: ${String(item).trim()}`);
			}

			if (!isMeaningfulDataLayerField(key, value)) return [];
			return [`${key.replace(/[._-]+/g, ' ')}: ${String(value).trim()}`];
		})
		.filter(Boolean);
}

export function extractDataLayerMetadata(html = '') {
	const rawHtml = String(html || '');
	if (!rawHtml.trim()) {
		return { entries: [], text: '' };
	}

	const $ = cheerio.load(rawHtml);
	const entries = [];
	const pushPattern = /(?:window\.)?dataLayer\.push\s*\(/g;
	const assignPattern = /(?:window\.)?dataLayer\s*=\s*\[/g;

	$('script').each((_, element) => {
		const content = $(element).html() || '';
		if (!/dataLayer/i.test(content)) return;

		for (const match of content.matchAll(pushPattern)) {
			const openIndex = content.indexOf('(', match.index);
			const args = extractBalancedSegment(content, openIndex, '(', ')');
			if (!args) continue;

			for (const literal of extractLooseObjectLiterals(args)) {
				const parsed = parseLooseDataLayerEntry(literal);
				if (Object.keys(parsed).length) entries.push(parsed);
			}
		}

		for (const match of content.matchAll(assignPattern)) {
			const openIndex = content.indexOf('[', match.index);
			const arrayLiteral = extractBalancedSegment(content, openIndex, '[', ']');
			if (!arrayLiteral) continue;

			for (const literal of extractLooseObjectLiterals(arrayLiteral)) {
				const parsed = parseLooseDataLayerEntry(literal);
				if (Object.keys(parsed).length) entries.push(parsed);
			}
		}
	});

	const seenLines = new Set();
	const text = entries
		.flatMap((entry) => entryToDataLayerLines(entry))
		.filter((line) => {
			const normalized = normalizeExtractedHtmlText(line);
			if (!normalized || seenLines.has(normalized.toLowerCase())) return false;
			seenLines.add(normalized.toLowerCase());
			return true;
		})
		.slice(0, 20)
		.join('\n');

	return {
		entries: entries.slice(0, 12),
		text,
	};
}

function appendDataLayerText(extractedText = '', dataLayerText = '') {
	return appendSupplementalText(extractedText, dataLayerText, {
		prependWhenPrimaryShort: true,
		minPrimaryLength: 240,
	});
}

function getArxivPaperId(url = '') {
	try {
		const parsed = new URL(String(url || ''));
		const match = parsed.pathname.match(/^\/(?:abs|pdf|html)\/([^/?#]+?)(?:\.pdf)?$/i);
		return match?.[1] || '';
	} catch {
		return '';
	}
}

function stripArxivVersion(paperId = '') {
	return String(paperId || '').replace(/v\d+$/i, '');
}

function isArxivAbstractUrl(url = '') {
	try {
		const parsed = new URL(String(url || ''));
		return /(?:^|\.)arxiv\.org$/i.test(parsed.hostname) && /^\/abs\//i.test(parsed.pathname);
	} catch {
		return false;
	}
}

function findMatchingArxivPdfUrl(urls = [], absUrl = '') {
	const absPaperId = getArxivPaperId(absUrl);
	if (!absPaperId) return '';

	const absRootId = stripArxivVersion(absPaperId);

	return (
		(Array.isArray(urls) ? urls : []).find((url) => {
			try {
				const parsed = new URL(String(url || ''));
				if (!/(?:^|\.)arxiv\.org$/i.test(parsed.hostname) || !/^\/pdf\//i.test(parsed.pathname)) {
					return false;
				}

				const candidateId = getArxivPaperId(url);
				return stripArxivVersion(candidateId) === absRootId;
			} catch {
				return false;
			}
		}) || ''
	);
}

function readArxivMetaRow($, label = '') {
	const normalizedLabel = String(label || '')
		.trim()
		.toLowerCase();
	if (!normalizedLabel) return '';

	const rows = $('.metatable tr, table tr').toArray();
	for (const row of rows) {
		const cells = $(row).find('td, th');
		if (cells.length < 2) continue;

		const key = normalizeExtractedHtmlText($(cells[0]).text())
			.replace(/[:\s]+$/g, '')
			.toLowerCase();
		if (key !== normalizedLabel) continue;

		return normalizeExtractedHtmlText($(cells[1]).text());
	}

	return '';
}

export function extractArxivAbstractDetails(html = '', absUrl = '') {
	const rawHtml = String(html || '');
	if (!rawHtml.trim()) {
		return { text: '', title: '', pdfUrl: '' };
	}

	const $ = cheerio.load(rawHtml);
	const title = normalizeExtractedHtmlText(($('h1.title, h1.title.mathjax, .title').first().text() || '').replace(/^Title:\s*/i, ''));
	const authorLinks = $('.authors a')
		.toArray()
		.map((element) => normalizeExtractedHtmlText($(element).text()))
		.filter(Boolean);
	const authors = authorLinks.length ? authorLinks : [normalizeExtractedHtmlText(($('.authors').first().text() || '').replace(/^Authors?:\s*/i, ''))].filter(Boolean);
	const abstract = normalizeExtractedHtmlText(($('blockquote.abstract, .abstract.mathjax, .abstract').first().text() || '').replace(/^Abstract:\s*/i, ''));
	const comments = readArxivMetaRow($, 'Comments');
	const subjects = readArxivMetaRow($, 'Subjects');
	const reportNumber = readArxivMetaRow($, 'Report number');
	const citeAs = readArxivMetaRow($, 'Cite as');
	const doi = readArxivMetaRow($, 'DOI');
	const submitted = normalizeExtractedHtmlText($('.dateline').first().text());
	const pdfUrl = findMatchingArxivPdfUrl(extractSupportingDocumentLinks(rawHtml, absUrl), absUrl);

	const detailLines = [
		title ? `Title: ${title}` : '',
		authors.length ? `Authors: ${authors.join(', ')}` : '',
		submitted ? `Submitted: ${submitted}` : '',
		subjects ? `Subjects: ${subjects}` : '',
		comments ? `Comments: ${comments}` : '',
		reportNumber ? `Report number: ${reportNumber}` : '',
		citeAs ? `Cite as: ${citeAs}` : '',
		doi ? `DOI: ${doi}` : '',
		abstract ? `Abstract: ${abstract}` : '',
	].filter(Boolean);

	return {
		text: detailLines.join('\n'),
		title,
		pdfUrl,
	};
}

function combineArxivAbstractAndPdfText(detailsText = '', pdfText = '') {
	const preface = normalizeExtractedHtmlText(detailsText);
	const body = String(pdfText || '').trim();

	if (!preface) return body;
	if (!body) return preface;

	return `${preface}\n\n${body}`.trim();
}

function mergeImageContextCollections(existingContext = {}, incomingContext = {}) {
	const mergedEntries = [];
	const seen = new Set();

	for (const entry of [...(existingContext?.entries || []), ...(incomingContext?.entries || [])]) {
		const key = JSON.stringify(entry || {});
		if (!key || seen.has(key)) continue;
		seen.add(key);
		mergedEntries.push(entry);
	}

	const mergedRenderableEntries = dedupeImageEntries([...(existingContext?.renderableEntries || []), ...(incomingContext?.renderableEntries || [])]);
	const text = [existingContext?.text, incomingContext?.text]
		.filter(Boolean)
		.map((value) => normalizeExtractedHtmlText(value))
		.filter(Boolean)
		.filter((value, index, array) => array.findIndex((candidate) => candidate.toLowerCase() === value.toLowerCase()) === index)
		.join('\n');

	return {
		entries: mergedEntries.slice(0, MAX_IMAGE_CONTEXT_ENTRIES),
		renderableEntries: mergedRenderableEntries.slice(0, MAX_IMAGE_CONTEXT_ENTRIES),
		text,
	};
}

function dedupeImageEntries(entries = []) {
	const seen = new Set();
	return (Array.isArray(entries) ? entries : []).filter((entry) => {
		const src = String(entry?.src || '').trim();
		if (!src || seen.has(src)) return false;
		seen.add(src);
		return true;
	});
}

function isRepositoryPdfDownloadUrl(value = '') {
	const rawValue = String(value || '').trim();
	if (!rawValue) return false;

	try {
		const normalizedUrl = new URL(rawValue, 'https://example.com');
		const pathname = normalizedUrl.pathname.toLowerCase();
		const hostname = normalizedUrl.hostname.toLowerCase();

		if (/\/cgi\/viewcontent\.cgi$/i.test(pathname)) {
			return Boolean(
				normalizedUrl.searchParams.get('article') ||
				normalizedUrl.searchParams.get('filename') ||
				normalizedUrl.searchParams.get('context') ||
				/(?:surface\.|digitalcommons\.|bepress\.|commons\.)/i.test(hostname),
			);
		}

		return false;
	} catch {
		return /\/cgi\/viewcontent\.cgi(?:$|\?)/i.test(rawValue);
	}
}

function isPdfLikeUrl(value = '') {
	const rawValue = String(value || '').trim();
	if (!rawValue) return false;
	if (isRepositoryPdfDownloadUrl(rawValue)) return true;

	try {
		const normalizedUrl = new URL(rawValue, 'https://example.com');
		const pathname = normalizedUrl.pathname.toLowerCase();
		return /\.pdf$/i.test(pathname) || /\/pdf(?:\/|$)/i.test(pathname);
	} catch {
		const normalizedValue = rawValue.toLowerCase();
		return /\.pdf(?:$|[?#])/i.test(normalizedValue) || /\/pdf(?:\/|$)/i.test(normalizedValue);
	}
}

function scoreSupportingDocumentLink(label = '', url = '', baseUrl = '') {
	const normalizedLabel = String(label || '').toLowerCase();
	let score = 0;

	if (isPdfLikeUrl(url)) score += 4;
	if (isRepositoryPdfDownloadUrl(url)) score += 2;
	if (/\b(view|download|full text|paper|manuscript)\b/.test(normalizedLabel)) score += 2;
	if (/\bpdf\b/.test(normalizedLabel)) score += 2;

	try {
		const candidateHost = new URL(url).hostname;
		const baseHost = new URL(baseUrl).hostname;
		if (candidateHost === baseHost) score += 1;
	} catch {
		// Ignore malformed hosts here; resolution happens before scoring.
	}

	return score;
}

export function extractSupportingDocumentLinks(html = '', baseUrl = '') {
	const rawHtml = String(html || '');
	if (!rawHtml.trim()) return [];

	const $ = cheerio.load(rawHtml);
	const matches = [];
	const seen = new Set();

	$('a[href]').each((_, element) => {
		const href = $(element).attr('href') || '';
		const resolved = resolveUrl(baseUrl, href);
		if (!resolved || !/^https?:/i.test(resolved)) return;

		const label = [$(element).text(), $(element).attr('title'), $(element).attr('aria-label')].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

		const looksLikeSupportingDoc =
			isPdfLikeUrl(resolved) ||
			(isRepositoryPdfDownloadUrl(resolved) && /\b(view|download|full text|paper|manuscript)\b/i.test(label)) ||
			(/\bpdf\b/i.test(label) && /\b(view|download|paper|full text|manuscript)\b/i.test(label));
		if (!looksLikeSupportingDoc) return;
		if (seen.has(resolved)) return;

		seen.add(resolved);
		matches.push({
			url: resolved,
			label,
			score: scoreSupportingDocumentLink(label, resolved, baseUrl),
		});
	});

	return matches
		.sort((left, right) => right.score - left.score || left.url.localeCompare(right.url))
		.slice(0, MAX_SUPPORTING_DOC_LINKS)
		.map((match) => match.url);
}

function buildImageContextLabel(entry = {}) {
	const parts = [];
	if (entry.caption) parts.push(`Figure: ${entry.caption}`);
	return parts.join('\n');
}

function extractMetadataImageEntries(html = '', baseUrl = '') {
	const rawHtml = String(html || '');
	if (!rawHtml.trim()) return [];

	const $ = cheerio.load(rawHtml);
	const pageTitle = normalizeExtractedHtmlText(
		$('meta[property="og:title"]').attr('content') || $('meta[name="twitter:title"]').attr('content') || $('title').first().text() || '',
	);
	const pageDescription = normalizeExtractedHtmlText(
		$('meta[property="og:description"]').attr('content') || $('meta[name="twitter:description"]').attr('content') || $('meta[name="description"]').attr('content') || '',
	);
	const imageAlt = normalizeExtractedHtmlText($('meta[property="og:image:alt"]').attr('content') || $('meta[name="twitter:image:alt"]').attr('content') || '');
	const selectors = ['meta[property="og:image"]', 'meta[property="og:image:url"]', 'meta[name="twitter:image"]', 'meta[name="twitter:image:src"]', 'link[rel="image_src"]'];
	const seen = new Set();
	const entries = [];

	for (const selector of selectors) {
		$(selector).each((_, element) => {
			const node = $(element);
			const src = resolveUrl(baseUrl, node.attr('content') || node.attr('href') || '');
			if (!src || seen.has(src)) return;

			const entry = {
				src,
				alt: imageAlt || pageTitle || 'Referenced page image',
				title: pageTitle,
				caption: pageDescription,
			};
			if (isNonContentImageEntry(entry)) return;

			seen.add(src);
			entries.push(entry);
		});
	}

	return entries;
}

function normalizeImageDescriptor(entry = {}) {
	return [entry.alt, entry.title, entry.caption, entry.src]
		.filter(Boolean)
		.map((value) => normalizeExtractedHtmlText(value))
		.join(' ')
		.trim();
}

function isNonContentImageEntry(entry = {}) {
	const descriptor = normalizeImageDescriptor(entry);
	const src = String(entry?.src || '').trim();
	if (!descriptor && !src) return true;
	if (NON_CONTENT_IMAGE_TEXT_RE.test(descriptor)) return true;
	if (NON_CONTENT_IMAGE_MARKETING_TEXT_RE.test(descriptor)) return true;
	if (NON_CONTENT_IMAGE_SRC_RE.test(src)) return true;
	if (NON_CONTENT_IMAGE_FILENAME_RE.test(src)) return true;
	if (NON_CONTENT_IMAGE_FILENAME_RE.test(descriptor)) return true;
	return false;
}

function isExcludedImageContextNode(node, image) {
	if (image.closest('header, footer, nav, aside, form, [role="navigation"], [role="banner"], [role="contentinfo"]').length) {
		return true;
	}

	if (
		image.closest(
			'[class*="header" i], [id*="header" i], [class*="footer" i], [id*="footer" i], [class*="nav" i], [id*="nav" i], [class*="menu" i], [id*="menu" i], [class*="social" i], [id*="social" i], [class*="share" i], [id*="share" i], [class*="logo" i], [id*="logo" i], [class*="breadcrumb" i], [id*="breadcrumb" i], [class*="pager" i], [id*="pager" i], [class*="pagination" i], [id*="pagination" i], [class*="toolbar" i], [id*="toolbar" i], [class*="masthead" i], [id*="masthead" i], [class*="site-header" i], [id*="site-header" i], [class*="site-footer" i], [id*="site-footer" i]',
		).length
	) {
		return true;
	}

	if (!node.is('figure') && !image.closest('figure').length) {
		const mainAncestor = image.closest('main, article, [role="main"], .article, .content, .entry-content, .main-content');
		if (!mainAncestor.length) {
			const descriptor = normalizeExtractedHtmlText([image.attr('alt'), image.attr('title'), image.attr('aria-label')].filter(Boolean).join(' '));
			if (descriptor.length < 8) return true;
		}
	}

	return false;
}

function isLikelyRenderableImageSource(value = '') {
	const normalized = String(value || '').trim();
	if (!normalized) return false;
	if (/^data:/i.test(normalized)) return false;

	try {
		const url = new URL(normalized, 'https://example.com');
		const pathname = url.pathname.toLowerCase();
		return /\.(?:png|jpe?g|webp|gif|svg)(?:$|[?#])/.test(pathname) || /^https?:$/i.test(url.protocol);
	} catch {
		return /\.(?:png|jpe?g|webp|gif|svg)(?:$|[?#])/i.test(normalized);
	}
}

function normalizeImageMimeType(contentType = '', src = '') {
	const normalizedType = String(contentType || '')
		.split(';')[0]
		.trim()
		.toLowerCase();
	if (normalizedType.startsWith('image/')) return normalizedType;

	const normalizedSrc = String(src || '').toLowerCase();
	if (/\.jpe?g(?:$|[?#])/.test(normalizedSrc)) return 'image/jpeg';
	if (/\.png(?:$|[?#])/.test(normalizedSrc)) return 'image/png';
	if (/\.webp(?:$|[?#])/.test(normalizedSrc)) return 'image/webp';
	if (/\.gif(?:$|[?#])/.test(normalizedSrc)) return 'image/gif';
	if (/\.svg(?:$|[?#])/.test(normalizedSrc)) return 'image/svg+xml';
	if (/\.avif(?:$|[?#])/.test(normalizedSrc)) return 'image/avif';
	return '';
}

function isPhotoLikeImageType(contentType = '', src = '') {
	const mimeType = normalizeImageMimeType(contentType, src);
	return /^(?:image\/jpeg|image\/jpg|image\/webp|image\/avif|image\/heic|image\/heif)$/i.test(mimeType);
}

function escapeSvgText(value = '') {
	return String(value || '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function toSvgDataUri(markup = '') {
	return `data:image/svg+xml;base64,${Buffer.from(String(markup || ''), 'utf8').toString('base64')}`;
}

function buildSvgImageRepresentation(dataUri = '', entry = {}) {
	const title = escapeSvgText(entry?.alt || entry?.title || entry?.caption || 'Embedded document image');
	const description = escapeSvgText(entry?.caption || entry?.title || entry?.originUrl || 'Embedded document figure');
	const svgMarkup = `
		<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900" role="img" aria-label="${title}">
			<title>${title}</title>
			<desc>${description}</desc>
			<rect width="1200" height="900" fill="#ffffff" />
			<image href="${dataUri}" x="0" y="0" width="1200" height="900" preserveAspectRatio="xMidYMid meet" />
		</svg>
	`;

	return toSvgDataUri(svgMarkup);
}

export function createEmbeddedImageAsset(entry = {}, options = {}) {
	const originalSrc = String(entry?.src || '').trim();
	const buffer = Buffer.isBuffer(options?.buffer) ? options.buffer : Buffer.from(options?.buffer || []);
	if (!originalSrc || !buffer.length) return null;

	const mimeType = normalizeImageMimeType(options?.contentType, originalSrc);
	if (!mimeType.startsWith('image/')) return null;

	const base64DataUri = `data:${mimeType};base64,${buffer.toString('base64')}`;
	const embeddedSrc = isPhotoLikeImageType(mimeType, originalSrc) ? base64DataUri : buildSvgImageRepresentation(base64DataUri, entry);

	return {
		...entry,
		src: embeddedSrc,
		originUrl: normalizeExtractedHtmlText(entry?.originUrl || originalSrc),
		contentType: mimeType,
		embedded: true,
		embeddedFormat: isPhotoLikeImageType(mimeType, originalSrc) ? 'base64' : 'svg',
	};
}

async function embedImageAsset(entry = {}) {
	const src = String(entry?.src || '').trim();
	if (!src || /^data:/i.test(src)) {
		return src ? { ...entry, embedded: /^data:/i.test(src), embeddedFormat: /^data:image\/svg\+xml/i.test(src) ? 'svg' : 'base64' } : null;
	}

	try {
		const response = await fetchBinaryResponse(src);
		return createEmbeddedImageAsset(entry, response) || { ...entry, originUrl: normalizeExtractedHtmlText(entry?.originUrl || src) };
	} catch (error) {
		logger.debug('Image embedding skipped', {
			src,
			error: error.message,
		});
		return { ...entry, originUrl: normalizeExtractedHtmlText(entry?.originUrl || src) };
	}
}

async function embedRenderableImageAssets(entries = []) {
	const embeddedAssets = await Promise.all((Array.isArray(entries) ? entries : []).map((entry) => embedImageAsset(entry)));
	return embeddedAssets.filter((entry) => entry?.src).slice(0, MAX_IMAGE_CONTEXT_ENTRIES);
}

function createImageAsset(entry = {}, fallbackAlt = '') {
	const src = String(entry?.src || '').trim();
	if (!isLikelyRenderableImageSource(src)) return null;

	const alt = normalizeExtractedHtmlText(entry?.alt || entry?.caption || entry?.title || fallbackAlt || 'Document image');
	const caption = normalizeExtractedHtmlText(entry?.caption || entry?.title || entry?.alt || '');

	return {
		src,
		alt,
		caption,
		title: normalizeExtractedHtmlText(entry?.title || ''),
		originUrl: normalizeExtractedHtmlText(entry?.originUrl || ''),
	};
}

function getRenderableImageAssets(entries = [], fallbackAlt = '') {
	const seen = new Set();
	const assets = [];

	for (const entry of Array.isArray(entries) ? entries : []) {
		if (isNonContentImageEntry(entry)) continue;
		const asset = createImageAsset(entry, fallbackAlt);
		if (!asset?.src || seen.has(asset.src)) continue;
		seen.add(asset.src);
		assets.push(asset);
	}

	return assets.slice(0, MAX_IMAGE_CONTEXT_ENTRIES);
}

function resolveBrowserExecutablePath() {
	return (
		BROWSER_EXECUTABLE_CANDIDATES.find((candidate) => {
			try {
				return candidate && existsSync(candidate);
			} catch {
				return false;
			}
		}) || null
	);
}

export function extractArxivHtmlUrlFromAbsHtml(html = '', absUrl = '') {
	const rawHtml = String(html || '');
	if (!rawHtml.trim()) return '';

	const $ = cheerio.load(rawHtml);
	const href =
		$('a[href*="/html/"]')
			.filter((_, element) => /html/i.test($(element).text()) || /experimental/i.test($(element).text()) || /\/html\//i.test($(element).attr('href') || ''))
			.first()
			.attr('href') || '';

	return resolveUrl(absUrl, href);
}

async function resolveRelatedHtmlUrlForPdf(url = '') {
	try {
		const parsed = new URL(url);
		if (!/arxiv\.org$/i.test(parsed.hostname)) return '';

		const match = parsed.pathname.match(/^\/pdf\/([^/?#]+?)(?:\.pdf)?$/i);
		if (!match?.[1]) return '';

		const paperId = match[1];
		if (/v\d+$/i.test(paperId)) {
			return `https://arxiv.org/html/${paperId}`;
		}

		const absUrl = `https://arxiv.org/abs/${paperId}`;
		const absHtml = await fetchText(absUrl);
		return extractArxivHtmlUrlFromAbsHtml(absHtml, absUrl) || `https://ar5iv.labs.arxiv.org/html/${paperId}`;
	} catch {
		return '';
	}
}

async function extractRelatedFigureContextForPdf(url = '') {
	const htmlUrl = await resolveRelatedHtmlUrlForPdf(url);
	if (!htmlUrl) {
		return { entries: [], renderableEntries: [], text: '' };
	}

	try {
		const html = await fetchText(htmlUrl);
		const imageContext = extractImageContextMetadata(html, htmlUrl);
		return {
			...imageContext,
			renderableEntries: await embedRenderableImageAssets(imageContext.renderableEntries || []),
		};
	} catch (error) {
		logger.debug('Related PDF figure context skipped', {
			url,
			htmlUrl,
			error: error.message,
		});
		return { entries: [], renderableEntries: [], text: '' };
	}
}

async function generatePdfPreviewImage(url = '') {
	let browser;

	try {
		browser = await puppeteer.launch({
			headless: true,
			executablePath: resolveBrowserExecutablePath() || undefined,
			args: ['--no-sandbox', '--disable-setuid-sandbox'],
		});

		const page = await browser.newPage();
		await page.setViewport({ width: 1280, height: 1720, deviceScaleFactor: 1 });
		await page.goto(url, {
			waitUntil: 'networkidle2',
			timeout: PDF_PREVIEW_TIMEOUT_MS,
		});

		await page
			.waitForSelector('embed[type="application/pdf"], iframe, canvas, body', {
				timeout: 4000,
			})
			.catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 900));

		const buffer = await page.screenshot({
			type: 'jpeg',
			quality: PDF_PREVIEW_IMAGE_QUALITY,
			fullPage: false,
		});

		if (!buffer?.length) return null;

		return {
			src: `data:image/jpeg;base64,${buffer.toString('base64')}`,
			alt: 'PDF first-page preview',
			caption: 'Preview generated from the first page of the PDF.',
			originUrl: url,
		};
	} catch (error) {
		logger.debug('PDF preview generation skipped', {
			url,
			error: error.message,
		});
		return null;
	} finally {
		if (browser) {
			await browser.close().catch(() => {});
		}
	}
}

export function extractImageContextMetadata(html = '', baseUrl = '') {
	const rawHtml = String(html || '');
	if (!rawHtml.trim()) {
		return { entries: [], renderableEntries: [], text: '' };
	}

	const $ = cheerio.load(rawHtml);
	const entries = [...extractMetadataImageEntries(rawHtml, baseUrl)];
	const seen = new Set();
	for (const entry of entries) {
		seen.add(JSON.stringify(entry));
	}

	$('figure, img').each((_, element) => {
		const node = $(element);
		const image = node.is('img') ? node : node.find('img').first();
		if (!image.length) return;
		if (isExcludedImageContextNode(node, image)) return;

		const src = resolveUrl(baseUrl, image.attr('src') || image.attr('data-src') || '');
		const alt = normalizeExtractedHtmlText(image.attr('alt') || image.attr('aria-label') || '');
		const title = normalizeExtractedHtmlText(image.attr('title') || '');
		const caption = normalizeExtractedHtmlText(
			node.find('figcaption').first().text() || node.attr('data-caption') || node.attr('aria-label') || image.closest('figure').find('figcaption').first().text() || '',
		);

		if (!src && !alt && !title && !caption) return;

		const candidateEntry = { src, alt, title, caption };
		if (isNonContentImageEntry(candidateEntry)) return;

		const key = JSON.stringify(candidateEntry);
		if (seen.has(key)) return;
		seen.add(key);

		entries.push(candidateEntry);
	});

	const text = entries
		.map((entry) => buildImageContextLabel(entry))
		.filter(Boolean)
		.slice(0, MAX_IMAGE_CONTEXT_ENTRIES)
		.join('\n');

	return {
		entries: entries.slice(0, MAX_IMAGE_CONTEXT_ENTRIES),
		renderableEntries: getRenderableImageAssets(entries, 'Referenced page image'),
		text,
	};
}

function extractReadableHtmlText(html = '', url = '', dataLayerText = '', imageContextText = '') {
	const rawHtml = stripStyleAndScriptBlocks(String(html || ''));
	if (!rawHtml.trim()) return '';

	try {
		const dom = new JSDOM(rawHtml, { url });
		const reader = new Readability(dom.window.document);
		const article = reader.parse();
		const articleText = appendSupplementalText(appendDataLayerText(article?.textContent || '', dataLayerText), imageContextText);
		if (articleText.length >= 240) {
			return articleText;
		}
	} catch (error) {
		logger.debug('Readability extraction fallback', {
			url,
			error: error.message,
		});
	}

	const $ = cheerio.load(rawHtml);
	$('script, style, noscript, svg, iframe, form, nav, footer, header, aside').remove();

	const selectorCandidates = ['main article', 'article', 'main', "[role='main']", '.article', '.post', '.content', '.entry-content', '.main-content'];

	for (const selector of selectorCandidates) {
		const text = appendSupplementalText(appendDataLayerText($(selector).first().text(), dataLayerText), imageContextText);
		if (text.length >= 240) {
			return text;
		}
	}
	return appendSupplementalText(appendDataLayerText($('body').text(), dataLayerText), imageContextText);
}

// ─── Per-format parsers ───────────────────────────────────────────────────────

async function parsePDF(url) {
	const buf = await fetchBinary(url);
	const data = await pdfParse(buf);
	const imageContext = await extractRelatedFigureContextForPdf(url);
	const previewImage = imageContext.renderableEntries?.length ? null : await generatePdfPreviewImage(url);
	return {
		text: data.text,
		previewImage,
		imageContext,
	};
}

async function parseDOCX(url) {
	const buf = await fetchBinary(url);
	const result = await mammoth.extractRawText({ buffer: buf });
	return result.value;
}

function resolveUrl(baseUrl, href = '') {
	const rawHref = String(href || '').trim();
	if (!rawHref) return '';

	try {
		const base = new URL(baseUrl);
		if (!/^(?:[a-z]+:|\/|#|\?)/i.test(rawHref)) {
			const paperHtmlPathMatch = base.pathname.match(/^(\/html\/[^/]+)(?:\/)?$/i);
			if (paperHtmlPathMatch?.[1]) {
				return new URL(`${paperHtmlPathMatch[1]}/${rawHref}`, base.origin).toString();
			}
		}

		return new URL(rawHref, base).toString();
	} catch {
		return '';
	}
}

function sanitizeYouTubeVideoId(value = '') {
	const normalized = String(value || '').trim();
	return /^[a-zA-Z0-9_-]{6,}$/.test(normalized) ? normalized : '';
}

function extractYouTubeVideoIdFromUrl(value = '') {
	const normalized = String(value || '').trim();
	if (!normalized) return '';

	try {
		const url = new URL(normalized);
		const host = url.hostname.toLowerCase();
		if (host === 'youtu.be' || host.endsWith('.youtu.be')) {
			return sanitizeYouTubeVideoId(url.pathname.split('/').filter(Boolean)[0] || '');
		}
		if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
			if (url.pathname === '/watch') {
				return sanitizeYouTubeVideoId(url.searchParams.get('v') || '');
			}
			if (url.pathname.startsWith('/embed/')) {
				return sanitizeYouTubeVideoId(url.pathname.split('/')[2] || '');
			}
			if (url.pathname.startsWith('/shorts/')) {
				return sanitizeYouTubeVideoId(url.pathname.split('/')[2] || '');
			}
		}
	} catch {
		return '';
	}

	return '';
}

function normalizeYouTubeLink(videoId = '') {
	const sanitizedId = sanitizeYouTubeVideoId(videoId);
	return sanitizedId ? `https://www.youtube.com/watch?v=${sanitizedId}` : '';
}

function extractYouTubeLinks(html = '', baseUrl = '') {
	const rawHtml = String(html || '');
	if (!rawHtml.trim()) return [];

	const $ = cheerio.load(rawHtml);
	const matches = [];
	const seen = new Set();

	$('a[href], iframe[src], source[src]').each((_, element) => {
		const node = $(element);
		const rawSrc = node.attr('href') || node.attr('src') || node.attr('data-src') || '';
		const resolved = resolveUrl(baseUrl, rawSrc);
		if (!resolved) return;

		const videoId = extractYouTubeVideoIdFromUrl(resolved);
		if (!videoId) return;

		const normalized = normalizeYouTubeLink(videoId);
		if (!normalized || seen.has(normalized)) return;

		seen.add(normalized);
		matches.push(normalized);
	});

	return matches.slice(0, 3);
}

function isPaginationLink(text = '', href = '') {
	const normalizedText = String(text || '')
		.toLowerCase()
		.trim();
	const normalizedHref = String(href || '').toLowerCase();

	return (
		/^(next|next page|older|more|›|»|→)$/i.test(normalizedText) ||
		normalizedText.includes('next') ||
		/[?&](page|p|pg|start|offset|idx)=/.test(normalizedHref) ||
		/\/page\//.test(normalizedHref)
	);
}

function findNextPageUrl($, currentUrl) {
	const candidates = $('link[rel="next"], a[rel="next"], a[aria-label*="next" i], .pagination a, .pager a, nav a').toArray();

	for (const candidate of candidates) {
		const element = $(candidate);
		const href = element.attr('href') || '';
		const resolved = resolveUrl(currentUrl, href);
		const label = [element.text(), element.attr('aria-label'), element.attr('title'), element.attr('class')].filter(Boolean).join(' ');

		if (!resolved) continue;

		try {
			const currentHost = new URL(currentUrl).hostname;
			const nextHost = new URL(resolved).hostname;
			if (currentHost !== nextHost) continue;
		} catch {
			continue;
		}

		if (isPaginationLink(label, resolved)) {
			return resolved;
		}
	}

	return '';
}

async function parseHTML(url) {
	const visited = new Set();
	const chunks = [];
	const dataLayerEntries = [];
	const seenDataLayerEntries = new Set();
	const supportingDocUrls = [];
	const seenSupportingDocUrls = new Set();
	const imageEntries = [];
	const seenImageEntries = new Set();
	const videoLinks = [];
	const seenVideoLinks = new Set();
	let previewImage = null;
	let currentUrl = url;

	while (currentUrl && !visited.has(currentUrl) && visited.size < MAX_HTML_PAGINATION_PAGES) {
		visited.add(currentUrl);

		try {
			const html = await fetchText(currentUrl);
			const dataLayer = extractDataLayerMetadata(html);
			const imageContext = extractImageContextMetadata(html, currentUrl);
			const discoveredVideoLinks = extractYouTubeLinks(html, currentUrl);
			const discoveredSupportingDocs = extractSupportingDocumentLinks(html, currentUrl);
			const arxivAbstractDetails = isArxivAbstractUrl(currentUrl) ? extractArxivAbstractDetails(html, currentUrl) : { text: '', pdfUrl: '' };

			for (const entry of dataLayer.entries || []) {
				const key = JSON.stringify(entry);
				if (!key || seenDataLayerEntries.has(key)) continue;
				seenDataLayerEntries.add(key);
				dataLayerEntries.push(entry);
			}

			for (const entry of imageContext.entries || []) {
				const key = JSON.stringify(entry);
				if (!key || seenImageEntries.has(key)) continue;
				seenImageEntries.add(key);
				imageEntries.push(entry);
			}

			for (const link of discoveredVideoLinks) {
				if (!link || seenVideoLinks.has(link)) continue;
				seenVideoLinks.add(link);
				videoLinks.push(link);
			}

			for (const supportingDocUrl of discoveredSupportingDocs) {
				if (supportingDocUrl && supportingDocUrl === arxivAbstractDetails.pdfUrl) continue;
				if (!supportingDocUrl || seenSupportingDocUrls.has(supportingDocUrl)) continue;
				seenSupportingDocUrls.add(supportingDocUrl);
				supportingDocUrls.push(supportingDocUrl);
			}

			let text = extractReadableHtmlText(html, currentUrl, dataLayer.text, imageContext.text);
			let mergedImageContext = imageContext;
			let mergedPreviewImage = null;

			if (arxivAbstractDetails.pdfUrl) {
				const parsedPdf = await parsePDF(arxivAbstractDetails.pdfUrl);
				text = combineArxivAbstractAndPdfText(arxivAbstractDetails.text, parsedPdf.text);
				mergedImageContext = mergeImageContextCollections(imageContext, parsedPdf.imageContext);
				mergedPreviewImage = parsedPdf.previewImage || null;
			}
			if (text) {
				chunks.push(text.slice(0, MAX_HTML_TEXT_CHARS));
			}

			for (const entry of mergedImageContext.entries || []) {
				const key = JSON.stringify(entry);
				if (!key || seenImageEntries.has(key)) continue;
				seenImageEntries.add(key);
				imageEntries.push(entry);
			}

			if (mergedPreviewImage?.src) {
				previewImage = previewImage || mergedPreviewImage;
				const key = JSON.stringify(mergedPreviewImage);
				if (!key || !seenImageEntries.has(key)) {
					seenImageEntries.add(key);
					imageEntries.push(mergedPreviewImage);
				}
			}

			const $ = cheerio.load(html);
			$('script, style, noscript').remove();

			const nextUrl = findNextPageUrl($, currentUrl);
			if (!nextUrl || visited.has(nextUrl)) {
				break;
			}

			currentUrl = nextUrl;
		} catch (err) {
			if (!chunks.length) throw err;
			logger.debug('HTML pagination stopped', {
				url: currentUrl,
				error: err.message,
			});
			break;
		}
	}

	logger.debug('HTML pages scanned', { startUrl: url, pages: visited.size });
	const dataLayerText = dataLayerEntries
		.flatMap((entry) => entryToDataLayerLines(entry))
		.filter(Boolean)
		.slice(0, 20)
		.join('\n');
	const imageContextText = imageEntries
		.map((entry) => buildImageContextLabel(entry))
		.filter(Boolean)
		.slice(0, MAX_IMAGE_CONTEXT_ENTRIES)
		.join('\n');
	const renderableImageEntries = getRenderableImageAssets(imageEntries, 'Referenced page image');
	const embeddedRenderableImageEntries = await embedRenderableImageAssets(renderableImageEntries);

	const supportingDocs = supportingDocUrls.length ? await parseDocuments(supportingDocUrls.slice(0, MAX_SUPPORTING_DOC_LINKS)) : [];
	for (const document of supportingDocs) {
		for (const entry of [...(document?.imageContext?.entries || []), ...(document?.imageContext?.renderableEntries || [])]) {
			const key = JSON.stringify(entry);
			if (!key || seenImageEntries.has(key)) continue;
			seenImageEntries.add(key);
			imageEntries.push(entry);
		}

		if (!previewImage && document?.previewImage?.src) {
			previewImage = document.previewImage;
			const key = JSON.stringify(document.previewImage);
			if (key && !seenImageEntries.has(key)) {
				seenImageEntries.add(key);
				imageEntries.push(document.previewImage);
			}
		}
	}

	const finalImageContextText = imageEntries
		.map((entry) => buildImageContextLabel(entry))
		.filter(Boolean)
		.slice(0, MAX_IMAGE_CONTEXT_ENTRIES)
		.join('\n');
	const finalRenderableImageEntries = getRenderableImageAssets(imageEntries, 'Referenced page image');
	const finalEmbeddedRenderableImageEntries = await embedRenderableImageAssets(finalRenderableImageEntries);
	const primaryPreviewImage = previewImage || finalEmbeddedRenderableImageEntries[0] || null;
	const supportingDocText = supportingDocs
		.map((document) => normalizeExtractedHtmlText(document?.text || '').slice(0, MAX_SUPPORTING_DOC_TEXT_CHARS))
		.filter(Boolean)
		.join('\n\n');
	const videoText = videoLinks.length ? videoLinks.map((link) => `Video: ${link}`).join('\n') : '';

	return {
		text: [chunks.join('\n\n'), supportingDocText, videoText].filter(Boolean).join('\n\n'),
		dataLayer: {
			entries: dataLayerEntries.slice(0, 12),
			text: dataLayerText,
		},
		previewImage,
		imageContext: {
			entries: imageEntries.slice(0, MAX_IMAGE_CONTEXT_ENTRIES),
			renderableEntries: finalEmbeddedRenderableImageEntries,
			text: finalImageContextText,
		},
		previewImage: primaryPreviewImage,
		supportingDocuments: {
			urls: supportingDocUrls.slice(0, MAX_SUPPORTING_DOC_LINKS),
			documents: supportingDocs.map((document) => ({
				url: document.url,
				text: normalizeExtractedHtmlText(document.text || '').slice(0, MAX_SUPPORTING_DOC_TEXT_CHARS),
				previewImage: document.previewImage || null,
				imageContext: document.imageContext || { entries: [], renderableEntries: [], text: '' },
			})),
		},
	};
}

// ─── Public interface ─────────────────────────────────────────────────────────

/**
 * Determines type from URL or Content-Type and extracts text + entities.
 * @param {string} url
 * @returns {{ url, text, entities }}
 */
export async function parseDocument(url) {
	const lower = url.toLowerCase();
	let text = '';
	let dataLayer = { entries: [], text: '' };
	let imageContext = { entries: [], renderableEntries: [], text: '' };
	let supportingDocuments = { urls: [], documents: [] };
	let previewImage = null;
	let blocked = false;
	let blockedReason = '';

	try {
		if (isPdfLikeUrl(url) || lower.endsWith('.pdf') || lower.includes('/pdf')) {
			const parsedPdf = await parsePDF(url);
			text = parsedPdf.text;
			previewImage = parsedPdf.previewImage;
			imageContext = parsedPdf.imageContext || imageContext;
		} else if (lower.endsWith('.docx')) {
			text = await parseDOCX(url);
		} else {
			const parsedHtml = await parseHTML(url);
			text = parsedHtml.text;
			dataLayer = parsedHtml.dataLayer || dataLayer;
			previewImage = parsedHtml.previewImage || previewImage;
			imageContext = parsedHtml.imageContext || imageContext;
			supportingDocuments = parsedHtml.supportingDocuments || supportingDocuments;
		}
	} catch (err) {
		logger.error('Document parse error', { url, error: err.message });
		return {
			url,
			text: '',
			blocked: false,
			blockedReason: '',
			entities: { phones: [], emails: [], addresses: [] },
			dataLayer,
			imageContext,
			supportingDocuments,
			previewImage,
			publicRecordList: { listType: '', state: '', entries: [] },
		};
	}

	const blockedAssessment = detectBlockedDocument(text, url);
	blocked = blockedAssessment.blocked;
	blockedReason = blockedAssessment.reason;
	const language = detectLikelyTextLanguage(text);

	const publicRecordList = extractPublicRecordEntries(text, url);
	logger.debug('Parsed document', { url, chars: text.length, blocked, blockedReason });
	return {
		url,
		text,
		language,
		blocked,
		blockedReason,
		entities: extractEntitiesFromText(text),
		dataLayer,
		imageContext,
		supportingDocuments,
		previewImage,
		publicRecordList,
	};
}

/**
 * Parses an array of document URLs in parallel (max 5 concurrent).
 * @param {string[]} urls
 * @returns {Promise<Array>}
 */
export async function parseDocuments(urls) {
	const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_REQUESTS) || 5;
	const results = [];

	for (let i = 0; i < urls.length; i += MAX_CONCURRENT) {
		const batch = urls.slice(i, i + MAX_CONCURRENT);
		const settled = await Promise.allSettled(batch.map((u) => parseDocument(u)));
		for (const r of settled) {
			if (r.status === 'fulfilled') results.push(r.value);
		}
	}

	return results;
}
