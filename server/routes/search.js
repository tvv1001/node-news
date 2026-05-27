import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { isBlockedSearchResultUrl, runAllSearchEngines } from '../services/crawler/searchEngines.js';
import { getRecentSearchRunQueries, getSearchRunById, listSearchRuns, saveSearchRun } from '../services/dataLayer/db.js';
import { searchLimiter } from '../middleware/rateLimiter.js';
import { getZillowPropertyDetails } from '../services/crawler/zillowScraper.js';
import { logger, logStream } from '../utils/logger.js';
import { canonicalizeLocation, getKnownStates, searchLocations } from '../utils/locationIndex.js';
import { parseDocument } from '../services/crawler/documentParser.js';
import { runScrapyCrawler } from '../services/crawler/scrapyRunner.js';

export const searchRouter = Router();

searchRouter.get('/zillow', async (req, res) => {
	try {
		const { address } = req.query;
		if (!address) {
			return res.status(400).json({ error: 'Missing address query parameter' });
		}
		const data = await getZillowPropertyDetails(address);
		if (!data) return res.status(404).json({ error: 'Property not found' });
		res.json(data);
	} catch (error) {
		res.status(500).json({ error: 'Failed to fetch property details' });
	}
});

const DEFAULT_CRAWLERS = [
	{ source: 'google', kind: 'search-engine' },
	{ source: 'bing', kind: 'search-engine' },
	// Directory sources removed: that'sthem, whitepages, 411
];

const HIDDEN_CRAWLER_SOURCES = new Set(['thatsthem', 'whitepages', '411']);

const searchJobs = new Map();
const SEARCH_JOB_TTL_MS = 15 * 60 * 1000;
const JOB_LOG_LIMIT = 140;
const BACKGROUND_CRAWL_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.BACKGROUND_CRAWL_ENABLED || 'false'));
const BACKGROUND_CRAWL_INTERVAL_MS = Math.max(60 * 1000, Number(process.env.BACKGROUND_CRAWL_INTERVAL_MS) || 15 * 60 * 1000);
const BACKGROUND_CRAWL_QUERY_LIMIT = Math.max(1, Math.min(100, Number(process.env.BACKGROUND_CRAWL_QUERY_LIMIT) || 10));
const BACKGROUND_CRAWL_STARTUP_DELAY_MS = Math.max(5 * 1000, Number(process.env.BACKGROUND_CRAWL_STARTUP_DELAY_MS) || 15 * 1000);
const LOCATION_SUGGESTION_CACHE_TTL_MS = Math.max(1000, Number(process.env.LOCATION_SUGGESTION_CACHE_TTL_MS) || 30 * 1000);
const BACKGROUND_STATUS_CACHE_TTL_MS = Math.max(500, Number(process.env.BACKGROUND_STATUS_CACHE_TTL_MS) || 3 * 1000);

const backgroundCrawlerState = {
	enabled: BACKGROUND_CRAWL_ENABLED,
	running: false,
	currentActivity: BACKGROUND_CRAWL_ENABLED ? 'Waiting for initial background crawl window…' : 'Background crawl disabled',
	currentQuery: null,
	queuedQueryCount: 0,
	processedQueries: 0,
	lastStartedAt: '',
	lastCompletedAt: '',
	lastPersistedRunId: '',
	lastError: '',
	nextRunAt: '',
};

let backgroundCrawlerTimer = null;
let backgroundCrawlerStarted = false;
const locationSuggestionCache = new Map();
let cachedBackgroundStatus = {
	expiresAt: 0,
	value: null,
};

function detachJobLogger(job) {
	if (job?.logListener) {
		logStream.off('line', job.logListener);
		job.logListener = null;
	}
}

function appendJobLog(job, update = {}) {
	if (!job) return;

	const message = String(update.line || [update.source ? `[${update.source}]` : '', update.message || update.currentActivity || ''].filter(Boolean).join(' ')).trim();

	if (!message) return;

	const lastEntry = job.logs[job.logs.length - 1];
	if (lastEntry?.line === message) return;

	job.logs.push({
		at: new Date().toISOString(),
		line: message,
	});

	if (job.logs.length > JOB_LOG_LIMIT) {
		job.logs = job.logs.slice(-JOB_LOG_LIMIT);
	}
}

function describeQueryDetails(query = {}) {
	return [
		query.searchTerm ? `term="${query.searchTerm}"` : '',
		query.name ? `name="${query.name}"` : '',
		query.location ? `location="${query.location}"` : '',
		query.address ? `address="${query.address}"` : '',
		query.sourceUrl ? `url="${query.sourceUrl}"` : '',
		query.ageRange ? `age=${query.ageRange}` : '',
		Number.isFinite(query.aliasCount) ? `aliases=${query.aliasCount}` : '',
	]
		.filter(Boolean)
		.join(' | ');
}

