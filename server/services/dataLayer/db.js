import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEARCH_RUNS_DIR = process.env.SEARCH_RUNS_DIR ? process.env.SEARCH_RUNS_DIR : join(__dirname, '../../data/search-runs');
const SEARCH_RUNS_INDEX_PATH = join(SEARCH_RUNS_DIR, 'index.json');

function ensureDir(dirPath) {
	if (!existsSync(dirPath)) {
		mkdirSync(dirPath, { recursive: true });
	}
}

function loadJsonFile(filePath, fallbackValue) {
	if (!existsSync(filePath)) {
		return fallbackValue;
	}

	try {
		return JSON.parse(readFileSync(filePath, 'utf-8'));
	} catch (err) {
		logger.error('Failed to parse JSON file', { filePath, error: err.message });
		return fallbackValue;
	}
}

function writeJsonFile(filePath, value) {
	ensureDir(dirname(filePath));
	writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function normalizeSearchRunParams(searchParams = {}) {
	return {
		searchTerm: String(searchParams.searchTerm || '').trim(),
		sourceUrl: String(searchParams.sourceUrl || '').trim(),
		address: String(searchParams.address || '').trim(),
		city: String(searchParams.city || '').trim(),
		state: String(searchParams.state || '').trim(),
		zipCode: String(searchParams.zipCode || '').trim(),
	};
}

function buildSearchRunQuerySignature(searchParams = {}) {
	return JSON.stringify(normalizeSearchRunParams(searchParams));
}

function sanitizeSearchRunResult(result = {}) {
	return {
		profiles: [],
		searchResults: Array.isArray(result.searchResults) ? result.searchResults : [],
		aiResponses: Array.isArray(result.aiResponses) ? result.aiResponses : [],
		source: String(result.source || 'crawl'),
		crawlersUsed: Array.isArray(result.crawlersUsed) ? [...new Set(result.crawlersUsed.filter(Boolean))] : [],
		crawlStatuses: Array.isArray(result.crawlStatuses) ? result.crawlStatuses : [],
		schemaDocumentId: '',
		searchRunId: String(result.searchRunId || ''),
	};
}

function loadSearchRunIndex() {
	ensureDir(SEARCH_RUNS_DIR);
	const payload = loadJsonFile(SEARCH_RUNS_INDEX_PATH, []);
	return Array.isArray(payload) ? payload : [];
}

function saveSearchRunIndex(entries = []) {
	writeJsonFile(SEARCH_RUNS_INDEX_PATH, entries);
}

export function saveSearchRun(searchParams = {}, result = {}, metadata = {}) {
	ensureDir(SEARCH_RUNS_DIR);

	const runId = String(metadata.runId || uuidv4());
	const savedAt = String(metadata.savedAt || new Date().toISOString());
	const normalizedQuery = normalizeSearchRunParams(searchParams);
	const sanitizedResult = sanitizeSearchRunResult(result);
	const querySignature = buildSearchRunQuerySignature(normalizedQuery);
	const record = {
		runId,
		savedAt,
		updatedAt: new Date().toISOString(),
		status: String(metadata.status || 'completed'),
		trigger: String(metadata.trigger || 'manual'),
		jobId: String(metadata.jobId || ''),
		querySignature,
		query: normalizedQuery,
		result: sanitizedResult,
	};

	writeJsonFile(join(SEARCH_RUNS_DIR, `${runId}.json`), record);

	const summary = {
		runId,
		savedAt: record.savedAt,
		updatedAt: record.updatedAt,
		status: record.status,
		trigger: record.trigger,
		jobId: record.jobId,
		querySignature,
		query: normalizedQuery,
		searchResultCount: sanitizedResult.searchResults.length,
		crawlerCount: sanitizedResult.crawlersUsed.length,
	};

	const filtered = loadSearchRunIndex().filter((entry) => entry?.runId !== runId);
	filtered.unshift(summary);
	saveSearchRunIndex(filtered.slice(0, 500));

	return record;
}

export function listSearchRuns(limit = 20) {
	const normalizedLimit = Math.max(1, Math.min(200, Number(limit) || 20));
	return loadSearchRunIndex().slice(0, normalizedLimit);
}

export function getSearchRunById(runId = '') {
	const normalizedRunId = String(runId || '').trim();
	if (!normalizedRunId) return null;

	const filePath = join(SEARCH_RUNS_DIR, `${normalizedRunId}.json`);
	return loadJsonFile(filePath, null);
}

export function getRecentSearchRunQueries(limit = 10) {
	const normalizedLimit = Math.max(1, Math.min(100, Number(limit) || 10));
	const uniqueQueries = [];
	const seenSignatures = new Set();

	for (const entry of loadSearchRunIndex()) {
		if (!entry?.querySignature || seenSignatures.has(entry.querySignature)) {
			continue;
		}

		const query = normalizeSearchRunParams(entry.query || {});
		const hasSearchInput = Boolean(query.searchTerm || query.address || query.sourceUrl);

		if (!hasSearchInput) {
			continue;
		}

		seenSignatures.add(entry.querySignature);
		uniqueQueries.push(query);

		if (uniqueQueries.length >= normalizedLimit) {
			break;
		}
	}

	return uniqueQueries;
}
