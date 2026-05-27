import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STOCK_SYMBOLS_FILE = path.resolve(__dirname, '../../data/stock-symbols/us-stock-symbols.json');
const STOCK_SYMBOL_CATALOG_REFRESH_MS = Math.max(60 * 60 * 1000, Number(process.env.STOCK_SYMBOL_CATALOG_REFRESH_MS) || 24 * 60 * 60 * 1000);
const STOCK_SYMBOL_SOURCE_URLS = {
	nasdaq: 'https://raw.githubusercontent.com/rreichel3/US-Stock-Symbols/main/nasdaq/nasdaq_tickers.json',
	nyse: 'https://raw.githubusercontent.com/rreichel3/US-Stock-Symbols/main/nyse/nyse_tickers.json',
	amex: 'https://raw.githubusercontent.com/rreichel3/US-Stock-Symbols/main/amex/amex_tickers.json',
};

const state = {
	ready: false,
	source: '',
	updatedAt: '',
	symbols: new Set(),
	exchanges: {
		nasdaq: [],
		nyse: [],
		amex: [],
	},
	refreshPromise: null,
};

function normalizeStockSymbol(value = '') {
	const normalized = String(value || '')
		.trim()
		.toUpperCase();

	return /^[A-Z][A-Z0-9]{0,9}$/.test(normalized) ? normalized : '';
}

function dedupeSymbols(input = []) {
	return [...new Set((Array.isArray(input) ? input : []).map((value) => normalizeStockSymbol(value)).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

export function buildStockSymbolCatalog(exchangeData = {}) {
	const exchanges = {
		nasdaq: dedupeSymbols(exchangeData.nasdaq),
		nyse: dedupeSymbols(exchangeData.nyse),
		amex: dedupeSymbols(exchangeData.amex),
	};
	const symbols = dedupeSymbols([...exchanges.nasdaq, ...exchanges.nyse, ...exchanges.amex]);
	const generatedAt = new Date().toISOString();

	return {
		updatedAt: generatedAt,
		symbols,
		exchanges,
		sources: STOCK_SYMBOL_SOURCE_URLS,
	};
}

function applyStockSymbolCatalog(catalog = {}, source = '') {
	const exchanges = catalog?.exchanges || {};
	state.exchanges = {
		nasdaq: dedupeSymbols(exchanges.nasdaq),
		nyse: dedupeSymbols(exchanges.nyse),
		amex: dedupeSymbols(exchanges.amex),
	};
	state.symbols = new Set(dedupeSymbols(catalog.symbols || [...state.exchanges.nasdaq, ...state.exchanges.nyse, ...state.exchanges.amex]));
	state.updatedAt = String(catalog.updatedAt || '').trim() || new Date().toISOString();
	state.source = String(source || '').trim() || 'memory';
	state.ready = state.symbols.size > 0;
	return getStockSymbolCatalogSnapshot();
}

async function readCachedStockSymbolCatalog() {
	try {
		const raw = await readFile(STOCK_SYMBOLS_FILE, 'utf-8');
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') return null;
		return parsed;
	} catch {
		return null;
	}
}

async function writeCachedStockSymbolCatalog(catalog = {}) {
	await mkdir(path.dirname(STOCK_SYMBOLS_FILE), { recursive: true });
	await writeFile(STOCK_SYMBOLS_FILE, `${JSON.stringify(catalog, null, 2)}\n`, 'utf-8');
}

function isCatalogFresh(updatedAt = '') {
	const updatedTime = Date.parse(updatedAt || '');
	if (Number.isNaN(updatedTime) || updatedTime <= 0) return false;
	return Date.now() - updatedTime < STOCK_SYMBOL_CATALOG_REFRESH_MS;
}

async function fetchExchangeSymbols(exchange = '', url = '') {
	const response = await fetch(url, {
		headers: {
			'User-Agent': 'query-notify-stock-symbol-registry/1.0',
			'Accept': 'application/json,text/plain,*/*',
		},
	});

	if (!response.ok) {
		throw new Error(`${exchange} stock symbol request failed with status ${response.status}`);
	}

	const parsed = await response.json();
	return dedupeSymbols(parsed);
}

async function downloadStockSymbolCatalog() {
	const exchangeEntries = await Promise.all(Object.entries(STOCK_SYMBOL_SOURCE_URLS).map(async ([exchange, url]) => [exchange, await fetchExchangeSymbols(exchange, url)]));

	return buildStockSymbolCatalog(Object.fromEntries(exchangeEntries));
}

export function isStockSymbolCatalogReady() {
	return state.ready;
}

export function isKnownUsStockSymbol(value = '') {
	const normalized = normalizeStockSymbol(value);
	return Boolean(normalized) && state.symbols.has(normalized);
}

export function getStockSymbolCatalogSnapshot() {
	return {
		ready: state.ready,
		source: state.source,
		updatedAt: state.updatedAt,
		symbolCount: state.symbols.size,
		exchangeCounts: {
			nasdaq: state.exchanges.nasdaq.length,
			nyse: state.exchanges.nyse.length,
			amex: state.exchanges.amex.length,
		},
		refreshMs: STOCK_SYMBOL_CATALOG_REFRESH_MS,
		cacheFile: STOCK_SYMBOLS_FILE,
	};
}

export async function ensureStockSymbolCatalog({ force = false } = {}) {
	if (state.refreshPromise && !force) {
		return state.refreshPromise;
	}

	state.refreshPromise = (async () => {
		const cachedCatalog = await readCachedStockSymbolCatalog();

		if (!force && cachedCatalog && isCatalogFresh(cachedCatalog.updatedAt)) {
			return applyStockSymbolCatalog(cachedCatalog, 'cache');
		}

		if (!state.ready && cachedCatalog) {
			applyStockSymbolCatalog(cachedCatalog, 'cache-stale');
		}

		try {
			const downloadedCatalog = await downloadStockSymbolCatalog();
			await writeCachedStockSymbolCatalog(downloadedCatalog);
			return applyStockSymbolCatalog(downloadedCatalog, 'remote');
		} catch (error) {
			logger.warn('US stock symbol catalog refresh failed', {
				error: error.message,
				hasCachedCatalog: Boolean(cachedCatalog),
			});

			if (cachedCatalog) {
				return applyStockSymbolCatalog(cachedCatalog, 'cache-fallback');
			}

			return getStockSymbolCatalogSnapshot();
		}
	})();

	try {
		return await state.refreshPromise;
	} finally {
		state.refreshPromise = null;
	}
}

export function seedStockSymbolCatalogForTests({ symbols = [], exchanges = null, updatedAt = '2026-05-14T00:00:00.000Z' } = {}) {
	const normalizedExchanges =
		exchanges && typeof exchanges === 'object' ?
			exchanges
		:	{
				nasdaq: symbols,
				nyse: [],
				amex: [],
			};
	const catalog = buildStockSymbolCatalog(normalizedExchanges);
	catalog.updatedAt = updatedAt;
	if (Array.isArray(symbols) && symbols.length) {
		catalog.symbols = dedupeSymbols(symbols);
	}
	return applyStockSymbolCatalog(catalog, 'test');
}

export function resetStockSymbolCatalogForTests() {
	state.ready = false;
	state.source = '';
	state.updatedAt = '';
	state.symbols = new Set();
	state.exchanges = {
		nasdaq: [],
		nyse: [],
		amex: [],
	};
	state.refreshPromise = null;
}