function describeSearchLabel(params = {}) {
	return String(params.searchTerm || '').trim() || String(params.address || '').trim() || String(params.sourceUrl || '').trim() || 'background search';
}

function persistSearchOutcome(params, result, metadata = {}) {
	const persistedRun = saveSearchRun(params, result, metadata);
	return {
		...result,
		searchRunId: persistedRun.runId,
	};
}

function getBackgroundCrawlStatus() {
	return {
		...backgroundCrawlerState,
		currentQuery: backgroundCrawlerState.currentQuery ? { ...backgroundCrawlerState.currentQuery } : null,
	};
}

function getCachedLocationSearchPayload(query = '') {
	const key = String(query || '')
		.trim()
		.toLowerCase();
	const now = Date.now();
	const existing = locationSuggestionCache.get(key);

	if (existing && existing.expiresAt > now) {
		return existing.payload;
	}

	const payload = {
		states: getKnownStates(),
		results: searchLocations(query),
	};

	locationSuggestionCache.set(key, {
		expiresAt: now + LOCATION_SUGGESTION_CACHE_TTL_MS,
		payload,
	});

	if (locationSuggestionCache.size > 200) {
		for (const [cacheKey, value] of locationSuggestionCache.entries()) {
			if (value.expiresAt <= now) {
				locationSuggestionCache.delete(cacheKey);
			}
		}
	}

	return payload;
}

function getCachedBackgroundStatusPayload() {
	const now = Date.now();
	if (cachedBackgroundStatus.value && cachedBackgroundStatus.expiresAt > now) {
		return cachedBackgroundStatus.value;
	}

	backgroundCrawlerState.queuedQueryCount = getRecentSearchRunQueries(BACKGROUND_CRAWL_QUERY_LIMIT).length;
	const payload = getBackgroundCrawlStatus();

	cachedBackgroundStatus = {
		expiresAt: now + BACKGROUND_STATUS_CACHE_TTL_MS,
		value: payload,
	};

	return payload;
}

function scheduleBackgroundCrawl(delayMs = BACKGROUND_CRAWL_INTERVAL_MS) {
	if (!BACKGROUND_CRAWL_ENABLED) return;

	if (backgroundCrawlerTimer) {
		clearTimeout(backgroundCrawlerTimer);
	}

	backgroundCrawlerState.nextRunAt = new Date(Date.now() + delayMs).toISOString();
	backgroundCrawlerTimer = setTimeout(() => {
		void runBackgroundCrawlCycle();
	}, delayMs);
}

async function runBackgroundCrawlCycle() {
	if (!BACKGROUND_CRAWL_ENABLED) return;

	if (backgroundCrawlerState.running) {
		logger.warn('Background crawl overlap prevented');
		scheduleBackgroundCrawl(BACKGROUND_CRAWL_INTERVAL_MS);
		return;
	}

	const queries = getRecentSearchRunQueries(BACKGROUND_CRAWL_QUERY_LIMIT).map((query) => normalizeSearchParams(query));
	backgroundCrawlerState.queuedQueryCount = queries.length;

	if (!queries.length) {
		backgroundCrawlerState.currentActivity = 'Waiting for persisted searches to seed background crawl…';
		scheduleBackgroundCrawl(BACKGROUND_CRAWL_INTERVAL_MS);
		return;
	}

	backgroundCrawlerState.running = true;
	backgroundCrawlerState.lastStartedAt = new Date().toISOString();
	backgroundCrawlerState.lastError = '';
	backgroundCrawlerState.currentActivity = `Processing ${queries.length} persisted quer${queries.length === 1 ? 'y' : 'ies'} in the background…`;

	try {
		for (const query of queries) {
			backgroundCrawlerState.currentQuery = query;
			backgroundCrawlerState.currentActivity = `Background crawling ${describeSearchLabel(query)}`;

			try {
				const result = await executeSearch(query);
				const persistedResult = persistSearchOutcome(query, result, {
					trigger: 'background',
					status: 'completed',
				});

				backgroundCrawlerState.lastPersistedRunId = persistedResult.searchRunId || '';
				backgroundCrawlerState.processedQueries += 1;

				logger.info('Background crawl completed', {
					searchRunId: persistedResult.searchRunId,
					query: describeSearchLabel(query),
				});
			} catch (error) {
				backgroundCrawlerState.lastError = error.message;
				logger.error('Background crawl query failed', {
					error: error.message,
					query: describeSearchLabel(query),
				});
			}
		}
	} finally {
		backgroundCrawlerState.running = false;
		backgroundCrawlerState.currentQuery = null;
		backgroundCrawlerState.currentActivity = 'Background crawl idle';
		backgroundCrawlerState.lastCompletedAt = new Date().toISOString();
		scheduleBackgroundCrawl(BACKGROUND_CRAWL_INTERVAL_MS);
	}
}

