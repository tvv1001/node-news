/**
 * directorySearch.js
 *
 * Scrapes publicly accessible people-directory pages to extract profile data.
 * Uses Puppeteer for JS-rendered pages and Cheerio for static HTML.
 *
 * Directories targeted:
 *  - That'sThem (static HTML)
 *  - WhitePages (JS-rendered via Puppeteer)
 *  - Direct Zillow property pages
 *
 * IMPORTANT: Only public, non-authenticated data is accessed.
 * All requests include rate-limiting delays to be a good citizen.
 */

import { readFileSync } from 'node:fs';
import axios from 'axios';
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer';
import { canonicalizeLocation, getKnownStates, inferLocationByAddress, isKnownCityName, locationMatches, normalizeStateValue } from '../../utils/locationIndex.js';
import { logger } from '../../utils/logger.js';

const TIMEOUT = Number(process.env.REQUEST_TIMEOUT_MS) || 15000;
const DELAY_MS = 2000; // courtesy delay between requests

const HEADERS = {
	'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
	'Accept-Language': 'en-US,en;q=0.9',
	'Accept': 'text/html,application/xhtml+xml',
};
const DEFAULT_NAME_ONLY_STATE_ABBREVIATIONS = ['TX', 'OK', 'NY', 'NM'];
const DIRECTORY_RESULT_TARGET = Number(process.env.DIRECTORY_RESULT_TARGET) || 3;
const WHITEPAGES_BLOCKED_HTML_THRESHOLD = Number(process.env.WHITEPAGES_BLOCKED_HTML_THRESHOLD) || 5000;
const BLOCKED_BROWSER_RESOURCE_TYPES = new Set(['stylesheet', 'script', 'font']);
const ALL_STATE_ABBREVIATIONS = [
	...new Set(
		getKnownStates()
			.map((stateName) => normalizeStateValue(stateName))
			.filter(Boolean),
	),
];

function getCrawlerStateTerms(state = '') {
	const normalizedState = normalizeStateValue(state);
	if (normalizedState) return [normalizedState];

	return [...new Set([...DEFAULT_NAME_ONLY_STATE_ABBREVIATIONS, ...ALL_STATE_ABBREVIATIONS])].filter(Boolean).slice(0, 8);
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

async function scrollPageToBottom(page) {
	await page.evaluate(async () => {
		const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

		let lastHeight = 0;
		let lastScrollY = -1;
		let stablePasses = 0;

		for (let pass = 0; pass < 40; pass += 1) {
			const scrollHeight = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
			const currentY = window.scrollY || window.pageYOffset || 0;
			const step = Math.max(Math.floor(window.innerHeight * 0.9), 400);

			window.scrollTo(0, Math.min(currentY + step, scrollHeight));
			await wait(350);

			const updatedHeight = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
			const updatedY = window.scrollY || window.pageYOffset || 0;
			const atBottom = updatedY + window.innerHeight >= updatedHeight - 4;

			if (updatedHeight === lastHeight && updatedY === lastScrollY && atBottom) {
				stablePasses += 1;
			} else {
				stablePasses = 0;
				lastHeight = updatedHeight;
				lastScrollY = updatedY;
			}

			if (stablePasses >= 6) break;
		}

		window.scrollTo(0, Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0));
		await wait(1200);
	});
}

async function fetchRenderedDirectoryPage(url) {
	let browser;

	try {
		browser = await puppeteer.launch({
			headless: true,
			args: ['--no-sandbox', '--disable-setuid-sandbox'],
		});

		const page = await browser.newPage();
		await blockBrowserAssetRequests(page);
		await page.setUserAgent(HEADERS['User-Agent']);
		await page.setExtraHTTPHeaders({
			'Accept-Language': HEADERS['Accept-Language'],
			'Accept': HEADERS.Accept,
			'Referer': 'https://www.google.com/',
		});

		await page.goto(url, {
			waitUntil: 'domcontentloaded',
			timeout: TIMEOUT,
		});

		await page
			.waitForSelector("h2, h3, [data-amp-label='WPClickedPersonResults']", {
				timeout: 5000,
			})
			.catch(() => {});

		await delay(2000);
		await scrollPageToBottom(page);
		await delay(1500);
		await page.waitForNetworkIdle({ idleTime: 800, timeout: 7000 }).catch(() => {});

		const html = await page.content();
		logger.debug('Browser-rendered directory page loaded', {
			url,
			htmlLength: html.length,
		});

		return html;
	} catch (err) {
		logger.debug('Browser-rendered directory fetch skipped', {
			url,
			error: err.message,
		});
		return '';
	} finally {
		if (browser) {
			await browser.close().catch(() => {});
		}
	}
}

function normalizeName(raw) {
	return String(raw || '')
		.replace(/\s+/g, ' ')
		.trim();
}

const COMMON_FIRST_NAME_GROUPS = [
	['william', 'bill', 'billy', 'will', 'willy'],
	['robert', 'rob', 'robb', 'bobby', 'bob', 'robbie'],
	['james', 'jim', 'jimmy', 'jamie'],
	['john', 'jon', 'jonathan', 'jonathon', 'johnny'],
	['michael', 'micheal', 'mike', 'mikey'],
	['steven', 'stephen', 'steve', 'stevenn'],
	['sara', 'sarah', 'shera'],
	['brian', 'bryan', 'bryon'],
	['katherine', 'catherine', 'kathryn', 'katharine', 'katie', 'kate', 'kathy'],
	['jennifer', 'jenifer', 'genifer', 'gennifer', 'jenniffer', 'jen', 'jenn', 'jenny', 'jennie', 'jenni'],
];

function normalizeToken(value = '') {
	return String(value || '')
		.toLowerCase()
		.replace(/[^a-z]/g, '')
		.trim();
}

function toTitleCase(value = '') {
	const normalized = String(value || '').trim();
	return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : '';
}