export function startBackgroundCrawlService() {
	if (backgroundCrawlerStarted) {
		return;
	}

	backgroundCrawlerStarted = true;

	if (!BACKGROUND_CRAWL_ENABLED) {
		logger.info('Background crawl service is disabled');
		return;
	}

	logger.info('Background crawl service scheduled', {
		intervalMs: BACKGROUND_CRAWL_INTERVAL_MS,
		queryLimit: BACKGROUND_CRAWL_QUERY_LIMIT,
		startupDelayMs: BACKGROUND_CRAWL_STARTUP_DELAY_MS,
	});

	scheduleBackgroundCrawl(BACKGROUND_CRAWL_STARTUP_DELAY_MS);
}

function createInitialCrawlerState(params = {}) {
	const shouldRunSearchEngines = Boolean(params.searchTerm || params.address || params.sourceUrl);
	const shouldRunDirectories = false;

	return DEFAULT_CRAWLERS.filter((crawler) => {
		if (crawler.kind === 'search-engine') return shouldRunSearchEngines;
		return shouldRunDirectories;
	}).map((crawler) => ({
		...crawler,
		status: 'queued',
		itemCount: 0,
		percent: 0,
		message: 'Waiting to start',
	}));
}

function cleanupExpiredJobs() {
	const cutoff = Date.now() - SEARCH_JOB_TTL_MS;
	for (const [jobId, job] of searchJobs.entries()) {
		if (Date.parse(job.updatedAt) < cutoff) {
			detachJobLogger(job);
			searchJobs.delete(jobId);
		}
	}
}

function resolvePercent(status, percent = 0) {
	if (Number.isFinite(percent)) {
		return Math.max(0, Math.min(100, Number(percent)));
	}

	if (status === 'running') return 55;
	if (['fetched', 'no-data', 'error'].includes(status)) return 100;
	return 0;
}

function createSearchJob(params) {
	cleanupExpiredJobs();

	const job = {
		jobId: randomUUID(),
		status: 'queued',
		progress: 0,
		currentActivity: 'Preparing crawler jobs…',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		query: {
			searchTerm: params.searchTerm || '',
			name: '',
			location: [params.city, params.state].filter(Boolean).join(', '),
			address: params.address || '',
			sourceUrl: params.sourceUrl || '',
			ageRange: params.ageMin || params.ageMax ? `${params.ageMin ?? '?'}-${params.ageMax ?? '?'}` : '',
			aliasCount: 0,
		},
		crawlStatuses: createInitialCrawlerState(params),
		logs: [],
		result: null,
		error: '',
	};

	if (job.query.searchTerm) {
		appendJobLog(job, {
			line: `payload | search="${job.query.searchTerm}"`,
		});
	}
	appendJobLog(job, { line: 'Session started' });
	appendJobLog(job, {
		line: `payload | ${describeQueryDetails(job.query) || 'basic lookup'}`,
	});
	appendJobLog(job, { currentActivity: job.currentActivity });

	job.logListener = (entry) => appendJobLog(job, entry);
	logStream.on('line', job.logListener);

	searchJobs.set(job.jobId, job);
	return job;
}

function updateSearchJob(jobId, update = {}) {
	const job = searchJobs.get(jobId);
	if (!job) return;

	job.updatedAt = new Date().toISOString();
	if (update.currentActivity) {
		job.currentActivity = update.currentActivity;
	}

	if (update.source) {
		const existing = job.crawlStatuses.find((entry) => entry.source === update.source);

		const nextState = {
			...(existing || {
				source: update.source,
				kind: update.kind || 'directory',
				status: 'queued',
				itemCount: 0,
				percent: 0,
				message: 'Waiting to start',
			}),
			...update,
		};

		nextState.percent = resolvePercent(nextState.status, nextState.percent);

		if (existing) {
			Object.assign(existing, nextState);
		} else {
			job.crawlStatuses.push(nextState);
		}

		if (update.message) {
			job.currentActivity = `${update.source}: ${update.message}`;
		}
	}

	const total = job.crawlStatuses.length || 1;
	const sum = job.crawlStatuses.reduce((acc, entry) => acc + resolvePercent(entry.status, entry.percent), 0);

	job.progress = Math.max(0, Math.min(100, Math.round(sum / total)));

	if (job.status !== 'completed' && job.status !== 'failed') {
		job.status = 'running';
	}
}

function mergeCrawlStatuses(existingEntries = [], incomingEntries = []) {
	const merged = new Map();

	for (const entry of existingEntries) {
		if (entry?.source && !HIDDEN_CRAWLER_SOURCES.has(entry.source)) {
			merged.set(entry.source, { ...entry });
		}
	}

	for (const entry of incomingEntries) {
		if (!entry?.source) continue;
		if (HIDDEN_CRAWLER_SOURCES.has(entry.source)) continue;

		merged.set(entry.source, {
			...(merged.get(entry.source) || {}),
			...entry,
			percent: resolvePercent(entry.status, entry.percent),
		});
	}

	const sourceOrder = DEFAULT_CRAWLERS.map((crawler) => crawler.source);
	return [...merged.values()].sort((left, right) => {
		const leftIndex = sourceOrder.indexOf(left.source);
		const rightIndex = sourceOrder.indexOf(right.source);
		return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
	});
}

function completeSearchJob(jobId, result) {
	const job = searchJobs.get(jobId);
	if (!job) return;

	const finalResult = {
		...result,
		crawlStatuses: mergeCrawlStatuses(job.crawlStatuses, result?.crawlStatuses || []),
	};

	job.status = 'completed';
	job.progress = 100;
	job.currentActivity = 'Search complete';
	job.updatedAt = new Date().toISOString();
	job.result = finalResult;
	job.crawlStatuses = finalResult.crawlStatuses;
	appendJobLog(job, {
		line: `Search complete | results=${finalResult?.searchResults?.length || 0} | sources=${finalResult?.crawlStatuses?.length || 0}`,
	});
	detachJobLogger(job);
}

function failSearchJob(jobId, error) {
	const job = searchJobs.get(jobId);
	if (!job) return;

	job.status = 'failed';
	job.progress = 100;
	job.error = error?.message || 'Search failed';
	job.currentActivity = job.error;
	job.updatedAt = new Date().toISOString();
	appendJobLog(job, { line: `Search failed · ${job.error}` });
	detachJobLogger(job);
}

function toCrawlStatus(entry, key, kind) {
	const items = Array.isArray(entry?.[key]) ? entry[key] : [];
	const itemCount = items.length;

	return {
		source: entry?.source || 'unknown',
		kind,
		status: itemCount ? 'fetched' : 'no-data',
		itemCount,
		percent: 100,
		message:
			itemCount ? `Processed ${itemCount} ${kind === 'search-engine' ? 'results' : 'profiles'}`
			: ['truepeoplesearch', 'property-source'].includes(entry?.source) ? ''
			: 'No data found',
	};
}

function isStandaloneArticleResult(result = {}) {
	return ['ai-supporting-article', 'media-article'].includes(
		String(result?.resultType || '')
			.trim()
			.toLowerCase(),
	);
}

function getResultDomain(url = '') {
	try {
		return new URL(String(url || '')).hostname.replace(/^www\./i, '').toLowerCase();
	} catch {
		return '';
	}
}

function getGroupedResultKey(result = {}) {
	if (isStandaloneArticleResult(result)) {
		return `article:${result.source || 'unknown'}:${result.url || result.title || ''}`;
	}

	const domain = getResultDomain(result?.url || '');
	if (domain) {
		return `domain:${domain}`;
	}

	return `url:${String(result?.url || result?.title || '')}`;
}

function getRepresentativeScore(result = {}) {
	return (
		Number(Boolean(result?.sourceLabel === 'Direct URL' || result?.source === 'source-url')) * 1000000 +
		Number(Boolean(result?.crawled)) * 100000 +
		Math.min(String(result?.content || '').length, 50000) +
		Math.min(String(result?.snippet || '').length, 5000)
	);
}

function shouldPromoteGroupRepresentative(current = null, candidate = {}) {
	if (!current) return true;

	const currentScore = getRepresentativeScore(current);
	const candidateScore = getRepresentativeScore(candidate);
	if (candidateScore !== currentScore) {
		return candidateScore > currentScore;
	}

	return String(candidate?.title || '').localeCompare(String(current?.title || '')) < 0;
}

function sortGroupedResults(items = []) {
	return [...(Array.isArray(items) ? items : [])].sort(
		(left, right) =>
			Number(Boolean(right?.sourceLabel === 'Direct URL' || right?.source === 'source-url')) -
				Number(Boolean(left?.sourceLabel === 'Direct URL' || left?.source === 'source-url')) ||
			Number(Boolean(right?.crawled)) - Number(Boolean(left?.crawled)) ||
			String(left?.title || '').localeCompare(String(right?.title || '')),
	);
}

function applyRepresentativeToGroup(group = {}, representative = {}) {
	const preservedFields = {
		groupedResults: group.groupedResults || [],
		groupedResultCount: group.groupedResultCount || 0,
		sources: group.sources || [],
		domain: group.domain || '',
	};

	Object.assign(group, representative, preservedFields, {
		source: preservedFields.sources.join(', '),
	});
}