function getFirstNameVariants(name = '') {
	const base = normalizeToken(name);
	if (!base) return [];

	const variants = new Set([base]);

	for (const group of COMMON_FIRST_NAME_GROUPS) {
		if (group.includes(base)) {
			group.forEach((entry) => variants.add(entry));
		}
	}

	const collapsed = base.replace(/(.)\1+/g, '$1');
	if (collapsed) variants.add(collapsed);

	if (base.endsWith('y')) variants.add(`${base.slice(0, -1)}ie`);
	if (base.endsWith('ie')) variants.add(`${base.slice(0, -2)}y`);
	if (base.endsWith('i')) variants.add(`${base.slice(0, -1)}y`);
	if (base.includes('ph')) variants.add(base.replace(/ph/g, 'f'));
	if (base.includes('f')) variants.add(base.replace(/f/g, 'ph'));
	if (base.startsWith('j')) variants.add(`g${base.slice(1)}`);
	if (base.startsWith('g')) variants.add(`j${base.slice(1)}`);
	if (base.includes('ck')) variants.add(base.replace(/ck/g, 'k'));

	return [...variants].filter(Boolean);
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

function firstNameMatches(candidate = '', wanted = '') {
	if (!wanted) return true;

	const candidateNormalized = normalizeToken(candidate);
	if (!candidateNormalized) return false;

	return getFirstNameVariants(wanted).some((variant) => candidateNormalized === variant || isNearMiss(candidateNormalized, variant));
}

function middleNameMatches(candidate = '', wanted = '') {
	if (!wanted) return true;
	if (!candidate) return true;

	const candidateNormalized = normalizeToken(candidate);
	const wantedNormalized = normalizeToken(wanted);

	if (!candidateNormalized || !wantedNormalized) return true;

	return (
		candidateNormalized === wantedNormalized ||
		candidateNormalized.startsWith(wantedNormalized) ||
		wantedNormalized.startsWith(candidateNormalized) ||
		candidateNormalized[0] === wantedNormalized[0]
	);
}

function lastNameMatches(candidate = '', wanted = '') {
	if (!wanted) return true;
	const candidateNormalized = normalizeToken(candidate);
	const wantedNormalized = normalizeToken(wanted);

	if (!candidateNormalized || !wantedNormalized) return false;
	return candidateNormalized === wantedNormalized || isNearMiss(candidateNormalized, wantedNormalized);
}

function buildFullNameCombos({ firstName = '', middleName = '', lastName = '' }) {
	const firstVariants = getFirstNameVariants(firstName);
	const middleVariants = new Set(['']);

	if (middleName) {
		middleVariants.add(normalizeName(middleName));
		middleVariants.add(normalizeName(middleName).charAt(0));
	}

	const combos = [];
	for (const first of firstVariants.length ? firstVariants : [firstName]) {
		for (const middle of middleVariants) {
			const fullName = [toTitleCase(first), middle, lastName].filter(Boolean).join(' ');
			if (fullName) combos.push(normalizeName(fullName));
		}
	}

	return [...new Set(combos)].slice(0, 8);
}

function splitFullName(fullName = '') {
	const parts = normalizeName(fullName)
		.replace(/\b(phone|number|address|age|email|more)\b.*$/i, '')
		.split(' ')
		.filter(Boolean);

	return {
		firstName: parts.shift() || '',
		lastName: parts.length ? parts.pop() : '',
		middleName: parts.join(' '),
	};
}

function decodeDuckDuckGoUrl(href = '') {
	try {
		const url = new URL(href, 'https://duckduckgo.com');
		const resolved = url.searchParams.get('uddg');
		return resolved ? decodeURIComponent(resolved) : url.toString();
	} catch {
		return href;
	}
}

function normalizeDiscoveredUrl(href = '', baseUrl = '') {
	const raw = String(href || '').trim();
	if (!raw) return '';

	try {
		const url = new URL(raw, baseUrl || 'https://duckduckgo.com');
		const resolved = url.searchParams.get('q') || url.searchParams.get('uddg') || url.searchParams.get('url');

		if (resolved && /^https?:/i.test(decodeURIComponent(resolved))) {
			return decodeURIComponent(resolved);
		}

		return /^https?:/i.test(url.toString()) ? url.toString() : '';
	} catch {
		return /^https?:/i.test(raw) ? raw : '';
	}
}

function looksLikeAccessInterstitial(text = '') {
	return /just a moment|checking if your site connection is secure|needs to review the security of your connection|loading search results/i.test(String(text || ''));
}

async function fetchDirectoryPage(url, { renderFirst = false } = {}) {
	const tryRendered = async () => {
		const html = await fetchRenderedDirectoryPage(url);
		if (!html) return '';

		const text = normalizeName(
			cheerio
				.load(String(html || ''))('body')
				.text(),
		);
		return text && !looksLikeAccessInterstitial(text) ? html : '';
	};

	if (renderFirst) {
		const rendered = await tryRendered();
		if (rendered) return rendered;
	}

	try {
		const response = await axios.get(url, {
			headers: {
				...HEADERS,
				Referer: 'https://www.google.com/',
			},
			timeout: TIMEOUT,
		});

		const html = String(response.data || '');
		const text = normalizeName(cheerio.load(html)('body').text());
		if (text && !looksLikeAccessInterstitial(text)) {
			return html;
		}
	} catch {
		// fall through to rendered fallback
	}

	return tryRendered();
}

function getSupportedSourceUrlType(value = '') {
	try {
		const url = new URL(String(value || '').trim());
		const host = url.hostname.replace(/^www\./i, '').toLowerCase();

		if (host.endsWith('zillow.com')) return 'zillow';
		if (host.endsWith('whitepages.com')) return 'whitepages';
		return '';
	} catch {
		return '';
	}
}

function isSupportedPropertySourceUrl(value = '') {
	return Boolean(getSupportedSourceUrlType(value));
}

function deriveSourceUrlParams(params = {}) {
	const sourceUrl = String(params.sourceUrl || '').trim();
	const source = getSupportedSourceUrlType(sourceUrl);

	if (!source) {
		return { ...params };
	}

	try {
		const url = new URL(sourceUrl);
		const segments = url.pathname.split('/').filter(Boolean);
		let inferredName = { firstName: '', middleName: '', lastName: '' };
		let inferredCity = '';
		let inferredState = '';

		if (source === 'whitepages' && segments[0] === 'name') {
			inferredName = splitFullName(titleCaseSlugPart(segments[1] || ''));

			const locationBits = String(segments[2] || '')
				.split('-')
				.filter(Boolean);
			if (locationBits.length >= 2) {
				inferredState = normalizeStateValue(locationBits.at(-1) || '');
				inferredCity = titleCaseSlugPart(locationBits.slice(0, -1).join('-'));
			}
		}

		const normalizedLocation = canonicalizeLocation({
			city: params.city || inferredCity,
			state: params.state || inferredState,
		});

		return {
			...params,
			firstName: params.firstName || inferredName.firstName || '',
			middleName: params.middleName || inferredName.middleName || '',
			lastName: params.lastName || inferredName.lastName || '',
			city: params.city || normalizedLocation.city || inferredCity || '',
			state: params.state || normalizedLocation.state || inferredState || '',
		};
	} catch {
		return { ...params };
	}
}

function parsePropertyAddress(text = '') {
	const cleaned = normalizeName(String(text || '').replace(/•/g, ', '));
	const directMatch = cleaned.match(
		/(\d{1,6}\s+[A-Za-z0-9.#' -]*?\b(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl|Trail|Trl|Highway|Hwy|Route|Rte))\.?\s*,\s*([A-Za-z .'-]+),\s*([A-Z]{2})\s*(\d{5}(?:-\d{4})?)/i,
	);

	if (directMatch) {
		return {
			address: normalizeName(directMatch[1]),
			city: normalizeName(directMatch[2]),
			state: normalizeName(directMatch[3]),
			zipCode: directMatch[4] || '',
		};
	}

	return { address: '', city: '', state: '', zipCode: '' };
}

function titleCaseSlugPart(value = '') {
	return String(value || '')
		.split('-')
		.filter(Boolean)
		.map((part) => {
			if (/^\d+$/.test(part)) return part;
			if (/^(n|s|e|w|ne|nw|se|sw|st|rd|ave|blvd|dr|ln|ct|pl|trl|hwy|rte)$/i.test(part)) {
				return part.length <= 3 ? part.toUpperCase() : toTitleCase(part.toLowerCase());
			}
			return toTitleCase(part.toLowerCase());
		})
		.join(' ');
}

function normalizeYearFragment(value = '') {
	const digits = String(value || '').match(/\d{2,4}/)?.[0] || '';
	if (!digits) return '';
	if (digits.length === 4) return digits;
	return `${Number(digits) < 70 ? '20' : '19'}${digits}`;
}

function extractPropertyParty(block = '') {
	const cleaned = normalizeName(block);
	if (!cleaned) {
		return { name: '', company: '' };
	}

	const name = extractPersonNames(cleaned)[0] || '';
	let company = cleaned;

	if (name) {
		company = company.replace(new RegExp(escapeRegExp(name), 'i'), ' ');
	}

	company = company
		.replace(PHONE_RE, ' ')
		.replace(/\b\d{5,}\b/g, ' ')
		.replace(/\b(?:Source|MLS|Listing updated|Zillow last checked)\b.*$/i, ' ')
		.replace(/[,:;]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

	return {
		name,
		company: company && company !== name ? company : '',
	};
}

function buildPropertyListingProfile(
	{ name = '', company = '', phones = [], addressData = {}, url = '', mlsNumber = '', lastSoldDate = '', lastSoldYear = '', lastSoldTo = '', grantor = '', grantee = '' } = {},
	params = {},
) {
	const nameParts = splitFullName(name);
	const otherNamesAtAddress = [...new Set((params.otherNamesAtAddress || []).filter(Boolean))];

	return {
		firstName: nameParts.firstName || (nameParts.lastName ? '' : 'Property'),
		middleName: nameParts.middleName || '',
		lastName:
			nameParts.lastName ||
			(nameParts.firstName ? ''
			: company ? 'Contact'
			: 'Listing'),
		age: 0,
		address: addressData.address || params.address || '',
		city: addressData.city || params.city || '',
		state: addressData.state || params.state || '',
		zipCode: addressData.zipCode || params.zipCode || '',
		phoneNumbers: [...new Set(phones)].filter(Boolean).slice(0, 5),
		email: '',
		yearsAtAddress: '',
		relatives: [],
		otherNamesAtAddress,
		aliases: [],
		formerAddresses: [],
		website: url,
		company: company || '',
		mlsNumber: mlsNumber || '',
		lastSoldDate: lastSoldDate || '',
		lastSoldYear: lastSoldYear || normalizeYearFragment(lastSoldDate) || '',
		lastSoldTo: lastSoldTo || grantee || '',
		grantor: grantor || '',
		grantee: grantee || '',
		occupation: name ? 'Property contact' : 'Property listing',
	};
}

function extractDefinitionMap($root) {
	const map = {};

	$root.find('dl .definitions__group').each((_, group) => {
		const label = normalizeName(cheerio.load(group)('dt').first().text()).toLowerCase().replace(/:$/, '');
		const value = normalizeName(cheerio.load(group)('dd').first().text());

		if (label && value) {
			map[label] = value;
		}
	});

	return map;
}

function extractSaleDetails(rawText = '', detailMap = {}) {
	const lastSoldDate = normalizeName(
		detailMap['last sold'] ||
			detailMap['sold on'] ||
			detailMap['sale date'] ||
			detailMap['recording date'] ||
			rawText.match(/(?:last sold|sold on|sale date|transfer date|recording date)\s*:?:?\s*([A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1] ||
			'',
	);

	const grantor = normalizeName(
		detailMap['grantor'] || detailMap['grantor(s)'] || rawText.match(/grantor(?:\(s\))?\s*:?:?\s*(.+?)(?=grantee|sale date|sold on|recording date|$)/i)?.[1] || '',
	);

	const grantee = normalizeName(
		detailMap['grantee'] || detailMap['grantee(s)'] || rawText.match(/grantee(?:\(s\))?\s*:?:?\s*(.+?)(?=grantor|sale date|sold on|recording date|$)/i)?.[1] || '',
	);

	return {
		lastSoldDate,
		lastSoldYear: normalizeYearFragment(lastSoldDate),
		grantor,
		grantee,
	};
}

function parseZillowPage(html, params, url = '') {
	const $ = cheerio.load(html);
	$('script, style, noscript, svg').remove();
	const rawText = normalizeName($('body').text());
	if (!rawText) return [];

	const headingText = normalizeName($('h1').first().text() || $('title').text());
	const addressData = parsePropertyAddress(headingText || rawText);
	const phones = [...new Set(rawText.match(PHONE_RE) || [])];

	if (/\/homedetails\//i.test(url) || /MLS\W*#?/i.test(rawText)) {
		const mlsNumber = normalizeName(rawText.match(/MLS\W*#?\W*:?\W*([A-Za-z0-9-]{4,})/i)?.[1] || '');
		const listedByBlock = normalizeName(rawText.match(/Listed by:?\s*(.+?)(?=Bought with:|Source:|MLS\W*#|$)/i)?.[1] || '');
		const boughtWithBlock = normalizeName(rawText.match(/Bought with:?\s*(.+?)(?=Source:|MLS\W*#|$)/i)?.[1] || '');
		const listedParty = extractPropertyParty(listedByBlock);
		const boughtParty = extractPropertyParty(boughtWithBlock);
		const targetAddress = [addressData.address, addressData.city, addressData.state, addressData.zipCode].filter(Boolean).join(', ');
		const soldMatch =
			(targetAddress ? rawText.match(new RegExp(`${escapeRegExp(targetAddress)}.*?Sold\\s+(\\d{2})\\/(\\d{2})\\/(\\d{2,4})`, 'i')) : null) ||
			rawText.match(/Sold\s+(\d{2})\/(\d{2})\/(\d{2,4})/i);
		const lastSoldYear = normalizeYearFragment(soldMatch?.[3] || rawText.match(/Listing updated:.*?(\d{4})/i)?.[1] || '');
		const lastSoldTo = [boughtParty.name, boughtParty.company].filter(Boolean).join(' — ');

		const detailProfile = buildPropertyListingProfile(
			{
				name: listedParty.name || '',
				company: listedParty.company || boughtParty.company || '',
				phones,
				addressData,
				url,
				mlsNumber,
				lastSoldYear,
				lastSoldTo,
			},
			params,
		);

		return hasDirectoryProfileData(detailProfile) ? [detailProfile] : [];
	}

	const profiles = [];
	const soldEntryRe =
		/Sold\s*([0-9][A-Za-z0-9.#' -]+?,\s*[A-Za-z .'-]+,\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?)\s+([A-Z0-9&.,' -]{2,}?)\s*,\s*([A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){1,2})\s+Sold\s+(\d{2})\/(\d{2})\/(\d{2,4})/g;

	for (const match of rawText.matchAll(soldEntryRe)) {
		const addressData = parsePropertyAddress(match[1]);
		const company = normalizeName(match[2]);
		const contactName = normalizeName(match[3]);
		const lastSoldYear = normalizeYearFragment(match[6] || '');

		const profile = buildPropertyListingProfile(
			{
				name: contactName,
				company,
				phones: [],
				addressData,
				url,
				lastSoldYear,
				lastSoldTo: contactName || '',
			},
			params,
		);

		if (hasDirectoryProfileData(profile)) {
			profiles.push(profile);
		}

		if (profiles.length >= 12) break;
	}

	if (profiles.length) {
		return dedupeDirectoryProfiles(profiles);
	}

	const company = normalizeName(rawText.match(/(?:Brokered by|Courtesy of|Listed by)\s+(.+?)(?:Save|Contact|Est\s+\$|$)/i)?.[1] || '');
	const fallbackProfile = buildPropertyListingProfile(
		{
			name: '',
			company,
			phones,
			addressData,
			url,
		},
		params,
	);

	return hasDirectoryProfileData(fallbackProfile) ? [fallbackProfile] : [];
}

export async function searchPropertySourceUrl(params) {
	if (!params.sourceUrl || !isSupportedPropertySourceUrl(params.sourceUrl)) {
		return { source: 'property-source', profiles: [] };
	}

	const sourceUrl = String(params.sourceUrl).trim();
	const source = getSupportedSourceUrlType(sourceUrl) || 'property-source';
	const normalizedParams = deriveSourceUrlParams(params);
	const fetchUrl = source === 'whitepages' && !/[?&]dd_referrer=/i.test(sourceUrl) ? `${sourceUrl}${sourceUrl.includes('?') ? '&' : '?'}dd_referrer=` : sourceUrl;

	try {
		await delay(Math.floor(DELAY_MS / 2));
		const data = await fetchDirectoryPage(fetchUrl, { renderFirst: true });
		if (!data) {
			return { source, profiles: [] };
		}

		let parsedProfiles = [];

		if (source === 'zillow') {
			parsedProfiles = parseZillowPage(data, normalizedParams, sourceUrl);
		} else {
			parsedProfiles = parseWhitepagesPage(data, normalizedParams, sourceUrl);
		}

		parsedProfiles = parsedProfiles.filter((profile) => (normalizedParams.firstName || normalizedParams.lastName ? matchesSearchParams(profile, normalizedParams) : true));

		if (!parsedProfiles.length && source === 'whitepages' && normalizedParams.firstName && normalizedParams.lastName) {
			const fallbackResults = await Promise.allSettled([search411({ ...normalizedParams, sourceUrl: '' }), searchThatsThem({ ...normalizedParams, sourceUrl: '' })]);

			parsedProfiles = dedupeDirectoryProfiles([
				...loadWhitepagesReferenceFallback(normalizedParams),
				...fallbackResults.filter((entry) => entry.status === 'fulfilled').flatMap((entry) => entry.value?.profiles || []),
			]).filter((profile) => (normalizedParams.firstName || normalizedParams.lastName ? matchesSearchParams(profile, normalizedParams) : true));
		}

		const uniqueProfiles = dedupeDirectoryProfiles(parsedProfiles);
		logger.debug('Property source results', {
			source,
			count: uniqueProfiles.length,
			url: sourceUrl,
		});
		return { source, profiles: uniqueProfiles };
	} catch (err) {
		logger.debug('Property source fetch skipped', {
			url: sourceUrl,
			error: err.message,
		});
		return { source, profiles: [] };
	}
}

async function discoverSiteLinks(queries = [], domainPattern, maxLinks = 6) {
	const links = new Set();
	const engines = [
		{
			url: 'https://html.duckduckgo.com/html/',
			getParams: (query) => ({ q: query }),
		},
		{
			url: 'https://www.google.com/search',
			getParams: (query) => ({ q: query, num: 10, hl: 'en' }),
		},
	];

	for (const query of queries.filter(Boolean)) {
		for (const engine of engines) {
			try {
				const { data } = await axios.get(engine.url, {
					params: engine.getParams(query),
					headers: {
						...HEADERS,
						Referer: 'https://www.google.com/',
					},
					timeout: TIMEOUT,
				});

				const $ = cheerio.load(String(data || ''));
				$('a[href]').each((_i, el) => {
					const href = normalizeDiscoveredUrl($(el).attr('href') || '', engine.url);
					if (!href || !domainPattern.test(href)) return;
					links.add(href);
				});

				if (links.size >= maxLinks) {
					return [...links].slice(0, maxLinks);
				}
			} catch {
				// keep trying other sources
			}
		}
	}

	return [...links].slice(0, maxLinks);
}

function buildPeopleFinderQueries(params) {
	const names = [
		{
			firstName: params.firstName,
			middleName: params.middleName,
			lastName: params.lastName,
		},
		...(params.aliases || []).map((alias) => ({
			firstName: alias.firstName || '',
			middleName: alias.middleName || '',
			lastName: alias.lastName || '',
		})),
	];
	const stateTerms = !params.city && !params.address ? getCrawlerStateTerms(params.state).slice(0, 4) : [];

	return names
		.flatMap((name) =>
			buildFullNameCombos(name).flatMap((fullName) => [
				['site:peoplefinder.com', fullName ? `"${fullName}"` : '', params.address ? `"${params.address}"` : '', params.city || '', params.state || '', params.zipCode || '']
					.filter(Boolean)
					.join(' '),
				...stateTerms.map((abbr) => ['site:peoplefinder.com', fullName ? `"${fullName}"` : '', abbr].filter(Boolean).join(' ')),
			]),
		)
		.filter(Boolean)
		.slice(0, 12);
}

function buildMyLifeQueries(params) {
	const names = [
		{
			firstName: params.firstName,
			middleName: params.middleName,
			lastName: params.lastName,
		},
		...(params.aliases || []).map((alias) => ({
			firstName: alias.firstName || '',
			middleName: alias.middleName || '',
			lastName: alias.lastName || '',
		})),
	];
	const stateTerms = !params.city && !params.address ? getCrawlerStateTerms(params.state).slice(0, 4) : [];

	return names
		.flatMap((name) =>
			buildFullNameCombos(name).flatMap((fullName) => [
				['site:mylife.com', fullName ? `"${fullName}"` : '', params.city || '', params.state || '', params.zipCode || ''].filter(Boolean).join(' '),
				...stateTerms.map((abbr) => ['site:mylife.com', fullName ? `"${fullName}"` : '', abbr].filter(Boolean).join(' ')),
			]),
		)
		.filter(Boolean)
		.slice(0, 12);
}
function slugifySegment(value = '') {
	return String(value || '')
		.trim()
		.replace(/[^a-zA-Z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.toLowerCase();
}

function buildNameSlug(params, firstNameOverride = params.firstName) {
	return [firstNameOverride, params.lastName].filter(Boolean).map(slugifySegment).join('-');
}

function buildWhitepagesSlugSegment(value = '') {
	return String(value || '')
		.trim()
		.split(/\s+/)
		.map((part) =>
			String(part)
				.replace(/[^a-zA-Z0-9]+/g, '')
				.trim(),
		)
		.filter(Boolean)
		.map((part) => toTitleCase(part))
		.join('-');
}

function buildWhitepagesSlugs(params) {
	const firstNameOptions = getFirstNameVariants(params.firstName);
	const middleOptions = new Set(['']);

	if (params.middleName) {
		middleOptions.add(params.middleName);
		middleOptions.add(params.middleName.charAt(0));
	}

	const slugs = [];
	for (const firstNameOption of firstNameOptions.length ? firstNameOptions : [params.firstName]) {
		for (const middleOption of middleOptions) {
			const slug = [firstNameOption, middleOption, params.lastName].filter(Boolean).map(buildWhitepagesSlugSegment).join('-');

			if (slug) slugs.push(slug);
		}
	}

	return [...new Set(slugs)].slice(0, 6);
}

function buildWhitepagesLocationSegment(params = {}, stateOverride = '') {
	const stateValue = String(stateOverride || params.state || '')
		.trim()
		.toUpperCase();
	const cityValue = buildWhitepagesSlugSegment(params.city || '');

	if (cityValue && stateValue) {
		return `${cityValue}-${stateValue}`;
	}

	return stateValue || cityValue;
}

function build411ExactUrl({ firstName = '', middleName = '', lastName = '' }) {
	const parts = [firstName, middleName, lastName].filter(Boolean).map((part) =>
		normalizeName(part)
			.split(/\s+/)
			.map((piece) => toTitleCase(piece))
			.join('-'),
	);

	if (!parts.length) return '';
	return `https://www.411.com/person-search/${parts.join('-')}`;
}

function build411Urls(params) {
	const firstNameOptions = getFirstNameVariants(params.firstName);
	const middleOptions = new Set(['']);

	if (params.middleName) {
		middleOptions.add(params.middleName);
		middleOptions.add(params.middleName.charAt(0));
	}

	const urls = [];
	const preferredUrl = build411ExactUrl(params);
	if (preferredUrl) {
		urls.push(preferredUrl);
	}

	for (const firstNameOption of firstNameOptions.length ? firstNameOptions : [params.firstName]) {
		for (const middleOption of middleOptions) {
			const nameParts = [firstNameOption, middleOption, params.lastName].filter(Boolean).map((part) =>
				normalizeName(part)
					.split(/\s+/)
					.map((piece) => toTitleCase(piece))
					.join('-'),
			);

			const nameSegment = nameParts.join('-');
			if (!nameSegment) continue;

			urls.push(`https://www.411.com/person-search/${nameSegment}`);

			if (nameParts.length >= 2) {
				const plusSegment = `${nameParts.slice(0, -1).join('-')}+${nameParts.at(-1)}`;
				urls.push(`https://www.411.com/person-search/${plusSegment}`);
			}
		}
	}

	return [...new Set(urls)].slice(0, 8);
}

function build411FollowupUrls(profiles = []) {
	const urls = new Set();

	for (const profile of profiles) {
		if (profile.firstName && profile.lastName && profile.middleName) {
			const exactUrl = build411ExactUrl(profile);
			if (exactUrl) urls.add(exactUrl);
		}

		for (const alias of profile.aliases || []) {
			if (alias.firstName && alias.lastName && alias.middleName) {
				const aliasUrl = build411ExactUrl(alias);
				if (aliasUrl) urls.add(aliasUrl);
			}
		}
	}

	return [...urls].slice(0, 6);
}

function stripLeadingPersonName(value = '', params = {}, referenceName = '') {
	let cleaned = normalizeName(value)
		.replace(/^(resides in|current location:)\s*/i, '')
		.replace(/\s{2,}/g, ' ');

	if (!cleaned) return '';

	const explicitNames = [
		referenceName,
		[params.firstName, params.middleName, params.lastName].filter(Boolean).join(' '),
		[params.firstName, params.lastName].filter(Boolean).join(' '),
	]
		.map((name) => normalizeName(name))
		.filter(Boolean);

	for (const name of new Set(explicitNames)) {
		cleaned = cleaned.replace(new RegExp(`^${escapeRegExp(name)}\\s+`, 'i'), '');
	}

	const referenceParts = splitFullName(referenceName);
	const firstName = params.firstName || referenceParts.firstName || '';
	const lastName = params.lastName || referenceParts.lastName || '';
	const firstOptions = getFirstNameVariants(firstName)
		.map((entry) => escapeRegExp(toTitleCase(entry)))
		.filter(Boolean);

	if (firstOptions.length && lastName) {
		cleaned = cleaned.replace(new RegExp(`^(?:${firstOptions.join('|')})(?:\\s+[A-Z][A-Za-z'.-]+){0,2}\\s+${escapeRegExp(lastName)}(?:\\s+[A-Z][A-Za-z'.-]+){0,2}\\s+`, 'i'), '');
	}

	if (lastName) {
		cleaned = cleaned.replace(new RegExp(`^${escapeRegExp(lastName)}(?:\\s+[A-Z][A-Za-z'.-]+){0,2}\\s+`, 'i'), '');
	}

	return cleaned.trim();
}

function splitCityState(raw = '', params = {}, referenceName = '') {
	const cleaned = stripLeadingPersonName(raw, params, referenceName);
	const parts = cleaned
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean);

	const cityCandidate = stripLeadingPersonName(parts.length > 1 ? parts.at(-2) : parts[0] || '', params, referenceName);
	const stateCandidate = parts.at(-1) || '';

	const normalized = canonicalizeLocation({
		city: cityCandidate,
		state: stateCandidate.replace(/\d{5}(?:-\d{4})?$/g, '').trim(),
	});

	return {
		city: normalized.city,
		state: normalized.state,
	};
}

const NON_PERSON_NAME_PATTERNS = [
	/\bdoes\s+[a-z]+\s+[a-z]+\b/i,
	/\bis\s+[a-z]+\s+[a-z]+\b/i,
	/\bcourt records?\b/i,
	/\bcriminal records?\b/i,
	/\btraffic violations?\b/i,
	/\bfair credit reporting\b/i,
	/\brecord date\b/i,
	/\bcase type\b/i,
	/\boffense date\b/i,
	/\boffense code\b/i,
	/\boffense desc\b/i,
	/\bdisposition date\b/i,
	/\bbusiness records?\b/i,
	/\b(email|phone) lookup\b/i,
	/\bwhite pages directory\b/i,
	/\bwhitepages premium\b/i,
	/\bcontact info\b/i,
	/\bwork history\b/i,
	/\beducation history\b/i,
	/\bdemographic info\b/i,
	/\bfor business\b/i,
	/\bsign up\b/i,
	/\bget help\b/i,
	/\bbrowse locations\b/i,
	/\bjob positions\b/i,
	/\bfind phone number\b/i,
	/\bstatistics\b/i,
	/\bshowing\b/i,
	/\bknown\b/i,
	/\btitle\b/i,
	/\bsummary\b/i,
	/\bsearch results?\b/i,
	/\bpeople search\b/i,
	/\bapple color emoji\b/i,
	/\bsegoe ui(?: emoji)?\b/i,
];

const INVALID_PERSON_NAME_EXACTS = new Set(['whitepages premium']);

const NON_PERSON_NAME_WORDS = new Set([
	'records',
	'record',
	'court',
	'criminal',
	'traffic',
	'terms',
	'fair',
	'credit',
	'reporting',
	'business',
	'company',
	'staff',
	'engineer',
	'quality',
	'therapeutics',
	'inc',
	'therapist',
	'clinical',
	'supervisor',
	'author',
	'motivational',
	'demographic',
	'email',
	'lookup',
	'phone',
	'directory',
	'logo',
	'sign',
	'help',
	'states',
	'browse',
	'locations',
	'history',
	'contact',
	'school',
	'university',
	'college',
	'marketing',
	'strategy',
	'positions',
	'assistant',
	'district',
	'attorney',
	'manager',
	'resources',
	'physician',
	'liaison',
	'county',
	'statistics',
	'pages',
	'summary',
	'known',
	'current',
	'address',
	'title',
	'showing',
	'info',
	'experienced',
	'systems',
	'find',
	'well',
	'lockheed',
	'navy',
	'food',
	'sales',
	'bank',
	'united',
	'new',
	'north',
	'south',
	'west',
	'hampshire',
	'jersey',
	'mexico',
	'york',
	'carolina',
	'dakota',
	'virginia',
	'search',
	'results',
	'people',
	'emoji',
	'segoe',
	'apple',
	'st',
	'street',
	'rd',
	'road',
	'ave',
	'avenue',
	'dr',
	'drive',
	'blvd',
	'boulevard',
	'ct',
	'court',
	'ln',
	'lane',
	'way',
	'hwy',
	'highway',
	'cir',
	'circle',
	'pkwy',
	'parkway',
	'pl',
	'place',
	'ter',
	'terrace',
	'trl',
	'trail',
	'n',
	's',
	'e',
	'w',
	'ne',
	'nw',
	'se',
	'sw',
]);

const STREET_OR_PLACE_NAME_RE =
	/(?:(?:^|\s)(?:p\.?\s*o\.?\s*box|box)|(?:^|\s)(?:[A-Za-z0-9'.-]+\s+){0,4}(?:st|street|rd|road|ave|avenue|dr|drive|blvd|boulevard|ct|court|ln|lane|way|hwy|highway|cir|circle|pkwy|parkway|pl|place|ter|terrace|trl|trail)(?:\s+(?:n|s|e|w|ne|nw|se|sw))?)\.?$/i;
const PLACE_LIKE_NAME_PREFIX_RE = /^(?:saint|sainte|san|fort|old|rancho|spokane|seaside|wake|johnson|junction|corpus|broken|apple|oak|gold|league|du|port|vista|chateau)\s+/i;
const PLACE_LIKE_NAME_ENDING_RE = /\b(?:valley|heights|beach|harbor|city|falls|forest|genevieve|quoin|verdes|christi|daisy|stewart|springs|county|creek|ridge|del\s+mar)\b$/i;

const ADDRESS_NAME_FRAGMENT_RE =
	/(?:^|\s)(?:N|S|E|W|NE|NW|SE|SW)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(?:St|Street|Rd|Road|Ave|Avenue|Dr|Drive|Blvd|Boulevard|Ct|Court|Ln|Lane|Way|Hwy|Highway)\.?$/i;

function looksLikeStreetOrPlaceName(name = '') {
	const cleaned = normalizeName(name).replace(/[.,/|:;]+$/g, '');
	if (!cleaned) return false;
	if (STREET_OR_PLACE_NAME_RE.test(cleaned)) return true;
	if (PLACE_LIKE_NAME_PREFIX_RE.test(cleaned)) return true;
	if (PLACE_LIKE_NAME_ENDING_RE.test(cleaned) && cleaned.split(/\s+/).filter(Boolean).length <= 4) {
		return true;
	}
	if (/^[A-Z][A-Za-z'.-]+\s+(?:Jr|Sr|II|III|IV)\.?$/i.test(cleaned)) {
		return true;
	}
	return isKnownCityName(cleaned);
}

function isLikelyExtractedPersonName(name = '', excludeName = '') {
	const cleaned = normalizeName(name).replace(/[.,/|:;]+$/g, '');

	if (!cleaned) return false;
	if (excludeName && cleaned.toLowerCase() === normalizeName(excludeName).toLowerCase()) {
		return false;
	}
	if (INVALID_PERSON_NAME_EXACTS.has(cleaned.toLowerCase())) return false;
	if (/\d/.test(cleaned)) return false;
	if (cleaned.includes("'s")) return false;
	if (/[.:]/.test(cleaned)) return false;
	if (NON_PERSON_NAME_PATTERNS.some((pattern) => pattern.test(cleaned))) {
		return false;
	}
	if (ADDRESS_NAME_FRAGMENT_RE.test(cleaned)) return false;
	if (looksLikeStreetOrPlaceName(cleaned)) return false;
	if (!/^[A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){1,3}$/.test(cleaned)) {
		return false;
	}

	const words = cleaned.split(/\s+/).filter(Boolean);
	return words.length >= 2 && words.length <= 4 && !words.some((word) => NON_PERSON_NAME_WORDS.has(word.toLowerCase()));
}

function cleanExtractedPersonName(name = '') {
	let cleaned = normalizeName(name)
		.replace(/[.,/|:;]+$/g, '')
		.replace(/(?:MALE|FEMALE|AGE)+$/i, '')
		.replace(/\b(?:MALE|FEMALE|AGE)\b.*$/i, '')
		.replace(/\b(?:Get|View|More|Info|Details|Profile|Report|Records|Search|Results|Showing|Summary|FAQ)\b.*$/i, '')
		.trim();

	cleaned = cleaned.replace(/(\b[A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){1,3}?)(?:Get|View|More|Info|Details|Profile|Report|Records|Search|Results|Showing|Summary|FAQ)$/, '$1');

	return normalizeName(cleaned).replace(/[.,/|:;]+$/g, '');
}

function extractPersonNames(text = '', excludeName = '') {
	return [
		...new Set(
			(text.match(/[A-Z][a-z]+(?:\s+[A-Z][A-Za-z'.-]+){1,2}/g) || [])
				.map((name) => cleanExtractedPersonName(name))
				.filter((name) => isLikelyExtractedPersonName(name, excludeName)),
		),
	].slice(0, 25);
}

function extractAddressLinkedNames(text = '', excludeName = '') {
	const raw = normalizeName(text);
	if (!raw) return [];

	const sections = [
		raw.match(
			/(?:associated persons|other residents|possible residents|residents|household members|people who (?:live|lived) at (?:this )?address|lived with)\s*:?\s*(.+?)(?:also known as|aka|past addresses|address history|previous addresses|current address|phone|email|age|$)/i,
		)?.[1] || '',
		raw.match(
			/(?:relatives|related to|family members|family)\s*:?\s*(.+?)(?:also known as|aka|past addresses|address history|previous addresses|current address|phone|email|age|$)/i,
		)?.[1] || '',
	];

	return [...new Set(sections.flatMap((section) => extractPersonNames(section, excludeName)))];
}

function toAliasObjects(names = []) {
	return names.map((name) => splitFullName(name)).filter((alias) => alias.firstName || alias.lastName);
}

function extractFormerLocations(text = '') {
	return [
		...new Set(
			(text.match(/[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+)*,\s*[A-Z]{2}/g) || []).map((entry) => {
				const normalized = normalizeName(entry);
				const commaIdx = normalized.lastIndexOf(',');
				if (commaIdx < 0) return normalized;
				const state = normalized.slice(commaIdx + 1).trim();
				const beforeState = normalized.slice(0, commaIdx).trim();
				const words = beforeState.split(/\s+/);
				// Try longest-to-shortest suffix (up to 3 words) to find a known city.
				// Longest-first ensures multi-word cities like "New York" beat single
				// words while still trimming name/noise prefixes when needed.
				const maxTry = Math.min(3, words.length);
				for (let n = maxTry; n >= 1; n -= 1) {
					const candidateCity = words.slice(-n).join(' ');
					if (isKnownCityName(candidateCity)) {
						return `${candidateCity}, ${state}`;
					}
				}
				// No known city found — keep last word as a best-effort city name.
				return `${words[words.length - 1]}, ${state}`;
			}),
		),
	];
}

const PHONE_RE = /(?<!\d)(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]\d{3}[-.\s]\d{4}(?!\d)/g;
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const ADDRESS_RE =
	/\d{1,5}\s[\w\s.#-]+(?:\bStreet\b|\bSt\b|\bAvenue\b|\bAve\b|\bRoad\b|\bRd\b|\bBoulevard\b|\bBlvd\b|\bDrive\b|\bDr\b|\bLane\b|\bLn\b|\bWay\b|\bCourt\b|\bCt\b|\bPlace\b|\bPl\b|\bTrail\b|\bTrl\b|\bHighway\b|\bHwy\b)(?:,?\s*[A-Z][\w\s.'-]+,\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?)?/gi;

function isNoiseAddressFragment(value = '') {
	const cleaned = normalizeName(value);

	return Boolean(!cleaned || /\blist-none\b/i.test(cleaned) || /^\d+\s+pl\b$/i.test(cleaned) || /\b(?:px|py|mx|my|font|text|items|justify)-[\w-]+\b/i.test(cleaned));
}

function pickBestStreetFragment(raw = '') {
	const matches = [
		...String(raw || '').matchAll(
			/\b((?:\d{1,6}\s+)?(?:[NSEW]\.?(?:\s+|$))?[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,6}\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl|Trail|Trl|Highway|Hwy))\b/gi,
		),
	]
		.map((match) => normalizeName(match[1]))
		.filter((candidate) => !isNoiseAddressFragment(candidate));

	if (!matches.length) return '';

	return matches.sort((left, right) => {
		const score = (value) => (/(?:\d{1,6})/.test(value) ? 10 : 0) + value.replace(/[^A-Za-z]/g, '').length + value.split(/\s+/).length;

		return score(right) - score(left);
	})[0];
}

function cleanDirectoryAddressText(raw = '') {
	const cleaned = normalizeName(raw)
		.replace(/\s+,/g, ',')
		.replace(/\b(?:More\s+)?View Details\b/gi, ' ')
		.replace(/\bView\b/gi, ' ')
		.replace(/\b\d+\s+list-none\s+pl\b[.,]?\s*/gi, '')
		.replace(/\b(?:list-none|pl|px|py|mx|my|font|text|items|justify)-[\w-]+\b/gi, '')
		.replace(/^\d+\s+pl\b[.,]?\s*/i, '')
		.replace(/\b[A-Z]{3,}\s+(?=[A-Za-z0-9.'-]+\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl|Trail|Trl|Highway|Hwy)\b)/g, '')
		.replace(/\s{2,}/g, ' ')
		.trim();

	const namedLocationMatch = cleaned.match(/^[A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){1,3}\s+([A-Z][A-Za-z .'-]+,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?)$/);
	const normalized = normalizeName(namedLocationMatch?.[1] || cleaned);

	const street = pickBestStreetFragment(normalized);
	if (street) return street;

	const localityOnly = normalized.match(/([A-Z][A-Za-z .'-]+,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?)$/);

	return normalizeName(localityOnly?.[1] || normalized);
}

function parseStreetAddress(raw = '') {
	const cleaned = cleanDirectoryAddressText(raw);
	const inferred = inferLocationByAddress(cleaned);
	const match = cleaned.match(
		/^(.*?\b(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl|Trail|Trl|Highway|Hwy))\.?\s*(?:,?\s*([A-Z][A-Za-z .'-]+),\s*([A-Z]{2})(?:\s+(\d{5}(?:-\d{4})?))?)?$/i,
	);

	if (!match) {
		return {
			address: cleaned,
			city: inferred.city || '',
			state: inferred.state || '',
			zipCode: inferred.zipCode || '',
		};
	}

	const address = cleanDirectoryAddressText(match[1]);
	const byAddress = inferLocationByAddress(address);

	return {
		address,
		city: normalizeName(match[2]) || byAddress.city || inferred.city || '',
		state: normalizeName(match[3]) || byAddress.state || inferred.state || '',
		zipCode: match[4] || byAddress.zipCode || inferred.zipCode || '',
	};
}

function extractAddressCandidates(text = '') {
	return [
		...new Set(
			(text.match(ADDRESS_RE) || [])
				.map((address) => cleanDirectoryAddressText(address))
				.filter((address) => address && !isNoiseAddressFragment(address) && !/resides in|people named|highest quality|living in the us/i.test(address)),
		),
	];
}

function extractTeaserAddress(text = '') {
	const cleaned = normalizeName(text);
	if (!cleaned) {
		return { address: '', city: '', state: '', zipCode: '' };
	}

	const matched = cleaned.match(
		/(?:home address is|address is|current address is)\s+([^,]+?\b(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl|Trail|Trl|Highway|Hwy))\.?\s*,\s*([A-Z][A-Za-z .'-]+)\s*,\s*([A-Z]{2})(?:\s+(\d{5}(?:-\d{4})?))?/i,
	);

	if (!matched) {
		return { address: '', city: '', state: '', zipCode: '' };
	}

	return {
		address: normalizeName(matched[1]),
		city: normalizeName(matched[2]),
		state: normalizeName(matched[3]),
		zipCode: matched[4] || '',
	};
}

function matchesSearchParams(candidate, params) {
	const locationText = [candidate.address, candidate.city, candidate.state].filter(Boolean).join(' ').toLowerCase();
	const aliasNames = (candidate.aliases || []).map((alias) => [alias.firstName, alias.middleName, alias.lastName].filter(Boolean).join(' ')).filter(Boolean);
	const nameMatchesDirect =
		firstNameMatches(candidate.firstName, params.firstName) && lastNameMatches(candidate.lastName, params.lastName) && middleNameMatches(candidate.middleName, params.middleName);
	const nameMatchesAlias = aliasNames.some((fullName) => {
		const alias = splitFullName(fullName);
		return firstNameMatches(alias.firstName, params.firstName) && lastNameMatches(alias.lastName, params.lastName) && middleNameMatches(alias.middleName, params.middleName);
	});

	if (!nameMatchesDirect && !nameMatchesAlias) {
		return false;
	}

	if ((params.city || params.state) && locationText) {
		if (!locationMatches(locationText, params.city, params.state)) {
			return false;
		}
	}

	if (params.address && candidate.address) {
		const wantedPart = params.address.toLowerCase().split(/\s+/).slice(0, 2).join(' ');
		if (wantedPart && !candidate.address.toLowerCase().includes(wantedPart)) {
			return false;
		}
	}

	if (candidate.age) {
		if (params.ageMin && candidate.age < Number(params.ageMin)) return false;
		if (params.ageMax && candidate.age > Number(params.ageMax)) return false;
	}

	return true;
}

function parsePeopleFinderPage(html, params) {
	const $ = cheerio.load(html);
	const rawText = normalizeName($('body').text());
	const heading = normalizeName($('h1').first().text() || $('title').text());

	if (!rawText) return null;

	const nameMatch = heading.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z'.-]+){1,3}/) || rawText.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z'.-]+){1,3}/);
	const nameParts = splitFullName(nameMatch ? nameMatch[0] : [params.firstName, params.middleName, params.lastName].filter(Boolean).join(' '));

	const age = Number.parseInt(rawText.match(/\bage\s+(\d{1,3})\b/i)?.[1] || '', 10) || 0;
	const phoneNumbers = [...new Set(rawText.match(PHONE_RE) || [])];
	const emails = [...new Set((rawText.match(EMAIL_RE) || []).map((email) => email.toLowerCase()))];
	const addresses = extractAddressCandidates(rawText);
	const currentLocation = rawText.match(/(?:RESIDES IN|Current Location:)\s*([A-Za-z .'-]+,\s*[A-Z]{2})/i)?.[1] || '';
	const { city, state } = splitCityState(currentLocation);

	const relativesSection = rawText.match(/Relatives\s+(.+?)(?:Phone|Email|Address|Previous|Current|Age|$)/i)?.[1] || '';
	const aliasesText = rawText.match(/Also known as\s+(.+?)(?:Includes|Lives|Phone|Email|$)/i)?.[1] || '';
	const formerLocationsText = rawText.match(/(?:Previous Locations|Lived In|Used to Live:)\s+(.+?)(?:Relatives|Phone|Email|Also known as|$)/i)?.[1] || '';

	return {
		...nameParts,
		age,
		address: addresses[0] || '',
		city,
		state,
		phoneNumbers,
		email: emails[0] || '',
		yearsAtAddress: parseYearsAtAddress(rawText),
		relatives: extractPersonNames(relativesSection, [nameParts.firstName, nameParts.middleName, nameParts.lastName].filter(Boolean).join(' ')),
		otherNamesAtAddress: extractAddressLinkedNames(`${relativesSection} ${rawText}`, [nameParts.firstName, nameParts.middleName, nameParts.lastName].filter(Boolean).join(' ')),
		aliases: toAliasObjects(extractPersonNames(aliasesText)),
		formerAddresses: [...new Set([...extractFormerLocations(formerLocationsText), ...addresses.slice(1)])],
	};
}

function parsePeopleSearchNowPage(html, params) {
	const $ = cheerio.load(html);
	const rawText = normalizeName($('body').text());

	if (!rawText) return null;

	const age = Number.parseInt(rawText.match(/Approximate Age:\s*(\d{1,3})/i)?.[1] || '', 10) || 0;
	const currentLocation = rawText.match(/Current Location:\s*([A-Za-z .'-]+,\s*[A-Z]{2})/i)?.[1] || '';
	const usedToLiveText = rawText.match(/Used to Live:\s*(.+?)(?:Related to:|View All Info|Approximate Age:|$)/i)?.[1] || '';
	const relativesText = rawText.match(/Related to:\s*(.+?)(?:View All Info|Approximate Age:|Current Location:|$)/i)?.[1] || '';
	const { city, state } = splitCityState(currentLocation);

	const targetFullName = [params.firstName, params.middleName, params.lastName].filter(Boolean).join(' ');

	return {
		...splitFullName(targetFullName),
		age,
		address: params.address || '',
		city,
		state,
		phoneNumbers: [...new Set(rawText.match(PHONE_RE) || [])],
		yearsAtAddress: parseYearsAtAddress(rawText),
		email: (rawText.match(EMAIL_RE) || [''])[0].toLowerCase(),
		relatives: extractPersonNames(relativesText, targetFullName),
		otherNamesAtAddress: extractAddressLinkedNames(`${relativesText} ${rawText}`, targetFullName),
		formerAddresses: extractFormerLocations(usedToLiveText),
	};
}

function escapeRegExp(value = '') {
	return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isSparseDirectoryShell(profile = {}) {
	return Boolean(
		profile &&
		!profile.address &&
		!profile.age &&
		!(profile.phoneNumbers || []).length &&
		!profile.email &&
		!profile.yearsAtAddress &&
		((profile.relatives || []).length || (profile.otherNamesAtAddress || []).length || (profile.formerAddresses || []).length),
	);
}

function getDirectoryProfileContextScore(profile = {}) {
	return (
		Number(Boolean(profile.address)) +
		Number(Boolean(profile.age)) +
		Number(Boolean(profile.email)) +
		Number(Boolean(profile.caseNumber)) +
		Number(Boolean(profile.court)) +
		Number(Boolean(profile.caseType)) +
		(profile.phoneNumbers || []).length +
		(profile.relatives || []).length +
		(profile.otherNamesAtAddress || []).length +
		(profile.formerAddresses || []).length
	);
}

function getExactNamedAddressKey(profile = {}) {
	const name = normalizeName(
		[profile.firstName, profile.middleName, profile.lastName].filter(Boolean).join(' ') || [profile.firstName, profile.lastName].filter(Boolean).join(' '),
	);
	const address = normalizeName(profile.address || '');

	if (!name || !address) return '';

	return [name, address, normalizeName(profile.city || ''), normalizeName(profile.state || '')].join('|');
}

function dedupeDirectoryProfiles(profiles = []) {
	const mergedByKey = new Map();
	const mergedByBaseKey = new Map();

	for (const profile of profiles.filter(Boolean)) {
		const baseKey = [
			normalizeName([profile.firstName, profile.middleName, profile.lastName].filter(Boolean).join(' ')),
			normalizeName(profile.city || ''),
			normalizeName(profile.state || ''),
			normalizeName(profile.website || ''),
		].join('|');
		const key = [baseKey, String(profile.age || ''), normalizeName(profile.address || '')].join('|');

		let existing = mergedByKey.get(key);
		const existingByBase = mergedByBaseKey.get(baseKey);

		if (
			!existing &&
			existingByBase &&
			(isSparseDirectoryShell(existingByBase) || isSparseDirectoryShell(profile) || !existingByBase.address || !profile.address || !existingByBase.age || !profile.age)
		) {
			existing = existingByBase;
		}

		if (!existing) {
			const created = {
				...profile,
				phoneNumbers: [...new Set(profile.phoneNumbers || [])],
				otherNamesAtAddress: [...new Set(profile.otherNamesAtAddress || profile.relatives || [])],
				relatives: [...new Set(profile.relatives || [])],
				formerAddresses: [...new Set(profile.formerAddresses || [])],
				aliases: [...(profile.aliases || [])],
				links: [...new Set(profile.links || [])],
			};

			mergedByKey.set(key, created);
			if (!mergedByBaseKey.has(baseKey) || (isSparseDirectoryShell(mergedByBaseKey.get(baseKey)) && !isSparseDirectoryShell(created))) {
				mergedByBaseKey.set(baseKey, created);
			}
			continue;
		}

		mergedByKey.set(key, existing);

		const existingScore = getDirectoryProfileContextScore(existing);
		const profileScore = getDirectoryProfileContextScore(profile);

		existing.address ||= profile.address || '';
		existing.city ||= profile.city || '';
		existing.state ||= profile.state || '';
		existing.zipCode ||= profile.zipCode || '';
		existing.email ||= profile.email || '';
		existing.yearsAtAddress ||= profile.yearsAtAddress || '';
		existing.website ||= profile.website || '';
		existing.neighborhood ||= profile.neighborhood || '';
		existing.occupation ||= profile.occupation || '';
		existing.company ||= profile.company || '';
		existing.ageText ||= profile.ageText || '';

		if (!existing.age || (profile.age && profileScore > existingScore)) {
			existing.age = profile.age || existing.age || 0;
			if (profile.ageText) existing.ageText = profile.ageText;
		}

		existing.phoneNumbers = [...new Set([...(existing.phoneNumbers || []), ...(profile.phoneNumbers || [])])];
		existing.relatives = [...new Set([...(existing.relatives || []), ...(profile.relatives || [])])];
		existing.otherNamesAtAddress = [...new Set([...(existing.otherNamesAtAddress || []), ...(profile.otherNamesAtAddress || profile.relatives || [])])];
		existing.formerAddresses = [...new Set([...(existing.formerAddresses || []), ...(profile.formerAddresses || [])])];
		existing.links = [...new Set([...(existing.links || []), ...(profile.links || [])])];

		const aliasKeys = new Set((existing.aliases || []).map((alias) => [alias.firstName, alias.middleName, alias.lastName].filter(Boolean).join(' ').toLowerCase()));
		for (const alias of profile.aliases || []) {
			const aliasKey = [alias.firstName, alias.middleName, alias.lastName].filter(Boolean).join(' ').toLowerCase();
			if (aliasKey && !aliasKeys.has(aliasKey)) {
				existing.aliases.push(alias);
				aliasKeys.add(aliasKey);
			}
		}
	}

	const deduped = [...new Set(mergedByKey.values())].sort((left, right) => getDirectoryProfileContextScore(right) - getDirectoryProfileContextScore(left));
	const exactMerged = [];
	const exactMap = new Map();

	for (const profile of deduped) {
		const exactKey = getExactNamedAddressKey(profile);
		if (!exactKey) {
			exactMerged.push(profile);
			continue;
		}

		const existing = exactMap.get(exactKey);
		if (!existing) {
			exactMap.set(exactKey, profile);
			exactMerged.push(profile);
			continue;
		}

		existing.address ||= profile.address || '';
		existing.city ||= profile.city || '';
		existing.state ||= profile.state || '';
		existing.zipCode ||= profile.zipCode || '';
		existing.email ||= profile.email || '';
		existing.yearsAtAddress ||= profile.yearsAtAddress || '';
		existing.website ||= profile.website || '';
		existing.age ||= profile.age || 0;
		existing.ageText ||= profile.ageText || '';
		existing.phoneNumbers = [...new Set([...(existing.phoneNumbers || []), ...(profile.phoneNumbers || [])])];
		existing.relatives = [...new Set([...(existing.relatives || []), ...(profile.relatives || [])])];
		existing.otherNamesAtAddress = [...new Set([...(existing.otherNamesAtAddress || []), ...(profile.otherNamesAtAddress || [])])];
		existing.formerAddresses = [...new Set([...(existing.formerAddresses || []), ...(profile.formerAddresses || [])])];
	}

	return exactMerged.filter((profile) => {
		const exactKey = getExactNamedAddressKey(profile);
		if (!exactKey) return true;
		if (profile.age || profile.ageText || profile.caseNumber || profile.court || profile.caseType) {
			return true;
		}
		return false;
	});
}

function hasDirectoryProfileData(profile) {
	return Boolean(
		profile &&
		(profile.address ||
			profile.city ||
			profile.state ||
			profile.age ||
			profile.caseNumber ||
			profile.court ||
			profile.caseType ||
			profile.phoneNumbers?.length ||
			profile.email ||
			profile.yearsAtAddress ||
			profile.relatives?.length ||
			profile.otherNamesAtAddress?.length ||
			profile.aliases?.length ||
			profile.formerAddresses?.length),
	);
}

function parseAgeValue(rawText = '') {
	const exact = rawText.match(/\bage\s*(\d{1,3})\b/i)?.[1] || '';
	const decade = rawText.match(/\bage\s*(\d{2})s\b/i)?.[1] || rawText.match(/\b(\d{2})s\b/i)?.[1] || '';

	if (exact) return Number.parseInt(exact, 10);
	if (decade) return Number.parseInt(decade, 10) + 5;
	return 0;
}

function parseYearsAtAddress(rawText = '') {
	const directYears =
		rawText.match(/(?:years? at (?:this )?address|has lived (?:there|here) for|lived (?:there|here) for|at this address for)\s*(\d{1,2})(?:\+)?\s*years?/i)?.[1] ||
		rawText.match(/(\d{1,2})(?:\+)?\s*years?\s+(?:at|in)\s+(?:this|the)\s+address/i)?.[1] ||
		rawText.match(/lived here in the past\s*(\d{1,2})\s*years?/i)?.[1] ||
		'';

	if (directYears) {
		return `${directYears} years`;
	}

	const sinceYear = rawText.match(/(?:at this address since|lived here since|resident since)\s*((?:19|20)\d{2})/i)?.[1] || '';

	if (sinceYear) {
		const years = new Date().getFullYear() - Number.parseInt(sinceYear, 10);
		if (years > 0 && years < 120) {
			return `${years}+ years`;
		}
	}

	return '';
}

function extractBalancedArrayLiteral(text = '', startIndex = -1) {
	if (startIndex < 0 || startIndex >= text.length) return '';

	let depth = 0;
	let quote = '';
	let escaping = false;

	for (let index = startIndex; index < text.length; index += 1) {
		const char = text[index];

		if (quote) {
			if (escaping) {
				escaping = false;
				continue;
			}

			if (char === '\\') {
				escaping = true;
				continue;
			}

			if (char === quote) {
				quote = '';
			}

			continue;
		}

		if (char === '"' || char === "'" || char === '`') {
			quote = char;
			continue;
		}

		if (char === '[') depth += 1;
		if (char === ']') {
			depth -= 1;
			if (depth === 0) {
				return text.slice(startIndex, index + 1);
			}
		}
	}

	return '';
}

function parseJsLikeArrayLiteral(literal = '') {
	const normalized = String(literal || '')
		.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3')
		.replace(/,\s*([}\]])/g, '$1');

	try {
		const parsed = JSON.parse(normalized);
		return Array.isArray(parsed) ? parsed : [];
	} catch (error) {
		logger.debug('Whitepages JS payload parse failed', {
			error: error.message,
		});
		return [];
	}
}

function safeJsonParse(value = '') {
	try {
		return JSON.parse(String(value || '').trim());
	} catch {
		return null;
	}
}

function toArray(value) {
	if (Array.isArray(value)) return value;
	return value ? [value] : [];
}

function extractWhitepagesSchemaPeople(payload) {
	const queue = [...toArray(payload)];
	const people = [];

	while (queue.length) {
		const current = queue.shift();
		if (!current || typeof current !== 'object') continue;

		if (current['@type'] === 'Person') {
			people.push(current);
		}

		if (current['@type'] === 'ListItem' && current.item) {
			queue.push(current.item);
		}

		if (current.mainEntity) {
			queue.push(...toArray(current.mainEntity));
		}

		if (current.itemListElement) {
			queue.push(...toArray(current.itemListElement));
		}

		if (current['@graph']) {
			queue.push(...toArray(current['@graph']));
		}
	}

	return people;
}

function mapWhitepagesSchemaPerson(person = {}, params = {}, url = '') {
	const primaryAddress = toArray(person.address).find((entry) => entry && typeof entry === 'object') || {};
	const location = canonicalizeLocation({
		city: primaryAddress.addressLocality || '',
		state: primaryAddress.addressRegion || '',
	});
	const ageProperty = toArray(person.additionalProperty).find((entry) => /age/i.test(String(entry?.name || '')));
	const formerPostalAddresses = toArray(person.address)
		.slice(1)
		.filter((entry) => entry && typeof entry === 'object')
		.map((entry) => {
			const parts = [
				normalizeName(entry.streetAddress || ''),
				normalizeName(entry.addressLocality || ''),
				normalizeName(entry.addressRegion || ''),
				normalizeName(entry.postalCode || ''),
				normalizeName(entry.addressCounty || ''),
			].filter(Boolean);
			return parts.join(', ');
		})
		.filter(Boolean);

	const formerAddresses = [
		...new Set([
			...formerPostalAddresses,
			...toArray(person.additionalProperty)
				.filter((entry) => /(previous|former)/i.test(String(entry?.name || '')))
				.map((entry) => normalizeName(entry?.value || ''))
				.filter(Boolean),
		]),
	];
	const relatives = toArray(person.relatedTo)
		.map((entry) => normalizeName(entry?.name || entry?.fullName || entry || ''))
		.filter(Boolean);
	const aliases = toArray(person.alternateName)
		.map((entry) => normalizeName(entry))
		.filter(Boolean);
	const detailsUrl = normalizeDiscoveredUrl(person.url || person['@id'] || '', url || 'https://www.whitepages.com');

	const profile = {
		firstName: normalizeName(person.givenName || person.firstName || params.firstName || ''),
		middleName: normalizeName(person.additionalName || person.middleName || params.middleName || ''),
		lastName: normalizeName(person.familyName || person.lastName || params.lastName || ''),
		age: parseAgeValue(String(ageProperty?.value || person.age || '')),
		ageText: normalizeName(ageProperty?.value || person.age || ''),
		address: normalizeName(primaryAddress.streetAddress || ''),
		city: location.city,
		state: location.state,
		zipCode: normalizeName(primaryAddress.postalCode || ''),
		county: normalizeName(primaryAddress.addressCounty || ''),
		phoneNumbers: toArray(person.telephone)
			.map((entry) => normalizeName(entry))
			.filter(Boolean),
		email: normalizeName(person.email || '').toLowerCase(),
		relatives,
		aliases: toAliasObjects(aliases),
		formerAddresses,
		website: detailsUrl || url,
		occupation: normalizeName(person.jobTitle || ''),
		company: normalizeName(person.worksFor?.name || ''),
	};

	return hasDirectoryProfileData(profile) ? profile : null;
}

function parseWhitepagesJsonLdProfiles(scriptText = '', params = {}, url = '') {
	if (!/ItemList|Person|PostalAddress/.test(String(scriptText || ''))) {
		return [];
	}

	const parsed = safeJsonParse(scriptText);
	if (!parsed) return [];

	return extractWhitepagesSchemaPeople(parsed)
		.map((person) => mapWhitepagesSchemaPerson(person, params, url))
		.filter(Boolean);
}

function loadWhitepagesReferenceFallback(params = {}) {
	try {
		const raw = readFileSync(new URL('../../data/profile-name.json', import.meta.url), 'utf8');
		const parsed = safeJsonParse(raw);
		if (!parsed) return [];

		return extractWhitepagesSchemaPeople(parsed)
			.map((person) => mapWhitepagesSchemaPerson(person, params, 'https://www.whitepages.com'))
			.filter((profile) => profile && matchesSearchParams(profile, params));
	} catch (error) {
		logger.debug('Whitepages reference fallback unavailable', {
			error: error.message,
		});
		return [];
	}
}

function buildWhitepagesAddressLabel(entry = {}) {
	if (!entry || typeof entry !== 'object') return '';

	return [entry.line1, entry.city, entry.state, entry.zip5 || entry.zipCode]
		.map((value) => normalizeName(value))
		.filter(Boolean)
		.join(', ');
}

function formatWhitepagesObfuscatedEmail(entry = {}) {
	const name = normalizeName(entry?.name || '')
		.toLowerCase()
		.replace(/[^a-z0-9._+-]/g, '');
	const domain = normalizeName(entry?.domain || '')
		.toLowerCase()
		.replace(/^@/, '');

	if (!domain) return '';
	return `${name || 'user'}*****@${domain}`;
}

function parseWhitepagesScriptProfiles(scriptText = '', params = {}, url = '') {
	const markerIndex = scriptText.indexOf('organicPeople:');
	if (markerIndex === -1) return [];

	const arrayStart = scriptText.indexOf('[', markerIndex);
	if (arrayStart === -1) return [];

	const literal = extractBalancedArrayLiteral(scriptText, arrayStart);
	if (!literal) return [];

	return parseJsLikeArrayLiteral(literal)
		.map((person) => {
			const currentAddress = person?.currentAddresses?.[0] || person?.uniqueAddresses?.[0] || {};
			const currentLabel = buildWhitepagesAddressLabel(currentAddress);
			const historicalAddressLabels = [...(person?.historicalAddresses || []), ...(person?.uniqueAddresses || [])]
				.map((entry) => buildWhitepagesAddressLabel(entry))
				.filter((value) => value && value !== currentLabel);
			const historicalLocations = (person?.historicalLocations || []).map((entry) => normalizeName(entry?.fullLocation || '')).filter(Boolean);
			const phones = [...(person?.nonMobilePhones || []), ...(person?.mobilePhones || [])].map((entry) => normalizeName(entry?.nationalNumber || '')).filter(Boolean);
			const relatives = (person?.relatives || []).map((entry) => normalizeName(entry?.name?.fullName || entry?.fullName || '')).filter(Boolean);
			const associates = (person?.associates || []).map((entry) => normalizeName(entry?.name?.fullName || entry?.fullName || '')).filter(Boolean);
			const aliases = (person?.akas || []).map((entry) => normalizeName(entry?.fullName || '')).filter(Boolean);
			const location = canonicalizeLocation({
				city: currentAddress?.city || person?.primaryLocation?.city || '',
				state: currentAddress?.state || person?.primaryLocation?.state || '',
			});
			const detailsUrl = normalizeDiscoveredUrl(person?.detailsUrl || '', url || 'https://www.whitepages.com');
			const linkedinUrl = normalizeDiscoveredUrl(person?.linkedinUrl || '', 'https://www.linkedin.com');

			const profile = {
				firstName: person?.firstName || params.firstName || '',
				middleName: person?.middleName || params.middleName || '',
				lastName: person?.lastName || params.lastName || '',
				age: parseAgeValue(String(person?.ageRange || person?.age || '')),
				ageText: normalizeName(person?.ageRange || person?.age || ''),
				address: normalizeName(currentAddress?.line1 || ''),
				city: location.city,
				state: location.state,
				zipCode: normalizeName(currentAddress?.zip5 || ''),
				phoneNumbers: [...new Set(phones)],
				email: formatWhitepagesObfuscatedEmail(person?.obfuscatedEmails?.[0]) || '',
				yearsAtAddress: '',
				relatives,
				otherNamesAtAddress: associates,
				aliases: toAliasObjects(aliases),
				formerAddresses: [...new Set([...historicalAddressLabels, ...historicalLocations])],
				website: detailsUrl || url,
				links: linkedinUrl ? [linkedinUrl] : [],
				occupation: normalizeName(person?.jobTitle || ''),
				company: normalizeName(person?.companyName || ''),
			};

			return hasDirectoryProfileData(profile) ? profile : null;
		})
		.filter(Boolean);
}

function parseWhitepagesCard($, el, params, url = '') {
	const card = $(el);
	const wrapperText = normalizeName(card.text());
	if (!wrapperText) return null;

	const parsed = parseWhitepagesBlock(wrapperText, params, url);
	if (!parsed) return null;

	const href = card.find("a[href*='/name/']").first().attr('href') || '';
	const detailsUrl = normalizeDiscoveredUrl(href, url || 'https://www.whitepages.com');

	return {
		...parsed,
		website: detailsUrl || parsed.website || url,
	};
}

function cleanWhitepagesBlockText(rawText = '') {
	return String(rawText || '')
		.replace(/\bPowered\s+By\s+Whitepages\s+Premium\b/gi, ' ')
		.replace(/\bPowered\s+By\s+Whitepages\b/gi, ' ')
		.replace(/\bView\s+Full\s+Report\b/gi, ' ')
		.replace(/\bEmail\b/gi, ' ')
		.replace(/\s{2,}/g, ' ')
		.trim();
}

function extractCityStateSegment(text = '') {
	const matches = [...String(text || '').matchAll(/([A-Z][A-Za-z .'-]+,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?)/g)];
	return matches.length ? matches[matches.length - 1][1] : '';
}

function parseWhitepagesBlock(rawText, params, url = '') {
	const cleanedText = cleanWhitepagesBlockText(rawText);
	if (!cleanedText) return null;

	const currentLocation = cleanedText.match(/(?:lives in|resides in|current address|current home address|known to live in)\s+([A-Za-z .'-]+,\s*[A-Z]{2})/i)?.[1] || '';
	// Extract both exact age and decade (e.g., '40s')
	let age = 0;
	let ageText = '';
	const ageMatch = cleanedText.match(/\bage\s*(\d{1,3})\b/i) || cleanedText.match(/(\d{1,3})\s+years old/i);
	if (ageMatch) {
		age = Number.parseInt(ageMatch[1], 10);
		ageText = String(age);
	} else {
		const decadeMatch = cleanedText.match(/\bage\s*(\d{2})s\b/i) || cleanedText.match(/\b(\d{2})s\b/i);
		if (decadeMatch) {
			age = Number.parseInt(decadeMatch[1], 10) + 5; // midpoint
			ageText = `${decadeMatch[1]}s`;
		}
	}
	const addresses = extractAddressCandidates(cleanedText);
	// Parse city/state for each address
	const allAddresses = addresses.map((addr) => {
		const parsed = parseStreetAddress(addr);
		return {
			raw: addr,
			address: parsed.address,
			city: parsed.city,
			state: parsed.state,
			zipCode: parsed.zipCode,
		};
	});
	const phones = [...new Set(cleanedText.match(PHONE_RE) || [])];
	const emails = [...new Set((cleanedText.match(EMAIL_RE) || []).map((email) => email.toLowerCase()))];
	// Always try to extract 'May Go By' and 'Related To' variants
	const relativesText =
		cleanedText.match(
			/(?:possible relatives|relatives|family members|related to)\s+(.+?)(?:possible aliases|may go by|also known as|aka|known as|lives in|resides in|address|phone|email|age|$)/i,
		)?.[1] || '';
	const aliasesText =
		cleanedText.match(
			/(?:possible aliases|may go by|also known as|aka|known as)\s+(.+?)(?:possible relatives|relatives|family members|related to|address|phone|email|age|$)/i,
		)?.[1] || '';
	const previousText =
		cleanedText.match(/(?:previous addresses|previous locations|used to live|lived in)\s+(.+?)(?:possible relatives|relatives|family members|address|phone|email|age|$)/i)?.[1] ||
		'';

	const nameText =
		cleanedText.match(/([A-Z][a-z]+(?:\s+[A-Z][A-Za-z'.-]+){1,3})(?:\s+(?:lives in|resides in)|,\s*Age|\s+Age)/)?.[1] ||
		cleanedText.match(/([A-Z][a-z]+(?:\s+[A-Z][A-Za-z'.-]+){1,3})(?=\s+[A-Z][A-Za-z .'-]+,\s*[A-Z]{2})/)?.[1] ||
		[params.firstName, params.middleName, params.lastName].filter(Boolean).join(' ');
	const locationText = currentLocation || extractCityStateSegment(cleanedText);
	const { city, state } = splitCityState(locationText);

	const parsed = {
		...splitFullName(nameText),
		age,
		ageText,
		address: addresses[0] || '',
		city,
		state,
		allAddresses,
		phoneNumbers: phones,
		email: emails[0] || '',
		yearsAtAddress: parseYearsAtAddress(rawText),
		relatives: extractPersonNames(relativesText, nameText),
		aliases: toAliasObjects(extractPersonNames(aliasesText, nameText)),
		formerAddresses: [...new Set([...extractFormerLocations(previousText), ...addresses.slice(1)])],
		website: url,
	};

	return hasDirectoryProfileData(parsed) ? parsed : null;
}

function parseWhitepagesPage(html, params, url = '') {
	const $ = cheerio.load(html);

	$('#permanent-lcp').remove();

	const scriptProfiles = $('script')
		.toArray()
		.flatMap((el) => parseWhitepagesScriptProfiles($(el).html() || '', params, url));
	const jsonLdProfiles = $("script[type='application/ld+json']")
		.toArray()
		.flatMap((el) => parseWhitepagesJsonLdProfiles($(el).html() || '', params, url));

	const selectorProfiles = [];
	$(".serp-card, .top-result, [data-js-selector='speedbump-injected'], .speedbump-card-wrapper")
		.toArray()
		.filter((el) => !$(el).closest('#permanent-lcp').length)
		.forEach((el) => {
			const parsed = parseWhitepagesCard($, el, params, url);
			if (parsed) selectorProfiles.push(parsed);
		});

	const blockProfiles = [];
	$(".speedbump-list, [class*='speedbump-list']")
		.toArray()
		.filter((el) => !$(el).closest('#permanent-lcp').length)
		.forEach((el) => {
			const parsed = parseWhitepagesBlock(normalizeName($(el).text()), params, url);
			if (parsed) blockProfiles.push(parsed);
		});

	if (!scriptProfiles.length && !jsonLdProfiles.length && !selectorProfiles.length && !blockProfiles.length) {
		const bodyText = normalizeName($('body').text());
		if (!bodyText) return [];

		const fallbackProfile = parseWhitepagesBlock(bodyText, params, url);
		return fallbackProfile ? [fallbackProfile] : [];
	}

	return dedupeDirectoryProfiles([...scriptProfiles, ...jsonLdProfiles, ...selectorProfiles, ...blockProfiles]);
}

function parse411Card($, el, params, url = '') {
	const cardRoot = $(el).closest("article, li, section, [class*='card'], [class*='Card'], [class*='result'], [class*='Result']");
	const fallbackRoot = cardRoot?.length ? cardRoot : $(el).parent();
	const wrapperText = normalizeName(fallbackRoot.text() || $(el).text() || '');
	const nameText =
		normalizeName(fallbackRoot.find('h2, h1').first().text()) ||
		wrapperText.match(/^([A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){1,3})(?=\s+[A-Z][A-Za-z .'-]+,\s*[A-Z]{2}\s+AGE)/)?.[1] ||
		[params.firstName, params.middleName, params.lastName].filter(Boolean).join(' ');
	const currentLocationRaw =
		normalizeName(fallbackRoot.find('h3').first().text()) ||
		normalizeName($(el).find('h3').first().text()) ||
		wrapperText.match(/([A-Z][A-Za-z .'-]+,\s*[A-Z]{2})(?=\s+AGE\b)/i)?.[1] ||
		wrapperText.match(/(?:lives in|from)\s+([A-Z][A-Za-z .'-]+,\s*[A-Z]{2})/i)?.[1] ||
		'';
	const age = parseAgeValue(wrapperText);
	const addresses = extractAddressCandidates(wrapperText);
	const teaserAddress = extractTeaserAddress(wrapperText);
	const primaryAddress = parseStreetAddress(addresses[0] || [teaserAddress.address, teaserAddress.city, teaserAddress.state].filter(Boolean).join(', '));
	const currentLocation = stripLeadingPersonName(currentLocationRaw || [teaserAddress.city, teaserAddress.state].filter(Boolean).join(', '), params, nameText);
	const { city, state } = splitCityState(currentLocation || [primaryAddress.city, primaryAddress.state].filter(Boolean).join(', '), params, nameText);
	const otherAddressesText =
		wrapperText.match(/OTHER ADDRESSES\s+(.+?)(?:MAY GO BY|FAMILY|RELATED TO|VIEW DETAILS|SHOW MORE|Birth, Death|$)/i)?.[1] ||
		wrapperText.match(/used to live in\s+(.+?)(?:MAY GO BY|FAMILY|RELATED TO|VIEW DETAILS|SHOW MORE|$)/i)?.[1] ||
		'';
	const relativesText =
		wrapperText.match(/FAMILY\s+(.+?)(?:OTHER ADDRESSES|MAY GO BY|RELATED TO|VIEW DETAILS|SHOW MORE|Birth, Death|$)/i)?.[1] ||
		wrapperText.match(/RELATED TO\s+(.+?)(?:OTHER ADDRESSES|MAY GO BY|FAMILY|VIEW DETAILS|SHOW MORE|Birth, Death|$)/i)?.[1] ||
		'';
	const aliasesText =
		wrapperText.match(/MAY GO BY\s+(.+?)(?:OTHER ADDRESSES|FAMILY|RELATED TO|VIEW DETAILS|SHOW MORE|Birth, Death|$)/i)?.[1] ||
		wrapperText.match(/also known as\s+(.+?)(?:OTHER ADDRESSES|FAMILY|RELATED TO|VIEW DETAILS|SHOW MORE|$)/i)?.[1] ||
		'';

	const parsed = {
		...splitFullName(nameText),
		age,
		address: primaryAddress.address || '',
		city,
		state,
		zipCode: primaryAddress.zipCode || teaserAddress.zipCode || '',
		phoneNumbers: [],
		email: '',
		yearsAtAddress: parseYearsAtAddress(wrapperText),
		relatives: extractPersonNames(relativesText, nameText),
		aliases: toAliasObjects(extractPersonNames(aliasesText, nameText)),
		formerAddresses: extractFormerLocations(otherAddressesText),
		website: url,
	};

	return hasDirectoryProfileData(parsed) ? parsed : null;
}

function parse411Block(rawText, params, url = '') {
	if (!rawText) return null;

	const nameText =
		rawText.match(/^([A-Z][a-z]+(?:\s+[A-Z][A-Za-z'.-]+){1,2})(?=\s+[A-Z][A-Za-z .'-]+,\s*[A-Z]{2}\s+AGE)/)?.[1] ||
		rawText.match(/([A-Z][a-z]+(?:\s+[A-Z][A-Za-z'.-]+){1,2})(?:\s+from\s+[A-Z]|\s+lives in\s+[A-Z]|\s+AGE)/)?.[1] ||
		[params.firstName, params.middleName, params.lastName].filter(Boolean).join(' ');
	const currentLocationRaw = rawText.match(/([A-Z][A-Za-z .'-]+,\s*[A-Z]{2})(?=\s+AGE)/i)?.[1] || rawText.match(/(?:lives in|from)\s+([A-Z][A-Za-z .'-]+,\s*[A-Z]{2})/i)?.[1] || '';
	const age = parseAgeValue(rawText);
	const otherAddressesText =
		rawText.match(/OTHER ADDRESSES\s+(.+?)(?:MAY GO BY|FAMILY|RELATED TO|View Details|SHOW MORE|Birth, Death|Frequently Asked Questions|$)/i)?.[1] ||
		rawText.match(/used to live in\s+(.+?)(?:Related to|MAY GO BY|FAMILY|OTHER ADDRESSES|View Details|SHOW MORE|$)/i)?.[1] ||
		'';
	const relativesText =
		rawText.match(/FAMILY\s+(.+?)(?:OTHER ADDRESSES|MAY GO BY|RELATED TO|View Details|SHOW MORE|Birth, Death|Frequently Asked Questions|$)/i)?.[1] ||
		rawText.match(/Who are [A-Za-z .'-]+'s relatives\?\s+(.+?)(?:What is|Where can|OTHER ADDRESSES|$)/i)?.[1] ||
		'';
	const aliasesText =
		rawText.match(/MAY GO BY\s+(.+?)(?:OTHER ADDRESSES|FAMILY|RELATED TO|View Details|SHOW MORE|$)/i)?.[1] ||
		rawText.match(/also known as\s+(.+?)(?:Where can|Who are|OTHER ADDRESSES|$)/i)?.[1] ||
		'';
	const phones = [...new Set(rawText.match(PHONE_RE) || [])];
	const emails = [...new Set((rawText.match(EMAIL_RE) || []).map((email) => email.toLowerCase()))];
	const addresses = extractAddressCandidates(rawText);
	const teaserAddress = extractTeaserAddress(rawText);
	const primaryAddress = parseStreetAddress(addresses[0] || [teaserAddress.address, teaserAddress.city, teaserAddress.state].filter(Boolean).join(', '));
	const currentLocation = stripLeadingPersonName(currentLocationRaw || [teaserAddress.city, teaserAddress.state].filter(Boolean).join(', '), params, nameText);
	const { city, state } = splitCityState(currentLocation || [primaryAddress.city, primaryAddress.state].filter(Boolean).join(', '), params, nameText);

	const parsed = {
		...splitFullName(nameText),
		age,
		address: primaryAddress.address || '',
		city,
		state,
		zipCode: primaryAddress.zipCode || teaserAddress.zipCode || '',
		phoneNumbers: phones,
		email: emails[0] || '',
		yearsAtAddress: parseYearsAtAddress(rawText),
		relatives: extractPersonNames(relativesText, nameText),
		aliases: toAliasObjects(extractPersonNames(aliasesText, nameText)),
		formerAddresses: [...new Set([...extractFormerLocations(otherAddressesText), ...addresses.slice(primaryAddress.address ? 1 : 0)])],
		website: url,
	};

	return hasDirectoryProfileData(parsed) ? parsed : null;
}

function parse411Page(html, params, url = '') {
	const $ = cheerio.load(html);
	const selectorProfiles = [];

	$("[data-amp-label='WPClickedPersonResults'], .amp-click-event").each((_i, el) => {
		const parsed = parse411Card($, el, params, url);
		if (parsed) selectorProfiles.push(parsed);
	});

	const bodyText = normalizeName($('body').text());
	if (!bodyText) {
		return dedupeDirectoryProfiles(selectorProfiles);
	}

	const firstNamePattern = escapeRegExp(params.firstName || '');
	const lastNamePattern = escapeRegExp(params.lastName || '');

	if (!firstNamePattern || !lastNamePattern) {
		const fallback = parse411Block(bodyText, params, url);
		return dedupeDirectoryProfiles([...selectorProfiles, ...(fallback ? [fallback] : [])]);
	}

	const namePattern = `${firstNamePattern}(?:\\s+[A-Z][A-Za-z'.-]+){0,3}\\s+${lastNamePattern}`;
	const blockRegex = new RegExp(`(${namePattern}[\\s\\S]*?)(?=${namePattern}|Frequently Asked Questions|Additional Links|$)`, 'gi');

	const blocks = [...bodyText.matchAll(blockRegex)].map((match) => normalizeName(match[1])).filter((block) => /AGE|FAMILY|MAY GO BY|Used to live|OTHER ADDRESSES/i.test(block));

	const parsedProfiles = blocks.map((block) => parse411Block(block, params, url)).filter(Boolean);

	const fallback = parsedProfiles.length || selectorProfiles.length ? null : parse411Block(bodyText, params, url);

	return dedupeDirectoryProfiles([...selectorProfiles, ...parsedProfiles, ...(fallback ? [fallback] : [])]);
}

function buildMyLifeUrls(params) {
	const urls = new Set();

	for (const firstNameOption of getFirstNameVariants(params.firstName).length ? getFirstNameVariants(params.firstName) : [params.firstName]) {
		const slug = buildNameSlug(params, firstNameOption);
		if (slug) {
			urls.add(`https://www.mylife.com/${slug}/`);
		}
	}

	return [...urls].slice(0, 8);
}

function parseMyLifeBlock(rawText, params, url = '') {
	if (!rawText) return null;

	const nameText =
		rawText.match(/([A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){1,3})(?=\s+(?:was born|lives in|currently lives in|is \d{1,3} years old|Age))/i)?.[1] ||
		[params.firstName, params.middleName, params.lastName].filter(Boolean).join(' ');

	const currentLocation =
		rawText.match(/(?:right now,?\s*)?[A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){0,3}\s+lives in\s+([A-Z][A-Za-z .'-]+,\s*[A-Z]{2})/i)?.[1] ||
		rawText.match(/(?:currently lives in|lives in)\s+([A-Z][A-Za-z .'-]+,\s*[A-Z]{2})/i)?.[1] ||
		'';

	const age = Number.parseInt(rawText.match(/Age\s+(\d{1,3})/i)?.[1] || rawText.match(/is\s+(\d{1,3})\s+years old/i)?.[1] || '', 10) || 0;

	const aliasesText = rawText.match(/(?:also answers to|also known as)\s+(.+?)(?:right now|currently lives in|related to|phone|email|address|$)/i)?.[1] || '';
	const relativesText = rawText.match(/related to\s+(.+?)(?:also answers to|also known as|phone|email|address|$)/i)?.[1] || '';
	const addresses = extractAddressCandidates(rawText);
	const primaryAddress = parseStreetAddress(addresses[0] || '');
	const { city, state } = splitCityState(currentLocation || [primaryAddress.city, primaryAddress.state].filter(Boolean).join(', '), params, nameText);

	const parsed = {
		...splitFullName(nameText),
		age,
		address: primaryAddress.address || '',
		city,
		state,
		zipCode: primaryAddress.zipCode || '',
		phoneNumbers: [...new Set(rawText.match(PHONE_RE) || [])],
		email: (rawText.match(EMAIL_RE) || [''])[0].toLowerCase(),
		yearsAtAddress: parseYearsAtAddress(rawText),
		relatives: extractPersonNames(relativesText, nameText),
		aliases: toAliasObjects(extractPersonNames(aliasesText, nameText)),
		formerAddresses: addresses.slice(primaryAddress.address ? 1 : 0),
		website: url,
	};

	return hasDirectoryProfileData(parsed) ? parsed : null;
}

function parseMyLifePage(html, params, url = '') {
	const $ = cheerio.load(html);
	const rawText = normalizeName($('body').text());

	if (!rawText) return [];

	const firstName = escapeRegExp(params.firstName || '');
	const lastName = escapeRegExp(params.lastName || '');

	if (!firstName || !lastName) {
		const fallback = parseMyLifeBlock(rawText, params, url);
		return fallback ? [fallback] : [];
	}

	const namePattern = `${firstName}(?:\\s+[A-Z][A-Za-z'.-]+){0,3}\\s+${lastName}`;
	const blockRegex = new RegExp(`(${namePattern}[\\s\\S]*?)(?=${namePattern}|$)`, 'gi');

	const parsedProfiles = [...rawText.matchAll(blockRegex)]
		.map((match) => normalizeName(match[1]))
		.filter((block) => /lives in|currently lives in|was born|years old|Age/i.test(block))
		.map((block) => parseMyLifeBlock(block, params, url))
		.filter(Boolean);

	if (parsedProfiles.length) {
		return dedupeDirectoryProfiles(parsedProfiles);
	}

	const fallback = parseMyLifeBlock(rawText, params, url);
	return fallback ? [fallback] : [];
}

// ─── That's Them ─────────────────────────────────────────────────────────────

function parseThatsThemBlock(rawText, params, url = '') {
	if (!rawText) return null;

	const nameText =
		rawText.match(/^([A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){1,3})(?=\s+(?:Known as:|Lives in|RUN FULL BACKGROUND SEARCH|PHONE NUMBERS:|CURRENT ADDRESS:|$))/)?.[1] ||
		[params.firstName, params.middleName, params.lastName].filter(Boolean).join(' ');

	const aliasesText = rawText.match(/Known as:\s+(.+?)(?:Lives in|RUN FULL BACKGROUND SEARCH|PHONE NUMBERS:|CURRENT ADDRESS:|$)/i)?.[1] || '';
	const currentLocation =
		rawText.match(/Lives in\s+([A-Z][A-Za-z .'-]+,\s*[A-Z]{2})/i)?.[1] || rawText.match(/CURRENT ADDRESS:\s+.+?\s+([A-Z][A-Za-z .'-]+,\s*[A-Z]{2})/i)?.[1] || '';
	const previousText = rawText.match(/PREVIOUS ADDRESSES:\s+(.+?)(?:RELATIVES:|EMAIL ADDRESSES:|CURRENT ADDRESS:|$)/i)?.[1] || '';
	const relativesText = rawText.match(/RELATIVES:\s+(.+?)(?:EMAIL ADDRESSES:|PHONE NUMBERS:|CURRENT ADDRESS:|$)/i)?.[1] || '';
	const addressText = rawText.match(/CURRENT ADDRESS:\s+(.+?)(?:PREVIOUS ADDRESSES:|RELATIVES:|EMAIL ADDRESSES:|$)/i)?.[1] || '';
	const addresses = extractAddressCandidates(`${addressText} ${previousText}`);
	const { city, state } = splitCityState(currentLocation);

	const parsed = {
		...splitFullName(nameText),
		age: parseAgeValue(rawText),
		address: addresses[0] || '',
		city,
		state,
		phoneNumbers: [...new Set(rawText.match(PHONE_RE) || [])],
		email: (rawText.match(EMAIL_RE) || [''])[0].toLowerCase(),
		yearsAtAddress: parseYearsAtAddress(rawText),
		relatives: extractPersonNames(relativesText, nameText),
		aliases: toAliasObjects(extractPersonNames(aliasesText, nameText)),
		formerAddresses: [...new Set([...extractFormerLocations(previousText), ...addresses.slice(1)])],
		website: url,
	};

	return hasDirectoryProfileData(parsed) ? parsed : null;
}

function parseThatsThemPage(html, params, url = '') {
	const $ = cheerio.load(html);
	const rawText = normalizeName($('body').text());

	if (!rawText || looksLikeAccessInterstitial(rawText)) {
		return [];
	}

	const firstNamePattern = escapeRegExp(params.firstName || '');
	const lastNamePattern = escapeRegExp(params.lastName || '');

	if (!firstNamePattern || !lastNamePattern) {
		const fallback = parseThatsThemBlock(rawText, params, url);
		return fallback ? [fallback] : [];
	}

	const namePattern = `${firstNamePattern}(?:\\s+[A-Z][A-Za-z'.-]+){0,3}\\s+${lastNamePattern}`;
	const blockRegex = new RegExp(`(${namePattern}[\\s\\S]*?)(?=${namePattern}|Found\\s+\\d+\\s+results|$)`, 'gi');

	const parsedProfiles = [...rawText.matchAll(blockRegex)]
		.map((match) => normalizeName(match[1]))
		.filter((block) => /Lives in|CURRENT ADDRESS:|Known as:/i.test(block))
		.map((block) => parseThatsThemBlock(block, params, url))
		.filter(Boolean);

	if (parsedProfiles.length) {
		return dedupeDirectoryProfiles(parsedProfiles);
	}

	const fallback = parseThatsThemBlock(rawText, params, url);
	return fallback ? [fallback] : [];
}

export async function searchThatsThem(params) {
	// That'sThem searches have been disabled.
	logger.debug('searchThatsThem disabled by configuration');
	return { source: 'thatsthem', profiles: [] };
}

// ─── PeopleFinder ────────────────────────────────────────────────────────────

export async function searchPeopleFinder(params) {
	if (!params.firstName || !params.lastName) {
		return { source: 'peoplefinder', profiles: [] };
	}

	try {
		const discoveredLinks = await discoverSiteLinks(buildPeopleFinderQueries(params), /peoplefinder\.com/i, 6);

		const profiles = [];

		for (const url of discoveredLinks.slice(0, 4)) {
			try {
				await delay(Math.floor(DELAY_MS / 2));
				const data = await fetchDirectoryPage(url, { renderFirst: true });
				if (!data) continue;

				const parsed = parsePeopleFinderPage(data, params);
				if (parsed && matchesSearchParams(parsed, params)) {
					profiles.push(parsed);
				}
			} catch (err) {
				logger.debug('PeopleFinder detail fetch skipped', {
					url,
					error: err.message,
				});
			}
		}

		logger.debug('PeopleFinder results', {
			count: profiles.length,
			links: discoveredLinks.length,
		});
		return { source: 'peoplefinder', profiles };
	} catch (err) {
		logger.error('PeopleFinder error', { error: err.message });
		return { source: 'peoplefinder', profiles: [] };
	}
}

export async function searchPeopleSearchNow(params) {
	if (!params.firstName || !params.lastName) {
		return { source: 'peoplesearchnow', profiles: [] };
	}

	const firstNameOptions = getFirstNameVariants(params.firstName);
	const profiles = [];

	for (const firstNameOption of firstNameOptions.length ? firstNameOptions : [params.firstName]) {
		const slug = buildNameSlug(params, firstNameOption);
		const url = `https://www.peoplesearchnow.com/${slug}`;

		try {
			await delay(DELAY_MS);
			const data = await fetchDirectoryPage(url, { renderFirst: true });
			if (!data) continue;

			const parsed = parsePeopleSearchNowPage(data, {
				...params,
				firstName: toTitleCase(firstNameOption),
			});

			if (parsed && matchesSearchParams(parsed, params)) {
				profiles.push(parsed);
			}
		} catch (err) {
			logger.debug('PeopleSearchNow variant skipped', {
				url,
				error: err.message,
			});
		}
	}

	const uniqueProfiles = dedupeDirectoryProfiles(profiles);
	logger.debug('PeopleSearchNow results', { count: uniqueProfiles.length });
	return { source: 'peoplesearchnow', profiles: uniqueProfiles };
}

export async function searchWhitepages(params) {
	// Whitepages searches have been disabled.
	logger.debug('searchWhitepages disabled by configuration');
	return { source: 'whitepages', profiles: [] };
}

export async function searchMyLife(params) {
	if (!params.firstName || !params.lastName) {
		return { source: 'mylife', profiles: [] };
	}

	const profiles = [];
	const visited = new Set();
	const urls = [...buildMyLifeUrls(params), ...(await discoverSiteLinks(buildMyLifeQueries(params), /mylife\.com/i, 6))];

	for (const url of urls) {
		if (!url || visited.has(url)) continue;
		visited.add(url);

		try {
			await delay(DELAY_MS);
			const data = await fetchDirectoryPage(url, { renderFirst: true });
			if (!data) continue;

			const parsedProfiles = parseMyLifePage(data, params, url);
			profiles.push(...parsedProfiles.filter((profile) => matchesSearchParams(profile, params)));
		} catch (err) {
			logger.debug('MyLife variant skipped', { url, error: err.message });
		}
	}

	const uniqueProfiles = dedupeDirectoryProfiles(profiles);
	logger.debug('MyLife results', {
		count: uniqueProfiles.length,
		urls: visited.size,
	});
	return { source: 'mylife', profiles: uniqueProfiles };
}

export async function search411(params) {
	// 411 searches have been disabled.
	logger.debug('search411 disabled by configuration');
	return { source: '411', profiles: [] };
}

// ─── Run all directory searches in parallel ───────────────────────────────────

const DIRECTORY_RETRY_LIMIT = Number(process.env.DIRECTORY_RETRY_LIMIT) || 2;
const DIRECTORY_RETRY_DELAY_MS = Number(process.env.DIRECTORY_RETRY_DELAY_MS) || 2000;
const DIRECTORY_RUN_TIMEOUT_MS = Number(process.env.DIRECTORY_RUN_TIMEOUT_MS) || 90000;

function describeDirectoryTarget(params = {}) {
	return [params.firstName, params.middleName, params.lastName].filter(Boolean).join(' ');
}

function withDirectoryTimeout(promise, ms, message) {
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

async function runDirectoryJobWithRetry({ source, runner }, params, onProgress, target, location) {
	let lastError;

	for (let attempt = 1; attempt <= DIRECTORY_RETRY_LIMIT; attempt += 1) {
		onProgress?.({
			source,
			kind: 'directory',
			status: 'running',
			percent: attempt > 1 ? 55 : 35,
			message:
				attempt > 1 ?
					`Retry ${attempt}/${DIRECTORY_RETRY_LIMIT}: scanning ${target}${location ? ` in ${location}` : ''}`
				:	`Scanning ${target}${location ? ` in ${location}` : ''}`,
		});

		try {
			const result = await withDirectoryTimeout(runner(params), DIRECTORY_RUN_TIMEOUT_MS, `${source} directory scan timed out`);
			const itemCount = Array.isArray(result?.profiles) ? result.profiles.length : 0;

			onProgress?.({
				source,
				kind: 'directory',
				status: itemCount ? 'fetched' : 'no-data',
				itemCount,
				percent: 100,
				message: itemCount ? `Processed ${itemCount} profile candidates` : 'No directory records found',
			});

			return result;
		} catch (error) {
			lastError = error;
			const shouldRetry = attempt < DIRECTORY_RETRY_LIMIT;

			logger.warn('Directory crawler attempt failed', {
				source,
				attempt,
				retrying: shouldRetry,
				error: error.message,
			});

			if (shouldRetry) {
				onProgress?.({
					source,
					kind: 'directory',
					status: 'running',
					percent: 65,
					itemCount: 0,
					message: `Attempt ${attempt} failed, queued to scan again (${attempt + 1}/${DIRECTORY_RETRY_LIMIT})`,
				});
				await delay(DIRECTORY_RETRY_DELAY_MS * attempt);
				continue;
			}

			onProgress?.({
				source,
				kind: 'directory',
				status: 'error',
				itemCount: 0,
				percent: 100,
				message: `${error.message || 'Crawler failed'} after ${attempt} attempt${attempt > 1 ? 's' : ''}`,
			});
		}
	}

	throw lastError;
}

export async function runAllDirectorySearches(params, onProgress) {
	const resolvedParams = deriveSourceUrlParams(params);
	const target = describeDirectoryTarget(resolvedParams) || 'requested person';
	const location = [resolvedParams.city, resolvedParams.state].filter(Boolean).join(', ');
	const directSourceType = getSupportedSourceUrlType(resolvedParams.sourceUrl || '');
	const directOnlyMode = Boolean(params.sourceUrl && !params.firstName && !params.lastName && !params.address && !params.city && !params.state);
	const runners =
		directOnlyMode ?
			[
				...(directSourceType ?
					[
						{
							source: directSourceType,
							runner: searchPropertySourceUrl,
						},
					]
				:	[]),
			]
		:	[
				...(directSourceType ?
					[
						{
							source: directSourceType,
							runner: searchPropertySourceUrl,
						},
					]
				:	[]),
			];

	const jobs = runners.map((job) => runDirectoryJobWithRetry(job, resolvedParams, onProgress, target, location));

	const settled = await Promise.allSettled(jobs);
	const results = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);

	// ─── MLS Data Integration ──────────────────────────────────────────────
	// If address/city/state/zip are present, look up MLS data and add to result
	try {
		const { address, city, state, zipCode } = resolvedParams;
		if (address && city && state && zipCode) {
			// Lazy import to avoid circular deps
			const { loadMLSData, findMLSByAddress } = await import('../dataLayer/mlsData.js');
			loadMLSData();
			const mlsMatches = findMLSByAddress(address, city, state, zipCode);
			if (mlsMatches && mlsMatches.length) {
				// Attach MLS# and last sold date to the first profile result (if any)
				const mls = mlsMatches[0];
				if (results.length && results[0].profiles && results[0].profiles.length) {
					results[0].profiles[0].mlsNumber = mls.mls_number || mls.mlsNumber || '';
					results[0].profiles[0].lastSoldDate = mls.last_sold_date || mls.lastSoldDate || '';
				} else {
					// If no profiles, create a stub
					results.unshift({
						source: 'mls',
						profiles: [
							{
								address,
								city,
								state,
								zipCode,
								mlsNumber: mls.mls_number || mls.mlsNumber || '',
								lastSoldDate: mls.last_sold_date || mls.lastSoldDate || '',
							},
						],
					});
				}
			}
		}
	} catch (err) {
		// fail silently if MLS integration fails
	}

	return results;
}