export function toSearchResults(engineResults = []) {
	const normalizedEntries = engineResults.map((entry) => ({
		source: entry.source,
		results: Array.isArray(entry.results) ? entry.results : [],
	}));
	const mergedByUrl = new Map();
	const orderedResults = [];
	const maxLength = Math.max(0, ...normalizedEntries.map((entry) => entry.results.length));

	for (let index = 0; index < maxLength; index += 1) {
		for (const entry of normalizedEntries) {
			const result = entry.results[index];
			if (!result?.url || result.hiddenFromUi || result.blocked || isBlockedSearchResultUrl(result.url)) continue;

			const preferredSnippet = result.contentPreview || result.snippet || '';
			const discoveryOrder = orderedResults.length;

			orderedResults.push({
				source: entry.source,
				sourceLabel: result.sourceLabel || '',
				title: result.title || result.url || 'Untitled result',
				url: result.url || '',
				content: String(result.content || result.contentPreview || result.snippet || '').trim(),
				snippet: preferredSnippet,
				resultType: result.resultType || '',
				organizations: Array.isArray(result.organizations) ? result.organizations.slice(0, 6) : [],
				dataLayer: result.dataLayer && typeof result.dataLayer === 'object' ? result.dataLayer : { entries: [], text: '' },
				imageContext: result.imageContext && typeof result.imageContext === 'object' ? result.imageContext : { entries: [], renderableEntries: [], text: '' },
				supportingDocuments: result.supportingDocuments && typeof result.supportingDocuments === 'object' ? result.supportingDocuments : { urls: [], documents: [] },
				previewImage: result.previewImage && typeof result.previewImage === 'object' ? result.previewImage : null,
				crawled: Boolean(result.crawled),
				discoveryOrder,
			});
		}
	}

	for (const result of orderedResults) {
		const mergeKey = isStandaloneArticleResult(result) ? `${result.resultType || 'article'}:${result.source}:${result.url}` : result.url;
		const existing = mergedByUrl.get(mergeKey);

		if (!existing) {
			mergedByUrl.set(mergeKey, {
				...result,
				sources: [result.source],
				latestDiscoveryOrder: Number(result.discoveryOrder ?? 0),
			});
			continue;
		}

		existing.sources = [...new Set([...(existing.sources || []), result.source])];
		existing.source = existing.sources.join(', ');

		const shouldPreferIncomingSnippet =
			(Boolean(result.crawled) && !existing.crawled) || (Boolean(result.crawled) === Boolean(existing.crawled) && (result.snippet || '').length > (existing.snippet || '').length);

		if (shouldPreferIncomingSnippet) {
			existing.snippet = result.snippet;
		}

		if ((result.content || '').length > (existing.content || '').length) {
			existing.content = result.content;
		}

		if (!existing.resultType && result.resultType) {
			existing.resultType = result.resultType;
		}

		if (!existing.sourceLabel && result.sourceLabel) {
			existing.sourceLabel = result.sourceLabel;
		}

		existing.organizations = [...new Set([...(existing.organizations || []), ...(result.organizations || [])])].slice(0, 6);

		if ((!existing.dataLayer?.entries?.length && result.dataLayer?.entries?.length) || (!existing.dataLayer?.text || '').length < (result.dataLayer?.text || '').length) {
			existing.dataLayer = result.dataLayer;
		}

		if (
			(!existing.imageContext?.entries?.length && result.imageContext?.entries?.length) ||
			(!existing.imageContext?.text || '').length < (result.imageContext?.text || '').length
		) {
			existing.imageContext = result.imageContext;
		}

		if (!existing.previewImage?.src && result.previewImage?.src) {
			existing.previewImage = result.previewImage;
		}

		existing.latestDiscoveryOrder = Math.max(Number(existing.latestDiscoveryOrder ?? existing.discoveryOrder ?? 0), Number(result.discoveryOrder ?? 0));

		if (
			(!existing.supportingDocuments?.documents?.length && result.supportingDocuments?.documents?.length) ||
			(!existing.supportingDocuments?.urls?.length && result.supportingDocuments?.urls?.length)
		) {
			existing.supportingDocuments = result.supportingDocuments;
		}

		existing.crawled = existing.crawled || result.crawled;
	}

	const groupedByDomain = new Map();

	for (const result of mergedByUrl.values()) {
		const groupKey = getGroupedResultKey(result);
		const existingGroup = groupedByDomain.get(groupKey);

		if (!existingGroup) {
			groupedByDomain.set(groupKey, {
				...result,
				domain: getResultDomain(result.url),
				groupedResults: [result],
				groupedResultCount: 1,
				source: (result.sources || [result.source]).join(', '),
				latestDiscoveryOrder: Number(result.latestDiscoveryOrder ?? result.discoveryOrder ?? 0),
			});
			continue;
		}

		existingGroup.groupedResults = sortGroupedResults([...(existingGroup.groupedResults || []), result]);
		existingGroup.groupedResultCount = existingGroup.groupedResults.length;
		existingGroup.sources = [...new Set([...(existingGroup.sources || []), ...(result.sources || [result.source])])];
		existingGroup.source = existingGroup.sources.join(', ');
		existingGroup.organizations = [...new Set([...(existingGroup.organizations || []), ...(result.organizations || [])])].slice(0, 6);
		existingGroup.latestDiscoveryOrder = Math.max(
			Number(existingGroup.latestDiscoveryOrder ?? existingGroup.discoveryOrder ?? 0),
			Number(result.latestDiscoveryOrder ?? result.discoveryOrder ?? 0),
		);

		if (shouldPromoteGroupRepresentative(existingGroup, result)) {
			applyRepresentativeToGroup(existingGroup, result);
		}
	}

	return [...groupedByDomain.values()]
		.map((group) => ({
			...group,
			groupedResults: sortGroupedResults(group.groupedResults || []),
			groupedResultCount: Array.isArray(group.groupedResults) ? group.groupedResults.length : 0,
			source: (group.sources || []).join(', '),
		}))
		.slice(0, 40);
}

function trimSummaryText(value = '', maxLength = 260) {
	const normalized = String(value || '')
		.replace(/\s+/g, ' ')
		.trim();

	if (!normalized) return '';
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength).trimEnd()}…`;
}

function buildAiResponseReferences(results = [], limit = 3) {
	const seen = new Set();

	return [...(results || [])]
		.sort(
			(left, right) =>
				Number(Boolean(right?.fromGoogleAiSupportingArticle || right?.fromGoogleAiCitation)) - Number(Boolean(left?.fromGoogleAiSupportingArticle || left?.fromGoogleAiCitation)),
		)
		.filter((item) => item?.url || item?.title)
		.map((item) => ({
			title: trimSummaryText(item.title || item.url || 'Source result', 120),
			url: String(item.url || '').trim(),
			source: String(item.source || '').trim(),
		}))
		.filter((item) => {
			const key = item.url || `${item.source}|${item.title}`;
			if (!key || seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.slice(0, limit);
}

function isValidSourceUrl(value = '') {
	if (!value) return false;

	try {
		const url = new URL(String(value));
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
}

function looksLikeStreetAddress(value = '') {
	return /\d/.test(value) || /\b(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct|place|pl|trail|trl|highway|hwy|route|rt)\b/i.test(value);
}

function deriveSearchTermParams(searchTerm = '') {
	const rawValue = String(searchTerm || '').trim();
	if (!rawValue) {
		return {};
	}

	if (isValidSourceUrl(rawValue)) {
		return { sourceUrl: rawValue };
	}

	if (looksLikeStreetAddress(rawValue)) {
		return { address: rawValue };
	}

	return { searchTerm: rawValue };
}

function toDirectSourceTitle(sourceUrl = '') {
	try {
		const parsed = new URL(sourceUrl);
		return parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname || sourceUrl;
	} catch {
		return sourceUrl || 'Direct source';
	}
}

function toContentPreview(value = '', maxLength = 600) {
	const normalized = String(value || '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!normalized) return '';
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength).trimEnd()}…`;
}

export function buildDirectSourceResult(sourceUrl = '', parsedDocument = {}) {
	if (parsedDocument?.language && parsedDocument.language !== 'en') {
		return null;
	}

	return {
		title: toDirectSourceTitle(sourceUrl),
		url: sourceUrl,
		snippet: toContentPreview(parsedDocument?.text || ''),
		contentPreview: toContentPreview(parsedDocument?.text || ''),
		content: String(parsedDocument?.text || '').trim(),
		resultType: 'source-page',
		sourceLabel: 'Direct URL',
		dataLayer: parsedDocument?.dataLayer || { entries: [], text: '' },
		imageContext: parsedDocument?.imageContext || { entries: [], renderableEntries: [], text: '' },
		supportingDocuments: parsedDocument?.supportingDocuments || { urls: [], documents: [] },
		previewImage: parsedDocument?.previewImage || null,
		organizations: [],
		blocked: Boolean(parsedDocument?.blocked),
		blockedReason: String(parsedDocument?.blockedReason || ''),
		crawled: Boolean(parsedDocument?.text),
	};
}

// Input validation helper
function validateSearchInput(body) {
	const derived = deriveSearchTermParams(body.searchTerm);
	const sourceUrl = String(body.sourceUrl || derived.sourceUrl || '').trim();
	const hasSourceUrl = Boolean(sourceUrl);
	const hasAddress = Boolean(String(body.address || derived.address || '').trim());
	const hasSearchTerm = Boolean(String(body.searchTerm || '').trim());

	if (!hasSourceUrl && !hasAddress && !hasSearchTerm) {
		return 'Enter any search term.';
	}

	if (hasSourceUrl && !isValidSourceUrl(sourceUrl)) {
		return 'Source URL must be a valid http or https link.';
	}

	return null;
}

function normalizeSearchParams(body) {
	const rawSearchTerm = String(body.searchTerm || '')
		.slice(0, 200)
		.trim();
	const derived = deriveSearchTermParams(rawSearchTerm);
	const normalizedLocation = canonicalizeLocation({
		city: String(body.city || derived.city || '').slice(0, 100),
		state: String(body.state || derived.state || '').slice(0, 50),
	});

	return {
		searchTerm: rawSearchTerm,
		queryProfile: String(body.queryProfile || '')
			.trim()
			.toLowerCase()
			.slice(0, 50),
		firstName: '',
		middleName: '',
		lastName: '',
		sourceUrl: String(body.sourceUrl || derived.sourceUrl || '').slice(0, 500),
		address: String(body.address || derived.address || '').slice(0, 200),
		city: normalizedLocation.city,
		state: normalizedLocation.state,
		zipCode: String(body.zipCode || '').slice(0, 20),
		ageMin: undefined,
		ageMax: undefined,
		aliases: [],
	};
}

function normalizeScrapyCrawlParams(body = {}) {
	return {
		url: String(body.url || '')
			.slice(0, 2000)
			.trim(),
		maxPages: Math.max(1, Math.min(100, Number(body.maxPages) || 100)),
		maxDepth: Math.max(0, Math.min(5, Number(body.maxDepth) || 5)),
		allowOffsite: Boolean(body.allowOffsite),
	};
}

async function executeSearch(params, onProgress) {
	onProgress?.({ currentActivity: 'Launching crawler jobs…' });

	const shouldRunSearchEngines = Boolean(params.searchTerm || params.address || params.sourceUrl);
	let directSourceEngineResults = [];

	if (params.sourceUrl) {
		onProgress?.({ currentActivity: 'Parsing direct source URL…' });
		const parsedDocument = await parseDocument(params.sourceUrl);
		const directSourceResult = buildDirectSourceResult(params.sourceUrl, parsedDocument);
		directSourceEngineResults = [...(directSourceResult ? [{ source: 'source-url', results: [directSourceResult] }] : [])];
	}

	const engineResults = shouldRunSearchEngines ? await runAllSearchEngines(params, onProgress) : [];
	const engineResultsWithDirectSource = [...directSourceEngineResults, ...engineResults];

	onProgress?.({ currentActivity: 'Normalizing contextual search results…' });

	const mergedSearchResults = toSearchResults(engineResultsWithDirectSource);
	const aiAnswerResponses = engineResultsWithDirectSource
		.filter((entry) => ['google', 'bing'].includes(String(entry?.source || '').toLowerCase()) && entry?.aiResponse)
		.map((entry) => ({
			source: entry.source,
			text: entry.aiResponse,
			references: buildAiResponseReferences(entry.results, 3),
		}));
	const aiSupportingResponses = engineResultsWithDirectSource
		.filter((entry) => String(entry?.source || '').toLowerCase() === 'google' && Array.isArray(entry?.results))
		.flatMap((entry) =>
			entry.results
				.filter((result) => String(result?.resultType || '').toLowerCase() === 'ai-supporting-article' && (result?.url || result?.title))
				.map((result) => ({
					source: entry.source,
					title: result.title || 'Google AI supporting article',
					text: result.snippet || result.content || '',
					url: result.url || '',
					resultType: 'ai-supporting-article',
					references: result.url ? [{ title: result.title || result.url, url: result.url, source: String(result.sourceLabel || result.source || entry.source || '').trim() }] : [],
					sections: Array.isArray(result.sections) ? result.sections : [],
				})),
		);
	const aiCitationResponses = engineResultsWithDirectSource
		.filter((entry) => String(entry?.source || '').toLowerCase() === 'google' && Array.isArray(entry?.citationResults))
		.flatMap((entry) =>
			entry.citationResults
				.filter((result) => result?.url || result?.title)
				.map((result) => ({
					source: entry.source,
					title: result.title || 'Google AI citation',
					text: result.snippet || result.content || result.parentText || result.ariaLabel || '',
					url: result.url || '',
					resultType: 'ai-citation',
					references: result.url ? [{ title: result.title || result.url, url: result.url, source: String(entry.source || '').trim() }] : [],
					sections: Array.isArray(result.sections) ? result.sections : [],
				})),
		);
	const aiResponses = [...aiAnswerResponses, ...aiSupportingResponses, ...aiCitationResponses];
	const aiSearchResults = aiResponses.map((entry, index) => ({
		source: entry.source,
		title:
			entry.resultType === 'ai-supporting-article' ? entry.title || 'Google AI supporting article'
			: entry.resultType === 'ai-citation' ? entry.title || 'Google AI citation'
			: entry.source === 'google' ? 'Google AI Overview'
			: entry.source === 'bing' ? 'Bing AI Response'
			: `${entry.source} AI Response`,
		url: entry.url || '',
		snippet: entry.text,
		resultType: entry.resultType || 'ai-answer',
		isAiResponse: true,
		position: index,
		references: Array.isArray(entry.references) ? entry.references : [],
		sections: Array.isArray(entry.sections) ? entry.sections : [],
	}));

	const crawlersUsed = [...new Set(engineResultsWithDirectSource.map((entry) => entry.source))];

	const crawlStatuses = engineResultsWithDirectSource
		.map((entry) => toCrawlStatus(entry, 'results', 'search-engine'))
		.filter((entry) => entry?.source && !HIDDEN_CRAWLER_SOURCES.has(entry.source));

	return {
		profiles: [],
		searchResults: [...aiSearchResults, ...mergedSearchResults],
		aiResponses,
		source: 'crawl',
		crawlersUsed,
		crawlStatuses,
		schemaDocumentId: '',
	};
}

searchRouter.post('/scrapy-crawl', async (req, res) => {
	const params = normalizeScrapyCrawlParams(req.body);

	if (!params.url) {
		return res.status(400).json({ error: 'A crawl URL is required.' });
	}

	try {
		const crawl = await runScrapyCrawler(params);
		return res.json(crawl);
	} catch (error) {
		logger.error('Scrapy crawl failed', {
			url: params.url,
			error: error.message,
		});
		return res.status(500).json({ error: error.message || 'Scrapy crawl failed.' });
	}
});

searchRouter.get('/locations', (req, res) => {
	const query = String(req.query.q || '').slice(0, 100);
	res.set('Cache-Control', 'private, max-age=15');
	res.json(getCachedLocationSearchPayload(query));
});

searchRouter.get('/history', (req, res) => {
	const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 20));
	res.json({ runs: listSearchRuns(limit) });
});

searchRouter.get('/history/:runId', (req, res) => {
	const run = getSearchRunById(req.params.runId);
	if (!run) {
		return res.status(404).json({ error: 'Search run not found' });
	}

	return res.json(run);
});

searchRouter.get('/background-status', (_req, res) => {
	res.set('Cache-Control', 'private, max-age=2');
	res.json(getCachedBackgroundStatusPayload());
});

searchRouter.get('/status/:jobId', (req, res) => {
	cleanupExpiredJobs();
	const job = searchJobs.get(req.params.jobId);
	if (!job) {
		return res.status(404).json({ error: 'Search job not found' });
	}
	return res.json(job);
});

searchRouter.post('/start', searchLimiter, (req, res) => {
	const error = validateSearchInput(req.body);
	if (error) return res.status(400).json({ error });

	const params = normalizeSearchParams(req.body);
	const job = createSearchJob(params);

	logger.info('Live search job started', {
		jobId: job.jobId,
		name: '',
		searchTerm: params.searchTerm,
	});

	void executeSearch(params, (update) => updateSearchJob(job.jobId, update))
		.then((result) => {
			const persistedResult = persistSearchOutcome(params, result, {
				trigger: 'manual',
				status: 'completed',
				jobId: job.jobId,
			});
			completeSearchJob(job.jobId, persistedResult);
		})
		.catch((err) => {
			logger.error('Search pipeline error', { error: err.message });
			failSearchJob(job.jobId, err);
		});

	return res.status(202).json({ jobId: job.jobId });
});

searchRouter.post('/', searchLimiter, async (req, res) => {
	const error = validateSearchInput(req.body);
	if (error) return res.status(400).json({ error });

	const params = normalizeSearchParams(req.body);

	logger.info('Search request', {
		name: '',
		searchTerm: params.searchTerm,
	});

	try {
		const result = await executeSearch(params);
		const persistedResult = persistSearchOutcome(params, result, {
			trigger: 'manual',
			status: 'completed',
		});
		res.json(persistedResult);
	} catch (err) {
		logger.error('Search pipeline error', { error: err.message });
		res.status(500).json({ error: 'Search failed. Please try again.' });
	}
});
