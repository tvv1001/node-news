import { EventEmitter } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import Parser from 'rss-parser';
import { parseDocument } from '../crawler/documentParser.js';
import { bingSearch, googleSearch, yahooSearch } from '../crawler/searchEngines.js';
import { hasXCredentials } from '../crawler/xSearchScraper.js';
import { ensureStockSymbolCatalog, isKnownUsStockSymbol, isStockSymbolCatalogReady, resetStockSymbolCatalogForTests } from './stockSymbolRegistry.js';
import { logger } from '../../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTEXT_FEEDS_FILE = path.resolve(__dirname, '../../data/context-feeds.json');
const BLOCKED_FEEDS_FILE = path.resolve(__dirname, '../../data/blocked-feeds.json');
const CONTEXTS = ['research', 'news', 'shopping'];
const CONTEXT_FEED_REFRESH_MS = Math.max(60 * 1000, Number(process.env.CONTEXT_FEED_REFRESH_MS) || 3 * 60 * 1000);
const X_FEED_REFRESH_MS = Math.max(30 * 1000, Number(process.env.X_FEED_REFRESH_MS) || 60 * 1000);
const CONTEXT_FEED_ITEMS_PER_SOURCE = Math.max(2, Math.min(10, Number(process.env.CONTEXT_FEED_ITEMS_PER_SOURCE) || 8));
const X_CONTEXT_FEED_ITEMS_PER_SOURCE = Math.max(8, Math.min(40, Number(process.env.X_CONTEXT_FEED_ITEMS_PER_SOURCE) || 18));
const CONTEXT_FEED_MATCH_LIMIT = Math.max(12, Math.min(120, Number(process.env.CONTEXT_FEED_MATCH_LIMIT) || 96));
const CONTEXT_SEARCH_ENGINE_REFRESH_MS = Math.max(CONTEXT_FEED_REFRESH_MS, Number(process.env.CONTEXT_SEARCH_ENGINE_REFRESH_MS) || 3 * 60 * 1000);
const CONTEXT_SEARCH_ENGINE_KEYWORD_LIMIT = Math.max(1, Math.min(8, Number(process.env.CONTEXT_SEARCH_ENGINE_KEYWORD_LIMIT) || 6));
const CONTEXT_SEARCH_ENGINE_RESULT_LIMIT = Math.max(2, Math.min(12, Number(process.env.CONTEXT_SEARCH_ENGINE_RESULT_LIMIT) || 8));
const HACKER_NEWS_TOP_STORIES_URL = process.env.HACKER_NEWS_TOP_STORIES_URL || 'https://hacker-news.firebaseio.com/v0/topstories.json';
const HACKER_NEWS_ITEM_URL_TEMPLATE = process.env.HACKER_NEWS_ITEM_URL_TEMPLATE || 'https://hacker-news.firebaseio.com/v0/item/{id}.json';
const ACTUALLY_RELEVANT_API_BASE_URL = process.env.ACTUALLY_RELEVANT_API_BASE_URL || 'https://actually-relevant-api.onrender.com';
const ACTUALLY_RELEVANT_STORIES_URL = process.env.ACTUALLY_RELEVANT_STORIES_URL || `${ACTUALLY_RELEVANT_API_BASE_URL}/api/stories`;
const GENERAL_NEWS_SOURCES_URL = process.env.GENERAL_NEWS_SOURCES_URL || 'https://raw.githubusercontent.com/rumca-js/RSS-Link-Database-2024/main/sources.json';
const GENERAL_NEWS_SOURCE_CACHE_MS = Math.max(5 * 60 * 1000, Number(process.env.GENERAL_NEWS_SOURCE_CACHE_MS) || 30 * 60 * 1000);
const GENERAL_NEWS_SOURCE_LIMIT = Math.max(6, Math.min(24, Number(process.env.GENERAL_NEWS_SOURCE_LIMIT) || 16));
const GENERAL_NEWS_ITEMS_PER_SOURCE = Math.max(2, Math.min(16, Number(process.env.GENERAL_NEWS_ITEMS_PER_SOURCE) || 10));
const GENERAL_NEWS_ITEM_LIMIT = Math.max(40, Math.min(240, Number(process.env.GENERAL_NEWS_ITEM_LIMIT) || 180));
const GENERAL_NEWS_LOOKBACK_MS = Math.max(24 * 60 * 60 * 1000, Number(process.env.GENERAL_NEWS_LOOKBACK_MS) || 7 * 24 * 60 * 60 * 1000);
const GOOGLE_NEWS_TAG_FEED_LIMIT = Math.max(1, Math.min(12, Number(process.env.GOOGLE_NEWS_TAG_FEED_LIMIT) || 8));
const CONTEXT_PREVIEW_IMAGE_CACHE_MS = Math.max(CONTEXT_FEED_REFRESH_MS, Number(process.env.CONTEXT_PREVIEW_IMAGE_CACHE_MS) || 6 * 60 * 60 * 1000);
const CONTEXT_PREVIEW_IMAGE_ENRICH_CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.CONTEXT_PREVIEW_IMAGE_ENRICH_CONCURRENCY) || 3));
const GOOGLE_ALERTS_FEEDS_JSON = process.env.GOOGLE_ALERTS_FEEDS_JSON || '';
const REDDIT_TAG_FEED_LIMIT = Math.max(1, Math.min(12, Number(process.env.REDDIT_TAG_FEED_LIMIT) || 6));
const CONTEXT_SEARCH_ENGINE_SOURCE_LABELS = {
	google: 'Google Search',
	bing: 'Bing Search',
	yahoo: 'Yahoo Search',
};
const CONTEXT_SEARCH_ENGINE_ENGINES = [
	...new Set(
		String(process.env.CONTEXT_SEARCH_ENGINE_ENGINES || 'google,bing,yahoo')
			.split(',')
			.map((value) =>
				String(value || '')
					.trim()
					.toLowerCase(),
			)
			.filter((value) => CONTEXT_SEARCH_ENGINE_SOURCE_LABELS[value]),
	),
];
const CONTEXT_X_CASHTAG_SEARCH_ENGINES = [
	...new Set(
		String(process.env.CONTEXT_X_CASHTAG_SEARCH_ENGINES || 'yahoo,google')
			.split(',')
			.map((value) =>
				String(value || '')
					.trim()
					.toLowerCase(),
			)
			.filter((value) => CONTEXT_SEARCH_ENGINE_SOURCE_LABELS[value]),
	),
];
const GOOGLE_NEWS_TOPIC_FEEDS = [
	{
		source: 'Google News · Top stories',
		topicId: 'CAAqJggKIiBDQkFTRWdvSUwyMHZNRFZxYUdjU0FtVnVHZ0pWVXlnQVAB',
		tags: ['news', 'google-news', 'top-stories'],
	},
	{
		source: 'Google News · World',
		topicId: 'CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx1YlY4U0FtVnVHZ0pWVXlnQVAB',
		tags: ['news', 'google-news', 'world'],
	},
	{
		source: 'Google News · Business',
		topicId: 'CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pWVXlnQVAB',
		tags: ['news', 'google-news', 'business'],
	},
	{
		source: 'Google News · Technology',
		topicId: 'CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pWVXlnQVAB',
		tags: ['news', 'google-news', 'technology'],
	},
];
const ACTUALLY_RELEVANT_ISSUES = [
	{
		slug: 'science-technology',
		source: 'Actually Relevant · Science & Technology',
		tags: ['news', 'actually-relevant', 'science-technology', 'technology'],
	},
	{
		slug: 'existential-threats',
		source: 'Actually Relevant · Existential Threats',
		tags: ['news', 'actually-relevant', 'existential-threats'],
	},
	{
		slug: 'planet-climate',
		source: 'Actually Relevant · Planet & Climate',
		tags: ['news', 'actually-relevant', 'planet-climate', 'climate'],
	},
	{
		slug: 'human-development',
		source: 'Actually Relevant · Human Development',
		tags: ['news', 'actually-relevant', 'human-development'],
	},
];
const BUILTIN_GENERAL_NEWS_FEEDS = [
	{
		source: 'Investing.com · Economy News',
		homepage: 'https://www.investing.com/news/economy-news',
		url: 'https://www.investing.com/rss/news_14.rss',
		language: 'en-US',
		category: 'News',
		subcategory: 'Economy News',
	},
	{
		source: 'Investing.com · Stock Market News',
		homepage: 'https://www.investing.com/news/stock-market-news',
		url: 'https://www.investing.com/rss/news_25.rss',
		language: 'en-US',
		category: 'News',
		subcategory: 'Stock Market News',
	},
	{
		source: 'Investing.com · Economic Indicators News',
		homepage: 'https://www.investing.com/news/economic-indicators',
		url: 'https://www.investing.com/rss/news_95.rss',
		language: 'en-US',
		category: 'News',
		subcategory: 'Economic Indicators News',
	},
	{
		source: 'Investing.com · Press Releases',
		homepage: 'https://www.investing.com/news/press-releases',
		url: 'https://www.investing.com/rss/news_355.rss',
		language: 'en-US',
		category: 'News',
		subcategory: 'Press Releases',
	},
	{
		source: 'WIRED · Artificial Intelligence',
		homepage: 'https://www.wired.com/tag/ai/',
		url: 'https://www.wired.com/feed/tag/ai/latest/rss',
		language: 'en-US',
		category: 'News',
		subcategory: 'Artificial Intelligence',
	},
	{
		source: 'WIRED · Security',
		homepage: 'https://www.wired.com/category/security/',
		url: 'https://www.wired.com/feed/category/security/latest/rss',
		language: 'en-US',
		category: 'News',
		subcategory: 'Security',
	},
	{
		source: 'WIRED · Science',
		homepage: 'https://www.wired.com/category/science/',
		url: 'https://www.wired.com/feed/category/science/latest/rss',
		language: 'en-US',
		category: 'News',
		subcategory: 'Science',
	},
	{
		source: 'WFAA (ABC 8) · Top Stories & Local News',
		homepage: 'https://www.wfaa.com/',
		url: 'https://rssfeeds.wfaa.com/wfaa/home',
		language: 'en-US',
		category: 'News',
		subcategory: 'Local News',
	},
	{
		source: 'NBC 5 DFW · Regional News & Weather',
		homepage: 'https://www.nbcdfw.com/',
		url: 'https://www.nbcdfw.com/?rss=y',
		language: 'en-US',
		category: 'News',
		subcategory: 'Local News',
	},
	{
		source: 'Dallas City News · Official Municipal Updates',
		homepage: 'https://dallascitynews.net/',
		url: 'https://dallascitynews.net/feed',
		language: 'en-US',
		category: 'News',
		subcategory: 'Local News',
	},
	{
		source: 'Dallas Observer · Local Reporting & Culture',
		homepage: 'https://www.dallasobserver.com/news',
		url: 'https://www.dallasobserver.com/news/rss',
		language: 'en-US',
		category: 'News',
		subcategory: 'Local News',
	},
	{
		source: 'Fort Worth Star-Telegram · FW & Tarrant County',
		homepage: 'https://www.star-telegram.com/',
		url: 'https://www.star-telegram.com/?widgetName=rssfeed&widgetContentId=6199&getXmlFeed=true',
		language: 'en-US',
		category: 'News',
		subcategory: 'Local News',
	},
];
const GENERAL_NEWS_PREFERRED_HOSTS = [
	'reutersagency.com',
	'reuters.com',
	'bbci.co.uk',
	'bbc.com',
	'npr.org',
	'nbcnews.com',
	'nytimes.com',
	'theguardian.com',
	'ft.com',
	'wsj.com',
	'washingtonpost.com',
	'cbsnews.com',
	'cnn.com',
	'economist.com',
	'time.com',
	'newsweek.com',
	'cnbc.com',
	'abcnews.go.com',
];
const FINANCE_REDDIT_SUBREDDITS = [
	{ subreddit: 'wallstreetbets', source: 'Reddit · r/wallstreetbets' },
	{ subreddit: 'stocks', source: 'Reddit · r/stocks' },
	{ subreddit: 'investing', source: 'Reddit · r/investing' },
	{ subreddit: 'options', source: 'Reddit · r/options' },
];
const INVESTING_STOCK_NEWS_FEEDS = [
	{
		source: 'Investing.com · Stock Market News',
		homepage: 'https://www.investing.com/news/stock-market-news',
		url: 'https://www.investing.com/rss/news_25.rss',
		tags: ['news', 'investing.com', 'stock-market-news'],
	},
	{
		source: 'Investing.com · Company News',
		homepage: 'https://www.investing.com/news/company-news',
		url: 'https://www.investing.com/rss/news_356.rss',
		tags: ['news', 'investing.com', 'company-news'],
	},
	{
		source: 'Investing.com · Stock Analyst Ratings',
		homepage: 'https://www.investing.com/news/analyst-ratings',
		url: 'https://www.investing.com/rss/news_1061.rss',
		tags: ['news', 'investing.com', 'analyst-ratings'],
	},
	{
		source: 'Investing.com · Earnings Reports and Whispers',
		homepage: 'https://www.investing.com/news/earnings',
		url: 'https://www.investing.com/rss/news_1062.rss',
		tags: ['news', 'investing.com', 'earnings'],
	},
];
const GENERAL_REDDIT_SUBREDDITS = [
	{ subreddit: 'news', source: 'Reddit · r/news' },
	{ subreddit: 'worldnews', source: 'Reddit · r/worldnews' },
	{ subreddit: 'technology', source: 'Reddit · r/technology' },
	{ subreddit: 'science', source: 'Reddit · r/science' },
	{ subreddit: 'business', source: 'Reddit · r/business' },
];
const STOCK_SIGNAL_TERMS = [
	'stock',
	'stocks',
	'share',
	'shares',
	'share price',
	'stock price',
	'equity',
	'equities',
	'shareholder',
	'shareholders',
	'investor',
	'investors',
	'market',
	'markets',
	'trading',
	'trader',
	'traders',
	'ticker',
	'market cap',
	'capitalization',
	'earnings',
	'eps',
	'revenue beat',
	'guides',
	'valuation',
	'price target',
	'buy rating',
	'sell rating',
	'overweight',
	'underweight',
	'outperform',
	'underperform',
	'upgrade',
	'upgraded',
	'downgrade',
	'downgraded',
	'nasdaq',
	'nyse',
	'wall street',
	'analyst',
	'analysts',
	'guidance',
	'bullish',
	'bearish',
	'rallying',
	'rally',
	'selloff',
	'volatility',
	'volumes',
	'volume spike',
	'options',
	'call options',
	'put options',
	'calls',
	'puts',
	'short interest',
	'float',
	'multiple expansion',
	'etf',
];
const ASSET_ALIASES = {
	tsla: ['tesla', 'tesla inc', 'tesla motors'],
	msft: ['microsoft', 'microsoft corporation', 'microsoft corp'],
	aapl: ['apple', 'apple inc'],
	nvda: ['nvidia', 'nvidia corporation'],
	amzn: ['amazon', 'amazon.com', 'amazon inc'],
	meta: ['meta', 'meta platforms', 'facebook'],
	googl: ['alphabet', 'google', 'alphabet inc'],
	goog: ['alphabet', 'google', 'alphabet inc'],
	mstr: ['microstrategy', 'strategy'],
};

const parser = new Parser({
	headers: {
		'User-Agent': 'query-notify-context-monitor/1.0',
		'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml',
	},
});
const FUTURE_DATE_TOLERANCE_MS = 5 * 60 * 1000;

const REDDIT_REQUEST_HEADERS = {
	'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
	'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml,*/*;q=0.9',
	'Accept-Language': 'en-US,en;q=0.9',
	'Referer': 'https://www.reddit.com/',
	'Origin': 'https://www.reddit.com',
};
const HTML_REQUEST_HEADERS = {
	'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 QueryNotify/1.0',
	'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/xml;q=0.8,*/*;q=0.7',
	'Accept-Language': 'en-US,en;q=0.9',
	'Cache-Control': 'no-cache',
};
const WEBSITE_FEED_PREVIEW_LIMIT = 3;
const WEBSITE_FEED_ITEM_LIMIT = Math.max(CONTEXT_FEED_ITEMS_PER_SOURCE, 10);
const WEBSITE_DISCOVERY_SCORE_THRESHOLD = 4;
const WEBSITE_TITLE_MIN_LENGTH = 12;
const WEBSITE_TITLE_MAX_LENGTH = 220;
const WEBSITE_SUMMARY_MAX_LENGTH = 260;
const WEBSITE_IGNORE_TITLE_RE = /^(?:read more|more|continue reading|learn more|view all|see all|home|about|contact|menu|next|previous|older|newer|sign in|sign up)$/i;
const WEBSITE_IGNORE_PATH_RE =
	/\/(?:account|login|log-in|logout|sign-in|sign-up|signup|subscribe|subscription|preferences|settings|privacy|terms|advertis(?:e|ing)|sponsor|donate|support|help|contact|about|careers|jobs|authors?|tag|tags|category|categories|topics|search|sitemap|feed|rss|atom)(?:[/?#]|$)/i;
const WEBSITE_IGNORE_EXT_RE = /\.(?:xml|rss|atom|json|js|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|zip|gz|mp4|mov|avi|mp3|wav)(?:$|[?#])/i;
const WEBSITE_ARTICLE_TYPE_RE = /^(?:article|newsarticle|blogposting|report|analysisnewsarticle)$/i;
const WEBSITE_TRACKING_PARAM_RE = /^(?:utm_[a-z_]+|fbclid|gclid|mc_[a-z]+)$/i;
const TAG_TEMPLATE_PLACEHOLDER_RE = /\{tag\}/i;
const TAG_TEMPLATE_PLACEHOLDER_GLOBAL_RE = /\{tag\}/gi;

const contextFeedEvents = new EventEmitter();
contextFeedEvents.setMaxListeners(0);
const searchEngineCache = new Map();
const previewImageFallbackCache = new Map();

function createProgressiveFeedState(overrides = {}) {
	return {
		active: false,
		phase: 'complete',
		generalNewsLoadedCount: 0,
		generalNewsTotal: 0,
		matchesLoadedCount: 0,
		matchesTotal: 0,
		...overrides,
	};
}

const state = {
	started: false,
	timer: null,
	xTimer: null,
	refreshPromise: null,
	backgroundRefreshPromise: null,
	generalNewsPromise: null,
	generalNewsSourceCatalog: [],
	generalNewsSourceCatalogFetchedAt: 0,
	keywords: [],
	feedCount: 0,
	lastUpdatedAt: '',
	lastError: '',
	contexts: createEmptyContexts(),
	matches: [],
	generalNews: [],
	generalNewsLastUpdatedAt: '',
	generalNewsLastError: '',
	notifications: [],
	seenMatchIds: new Set(),
	streamVersion: 0,
	progressiveFeedState: createProgressiveFeedState(),
	feedHealth: {}, // Key: feed URL, Value: { lastSuccessAt, lastError, errorCount, successCount, itemCount }
	blockedFeedUrls: new Set(),
};

function createEmptyContexts() {
	return {
		research: [],
		news: [],
		shopping: [],
	};
}

function normalizeFeedContext(value = '') {
	const normalized = normalizeKeyword(value);
	return CONTEXTS.includes(normalized) ? normalized : 'news';
}

function normalizeKeyword(value = '') {
	if (value && typeof value === 'object') return '';

	return String(value || '')
		.toLowerCase()
		.trim()
		.replace(/\s+/g, ' ');
}

function unescapeHtml(text = '') {
	return String(text || '')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

function isImplicitAssetSymbol(value = '') {
	if (value && typeof value === 'object') return false;

	const normalized = String(value || '')
		.trim()
		.toLowerCase();
	if (!/^[a-z][a-z0-9]{3,9}$/.test(normalized)) return false;
	if (ASSET_ALIASES[normalized]) return true;
	return isStockSymbolCatalogReady() && isKnownUsStockSymbol(normalized);
}

function normalizeStringList(value = []) {
	if (Array.isArray(value)) {
		return value.map((entry) => String(entry || '').trim()).filter(Boolean);
	}

	if (value && typeof value === 'object') {
		return Object.values(value)
			.map((entry) => String(entry || '').trim())
			.filter(Boolean);
	}

	const normalizedValue = String(value || '').trim();
	return normalizedValue ? [normalizedValue] : [];
}

function buildSimpleKeywordMatcher(value = '') {
	const normalized = normalizeKeyword(value);
	if (!normalized) return null;
	const isExplicitAsset = normalized.startsWith('$') && normalized.length > 1;
	const implicitSymbol = !isExplicitAsset && /^[a-z][a-z0-9]{0,9}$/.test(normalized) ? normalized.replace(/[^a-z0-9]/g, '') : '';
	const symbol =
		isExplicitAsset ? normalized.slice(1).replace(/[^a-z0-9]/g, '')
		: isImplicitAssetSymbol(implicitSymbol) ? implicitSymbol
		: '';
	const isAsset = Boolean(symbol);
	const isKnownSymbol = isAsset ? isKnownUsStockSymbol(symbol) : false;

	const parts = normalized
		.split(/[^a-z0-9]+/i)
		.map((part) => part.trim())
		.filter((part) => part.length >= 2);
	const aliases = isAsset ? [...new Set([symbol, `$${symbol}`, ...(ASSET_ALIASES[symbol] || [])].map((entry) => normalizeKeyword(entry)).filter(Boolean))] : [];

	return {
		keyword: normalized,
		isExpression: false,
		groups: null,
		canUseFinanceFeeds: isAsset && (!isStockSymbolCatalogReady() || isKnownSymbol),
		isAsset,
		isKnownSymbol,
		symbol,
		aliases,
		parts,
	};
}

function hasAdvancedSearchSyntax(value = '') {
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

function tokenizeAdvancedQuery(value = '') {
	const tokens = [];
	const input = String(value || '').trim();
	let index = 0;
	let previousType = 'START';

	const pushToken = (token) => {
		tokens.push(token);
		previousType = token.type;
	};

	while (index < input.length) {
		const character = input[index];

		if (/\s/.test(character)) {
			index += 1;
			continue;
		}

		if (character === '(') {
			pushToken({ type: 'LPAREN' });
			index += 1;
			continue;
		}

		if (character === ')') {
			pushToken({ type: 'RPAREN' });
			index += 1;
			continue;
		}

		if (character === '|') {
			pushToken({ type: 'OR' });
			index += 1;
			continue;
		}

		const previousCharacter = index > 0 ? input[index - 1] : '';
		if (character === '-' && (index === 0 || /[\s(]/.test(previousCharacter))) {
			pushToken({ type: 'NOT' });
			index += 1;
			continue;
		}

		if (character === '"') {
			let endIndex = index + 1;
			let buffer = '';

			while (endIndex < input.length) {
				const nextCharacter = input[endIndex];
				if (nextCharacter === '"') break;
				buffer += nextCharacter;
				endIndex += 1;
			}

			pushToken({ type: 'TERM', value: buffer, quoted: true });
			index = endIndex < input.length ? endIndex + 1 : endIndex;
			continue;
		}

		let endIndex = index;
		while (endIndex < input.length && !/[\s()|]/.test(input[endIndex])) {
			endIndex += 1;
		}

		const rawToken = input.slice(index, endIndex);
		const normalizedToken = rawToken.toUpperCase();
		if (normalizedToken === 'OR') {
			pushToken({ type: 'OR' });
		} else if (normalizedToken === 'AND') {
			pushToken({ type: 'AND' });
		} else {
			pushToken({ type: 'TERM', value: rawToken, quoted: false });
		}

		index = endIndex;
	}

	return tokens;
}

function buildWildcardPattern(value = '') {
	const normalizedValue = normalizeKeyword(value);
	if (!normalizedValue) return null;

	const escaped = normalizedValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const pattern = escaped.replace(/\\\*/g, '[\\w./:%#@&+=~-]+');
	return new RegExp(pattern, 'i');
}

function normalizeOperatorComparable(value = '') {
	return normalizeKeyword(String(value || '').replace(/[_-]+/g, ' '));
}

function buildAdvancedTermNode(value = '', quoted = false) {
	const rawValue = String(value || '').trim();
	const normalizedValue = normalizeKeyword(rawValue);
	if (!normalizedValue) return null;

	if (!quoted) {
		const fieldMatch = rawValue.match(/^([a-z]+):(.*)$/i);
		if (fieldMatch) {
			return {
				type: 'FIELD',
				operator: normalizeKeyword(fieldMatch[1]),
				value: String(fieldMatch[2] || '').trim(),
			};
		}
	}

	if (normalizedValue === '*') {
		return { type: 'ANY', raw: rawValue };
	}

	if (rawValue.includes('*')) {
		return {
			type: quoted ? 'PHRASE' : 'WILDCARD',
			raw: rawValue,
			pattern: buildWildcardPattern(rawValue),
		};
	}

	if (quoted) {
		return { type: 'PHRASE', raw: rawValue, value: normalizedValue };
	}

	return {
		type: 'SIMPLE',
		raw: rawValue,
		matcher: buildSimpleKeywordMatcher(rawValue),
	};
}

function parseAdvancedQueryExpression(tokens = [], startIndex = 0) {
	function parsePrimary(index) {
		const token = tokens[index];
		if (!token) {
			return [null, index];
		}

		if (token.type === 'LPAREN') {
			const [expressionNode, nextIndex] = parseOr(index + 1);
			if (tokens[nextIndex]?.type === 'RPAREN') {
				return [expressionNode, nextIndex + 1];
			}
			return [expressionNode, nextIndex];
		}

		if (token.type === 'TERM') {
			return [buildAdvancedTermNode(token.value, token.quoted), index + 1];
		}

		return [null, index + 1];
	}

	function parseUnary(index) {
		const token = tokens[index];
		if (token?.type === 'NOT') {
			const [expressionNode, nextIndex] = parseUnary(index + 1);
			return [expressionNode ? { type: 'NOT', expression: expressionNode } : null, nextIndex];
		}

		return parsePrimary(index);
	}

	function parseAnd(index) {
		let [leftNode, nextIndex] = parseUnary(index);

		while (nextIndex < tokens.length) {
			const nextToken = tokens[nextIndex];
			const isExplicitAnd = nextToken?.type === 'AND';
			const isImplicitAnd = ['TERM', 'LPAREN', 'NOT'].includes(nextToken?.type);

			if (!isExplicitAnd && !isImplicitAnd) {
				break;
			}

			const [rightNode, followingIndex] = parseUnary(isExplicitAnd ? nextIndex + 1 : nextIndex);
			if (!rightNode) {
				nextIndex = followingIndex;
				continue;
			}

			leftNode = leftNode ? { type: 'AND', left: leftNode, right: rightNode } : rightNode;
			nextIndex = followingIndex;
		}

		return [leftNode, nextIndex];
	}

	function parseOr(index) {
		let [leftNode, nextIndex] = parseAnd(index);

		while (tokens[nextIndex]?.type === 'OR') {
			const [rightNode, followingIndex] = parseAnd(nextIndex + 1);
			if (!rightNode) {
				nextIndex = followingIndex;
				continue;
			}

			leftNode = leftNode ? { type: 'OR', left: leftNode, right: rightNode } : rightNode;
			nextIndex = followingIndex;
		}

		return [leftNode, nextIndex];
	}

	return parseOr(startIndex);
}

function buildAdvancedKeywordMatcher(value = '') {
	const normalized = normalizeKeyword(value);
	if (!normalized) return null;

	const tokens = tokenizeAdvancedQuery(value);
	const [ast] = parseAdvancedQueryExpression(tokens);
	if (!ast) {
		return buildSimpleKeywordMatcher(value);
	}

	return {
		keyword: normalized,
		isExpression: true,
		isAdvanced: true,
		ast,
		groups: null,
		canUseFinanceFeeds: false,
		isAsset: false,
		symbol: '',
		aliases: [],
		parts: [],
	};
}

function buildKeywordMatcher(value = '') {
	const normalized = normalizeKeyword(value);
	if (!normalized) return null;
	if (hasAdvancedSearchSyntax(value)) {
		return buildAdvancedKeywordMatcher(value);
	}

	const clauses = normalized
		.split(/\s+or\s+/i)
		.map((clause) => clause.trim())
		.filter(Boolean)
		.map((clause) =>
			clause
				.split(/\s+and\s+/i)
				.map((term) => term.trim())
				.filter(Boolean)
				.map((term) => buildSimpleKeywordMatcher(term))
				.filter(Boolean),
		)
		.filter((clause) => clause.length);

	if (!clauses.length) return null;
	if (clauses.length === 1 && clauses[0].length === 1) {
		return clauses[0][0];
	}

	return {
		keyword: normalized,
		isExpression: true,
		isAdvanced: false,
		groups: clauses,
		canUseFinanceFeeds: false,
		isAsset: false,
		symbol: '',
		aliases: [],
		parts: [],
	};
}

function isStockRelatedText(text = '') {
	const normalizedText = normalizeKeyword(text);
	if (!normalizedText) return false;

	return STOCK_SIGNAL_TERMS.some((term) => normalizedText.includes(term));
}

function summarizeText(value = '', maxLength = 220) {
	const normalized = String(value || '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

	if (!normalized) return '';
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength).trimEnd()}…`;
}

function normalizeFeedText(value = '') {
	return summarizeText(value, Number.POSITIVE_INFINITY);
}

function normalizeTemplateTagValue(value = '') {
	return String(value || '').trim();
}

function escapeRegExp(value = '') {
	return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSourceRequest(input = {}) {
	if (typeof input === 'string') {
		return { url: input };
	}

	return input && typeof input === 'object' ? input : { url: String(input || '').trim() };
}

export function buildTagTemplateBaseUrl(url = '', replaceTagValue = '') {
	const normalizedUrl = String(url || '').trim();
	const normalizedReplaceTagValue = normalizeTemplateTagValue(replaceTagValue);
	if (!normalizedUrl) return '';
	if (!normalizedReplaceTagValue) return normalizedUrl;
	if (TAG_TEMPLATE_PLACEHOLDER_RE.test(normalizedUrl)) return normalizedUrl;

	const encodedReplaceTagValue = encodeURIComponent(normalizedReplaceTagValue);
	const replacementCandidates = [...new Set([normalizedReplaceTagValue, encodedReplaceTagValue].filter(Boolean))];

	for (const candidate of replacementCandidates) {
		if (!candidate || !normalizedUrl.includes(candidate)) continue;
		return normalizedUrl.replace(new RegExp(escapeRegExp(candidate), 'i'), '{tag}');
	}

	return '';
}

function isTagTemplateSource(feed = {}) {
	const type = String(feed?.type || '')
		.trim()
		.toLowerCase();
	const urlTemplate = String(feed?.urlTemplate || '').trim();
	const url = String(feed?.url || '').trim();
	return type === 'tag-template' || Boolean(urlTemplate) || TAG_TEMPLATE_PLACEHOLDER_RE.test(url);
}

export function buildDefaultContextSourceLabel(inputUrl = '', options = {}) {
	const normalizedUrl = String(inputUrl || '').trim();
	if (!normalizedUrl) return '';

	try {
		const parsedUrl = new URL(normalizedUrl);
		const hostname = String(parsedUrl.hostname || '').toLowerCase();
		const pathname = String(parsedUrl.pathname || '').replace(/\/+$/, '');
		const isTemplate = Boolean(options.useTagTemplate);

		if (isXHostname(hostname)) {
			if (pathname === '/search' && parsedUrl.searchParams.has('q')) {
				return isTemplate ? 'Twitter Search Template' : 'Twitter Search';
			}

			const profileMatch = pathname.match(/^\/([^/]+)$/);
			if (profileMatch && !['home', 'explore', 'notifications', 'messages', 'search', 'settings', 'i'].includes(profileMatch[1].toLowerCase())) {
				return isTemplate ? `Twitter Profile Template · @${profileMatch[1]}` : `Twitter Profile · @${profileMatch[1]}`;
			}

			return isTemplate ? 'Twitter Template' : 'Twitter';
		}

		const hostLabel = parsedUrl.hostname.replace(/^www\./i, '').trim();
		if (!hostLabel) return '';
		return isTemplate ? `${hostLabel} Template` : hostLabel;
	} catch {
		return '';
	}
}

export function applyTagToUrlTemplate(template = '', tag = '') {
	const normalizedTemplate = String(template || '').trim();
	const normalizedTag = normalizeTemplateTagValue(tag);
	if (!normalizedTemplate || !normalizedTag) return '';

	const encodedTag = encodeURIComponent(normalizedTag);
	if (TAG_TEMPLATE_PLACEHOLDER_RE.test(normalizedTemplate)) {
		return normalizedTemplate.replace(TAG_TEMPLATE_PLACEHOLDER_GLOBAL_RE, encodedTag);
	}

	return `${normalizedTemplate}${encodedTag}`;
}

function resolveTagTemplateRequest(input = {}, fallbackTags = []) {
	const request = normalizeSourceRequest(input);
	const replaceTagValue = normalizeTemplateTagValue(request.replaceTagValue || request.tagSegment || request.tagValue || '');
	const rawBaseUrl = String(request.urlTemplate || request.url || '').trim();
	const baseUrl = buildTagTemplateBaseUrl(rawBaseUrl, replaceTagValue) || rawBaseUrl;
	const useTagTemplate = Boolean(request.useTagTemplate) || isTagTemplateSource(request);
	if (!useTagTemplate) {
		return {
			useTagTemplate: false,
			baseUrl,
			replaceTagValue,
			testTag: '',
			testedUrl: baseUrl,
		};
	}

	if (!baseUrl) {
		throw new Error('Base URL is required for tag-based sources');
	}

	if (replaceTagValue && !TAG_TEMPLATE_PLACEHOLDER_RE.test(baseUrl)) {
		throw new Error('Could not find the selected tag text inside the provided URL');
	}

	const fallbackTag = [request.testTag, request.sampleTag, replaceTagValue, ...(Array.isArray(fallbackTags) ? fallbackTags : [fallbackTags])]
		.map((value) => normalizeTemplateTagValue(value))
		.find(Boolean);

	if (!fallbackTag) {
		throw new Error('Provide a test tag or add at least one active tag before validating a base URL template');
	}

	const testedUrl = applyTagToUrlTemplate(baseUrl, fallbackTag);
	if (!testedUrl) {
		throw new Error('Could not build a tagged URL from the provided base URL');
	}

	return {
		useTagTemplate: true,
		baseUrl,
		replaceTagValue,
		testTag: fallbackTag,
		testedUrl,
	};
}

export function expandTagTemplateFeed(feed = {}, keywords = []) {
	const baseUrl = String(feed?.urlTemplate || feed?.url || '').trim();
	if (!baseUrl) return [];

	const normalizedKeywords = [...new Set((Array.isArray(keywords) ? keywords : [keywords]).map((keyword) => normalizeKeyword(keyword)).filter(Boolean))];
	return normalizedKeywords
		.map((keyword) => {
			const taggedUrl = applyTagToUrlTemplate(baseUrl, keyword);
			if (!taggedUrl) return null;

			return {
				...feed,
				type: 'tag-template-instance',
				url: taggedUrl,
				homepage: taggedUrl,
				urlTemplate: baseUrl,
				parentUrl: String(feed?.url || baseUrl).trim(),
				templateTag: keyword,
				source: `${String(feed?.source || 'Custom Source').trim() || 'Custom Source'} · ${keyword}`,
				tags: [...new Set([...(Array.isArray(feed?.tags) ? feed.tags : []), 'template', keyword].filter(Boolean))],
			};
		})
		.filter(Boolean);
}

function normalizeWhitespace(value = '') {
	return String(value || '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function toArray(value) {
	if (Array.isArray(value)) return value;
	if (value == null) return [];
	return [value];
}

function stripTrackingParams(rawUrl = '') {
	try {
		const url = new URL(String(rawUrl || '').trim());
		for (const key of [...url.searchParams.keys()]) {
			if (WEBSITE_TRACKING_PARAM_RE.test(key)) {
				url.searchParams.delete(key);
			}
		}
		url.hash = '';
		return url.toString();
	} catch {
		return String(rawUrl || '').trim();
	}
}

function isLikelyHtmlPageUrl(value = '') {
	try {
		const url = new URL(String(value || '').trim());
		if (!/^https?:$/i.test(url.protocol)) return false;
		if (WEBSITE_IGNORE_EXT_RE.test(url.pathname)) return false;
		return true;
	} catch {
		return false;
	}
}

function extractMetaContent($, selectors = []) {
	for (const selector of selectors) {
		const value = normalizeWhitespace($(selector).first().attr('content') || $(selector).first().text() || '');
		if (value) return value;
	}
	return '';
}

function buildWebsiteItemPreviewImage(src = '', alt = '', pageUrl = '') {
	const resolvedSrc = resolveFeedItemUrl(pageUrl, src) || String(src || '').trim();
	if (!resolvedSrc) return null;

	return normalizePreviewImage({
		src: resolvedSrc,
		alt,
		caption: alt,
		originUrl: resolvedSrc,
	});
}

function findWebsiteCandidateImage($container, pageUrl = '') {
	const imageElement = $container.find('img[src]').first();
	if (!imageElement.length) return null;
	return buildWebsiteItemPreviewImage(imageElement.attr('src') || '', imageElement.attr('alt') || '', pageUrl);
}

function normalizeWebsiteCandidateLink(baseUrl = '', href = '') {
	const resolved = stripTrackingParams(resolveFeedItemUrl(baseUrl, href) || '');
	if (!resolved || !isLikelyHtmlPageUrl(resolved)) return '';

	try {
		const url = new URL(resolved);
		if (/^(?:mailto|tel|javascript|data):/i.test(url.protocol)) return '';
		if (url.pathname === '/' && !url.search) return '';
		if (WEBSITE_IGNORE_PATH_RE.test(url.pathname)) return '';
		return url.toString();
	} catch {
		return '';
	}
}

function flattenJsonLdNodes(value = null, results = []) {
	if (value == null) return results;
	if (Array.isArray(value)) {
		for (const entry of value) {
			flattenJsonLdNodes(entry, results);
		}
		return results;
	}
	if (typeof value !== 'object') return results;
	results.push(value);
	if (Array.isArray(value['@graph'])) {
		flattenJsonLdNodes(value['@graph'], results);
	}
	return results;
}

function extractArticleUrlFromJsonLd(node = {}) {
	const directUrl = node.url || node['@id'] || '';
	if (typeof directUrl === 'string' && directUrl.trim()) return directUrl;

	if (typeof node.mainEntityOfPage === 'string') return node.mainEntityOfPage;
	if (node.mainEntityOfPage && typeof node.mainEntityOfPage === 'object') {
		return node.mainEntityOfPage['@id'] || node.mainEntityOfPage.url || '';
	}

	return '';
}

function normalizeJsonLdWebsiteItem(node = {}, pageUrl = '') {
	const title = normalizeWhitespace(node.headline || node.name || node.title || '');
	const link = normalizeWebsiteCandidateLink(pageUrl, extractArticleUrlFromJsonLd(node));
	if (!title || !link) return null;

	const datePublished = parsePublishedAt({
		isoDate: node.datePublished || node.dateCreated || node.dateModified || '',
		datePublished: node.datePublished || '',
		dateCreated: node.dateCreated || '',
	});
	const imageCandidate = Array.isArray(node.image) ? node.image[0] : node.image;
	const imageUrl = typeof imageCandidate === 'string' ? imageCandidate : imageCandidate?.url || imageCandidate?.contentUrl || imageCandidate?.src || '';
	const keywords = [...toArray(node.keywords), ...toArray(node.articleSection)]
		.flatMap((entry) => String(entry || '').split(','))
		.map((entry) => normalizeKeyword(entry))
		.filter(Boolean);

	return {
		title,
		link,
		summary: summarizeText(node.description || node.abstract || title, WEBSITE_SUMMARY_MAX_LENGTH),
		publishedAt: datePublished,
		previewImage: buildWebsiteItemPreviewImage(imageUrl, title, pageUrl),
		categories: keywords,
		score: 12,
		discoverySource: 'jsonld',
	};
}

function extractWebsiteItemsFromJsonLd($, pageUrl = '') {
	const candidates = [];

	$('script[type="application/ld+json"]').each((_, script) => {
		const rawText = normalizeWhitespace($(script).html() || '');
		if (!rawText) return;

		try {
			const parsed = JSON.parse(rawText);
			const nodes = flattenJsonLdNodes(parsed, []);

			for (const node of nodes) {
				const types = toArray(node?.['@type']).map((entry) => normalizeKeyword(entry));
				if (types.some((type) => WEBSITE_ARTICLE_TYPE_RE.test(type))) {
					const item = normalizeJsonLdWebsiteItem(node, pageUrl);
					if (item) candidates.push(item);
					continue;
				}

				if (types.includes('itemlist') && Array.isArray(node.itemListElement)) {
					for (const entry of node.itemListElement) {
						const item = normalizeJsonLdWebsiteItem(entry?.item || entry, pageUrl);
						if (item) candidates.push(item);
					}
				}
			}
		} catch {
			// Ignore malformed JSON-LD blocks.
		}
	});

	return candidates;
}

function extractWebsiteCandidateSummary($container, title = '') {
	const text = normalizeWhitespace($container.text() || '');
	if (!text) return '';
	const normalizedTitle = normalizeWhitespace(title);
	const summary = normalizedTitle ? normalizeWhitespace(text.replace(normalizedTitle, ' ')) : text;
	return summarizeText(summary, WEBSITE_SUMMARY_MAX_LENGTH);
}

function extractWebsiteCandidatePublishedAt($container) {
	const timeElement = $container.find('time').first();
	const directDate = parsePublishedAt({
		isoDate: timeElement.attr('datetime') || timeElement.attr('dateTime') || '',
		pubDate: timeElement.attr('datetime') || timeElement.attr('dateTime') || '',
		datePublished:
			$container.find('[itemprop="datePublished"]').attr('content') ||
			$container.find('[property="article:published_time"]').attr('content') ||
			$container.find('meta[property="article:published_time"]').attr('content') ||
			'',
	});
	if (directDate) return directDate;

	const dateText = normalizeWhitespace(
		$container.find('time').first().text() ||
			$container.find('[itemprop="datePublished"]').first().text() ||
			$container.find('[class*="date"],[class*="time"],[datetime]').first().text() ||
			'',
	);
	return parsePublishedAtFromText(dateText);
}

function scoreWebsiteCandidate(link = '', title = '', $anchor = null, $container = null, pageUrl = '') {
	let score = 0;

	try {
		const candidateUrl = new URL(link);
		const sourceUrl = new URL(pageUrl);
		if (candidateUrl.hostname === sourceUrl.hostname) {
			score += 3;
		}
		if (/\/20\d{2}\/|\/\d{4}\/\d{2}\//.test(candidateUrl.pathname)) {
			score += 3;
		}
		if (/[-_]/.test(candidateUrl.pathname) && candidateUrl.pathname.length > 16) {
			score += 2;
		}
		if (candidateUrl.search) {
			score -= 1;
		}
	} catch {
		return 0;
	}

	const normalizedTitle = normalizeWhitespace(title);
	if (normalizedTitle.length >= WEBSITE_TITLE_MIN_LENGTH && normalizedTitle.length <= WEBSITE_TITLE_MAX_LENGTH) {
		score += 3;
	}
	if (WEBSITE_IGNORE_TITLE_RE.test(normalizedTitle)) {
		score -= 8;
	}

	if ($anchor?.closest('article, main, section').length) {
		score += 2;
	}
	if ($container?.find('time,[itemprop="datePublished"],[property="article:published_time"]').length) {
		score += 2;
	}
	if ($container?.find('img[src]').length) {
		score += 1;
	}

	return score;
}

export function discoverAlternateFeedUrlsFromHtml(html = '', pageUrl = '') {
	const $ = cheerio.load(String(html || ''));
	const candidates = new Set();

	$('link[rel]').each((_, element) => {
		const rel = String($(element).attr('rel') || '').toLowerCase();
		const type = String($(element).attr('type') || '').toLowerCase();
		const href = String($(element).attr('href') || '').trim();
		if (!href) return;
		if (!/alternate/.test(rel) && !/application\/(?:rss\+xml|atom\+xml|xml)|text\/xml/.test(type)) return;
		const resolved = resolveFeedItemUrl(pageUrl, href);
		if (resolved) candidates.add(resolved);
	});

	$('a[href]').each((_, element) => {
		const anchorText = normalizeWhitespace($(element).text() || '');
		const href = String($(element).attr('href') || '').trim();
		if (!href) return;
		if (!/(?:rss|feed|atom)/i.test(anchorText) && !/(?:\/feed(?:[/?#]|$)|\.rss(?:$|[?#])|\.xml(?:$|[?#]))/i.test(href)) return;
		const resolved = resolveFeedItemUrl(pageUrl, href);
		if (resolved) candidates.add(resolved);
	});

	return [...candidates];
}

export function extractWebsiteFeedItemsFromHtml(html = '', pageUrl = '', options = {}) {
	const $ = cheerio.load(String(html || ''));
	const limit = Math.max(1, Math.min(24, Number(options.limit) || WEBSITE_FEED_ITEM_LIMIT));
	const dedupedCandidates = new Map();

	const addCandidate = (candidate = {}) => {
		const link = String(candidate.link || '').trim();
		const title = normalizeWhitespace(candidate.title || '');
		if (!link || !title) return;
		if (!isLikelyHtmlPageUrl(link)) return;
		if (WEBSITE_IGNORE_TITLE_RE.test(title)) return;

		const normalizedCandidate = {
			title,
			link,
			summary: summarizeText(candidate.summary || title, WEBSITE_SUMMARY_MAX_LENGTH),
			publishedAt: String(candidate.publishedAt || '').trim(),
			previewImage: candidate.previewImage || null,
			categories: Array.isArray(candidate.categories) ? candidate.categories.filter(Boolean) : [],
			score: Number(candidate.score) || 0,
			discoverySource: candidate.discoverySource || 'dom',
		};

		const existing = dedupedCandidates.get(link);
		if (!existing || normalizedCandidate.score > existing.score) {
			dedupedCandidates.set(link, normalizedCandidate);
		}
	};

	for (const item of extractWebsiteItemsFromJsonLd($, pageUrl)) {
		addCandidate(item);
	}

	$('a[href]').each((_, element) => {
		const $anchor = $(element);
		const title = normalizeWhitespace($anchor.text() || $anchor.attr('title') || '');
		if (title.length < WEBSITE_TITLE_MIN_LENGTH || title.length > WEBSITE_TITLE_MAX_LENGTH) return;

		const link = normalizeWebsiteCandidateLink(pageUrl, $anchor.attr('href') || '');
		if (!link) return;

		const $container = $anchor.closest('article, li, section, div').first();
		const score = scoreWebsiteCandidate(link, title, $anchor, $container, pageUrl);
		if (score < WEBSITE_DISCOVERY_SCORE_THRESHOLD) return;

		addCandidate({
			title,
			link,
			summary: extractWebsiteCandidateSummary($container, title),
			publishedAt: extractWebsiteCandidatePublishedAt($container),
			previewImage: findWebsiteCandidateImage($container, pageUrl),
			score,
			discoverySource: 'dom',
		});
	});

	return [...dedupedCandidates.values()]
		.sort((left, right) => {
			const leftTime = parseTimestamp(left.publishedAt || '') || 0;
			const rightTime = parseTimestamp(right.publishedAt || '') || 0;
			if (leftTime || rightTime) {
				if (rightTime !== leftTime) return rightTime - leftTime;
			}
			return (right.score || 0) - (left.score || 0) || left.title.localeCompare(right.title);
		})
		.slice(0, limit)
		.map((item) => ({
			title: item.title,
			link: item.link,
			contentSnippet: item.summary,
			summary: item.summary,
			content: item.summary,
			isoDate: item.publishedAt,
			published: item.publishedAt,
			previewImage: item.previewImage,
			categories: item.categories,
			guid: item.link,
		}));
}

function buildWebsiteFeedFromHtml(html = '', pageUrl = '', options = {}) {
	const $ = cheerio.load(String(html || ''));
	const title =
		extractMetaContent($, ['meta[property="og:site_name"]', 'meta[name="application-name"]']) || normalizeWhitespace($('title').first().text() || '') || new URL(pageUrl).hostname;
	const description = extractMetaContent($, ['meta[name="description"]', 'meta[property="og:description"]']);
	const items = extractWebsiteFeedItemsFromHtml(html, pageUrl, options);

	return {
		title,
		description,
		items,
	};
}

async function fetchHtmlPage(url = '') {
	const response = await fetch(url, {
		headers: HTML_REQUEST_HEADERS,
	});

	if (!response.ok) {
		throw new Error(`Status code ${response.status}`);
	}

	const contentType = String(response.headers.get('content-type') || '').toLowerCase();
	const html = await response.text();
	return {
		url: response.url || url,
		contentType,
		html,
	};
}

async function resolveContextSource(inputUrl = '', options = {}) {
	const requestedUrl = String(inputUrl || '').trim();
	if (!requestedUrl) throw new Error('URL is required');

	const feedUrl = transformPlatformUrlToFeedUrl(requestedUrl);
	let rssError = null;

	try {
		const parsed = await parseFeed(feedUrl);
		if (parsed?.items) {
			return {
				type: 'rss-feed',
				parsed,
				finalUrl: feedUrl,
				homepage: requestedUrl,
				storageUrl: feedUrl,
				validationMethod: 'rss',
			};
		}
	} catch (error) {
		rssError = error;
	}

	const page = await fetchHtmlPage(requestedUrl);
	for (const alternateFeedUrl of discoverAlternateFeedUrlsFromHtml(page.html, page.url)) {
		try {
			const parsed = await parseFeed(alternateFeedUrl);
			if (parsed?.items) {
				return {
					type: 'rss-feed',
					parsed,
					finalUrl: alternateFeedUrl,
					homepage: page.url,
					storageUrl: alternateFeedUrl,
					validationMethod: 'discovered-feed',
				};
			}
		} catch (error) {
			logger.debug('Discovered website feed link could not be parsed', {
				inputUrl: requestedUrl,
				feedUrl: alternateFeedUrl,
				error: error.message,
			});
		}
	}

	const parsedWebsiteFeed = buildWebsiteFeedFromHtml(page.html, page.url, options);
	if (parsedWebsiteFeed.items?.length) {
		return {
			type: 'website-feed',
			parsed: parsedWebsiteFeed,
			finalUrl: page.url,
			homepage: page.url,
			storageUrl: page.url,
			validationMethod: 'html-heuristic',
		};
	}

	if (rssError) {
		throw new Error(`Unable to parse as RSS and could not extract website items: ${rssError.message}`);
	}

	throw new Error('Could not discover feed items from website HTML');
}

async function resolveContextSourceInput(input = {}, options = {}) {
	const templateRequest = resolveTagTemplateRequest(input, options.fallbackTags || []);
	const resolvedSource = await resolveContextSource(templateRequest.testedUrl, options);

	if (!templateRequest.useTagTemplate) {
		return {
			...resolvedSource,
			useTagTemplate: false,
			baseUrl: templateRequest.baseUrl,
			replaceTagValue: templateRequest.replaceTagValue,
			testTag: '',
			testedUrl: templateRequest.testedUrl,
		};
	}

	return {
		...resolvedSource,
		useTagTemplate: true,
		baseUrl: templateRequest.baseUrl,
		replaceTagValue: templateRequest.replaceTagValue,
		testTag: templateRequest.testTag,
		testedUrl: templateRequest.testedUrl,
		storageUrl: templateRequest.baseUrl,
		homepage: templateRequest.baseUrl,
		type: 'tag-template',
	};
}

function isXHostname(value = '') {
	return /(^|\.)(twitter\.com)$/i.test(String(value || '').trim());
}

function decodeUrlComponent(value = '') {
	const normalizedValue = String(value || '').trim();
	if (!normalizedValue) return '';

	try {
		return decodeURIComponent(normalizedValue.replace(/\+/g, '%20'));
	} catch {
		return normalizedValue;
	}
}

function extractLocalXRouteInfo(feedUrl = '') {
	try {
		const url = new URL(String(feedUrl || '').trim());
		const pathSegments = url.pathname
			.split('/')
			.map((segment) => segment.trim())
			.filter(Boolean);
		const twitterIndex = pathSegments.findIndex((segment) => segment === 'twitter');
		if (twitterIndex === -1) return null;

		const routeType = pathSegments[twitterIndex + 1] || '';
		const routeValue = pathSegments[twitterIndex + 2] || '';
		if (!routeType || !routeValue) return null;

		return {
			type: routeType,
			value: routeValue,
			decodedValue: decodeUrlComponent(routeValue),
		};
	} catch {
		return null;
	}
}

export function buildXPlatformFallbackFeedUrls(feedUrl = '') {
	const routeInfo = extractLocalXRouteInfo(feedUrl);
	if (!routeInfo) return [];

	const fallbackUrls = [];
	const nitterBase = 'https://nitter.poast.org';

	if (routeInfo.type === 'user') {
		fallbackUrls.push(`${nitterBase}/${routeInfo.value}/rss`);
	}

	if (routeInfo.type === 'keyword') {
		fallbackUrls.push(`${nitterBase}/search/rss?q=${routeInfo.value}`);

		const googleNewsFallbackUrl = buildGoogleNewsXFeedUrl(routeInfo.decodedValue);
		if (googleNewsFallbackUrl) {
			fallbackUrls.push(googleNewsFallbackUrl);
		}
	}

	return [...new Set(fallbackUrls.filter(Boolean))];
}

function transformPlatformUrlToFeedUrl(inputUrl = '') {
	const trimmed = String(inputUrl || '').trim();
	if (!trimmed) return trimmed;

	try {
		const url = new URL(trimmed);
		const hostname = url.hostname.toLowerCase();
		const pathname = url.pathname.replace(/\/+$/, '');
		const searchParams = url.searchParams;

		// X / Twitter
		if (isXHostname(hostname)) {
			const port = process.env.PORT || '3001';
			const nitterFallback = 'https://nitter.poast.org'; // Reliable 2026 fallback

			// Search: x.com/search?q=query
			if (pathname === '/search' && searchParams.has('q')) {
				const query = searchParams.get('q');
				// Try local proxy first, but if it's been failing or we want a more robust URL,
				// we'll rely on the parser to handle the fallback if the proxy returns 502.
				// For now, let's keep the local proxy as the "intended" path but add the nitter fallback
				// logic directly into the fetcher if needed.
				// Actually, a better approach for the USER is to return a URL that can be tested.
				return `http://localhost:${port}/api/x/twitter/keyword/${encodeURIComponent(query)}`;
			}

			// Profile: x.com/username
			const profileMatch = pathname.match(/^\/([^/]+)$/);
			if (profileMatch && !['home', 'explore', 'notifications', 'messages', 'search', 'settings', 'i'].includes(profileMatch[1].toLowerCase())) {
				const username = profileMatch[1];
				return `http://localhost:${port}/api/x/twitter/user/${username}`;
			}

			// Root or other X URL
			if (pathname === '' || pathname === '/') {
				const error = new Error('Please provide a full X profile URL (e.g., https://x.com/username) or a search URL.');
				error.status = 400;
				throw error;
			}
		}

		// Reddit
		if (/(^|\.)reddit\.com$/i.test(hostname)) {
			// Subreddit or User
			if (pathname.startsWith('/r/') || pathname.startsWith('/u/') || pathname.startsWith('/user/')) {
				return `${trimmed.replace(/\/+$/, '')}/.rss`;
			}
		}

		// Google Search / News
		if (/(^|\.)google\.[a-z.]+$/i.test(hostname)) {
			const query = searchParams.get('q');
			if (query) {
				// Convert any Google search/news URL into a clean Google News RSS feed
				const rssUrl = new URL('https://news.google.com/rss/search');
				rssUrl.searchParams.set('q', query);
				rssUrl.searchParams.set('hl', 'en-US');
				rssUrl.searchParams.set('gl', 'US');
				rssUrl.searchParams.set('ceid', 'US:en');
				return rssUrl.toString();
			}
		}
	} catch (err) {
		// Not a valid URL, return as is
	}

	return trimmed;
}

function extractXStatusIdFromUrl(value = '') {
	try {
		const url = new URL(String(value || '').trim());
		if (!isXHostname(url.hostname)) return '';
		const match = url.pathname.match(/\/status\/(\d+)/i);
		return match?.[1] || '';
	} catch {
		return '';
	}
}

function isDirectXStatusUrl(value = '') {
	return Boolean(extractXStatusIdFromUrl(value));
}

function xStatusIdToIsoDate(value = '') {
	const statusId = String(value || '').trim();
	if (!/^\d+$/.test(statusId)) return '';

	try {
		const numericStatusId = BigInt(statusId);
		if (numericStatusId < 1n << 22n) return '';

		const twitterEpochMs = 1288834974657n;
		const timestampMs = (numericStatusId >> 22n) + twitterEpochMs;
		const timestampNumber = Number(timestampMs);
		if (!Number.isFinite(timestampNumber) || timestampNumber <= 0) return '';
		return new Date(timestampNumber).toISOString();
	} catch {
		return '';
	}
}

function isStatusOnlyXFeed(feed = {}) {
	const source = String(feed?.source || '').toLowerCase();
	const tags = Array.isArray(feed?.tags) ? feed.tags.map((tag) => String(tag || '').toLowerCase()) : [];
	return source.includes('x cashtags') || source.includes('google news · twitter') || tags.includes('twitter.com');
}

function isStatusOnlyXResult(result = {}) {
	return isDirectXStatusUrl(result?.url || result?.link || result?.guid || '');
}

function isRedditFeedUrl(value = '') {
	try {
		const url = new URL(String(value || ''));
		return /(^|\.)reddit\.com$/i.test(url.hostname);
	} catch {
		return false;
	}
}

async function fetchAndParseFeed(feedUrl = '') {
	const response = await fetch(feedUrl, {
		headers: isRedditFeedUrl(feedUrl) ? REDDIT_REQUEST_HEADERS : undefined,
	});

	if (!response.ok) {
		throw new Error(`Status code ${response.status}`);
	}

	const xml = await response.text();
	return parser.parseString(xml);
}

async function parseFeed(feedUrl = '') {
	if (!feedUrl) return null;

	try {
		return await parser.parseURL(feedUrl);
	} catch (error) {
		// Detect if this is a local X scraper proxy failure — any error qualifies for fallback
		const isLocalProxy = feedUrl.includes('/api/x/twitter/');
		const isRetryableError =
			/Status code (502|503|504)/i.test(error?.message || '') ||
			/fetch failed/i.test(error?.message || '') ||
			/X feed scrape failed/i.test(error?.message || '') ||
			/ECONNREFUSED/i.test(error?.message || '');

		if (isLocalProxy && isRetryableError) {
			for (const fallbackUrl of buildXPlatformFallbackFeedUrls(feedUrl)) {
				try {
					logger.info('X scraper feed unavailable, trying fallback', {
						original: feedUrl,
						fallback: fallbackUrl,
					});
					return await fetchAndParseFeed(fallbackUrl);
				} catch (fallbackErr) {
					logger.debug('X feed fallback failed', {
						fallback: fallbackUrl,
						error: fallbackErr.message,
					});
				}
			}
		}

		if (!isRedditFeedUrl(feedUrl) || !/Status code 403/i.test(error?.message || '')) {
			throw error;
		}

		return fetchAndParseFeed(feedUrl);
	}
}

async function fetchContextSourceItems(feed = {}, options = {}) {
	const isXFeed = String(feed?.url || '').includes('/api/x/twitter/');
	const defaultLimit = isXFeed ? X_CONTEXT_FEED_ITEMS_PER_SOURCE : CONTEXT_FEED_ITEMS_PER_SOURCE;
	const limit = Math.max(1, Math.min(40, Number(options.limit) || defaultLimit));

	if (feed.type === 'search-engine') {
		return fetchSearchEngineFeedItems(feed);
	}

	if (feed.type === 'tag-template-instance') {
		const resolvedTemplateSource = await resolveContextSource(feed.url, { limit: Math.max(limit, WEBSITE_FEED_ITEM_LIMIT) });
		return [...(resolvedTemplateSource.parsed?.items || [])].slice(0, limit);
	}

	if (feed.type === 'website-feed') {
		const parsedWebsiteFeed = await resolveContextSource(feed.url, { limit: Math.max(limit, WEBSITE_FEED_ITEM_LIMIT) });
		return [...(parsedWebsiteFeed.parsed?.items || [])].slice(0, limit);
	}

	return [...((await parseFeed(feed.url))?.items || [])]
		.filter((item) => !isStatusOnlyXFeed(feed) || isStatusOnlyXResult(item))
		.sort((left, right) => {
			const leftTime = Date.parse(parsePublishedAt(left) || '') || 0;
			const rightTime = Date.parse(parsePublishedAt(right) || '') || 0;
			return rightTime - leftTime;
		})
		.slice(0, limit);
}

function normalizeCategoryName(value = '') {
	return normalizeKeyword(String(value || '').replace(/[^a-z0-9]+/gi, ' '));
}

function buildSourceHomepage(feedUrl = '') {
	try {
		const url = new URL(feedUrl);
		return `${url.protocol}//${url.host}`;
	} catch {
		return '';
	}
}

function isGoogleNewsHostname(value = '') {
	try {
		return new URL(String(value || '').trim()).hostname.toLowerCase() === 'news.google.com';
	} catch {
		return false;
	}
}

function isXLikeContextMatch(match = {}) {
	const source = String(match?.source || '').toLowerCase();
	const homepage = String(match?.homepage || '').toLowerCase();
	const feedUrl = String(match?.feedUrl || '').toLowerCase();
	const tags = Array.isArray(match?.tags) ? match.tags.map((tag) => normalizeKeyword(tag)) : [];

	return (
		source.includes('x live tag feed') ||
		source.includes('google news · twitter') ||
		source.includes('x cashtags') ||
		homepage.includes('twitter.com') ||
		feedUrl.includes('twitter.com') ||
		tags.includes('twitter.com')
	);
}

function buildContextMatchPreviewFallbackUrls(match = {}) {
	const urls = [];

	for (const candidate of [match?.originalLink, match?.link]) {
		const value = String(candidate || '').trim();
		if (!value || urls.includes(value)) continue;
		if (!/^https?:\/\//i.test(value)) continue;
		urls.push(value);
	}

	return urls;
}

function shouldAttemptContextMatchPreviewFallback(match = {}) {
	if (normalizePreviewImage(match?.previewImage)) return false;
	const candidateUrls = buildContextMatchPreviewFallbackUrls(match);
	if (!candidateUrls.length) return false;

	return candidateUrls.some((url) => isGoogleNewsHostname(url)) || isXLikeContextMatch(match);
}

export async function resolveContextMatchPreviewImage(match = {}, { loader = parseDocument } = {}) {
	if (!shouldAttemptContextMatchPreviewFallback(match)) return null;

	for (const candidateUrl of buildContextMatchPreviewFallbackUrls(match)) {
		const cached = previewImageFallbackCache.get(candidateUrl);
		if (cached && Date.now() - cached.fetchedAt < CONTEXT_PREVIEW_IMAGE_CACHE_MS) {
			if (cached.previewImage?.src && !isGenericPreviewImage(cached.previewImage)) {
				return cached.previewImage;
			}
			continue;
		}

		try {
			const parsed = await loader(candidateUrl);
			const previewImage =
				normalizePreviewImage(parsed?.previewImage) ||
				normalizePreviewImage(parsed?.imageContext?.renderableEntries?.[0]) ||
				normalizePreviewImage(parsed?.imageContext?.entries?.[0]);
			const normalizedPreviewImage = previewImage?.src && !isGenericPreviewImage(previewImage) ? previewImage : null;

			previewImageFallbackCache.set(candidateUrl, {
				fetchedAt: Date.now(),
				previewImage: normalizedPreviewImage,
			});

			if (normalizedPreviewImage) {
				return normalizedPreviewImage;
			}
		} catch (error) {
			previewImageFallbackCache.set(candidateUrl, {
				fetchedAt: Date.now(),
				previewImage: null,
			});
			logger.debug('Context match preview image fallback failed', {
				url: candidateUrl,
				error: error?.message || String(error || ''),
			});
		}
	}

	return null;
}

async function enrichContextMatchesPreviewImages(items = []) {
	const input = Array.isArray(items) ? items : [];
	const enriched = [];

	for (let index = 0; index < input.length; index += CONTEXT_PREVIEW_IMAGE_ENRICH_CONCURRENCY) {
		const batch = input.slice(index, index + CONTEXT_PREVIEW_IMAGE_ENRICH_CONCURRENCY);
		const resolvedBatch = await Promise.all(
			batch.map(async (item) => {
				if (!shouldAttemptContextMatchPreviewFallback(item)) return item;
				const previewImage = await resolveContextMatchPreviewImage(item);
				return previewImage ? { ...item, previewImage } : item;
			}),
		);
		enriched.push(...resolvedBatch);
	}

	return enriched;
}

function buildSourceDomainKey(feedUrl = '') {
	try {
		return new URL(feedUrl).hostname
			.toLowerCase()
			.replace(/^www\./, '')
			.replace(/^feeds\./, '');
	} catch {
		return '';
	}
}

function normalizePreviewImage(value = null) {
	if (!value || typeof value !== 'object') return null;
	const src = unescapeHtml(String(value.src || '').trim());
	if (!src) return null;

	return {
		src,
		alt: summarizeText(value.alt || value.title || value.caption || 'Article image', 160),
		caption: summarizeText(value.caption || value.title || value.alt || '', 220),
		originUrl: unescapeHtml(String(value.originUrl || src).trim()),
	};
}

const GENERIC_PREVIEW_IMAGE_TEXT_RE =
	/\b(?:logo|logomark|icon|favicon|avatar|profile image|brand|branding|header|navigation|nav|menu|footer|breadcrumb|pager|pagination|subscribe|donate|sponsored|advertisement|marketing|homepage|home page|ad|ads|sponsor|sponsored content)\b/i;
const GENERIC_PREVIEW_IMAGE_SRC_RE =
	/(?:^data:|\/logo(?:[\-_./]|$)|\/logos?(?:[\-_./]|$)|\/icon(?:s)?(?:[\-_./]|$)|favicon|apple-touch-icon|\/social\/(?:|[^/]+$)|\/share(?:[\-_./]|$)|\/nav(?:igation)?(?:[\-_./]|$)|\/header(?:[\-_./]|$)|\/footer(?:[\-_./]|$)|bibsonomy|doubleclick|googleadservices|adservice|adnxs|taboola|outbrain|\/ads?(?:[\-_./]|$)|[?&](?:ad|ads|adid|adunit|utm_medium=display)\b)/i;
const GENERIC_PREVIEW_IMAGE_FILENAME_RE = /(?:^|[\s/])[^\s/]+\.(?:jpe?g|png|gif|webp|svg|avif)(?:\?.*)?$/i;

function buildPreviewImageUniqKey(image = {}) {
	const src = String(image?.src || '')
		.trim()
		.toLowerCase();
	if (!src) return '';

	try {
		const url = new URL(src);
		const base = `${url.protocol}//${url.hostname}${url.pathname}`.replace(/\/$/, '');
		return base;
	} catch {
		return src.replace(/[?#].*$/, '');
	}
}

function keepOnlyUniquePreviewImages(items = []) {
	const seenPreviewImages = new Set();

	return (Array.isArray(items) ? items : []).map((item) => {
		const previewImage = normalizePreviewImage(item?.previewImage);
		if (!previewImage?.src) return item;
		if (isGenericPreviewImage(previewImage)) {
			return { ...item, previewImage: null };
		}

		const imageKey = buildPreviewImageUniqKey(previewImage);
		if (!imageKey) {
			return { ...item, previewImage: null };
		}

		if (seenPreviewImages.has(imageKey)) {
			return { ...item, previewImage: null };
		}

		seenPreviewImages.add(imageKey);
		return { ...item, previewImage };
	});
}

function isGenericPreviewImage(image = {}) {
	const src = String(image?.src || '').trim();
	const alt = String(image?.alt || '').trim();
	const title = String(image?.title || '').trim();
	const caption = String(image?.caption || '').trim();
	const metadata = [alt, title, caption].filter(Boolean).join(' ').trim();

	if (!metadata && !src) return true;
	if (metadata && GENERIC_PREVIEW_IMAGE_TEXT_RE.test(metadata)) return true;
	if (GENERIC_PREVIEW_IMAGE_SRC_RE.test(src)) return true;
	if (GENERIC_PREVIEW_IMAGE_FILENAME_RE.test(src) && !alt && !title && !caption) return true;

	return false;
}

function normalizeFeedImageCandidate(candidate = null, baseUrl = '') {
	if (!candidate) return null;

	if (typeof candidate === 'string') {
		const src = String(candidate).trim();
		return src ? normalizePreviewImage({ src: resolveFeedItemUrl(baseUrl, src) || src }) : null;
	}

	if (Array.isArray(candidate)) {
		for (const entry of candidate) {
			const normalized = normalizeFeedImageCandidate(entry, baseUrl);
			if (normalized?.src) return normalized;
		}
		return null;
	}

	if (typeof candidate !== 'object') return null;

	const rawUrl = candidate.url || candidate.href || candidate.link || candidate.src || candidate.content || candidate.$?.url || candidate.$?.href || '';
	const type = String(candidate.type || candidate.medium || candidate.$?.type || '')
		.trim()
		.toLowerCase();
	if (type && !type.startsWith('image/')) return null;

	const src = resolveFeedItemUrl(baseUrl, rawUrl) || String(rawUrl || '').trim();
	if (!src) return null;

	return normalizePreviewImage({
		src,
		alt: candidate.alt || candidate.title || candidate.caption || '',
		caption: candidate.caption || candidate.alt || candidate.title || '',
		originUrl: src,
	});
}

function resolveFeedItemUrl(baseUrl = '', value = '') {
	const rawValue = String(value || '').trim();
	if (!rawValue) return '';

	try {
		return new URL(rawValue, baseUrl || undefined).toString();
	} catch {
		return '';
	}
}

function extractPreviewImageFromHtmlFragment(value = '', baseUrl = '') {
	const html = String(value || '').trim();
	if (!html || !/<(?:img|figure|meta|div|span|p|a)\b/i.test(html)) return null;
	const imageMatch = html.match(/<img\b[^>]*\bsrc=(['"])(.*?)\1[^>]*>/i);
	if (!imageMatch?.[2]) return null;
	const altMatch = imageMatch[0].match(/\balt=(['"])(.*?)\1/i);
	const titleMatch = imageMatch[0].match(/\btitle=(['"])(.*?)\1/i);

	return normalizePreviewImage({
		src: resolveFeedItemUrl(baseUrl, imageMatch[2]) || imageMatch[2],
		alt: altMatch?.[2] || '',
		caption: titleMatch?.[2] || altMatch?.[2] || '',
	});
}

export function extractFeedItemPreviewImage(item = {}, feed = {}) {
	const baseUrl = String(item.link || item.guid || feed.homepage || feed.url || '').trim();
	const candidates = [
		item.previewImage,
		item.image,
		item.enclosure,
		item.enclosures,
		item['media:content'],
		item['media:thumbnail'],
		item['media:group'],
		item['itunes:image'],
		item['podcast:image'],
		item?.custom?.image,
	];

	for (const candidate of candidates) {
		const normalized = normalizeFeedImageCandidate(candidate, baseUrl);
		if (normalized?.src && !isGenericPreviewImage(normalized)) return normalized;
	}

	for (const htmlCandidate of [item.content, item['content:encoded'], item.contentSnippet, item.summary]) {
		const normalized = extractPreviewImageFromHtmlFragment(htmlCandidate, baseUrl);
		if (normalized?.src && !isGenericPreviewImage(normalized)) return normalized;
	}

	return null;
}

function buildSearchEngineHomepageUrl(engine = '', keyword = '') {
	const normalizedEngine = String(engine || '')
		.trim()
		.toLowerCase();
	const query = buildGoogleNewsSearchQuery(keyword);
	if (!query) return '';

	switch (normalizedEngine) {
		case 'google': {
			const url = new URL('https://www.google.com/search');
			url.searchParams.set('q', query);
			url.searchParams.set('num', '10');
			url.searchParams.set('newwindow', '1');
			return url.toString();
		}
		case 'bing': {
			const url = new URL('https://www.bing.com/search');
			url.searchParams.set('q', query);
			url.searchParams.set('setlang', 'en-US');
			return url.toString();
		}
		case 'yahoo': {
			const url = new URL('https://search.yahoo.com/search');
			url.searchParams.set('p', query);
			return url.toString();
		}
		default:
			return '';
	}
}

function isLikelyArticleNewsFeed(feedUrl = '') {
	try {
		const hostname = new URL(feedUrl).hostname.toLowerCase();
		return !/(^|\.)(reddit\.com|youtube\.com|youtu\.be|odysee\.com|news\.google\.com)$/.test(hostname);
	} catch {
		return false;
	}
}

function getPreferredHostRank(feedUrl = '') {
	const hostname = buildSourceDomainKey(feedUrl);
	if (!hostname) return GENERAL_NEWS_PREFERRED_HOSTS.length + 1;

	const index = GENERAL_NEWS_PREFERRED_HOSTS.findIndex((preferredHost) => hostname === preferredHost || hostname.endsWith(`.${preferredHost}`));
	return index === -1 ? GENERAL_NEWS_PREFERRED_HOSTS.length + 1 : index;
}

function sortGeneralNewsSources(left = {}, right = {}) {
	const leftPreferredRank = getPreferredHostRank(left.url);
	const rightPreferredRank = getPreferredHostRank(right.url);
	if (leftPreferredRank !== rightPreferredRank) {
		return leftPreferredRank - rightPreferredRank;
	}

	const leftLanguageRank = /^en/i.test(String(left.language || '')) ? 0 : 1;
	const rightLanguageRank = /^en/i.test(String(right.language || '')) ? 0 : 1;
	if (leftLanguageRank !== rightLanguageRank) {
		return leftLanguageRank - rightLanguageRank;
	}

	const leftFetchPeriod = Number(left.fetch_period) || Number.MAX_SAFE_INTEGER;
	const rightFetchPeriod = Number(right.fetch_period) || Number.MAX_SAFE_INTEGER;
	if (leftFetchPeriod !== rightFetchPeriod) {
		return leftFetchPeriod - rightFetchPeriod;
	}

	return String(left.title || '').localeCompare(String(right.title || ''));
}

export function selectGeneralNewsSources(input = []) {
	const candidates = (Array.isArray(input) ? input : [])
		.filter((entry) => entry?.enabled)
		.filter((entry) => normalizeCategoryName(entry?.category_name) === 'news')
		.filter((entry) => ['BaseRssPlugin', 'BaseParsePlugin'].includes(String(entry?.source_type || '')))
		.filter((entry) => typeof entry?.url === 'string' && entry.url.trim())
		.filter((entry) => isLikelyArticleNewsFeed(entry.url))
		.sort(sortGeneralNewsSources);

	const selected = [];
	const seenDomains = new Set();

	for (const entry of candidates) {
		const domainKey = buildSourceDomainKey(entry.url);
		if (!domainKey || seenDomains.has(domainKey)) continue;

		seenDomains.add(domainKey);
		selected.push({
			source: entry.title || domainKey,
			homepage: buildSourceHomepage(entry.url),
			url: entry.url,
			language: entry.language || '',
			category: entry.category_name || 'News',
			subcategory: entry.subcategory_name || 'News',
		});

		if (selected.length >= GENERAL_NEWS_SOURCE_LIMIT) break;
	}

	return selected;
}

export function getBuiltinGeneralNewsSources() {
	return BUILTIN_GENERAL_NEWS_FEEDS.map((feed) => ({ ...feed }));
}

async function loadGeneralNewsSourceCatalog({ force = false } = {}) {
	const now = Date.now();
	if (!force && state.generalNewsSourceCatalog.length && now - state.generalNewsSourceCatalogFetchedAt < GENERAL_NEWS_SOURCE_CACHE_MS) {
		return state.generalNewsSourceCatalog;
	}

	const response = await fetch(GENERAL_NEWS_SOURCES_URL, {
		headers: {
			'User-Agent': 'query-notify-general-news/1.0',
			'Accept': 'application/json,text/plain,*/*',
		},
	});

	if (!response.ok) {
		throw new Error(`General news source catalog request failed with status ${response.status}`);
	}

	const parsed = await response.json();
	state.generalNewsSourceCatalog = Array.isArray(parsed) ? parsed : [];
	state.generalNewsSourceCatalogFetchedAt = now;
	return state.generalNewsSourceCatalog;
}

function hydrateGeneralNewsItem(feed = {}, item = {}) {
	const publishedAt = parsePublishedAt(item);
	const sourceKey = buildSourceDomainKey(feed.url) || normalizeKeyword(feed.source || feed.title || '') || 'news-source';
	return {
		id: `general:${sourceKey}:${buildMatchId(feed, item)}`,
		context: 'news',
		type: 'general-news',
		source: feed.source || feed.title || 'News source',
		homepage: feed.homepage || '',
		feedUrl: feed.url || '',
		title: normalizeFeedText(item.title || 'Untitled story'),
		summary: normalizeFeedText(item.contentSnippet || item.content || item.summary || item.title || ''),
		link: item.link || item.guid || '',
		previewImage: extractFeedItemPreviewImage(item, feed),
		publishedAt,
		discoveredAt: publishedAt || new Date().toISOString(),
		tags: [feed.category, feed.subcategory].filter(Boolean),
	};
}

function buildGeneralNewsDedupeKey(item = {}) {
	const link = String(item.link || '')
		.trim()
		.toLowerCase();
	if (link) return `link:${link}`;

	const id = String(item.id || '')
		.trim()
		.toLowerCase();
	if (id) return `id:${id}`;

	const source = normalizeKeyword(item.source || '');
	const title = normalizeKeyword(item.title || '');
	const publishedAt = String(item.publishedAt || item.discoveredAt || '').trim();
	return `fallback:${source}:${title}:${publishedAt}`;
}

function dedupeGeneralNewsItems(items = []) {
	const dedupedItems = [];
	const seenKeys = new Set();

	for (const item of Array.isArray(items) ? items : []) {
		const dedupeKey = buildGeneralNewsDedupeKey(item);
		if (!dedupeKey || seenKeys.has(dedupeKey)) continue;

		seenKeys.add(dedupeKey);
		dedupedItems.push(item);
	}

	return dedupedItems;
}

function isGeneralNewsItemWithinLookback(item = {}) {
	const rawTimestamp = item.publishedAt || item.discoveredAt || '';
	if (!rawTimestamp) return true;

	const timestamp = Date.parse(rawTimestamp);
	if (Number.isNaN(timestamp)) return true;

	return Date.now() - timestamp <= GENERAL_NEWS_LOOKBACK_MS;
}

function normalizeGeneralNewsTimeline(items = []) {
	return keepOnlyUniquePreviewImages(
		sortContextMatchesNewestFirst(dedupeGeneralNewsItems(items).filter((item) => isGeneralNewsItemWithinLookback(item))).slice(0, GENERAL_NEWS_ITEM_LIMIT),
	);
}

function relativeTimeToIsoDate(amount = 0, unit = '') {
	const normalizedAmount = Number(amount);
	if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) return '';

	const normalizedUnit = String(unit || '')
		.trim()
		.toLowerCase();
	const millisPerUnit = {
		minute: 60 * 1000,
		minutes: 60 * 1000,
		min: 60 * 1000,
		hour: 60 * 60 * 1000,
		hours: 60 * 60 * 1000,
		day: 24 * 60 * 60 * 1000,
		days: 24 * 60 * 60 * 1000,
		week: 7 * 24 * 60 * 60 * 1000,
		weeks: 7 * 24 * 60 * 60 * 1000,
		month: 30 * 24 * 60 * 60 * 1000,
		months: 30 * 24 * 60 * 60 * 1000,
		year: 365 * 24 * 60 * 60 * 1000,
		years: 365 * 24 * 60 * 60 * 1000,
	};
	const millis = millisPerUnit[normalizedUnit];
	if (!millis) return '';

	return new Date(Date.now() - normalizedAmount * millis).toISOString();
}

function parsePublishedAtFromText(value = '') {
	const normalizedValue = String(value || '')
		.replace(/\u00b7/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!normalizedValue) return '';

	const relativeMatch = normalizedValue.match(/\b(\d{1,3})\s+(minute|minutes|min|hour|hours|day|days|week|weeks|month|months|year|years)\s+ago\b/i);
	if (relativeMatch) {
		return relativeTimeToIsoDate(relativeMatch[1], relativeMatch[2]);
	}

	if (/\byesterday\b/i.test(normalizedValue)) {
		return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	}

	const datePatterns = [
		/\b(?:Jan|January|Feb|February|Mar|March|Apr|April|May|Jun|June|Jul|July|Aug|August|Sep|Sept|September|Oct|October|Nov|November|Dec|December)\s+\d{1,2},\s+\d{4}(?:,?\s+\d{1,2}:\d{2}(?:\s*[AP]M)?)?\b/i,
		/\b\d{1,2}\s+(?:Jan|January|Feb|February|Mar|March|Apr|April|May|Jun|June|Jul|July|Aug|August|Sep|Sept|September|Oct|October|Nov|November|Dec|December)\s+\d{4}(?:\s+\d{1,2}:\d{2}(?:\s*[AP]M)?)?\b/i,
		/\b\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d{3})?(?:Z|[+-]\d{2}:?\d{2})?)?\b/i,
		/\b\d{4}\/\d{2}\/\d{2}\b/i,
	];

	for (const pattern of datePatterns) {
		const match = normalizedValue.match(pattern);
		if (!match?.[0]) continue;

		const timestamp = Date.parse(match[0]);
		if (!Number.isNaN(timestamp)) {
			return new Date(timestamp).toISOString();
		}
	}

	return '';
}

function collectDateCandidates(value, key = '', results = []) {
	if (value == null) return results;

	if (typeof value === 'string') {
		if (/(date|time|published|updated|modified|created|upload|lastmod)/i.test(key) || parsePublishedAtFromText(value)) {
			results.push(value);
		}
		return results;
	}

	if (typeof value === 'number') {
		if (/(date|time|published|updated|modified|created|upload|lastmod)/i.test(key)) {
			results.push(String(value));
		}
		return results;
	}

	if (Array.isArray(value)) {
		for (const entry of value) {
			collectDateCandidates(entry, key, results);
		}
		return results;
	}

	if (typeof value === 'object') {
		for (const [childKey, childValue] of Object.entries(value)) {
			collectDateCandidates(childValue, childKey, results);
		}
	}

	return results;
}

export function extractPublishedAtFromSearchResult(result = {}) {
	const directXStatusDate = xStatusIdToIsoDate(extractXStatusIdFromUrl(result.url || result.link || ''));
	if (directXStatusDate) return directXStatusDate;

	const directCandidates = [
		result.publishedAt,
		result.published,
		result.updatedAt,
		result.datePublished,
		result.dateCreated,
		result.uploadDate,
		result.snippet,
		result.summary,
		result.contentPreview,
		result.content,
	];
	const dataLayerCandidates = collectDateCandidates(result.dataLayer?.entries || []);
	const candidates = [...directCandidates, ...dataLayerCandidates].filter(Boolean);

	for (const candidate of candidates) {
		const directDate = parsePublishedAt({
			isoDate: candidate,
			pubDate: candidate,
			published: candidate,
			updated: candidate,
			datePublished: candidate,
			dateCreated: candidate,
			uploadDate: candidate,
		});
		if (directDate) return directDate;

		const parsedTextDate = parsePublishedAtFromText(candidate);
		if (parsedTextDate) return parsedTextDate;
	}

	return '';
}

export function normalizeSearchEngineResultItem(feed = {}, result = {}) {
	const publishedAt = extractPublishedAtFromSearchResult(result);
	const snippet = normalizeFeedText(result.snippet || result.contentPreview || result.content || '');
	const organizations = normalizeStringList(result.organizations);
	const entities = normalizeStringList(result.entities);
	const previewImage =
		normalizePreviewImage(result.previewImage) || normalizePreviewImage(result.imageContext?.renderableEntries?.[0]) || normalizePreviewImage(result.imageContext?.entries?.[0]);

	return {
		id: `${feed.engine || 'search'}:${result.url || result.title || ''}`,
		guid: result.url || result.title || '',
		link: result.url || '',
		title: normalizeFeedText(result.title || 'Untitled result'),
		summary: snippet,
		contentSnippet: snippet,
		content: normalizeFeedText(result.contentPreview || result.content || result.snippet || ''),
		isoDate: publishedAt,
		published: publishedAt,
		updated: publishedAt,
		categories: [...new Set([...organizations, ...entities])].slice(0, 6),
		previewImage,
	};
}

function buildActuallyRelevantStoryId(story = {}) {
	const slug = String(story.slug || '').trim();
	const id = String(story.id || '').trim();
	return slug || id;
}

function normalizeActuallyRelevantIssueSlug(value = '') {
	return String(value || '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-');
}

export function buildActuallyRelevantFeedUrl(issueSlug = '') {
	const normalizedIssueSlug = normalizeActuallyRelevantIssueSlug(issueSlug);
	const url = new URL(normalizedIssueSlug ? `/api/feed/${encodeURIComponent(normalizedIssueSlug)}` : '/api/feed', ACTUALLY_RELEVANT_API_BASE_URL);
	return url.toString();
}

function buildActuallyRelevantStoriesUrl(limit = GENERAL_NEWS_ITEM_LIMIT) {
	const url = new URL(ACTUALLY_RELEVANT_STORIES_URL);
	url.searchParams.set('page', '1');
	url.searchParams.set('pageSize', String(Math.max(1, Math.min(100, Number(limit) || GENERAL_NEWS_ITEM_LIMIT))));
	return url.toString();
}

function buildActuallyRelevantHomepage(issueSlug = '') {
	const normalizedIssueSlug = normalizeActuallyRelevantIssueSlug(issueSlug);
	return normalizedIssueSlug ? `https://actuallyrelevant.news/issues/${normalizedIssueSlug}` : 'https://actuallyrelevant.news/';
}

export function normalizeActuallyRelevantStory(story = {}) {
	const storyKey = buildActuallyRelevantStoryId(story);
	const sourceLink = String(story.sourceUrl || '').trim();
	const title = String(story.title || '').trim();
	if (!storyKey || !sourceLink || !title) {
		return null;
	}

	const issueSlug = normalizeActuallyRelevantIssueSlug(story.issue?.slug || '');
	const issueName = String(story.issue?.name || '').trim();
	const publishedAt = parsePublishedAt({
		isoDate: story.datePublished || story.dateCrawled || '',
	});
	const sourceName = String(story.sourceTitle || '').trim() || 'Actually Relevant';
	const feedTitle = String(story.feed?.displayTitle || story.feed?.title || '').trim();
	const summary = summarizeText(story.summary || story.marketingBlurb || story.quote || title, 260);
	const tags = [
		'news',
		'actually-relevant',
		issueSlug,
		normalizeKeyword(issueName),
		normalizeKeyword(story.emotionTag || ''),
		normalizeKeyword(story.feed?.issue?.slug || ''),
	].filter(Boolean);

	return {
		id: `general:actually-relevant:${storyKey}`,
		context: 'news',
		type: 'general-news',
		source: issueName ? `Actually Relevant · ${issueName}` : 'Actually Relevant',
		homepage: buildActuallyRelevantHomepage(issueSlug),
		feedUrl: buildActuallyRelevantFeedUrl(issueSlug),
		title: normalizeFeedText(title),
		summary: normalizeFeedText([summary, feedTitle ? `Feed: ${feedTitle}` : '', sourceName ? `Source: ${sourceName}` : ''].filter(Boolean).join(' • ')),
		link: sourceLink,
		publishedAt,
		discoveredAt: publishedAt || new Date().toISOString(),
		tags: [...new Set(tags)].slice(0, 6),
	};
}

async function fetchActuallyRelevantStories(limit = GENERAL_NEWS_ITEM_LIMIT) {
	const response = await fetch(buildActuallyRelevantStoriesUrl(limit), {
		headers: {
			'User-Agent': 'query-notify-general-news/1.0',
			'Accept': 'application/json,text/plain,*/*',
		},
	});

	if (!response.ok) {
		throw new Error(`Actually Relevant stories request failed with status ${response.status}`);
	}

	const parsed = await response.json();
	const stories = Array.isArray(parsed?.data) ? parsed.data : [];
	return stories.map((story) => normalizeActuallyRelevantStory(story)).filter(Boolean);
}

function buildHackerNewsItemApiUrl(id) {
	const normalizedId = Number(id);
	if (!Number.isFinite(normalizedId) || normalizedId <= 0) return '';
	return HACKER_NEWS_ITEM_URL_TEMPLATE.replace('{id}', String(normalizedId));
}

function buildHackerNewsStoryFallbackUrl(id) {
	const normalizedId = Number(id);
	if (!Number.isFinite(normalizedId) || normalizedId <= 0) return 'https://news.ycombinator.com/';
	return `https://news.ycombinator.com/item?id=${normalizedId}`;
}

export function normalizeHackerNewsStoryItem(item = {}) {
	const storyId = Number(item.id);
	if (!Number.isFinite(storyId) || storyId <= 0 || String(item.type || 'story').toLowerCase() !== 'story' || !item.title) {
		return null;
	}

	const publishedAt = Number.isFinite(Number(item.time)) ? new Date(Number(item.time) * 1000).toISOString() : '';
	const summaryParts = [
		item.by ? `by ${item.by}` : '',
		Number.isFinite(Number(item.score)) ? `${Number(item.score)} points` : '',
		Number.isFinite(Number(item.descendants)) ? `${Number(item.descendants)} comments` : '',
	].filter(Boolean);

	return {
		id: `general:hacker-news:${storyId}`,
		context: 'news',
		type: 'general-news',
		source: 'Hacker News',
		homepage: 'https://news.ycombinator.com/',
		feedUrl: HACKER_NEWS_TOP_STORIES_URL,
		title: normalizeFeedText(item.title || 'Untitled story'),
		summary: normalizeFeedText(item.text || summaryParts.join(' • ')),
		link: String(item.url || '').trim() || buildHackerNewsStoryFallbackUrl(storyId),
		publishedAt,
		discoveredAt: publishedAt || new Date().toISOString(),
		tags: ['technology', 'hacker-news'],
	};
}

async function fetchHackerNewsTopStoryIds() {
	const response = await fetch(HACKER_NEWS_TOP_STORIES_URL, {
		headers: {
			'User-Agent': 'query-notify-general-news/1.0',
			'Accept': 'application/json,text/plain,*/*',
		},
	});

	if (!response.ok) {
		throw new Error(`Hacker News top stories request failed with status ${response.status}`);
	}

	const parsed = await response.json();
	return Array.isArray(parsed) ? parsed : [];
}

async function fetchHackerNewsStories() {
	const ids = (await fetchHackerNewsTopStoryIds())
		.map((value) => Number(value))
		.filter((value) => Number.isFinite(value) && value > 0)
		.slice(0, GENERAL_NEWS_ITEM_LIMIT);

	const stories = await Promise.all(
		ids.map(async (id) => {
			const response = await fetch(buildHackerNewsItemApiUrl(id), {
				headers: {
					'User-Agent': 'query-notify-general-news/1.0',
					'Accept': 'application/json,text/plain,*/*',
				},
			});

			if (!response.ok) {
				throw new Error(`Hacker News item ${id} request failed with status ${response.status}`);
			}

			return response.json();
		}),
	);

	return stories.map((item) => normalizeHackerNewsStoryItem(item)).filter(Boolean);
}

async function buildGeneralNewsItems(feeds = []) {
	const items = [];

	for (const feed of feeds) {
		try {
			const sourceItems = await fetchContextSourceItems(feed, { limit: GENERAL_NEWS_ITEMS_PER_SOURCE });

			// Record success
			const health = state.feedHealth[feed.url] || { successCount: 0, errorCount: 0 };
			state.feedHealth[feed.url] = {
				...health,
				lastSuccessAt: new Date().toISOString(),
				lastError: '',
				successCount: health.successCount + 1,
				itemCount: sourceItems.length,
			};

			for (const item of sourceItems) {
				const hydratedItem = hydrateGeneralNewsItem(feed, item);
				if (isFuturePublishedAt(hydratedItem?.publishedAt)) continue;
				items.push(hydratedItem);
			}
		} catch (error) {
			// Record error
			const health = state.feedHealth[feed.url] || { successCount: 0, errorCount: 0 };
			state.feedHealth[feed.url] = {
				...health,
				lastError: error.message,
				lastErrorAt: new Date().toISOString(),
				errorCount: health.errorCount + 1,
			};

			logger.debug('General news feed parse failed', {
				feed: feed.source || feed.url,
				url: feed.url,
				error: error.message,
			});
		}
	}

	return normalizeGeneralNewsTimeline(items);
}

async function refreshGeneralNewsFeed({ force = false } = {}) {
	if (state.generalNewsPromise && !force) {
		return state.generalNewsPromise;
	}

	state.generalNewsPromise = (async () => {
		try {
			let selectedFeeds = getBuiltinGeneralNewsSources();
			try {
				selectedFeeds = dedupeContextFeeds([...selectedFeeds, ...selectGeneralNewsSources(await loadGeneralNewsSourceCatalog({ force }))]);
			} catch (catalogError) {
				logger.debug('General news source catalog refresh failed', { error: catalogError.message });
			}

			const [rssCatalogItems, hackerNewsItems, actuallyRelevantItems] = await Promise.allSettled([
				buildGeneralNewsItems(selectedFeeds),
				fetchHackerNewsStories(),
				fetchActuallyRelevantStories(),
			]);
			const items = normalizeGeneralNewsTimeline([
				...(rssCatalogItems.status === 'fulfilled' ? rssCatalogItems.value : []),
				...(hackerNewsItems.status === 'fulfilled' ? hackerNewsItems.value : []),
				...(actuallyRelevantItems.status === 'fulfilled' ? actuallyRelevantItems.value : []),
			]);

			if (rssCatalogItems.status === 'rejected') {
				logger.debug('Catalog-backed RSS general feed refresh failed', { error: rssCatalogItems.reason?.message || String(rssCatalogItems.reason || '') });
			}

			if (hackerNewsItems.status === 'rejected') {
				logger.debug('Hacker News general feed refresh failed', { error: hackerNewsItems.reason?.message || String(hackerNewsItems.reason || '') });
			}

			if (actuallyRelevantItems.status === 'rejected') {
				logger.debug('Actually Relevant general feed refresh failed', {
					error: actuallyRelevantItems.reason?.message || String(actuallyRelevantItems.reason || ''),
				});
			}

			state.generalNews = items;
			state.generalNewsLastUpdatedAt = new Date().toISOString();
			state.generalNewsLastError = '';
			return items;
		} catch (error) {
			state.generalNewsLastError = error.message;
			logger.error('General news refresh failed', { error: error.message });
			return state.generalNews;
		}
	})();

	try {
		return await state.generalNewsPromise;
	} finally {
		state.generalNewsPromise = null;
	}
}

function buildGoogleNewsSearchQueryFromSimpleMatcher(matcher = null) {
	if (!matcher?.keyword) return '';

	if (!matcher.isAsset) {
		return matcher.keyword;
	}

	const alias = matcher.aliases.find((entry) => entry && entry !== matcher.symbol && entry !== `$${matcher.symbol}`) || matcher.symbol;
	const terms = [alias, matcher.symbol.toUpperCase(), 'stock'].filter(Boolean);
	return [...new Set(terms)].join(' ');
}

function buildGoogleNewsXQueryFromSimpleMatcher(matcher = null) {
	if (!matcher?.keyword) return '';

	if (!matcher.isAsset) {
		return buildGoogleNewsSearchQueryFromSimpleMatcher(matcher);
	}

	const symbol = String(matcher.symbol || '')
		.trim()
		.toUpperCase();
	const cashtag = symbol ? `$${symbol}` : '';
	const alias = matcher.aliases.find((entry) => entry && entry !== matcher.symbol && entry !== `$${matcher.symbol}`) || matcher.symbol;
	const terms = [cashtag, symbol, alias].map((entry) => String(entry || '').trim()).filter(Boolean);

	return [...new Set(terms)].join(' OR ');
}

function buildRedditSearchQueryFromSimpleMatcher(matcher = null) {
	if (!matcher?.keyword) return '';

	if (!matcher.isAsset) {
		return matcher.keyword;
	}

	const aliasTerms = [...new Set([matcher.symbol, ...(matcher.aliases || [])])]
		.map((entry) => normalizeKeyword(entry))
		.filter((entry) => entry && entry !== `$${matcher.symbol}`)
		.map((entry) => (/\s/.test(entry) ? `"${entry}"` : entry));

	if (!aliasTerms.length) {
		return matcher.symbol;
	}

	if (aliasTerms.length === 1) {
		return aliasTerms[0];
	}

	return `(${aliasTerms.join(' OR ')})`;
}

function buildGoogleNewsSearchQuery(keyword = '') {
	const matcher = buildKeywordMatcher(keyword);
	if (!matcher?.keyword) return '';
	if (matcher.isAdvanced) {
		return String(keyword || '')
			.trim()
			.replace(/\|/g, ' OR ')
			.replace(/\s+/g, ' ')
			.replace(/\bAND\b/gi, 'AND')
			.replace(/\bOR\b/gi, 'OR');
	}

	if (matcher.isExpression && Array.isArray(matcher.groups)) {
		return matcher.groups
			.map((group) =>
				group
					.map((term) => buildGoogleNewsSearchQueryFromSimpleMatcher(term))
					.filter(Boolean)
					.join(' AND '),
			)
			.filter(Boolean)
			.join(' OR ');
	}

	return buildGoogleNewsSearchQueryFromSimpleMatcher(matcher);
}

function buildGoogleNewsXSearchQuery(keyword = '') {
	const matcher = buildKeywordMatcher(keyword);
	if (!matcher?.keyword) return '';
	if (matcher.isAdvanced) {
		return String(keyword || '')
			.trim()
			.replace(/\|/g, ' OR ')
			.replace(/\s+/g, ' ')
			.replace(/\bAND\b/gi, 'AND')
			.replace(/\bOR\b/gi, 'OR');
	}

	if (matcher.isExpression && Array.isArray(matcher.groups)) {
		return matcher.groups
			.map((group) =>
				group
					.map((term) => buildGoogleNewsXQueryFromSimpleMatcher(term))
					.filter(Boolean)
					.join(' AND '),
			)
			.filter(Boolean)
			.join(' OR ');
	}

	return buildGoogleNewsXQueryFromSimpleMatcher(matcher);
}

function buildRedditSearchQuery(keyword = '') {
	const matcher = buildKeywordMatcher(keyword);
	if (!matcher?.keyword) return '';
	if (matcher.isAdvanced) {
		return String(keyword || '')
			.trim()
			.replace(/\|/g, ' OR ')
			.replace(/\b(?:site|source|intitle|allintitle|inurl|allinurl|intext|allintext|filetype|ext):/gi, '')
			.replace(/\b(?:before|after|define|cache|related|weather|stocks|map|movie):[^\s)]+/gi, '')
			.replace(/\s+/g, ' ')
			.replace(/\bAND\b/gi, 'AND')
			.replace(/\bOR\b/gi, 'OR')
			.trim();
	}

	if (matcher.isExpression && Array.isArray(matcher.groups)) {
		return matcher.groups
			.map((group) =>
				group
					.map((term) => buildRedditSearchQueryFromSimpleMatcher(term))
					.filter(Boolean)
					.join(' AND '),
			)
			.filter(Boolean)
			.join(' OR ');
	}

	return buildRedditSearchQueryFromSimpleMatcher(matcher);
}

function stringifyAdvancedNodeForFeedSearch(node = null) {
	if (!node) return '';

	switch (node.type) {
		case 'AND': {
			const left = stringifyAdvancedNodeForFeedSearch(node.left);
			const right = stringifyAdvancedNodeForFeedSearch(node.right);
			return [left, right].filter(Boolean).join(' ').trim();
		}
		case 'OR': {
			const left = stringifyAdvancedNodeForFeedSearch(node.left);
			const right = stringifyAdvancedNodeForFeedSearch(node.right);
			return [left, right].filter(Boolean).join(' OR ').trim();
		}
		case 'NOT': {
			const value = stringifyAdvancedNodeForFeedSearch(node.expression);
			if (!value) return '';
			return /\s/.test(value) && !/^\(.+\)$/.test(value) ? `-(${value})` : `-${value}`;
		}
		case 'FIELD':
			return `${String(node.operator || '').trim()}:${String(node.value || '').trim()}`.trim();
		case 'PHRASE': {
			const value = String(node.raw || node.value || '')
				.trim()
				.replace(/^"|"$/g, '');
			return value ? `"${value}"` : '';
		}
		case 'WILDCARD':
			return String(node.raw || '').trim();
		case 'ANY':
			return '*';
		case 'SIMPLE':
		default:
			return String(node.matcher?.keyword || node.raw || '').trim();
	}
}

function expandAdvancedNodeToFeedSearchTerms(node = null) {
	if (!node) return [];

	switch (node.type) {
		case 'OR':
			return [...expandAdvancedNodeToFeedSearchTerms(node.left), ...expandAdvancedNodeToFeedSearchTerms(node.right)];
		case 'AND': {
			const leftBranches = expandAdvancedNodeToFeedSearchTerms(node.left);
			const rightBranches = expandAdvancedNodeToFeedSearchTerms(node.right);
			if (!leftBranches.length) return rightBranches;
			if (!rightBranches.length) return leftBranches;

			return leftBranches.flatMap((leftBranch) => rightBranches.map((rightBranch) => [...leftBranch, ...rightBranch].filter(Boolean)));
		}
		default: {
			const term = stringifyAdvancedNodeForFeedSearch(node);
			return term ? [[term]] : [];
		}
	}
}

export function buildFeedSearchKeywords(keyword = '') {
	const matcher = buildKeywordMatcher(keyword);
	if (!matcher?.keyword) return [];

	if (matcher.isAdvanced && matcher.ast) {
		return [
			...new Set(
				expandAdvancedNodeToFeedSearchTerms(matcher.ast)
					.map((branch) => branch.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim())
					.filter(Boolean),
			),
		];
	}

	if (matcher.isExpression && Array.isArray(matcher.groups)) {
		return [
			...new Set(
				matcher.groups
					.map((group) =>
						group
							.map((term) => term.keyword)
							.filter(Boolean)
							.join(' ')
							.replace(/\s+/g, ' ')
							.trim(),
					)
					.filter(Boolean),
			),
		];
	}

	return [matcher.keyword];
}

function normalizeGoogleSiteRestriction(site = '') {
	return String(site || '')
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, '')
		.replace(/^www\./, '')
		.split(/[/?#]/)[0]
		.trim();
}

function buildGoogleNewsScopedQuery(keyword = '', { site = '' } = {}) {
	const normalizedSite = normalizeGoogleSiteRestriction(site);
	const query = normalizedSite === 'twitter.com' ? buildGoogleNewsXSearchQuery(keyword) : buildGoogleNewsSearchQuery(keyword);
	if (!query) return '';

	const scopedQuery = normalizedSite && /\bOR\b/.test(query) ? `(${query})` : query;
	return [scopedQuery, normalizedSite ? `site:${normalizedSite}` : ''].filter(Boolean).join(' ');
}

export function buildGoogleNewsFeedUrl(keyword = '', options = {}) {
	const query = buildGoogleNewsScopedQuery(keyword, options);
	if (!query) return '';

	const url = new URL('https://news.google.com/rss/search');
	url.searchParams.set('q', query);
	url.searchParams.set('hl', 'en-US');
	url.searchParams.set('gl', 'US');
	url.searchParams.set('ceid', 'US:en');
	return url.toString();
}

export function buildGoogleNewsXFeedUrl(keyword = '') {
	return buildGoogleNewsFeedUrl(keyword, { site: 'twitter.com' });
}

export function buildGoogleNewsQuoraFeedUrl(keyword = '') {
	return buildGoogleNewsFeedUrl(keyword, { site: 'quora.com' });
}

export function buildGoogleSearchHomepageUrl(keyword = '', options = {}) {
	const query = buildGoogleNewsScopedQuery(keyword, options);
	if (!query) return '';

	const url = new URL('https://www.google.com/search');
	url.searchParams.set('q', query);
	url.searchParams.set('num', '10');
	url.searchParams.set('newwindow', '1');
	return url.toString();
}

export function buildGoogleNewsSearchHomepageUrl(keyword = '', options = {}) {
	const query = buildGoogleNewsScopedQuery(keyword, options);
	if (!query) return '';

	const url = new URL('https://www.google.com/search');
	url.searchParams.set('q', query);
	url.searchParams.set('num', '10');
	url.searchParams.set('newwindow', '1');
	url.searchParams.set('tbm', 'nws');
	url.searchParams.set('tbs', 'sbd:1');
	return url.toString();
}

export function buildGoogleNewsTopicFeedUrl(topicId = '') {
	const normalizedTopicId = String(topicId || '').trim();
	if (!normalizedTopicId) return '';

	const url = new URL(`https://news.google.com/rss/topics/${encodeURIComponent(normalizedTopicId)}`);
	url.searchParams.set('hl', 'en-US');
	url.searchParams.set('gl', 'US');
	url.searchParams.set('ceid', 'US:en');
	return url.toString();
}

export function buildRedditFeedUrl(keyword = '') {
	const query = buildRedditSearchQuery(keyword);
	if (!query) return '';

	const url = new URL('https://www.reddit.com/search.rss');
	url.searchParams.set('q', query);
	url.searchParams.set('sort', 'new');
	return url.toString();
}

export function buildRedditSubredditFeedUrl(subreddit = '', keyword = '') {
	const normalizedSubreddit = String(subreddit || '')
		.trim()
		.replace(/^r\//i, '')
		.replace(/^\//, '');
	const query = buildRedditSearchQuery(keyword);
	if (!normalizedSubreddit || !query) return '';

	const url = new URL(`https://www.reddit.com/r/${normalizedSubreddit}/search.rss`);
	url.searchParams.set('q', query);
	url.searchParams.set('sort', 'new');
	url.searchParams.set('restrict_sr', '1');
	return url.toString();
}

export function buildRedditWallStreetBetsFeedUrl(keyword = '') {
	return buildRedditSubredditFeedUrl('wallstreetbets', keyword);
}

function buildRedditSubredditFeed(keyword = '', context = 'news', subredditConfig = {}) {
	const normalizedKeyword = normalizeKeyword(keyword);
	const normalizedContext = normalizeKeyword(context) || 'news';
	const subreddit = String(subredditConfig.subreddit || '').trim();
	const source = String(subredditConfig.source || '').trim() || `Reddit · r/${subreddit}`;
	const feedUrl = buildRedditSubredditFeedUrl(subreddit, normalizedKeyword);
	if (!normalizedKeyword || !feedUrl || !subreddit) return null;

	const homepage = new URL(`https://www.reddit.com/r/${subreddit}/search`);
	homepage.searchParams.set('q', buildRedditSearchQuery(normalizedKeyword));
	homepage.searchParams.set('sort', 'new');
	homepage.searchParams.set('restrict_sr', '1');

	return {
		context: normalizedContext,
		source,
		homepage: homepage.toString(),
		url: feedUrl,
		tags: [normalizedContext, 'reddit', subreddit, normalizedKeyword],
		keyword: normalizedKeyword,
	};
}

function buildFinanceRedditFeeds(keyword = '', context = 'news') {
	return FINANCE_REDDIT_SUBREDDITS.map((subredditConfig) => buildRedditSubredditFeed(keyword, context, subredditConfig)).filter(Boolean);
}

function buildTopicalRedditFeeds(keyword = '', context = 'news') {
	return GENERAL_REDDIT_SUBREDDITS.map((subredditConfig) => buildRedditSubredditFeed(keyword, context, subredditConfig)).filter(Boolean);
}

export function buildInvestingStockNewsFeeds(context = 'news') {
	const normalizedContext = normalizeFeedContext(context);

	return INVESTING_STOCK_NEWS_FEEDS.map((feed) => ({
		context: normalizedContext,
		source: feed.source,
		homepage: feed.homepage,
		url: feed.url,
		tags: [normalizedContext, ...feed.tags.filter(Boolean)],
	}));
}

function buildStandardRedditFeed(keyword = '', context = 'news') {
	const query = buildRedditSearchQuery(keyword);
	const normalizedKeyword = normalizeKeyword(keyword);
	const normalizedContext = normalizeKeyword(context) || 'news';
	const feedUrl = buildRedditFeedUrl(normalizedKeyword);
	if (!query || !normalizedKeyword || !feedUrl) return null;

	const homepage = new URL('https://www.reddit.com/search');
	homepage.searchParams.set('q', query);
	homepage.searchParams.set('sort', 'new');

	return {
		context: normalizedContext,
		source: 'Reddit',
		homepage: homepage.toString(),
		url: feedUrl,
		tags: [normalizedContext, 'reddit', normalizedKeyword],
		keyword: normalizedKeyword,
	};
}

function buildGoogleNewsFeed(keyword = '') {
	const normalizedKeyword = normalizeKeyword(keyword);
	const feedUrl = buildGoogleNewsFeedUrl(normalizedKeyword);
	if (!normalizedKeyword || !feedUrl) return null;

	return {
		context: 'news',
		source: 'Google News',
		homepage: buildGoogleNewsSearchHomepageUrl(normalizedKeyword),
		url: feedUrl,
		tags: ['news', 'google-news', normalizedKeyword],
		keyword: normalizedKeyword,
	};
}

export function buildXSearchFeed(keyword = '', context = 'research') {
	const normalizedKeyword = normalizeKeyword(keyword);
	const normalizedContext = normalizeFeedContext(context);
	const homepage = applyTagToUrlTemplate('https://twitter.com/search?q={tag}&f=live', normalizedKeyword);
	const feedUrl = transformPlatformUrlToFeedUrl(homepage);
	if (!normalizedKeyword || !homepage || !feedUrl) return null;

	return {
		context: normalizedContext,
		source: 'Twitter Search',
		homepage,
		url: feedUrl,
		urlTemplate: 'https://twitter.com/search?q={tag}&f=live',
		parentUrl: 'https://twitter.com/search?q={tag}&f=live',
		templateTag: normalizedKeyword,
		tags: [normalizedContext, 'twitter.com', 'live-search', normalizedKeyword],
		keyword: normalizedKeyword,
	};
}

function buildGoogleNewsXFeed(keyword = '', context = 'research') {
	const normalizedKeyword = normalizeKeyword(keyword);
	const feedUrl = buildGoogleNewsXFeedUrl(normalizedKeyword);
	if (!normalizedKeyword || !feedUrl) return null;

	return {
		context: normalizeFeedContext(context),
		source: 'Google News · Twitter',
		homepage: buildGoogleNewsSearchHomepageUrl(normalizedKeyword, { site: 'twitter.com' }),
		url: feedUrl,
		tags: [normalizeFeedContext(context), 'google-news', 'twitter.com', normalizedKeyword],
		keyword: normalizedKeyword,
	};
}

function buildGoogleNewsQuoraFeed(keyword = '') {
	const normalizedKeyword = normalizeKeyword(keyword);
	const feedUrl = buildGoogleNewsQuoraFeedUrl(normalizedKeyword);
	if (!normalizedKeyword || !feedUrl) return null;

	return {
		context: 'news',
		source: 'Google News · Quora',
		homepage: buildGoogleNewsSearchHomepageUrl(normalizedKeyword, { site: 'quora.com' }),
		url: feedUrl,
		tags: ['news', 'google-news', 'quora.com', normalizedKeyword],
		keyword: normalizedKeyword,
	};
}

export function buildGoogleXStockSearchKeyword(keyword = '') {
	const matcher = buildKeywordMatcher(keyword);
	if (!matcher?.canUseFinanceFeeds || !matcher.symbol) return '';

	return `site:twitter.com $${matcher.symbol}`;
}

function buildSearchEngineFeed(keyword = '', engine = 'google', context = 'news', options = {}) {
	const normalizedKeyword = normalizeKeyword(keyword);
	const normalizedEngine = String(engine || '')
		.trim()
		.toLowerCase();
	const source = String(options.source || CONTEXT_SEARCH_ENGINE_SOURCE_LABELS[normalizedEngine] || '').trim();
	if (!normalizedKeyword || !source) return null;
	const homepage = String(options.homepage || buildSearchEngineHomepageUrl(normalizedEngine, normalizedKeyword)).trim();
	const tags = Array.isArray(options.tags) ? options.tags.filter(Boolean) : ['news', 'search-engine', normalizedEngine, normalizedKeyword];

	return {
		type: 'search-engine',
		engine: normalizedEngine,
		context: normalizeFeedContext(context),
		source,
		homepage,
		url: homepage,
		tags,
		keyword: normalizedKeyword,
	};
}

function buildXStockSearchFeed(keyword = '', engine = 'google') {
	const fallbackKeyword = buildGoogleXStockSearchKeyword(keyword);
	if (!fallbackKeyword) return null;
	const normalizedEngine = String(engine || '')
		.trim()
		.toLowerCase();
	const sourceLabel = CONTEXT_SEARCH_ENGINE_SOURCE_LABELS[normalizedEngine] || 'Search';

	return buildSearchEngineFeed(fallbackKeyword, normalizedEngine, 'news', {
		source: `${sourceLabel} · Twitter cashtags`,
		tags: ['news', 'search-engine', normalizedEngine, 'twitter.com', 'cashtag', normalizeKeyword(keyword)].filter(Boolean),
	});
}

export function buildGoogleXStockSearchFeed(keyword = '') {
	return buildXStockSearchFeed(keyword, 'google');
}

function buildGoogleNewsTopicHomepageUrl(topicId = '') {
	const normalizedTopicId = String(topicId || '').trim();
	if (!normalizedTopicId) return '';

	const url = new URL(`https://news.google.com/topics/${encodeURIComponent(normalizedTopicId)}`);
	url.searchParams.set('hl', 'en-US');
	url.searchParams.set('gl', 'US');
	url.searchParams.set('ceid', 'US:en');
	return url.toString();
}

function buildGoogleNewsTopicFeed(topic = {}) {
	const topicId = String(topic.topicId || '').trim();
	const feedUrl = buildGoogleNewsTopicFeedUrl(topicId);
	if (!topicId || !feedUrl) return null;

	return {
		context: 'news',
		source: String(topic.source || 'Google News topic').trim() || 'Google News topic',
		homepage: buildGoogleNewsTopicHomepageUrl(topicId),
		url: feedUrl,
		tags: Array.isArray(topic.tags) ? topic.tags.filter(Boolean) : ['news', 'google-news'],
	};
}

function buildActuallyRelevantIssueFeed(issue = {}) {
	const issueSlug = normalizeActuallyRelevantIssueSlug(issue.slug || '');
	const feedUrl = buildActuallyRelevantFeedUrl(issueSlug);
	if (!issueSlug || !feedUrl) return null;

	return {
		context: 'news',
		source: String(issue.source || 'Actually Relevant').trim() || 'Actually Relevant',
		homepage: buildActuallyRelevantHomepage(issueSlug),
		url: feedUrl,
		tags: Array.isArray(issue.tags) ? issue.tags.filter(Boolean) : ['news', 'actually-relevant', issueSlug],
	};
}

function buildActuallyRelevantAllStoriesFeed() {
	return {
		context: 'news',
		source: 'Actually Relevant',
		homepage: buildActuallyRelevantHomepage(),
		url: buildActuallyRelevantFeedUrl(),
		tags: ['news', 'actually-relevant', 'curated'],
	};
}

const BUILTIN_RESEARCH_FEEDS = [
	{
		source: 'arXiv · Artificial Intelligence',
		homepage: 'https://arxiv.org/list/cs.AI/recent',
		url: 'https://export.arxiv.org/rss/cs.AI',
		context: 'research',
		tags: ['research', 'ai', 'arxiv'],
	},
	{
		source: 'arXiv · Quantum Physics',
		homepage: 'https://arxiv.org/list/quant-ph/recent',
		url: 'https://export.arxiv.org/rss/quant-ph',
		context: 'research',
		tags: ['research', 'quantum', 'arxiv'],
	},
	{
		source: 'Nature · Recent News',
		homepage: 'https://www.nature.com/nature/articles',
		url: 'https://www.nature.com/nature.rss',
		context: 'research',
		tags: ['research', 'science', 'nature'],
	},
	{
		source: 'Science · Current News',
		homepage: 'https://www.science.org/news',
		url: 'https://www.science.org/rss/news_current.xml',
		context: 'research',
		tags: ['research', 'science', 'science.org'],
	},
	{
		source: 'Phys.org · Main Feed',
		homepage: 'https://phys.org/',
		url: 'https://phys.org/rss-feed/',
		context: 'research',
		tags: ['research', 'science', 'phys.org'],
	},
	{
		source: 'MIT Technology Review',
		homepage: 'https://www.technologyreview.com/',
		url: 'https://www.technologyreview.com/feed/',
		context: 'research',
		tags: ['research', 'technology', 'mit'],
	},
];

function buildBuiltinContextFeeds() {
	return [
		...GOOGLE_NEWS_TOPIC_FEEDS.map((topic) => buildGoogleNewsTopicFeed(topic)).filter(Boolean),
		buildActuallyRelevantAllStoriesFeed(),
		...ACTUALLY_RELEVANT_ISSUES.map((issue) => buildActuallyRelevantIssueFeed(issue)).filter(Boolean),
		...BUILTIN_RESEARCH_FEEDS.map((feed) => ({ ...feed })),
	].filter(Boolean);
}

function normalizeConfiguredFeedEntry(entry = null) {
	if (typeof entry === 'string') {
		const url = entry.trim();
		if (!url) return null;

		return {
			context: 'news',
			source: 'Google Alerts',
			homepage: 'https://www.google.com/alerts',
			url,
			tags: ['news', 'google-alerts'],
		};
	}

	if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string') {
		return null;
	}

	const url = entry.url.trim();
	if (!url) return null;

	const tags = Array.isArray(entry.tags) ? entry.tags.map((tag) => normalizeKeyword(tag)).filter(Boolean) : ['news', 'google-alerts'];

	return {
		context: normalizeFeedContext(entry.context),
		source: String(entry.source || 'Google Alerts').trim() || 'Google Alerts',
		homepage: String(entry.homepage || 'https://www.google.com/alerts').trim() || 'https://www.google.com/alerts',
		url,
		tags,
	};
}

export function parseConfiguredAlertFeeds(rawValue = GOOGLE_ALERTS_FEEDS_JSON) {
	const normalizedRawValue = String(rawValue || '').trim();
	if (!normalizedRawValue) return [];

	try {
		const parsed = JSON.parse(normalizedRawValue);
		const entries = Array.isArray(parsed) ? parsed : [parsed];
		return entries.map((entry) => normalizeConfiguredFeedEntry(entry)).filter(Boolean);
	} catch (error) {
		logger.error('Configured Google Alerts feeds could not be parsed', {
			error: error.message,
		});
		return [];
	}
}

function dedupeContextFeeds(feeds = []) {
	const uniqueFeeds = [];
	const seenUrls = new Set();

	for (const feed of feeds) {
		const url = String(feed?.url || '').trim();
		if (!url || seenUrls.has(url)) continue;

		seenUrls.add(url);
		uniqueFeeds.push(feed);
	}

	return uniqueFeeds;
}

function buildContextFeedCatalog(feeds = [], keywords = []) {
	const normalizedKeywords = [...new Set((keywords || []).map((keyword) => normalizeKeyword(keyword)).filter(Boolean))];
	const templateFeeds = (Array.isArray(feeds) ? feeds : []).filter((feed) => isTagTemplateSource(feed));
	const staticFeeds = (Array.isArray(feeds) ? feeds : []).filter((feed) => !isTagTemplateSource(feed));
	const feedSearchKeywords = normalizedKeywords.flatMap((keyword) => buildFeedSearchKeywords(keyword));
	const keywordMatchers = [...new Set(feedSearchKeywords.map((keyword) => normalizeKeyword(keyword)).filter(Boolean))].map((keyword) => ({
		keyword,
		matcher: buildKeywordMatcher(keyword),
	}));
	const hasFinanceKeyword = keywordMatchers.some(({ matcher }) => matcher?.canUseFinanceFeeds);

	const searchEngineFeeds = keywordMatchers
		.slice(0, CONTEXT_SEARCH_ENGINE_KEYWORD_LIMIT)
		.flatMap(({ keyword }) => CONTEXT_SEARCH_ENGINE_ENGINES.map((engine) => buildSearchEngineFeed(keyword, engine, 'news')))
		.filter(Boolean);

	const researchFeeds = keywordMatchers
		.slice(0, CONTEXT_SEARCH_ENGINE_KEYWORD_LIMIT)
		.flatMap(({ keyword }) =>
			CONTEXT_SEARCH_ENGINE_ENGINES.map((engine) =>
				buildSearchEngineFeed(
					`${keyword} (site:arxiv.org OR site:researchgate.net OR site:nature.com OR site:science.org OR site:phys.org OR site:technologyreview.com)`,
					engine,
					'research',
					{
						source: `${CONTEXT_SEARCH_ENGINE_SOURCE_LABELS[engine] || 'Search'} · Research`,
						tags: ['research', 'search-engine', engine, normalizeKeyword(keyword)],
					},
				),
			),
		)
		.filter(Boolean);

	const googleNewsFeeds = keywordMatchers
		.slice(0, GOOGLE_NEWS_TAG_FEED_LIMIT)
		.map(({ keyword }) => buildGoogleNewsFeed(keyword))
		.filter(Boolean);
	const xSearchFeeds = keywordMatchers
		.slice(0, GOOGLE_NEWS_TAG_FEED_LIMIT)
		.map(({ keyword }) => buildXSearchFeed(keyword, 'research'))
		.filter(Boolean);
	const googleNewsXFeeds = keywordMatchers
		.slice(0, GOOGLE_NEWS_TAG_FEED_LIMIT)
		.map(({ keyword }) => buildGoogleNewsXFeed(keyword, 'research'))
		.filter(Boolean);
	const googleNewsQuoraFeeds = keywordMatchers
		.slice(0, GOOGLE_NEWS_TAG_FEED_LIMIT)
		.map(({ keyword }) => buildGoogleNewsQuoraFeed(keyword))
		.filter(Boolean);
	// Skip Google/Yahoo site:x.com cashtag searches when the direct X API is available.
	// Those feeds are inherently stale (Google/Yahoo indexing delay of hours–days) and
	// are redundant when xSearchFeeds already provides live data from the X GraphQL API.
	const googleXStockSearchFeeds =
		hasXCredentials() ?
			[]
		:	keywordMatchers
				.slice(0, CONTEXT_SEARCH_ENGINE_KEYWORD_LIMIT)
				.filter(({ matcher }) => matcher?.canUseFinanceFeeds)
				.flatMap(({ keyword }) => CONTEXT_X_CASHTAG_SEARCH_ENGINES.map((engine) => buildXStockSearchFeed(keyword, engine)))
				.filter(Boolean);
	const redditFeeds = keywordMatchers
		.slice(0, REDDIT_TAG_FEED_LIMIT)
		.flatMap(({ keyword, matcher }) => {
			if (matcher?.canUseFinanceFeeds) {
				return buildFinanceRedditFeeds(keyword, 'research');
			}

			return [buildStandardRedditFeed(keyword, 'research'), ...buildTopicalRedditFeeds(keyword, 'research')].filter(Boolean);
		})
		.filter(Boolean);
	const investingFeeds = hasFinanceKeyword ? buildInvestingStockNewsFeeds('news') : [];
	const templateExpandedFeeds = templateFeeds.flatMap((feed) => expandTagTemplateFeed(feed, normalizedKeywords));

	const catalog = sortContextFeedCatalog([
		...googleNewsFeeds,
		...xSearchFeeds,
		...googleNewsXFeeds,
		...googleNewsQuoraFeeds,
		...googleXStockSearchFeeds,
		...searchEngineFeeds,
		...researchFeeds,
		...redditFeeds,
		...investingFeeds,
		...staticFeeds,
		...templateExpandedFeeds,
	]);

	// Filter out blocked URLs
	return catalog.filter((feed) => !state.blockedFeedUrls.has(feed.url));
}

function getContextFeedFamily(feed = {}) {
	const source = String(feed?.source || '').toLowerCase();
	const feedUrl = String(feed?.url || '').toLowerCase();
	const homepage = String(feed?.homepage || '').toLowerCase();
	const tags = Array.isArray(feed?.tags) ? feed.tags.map((tag) => normalizeKeyword(tag)) : [];

	if (feed?.type === 'search-engine') return 'search-engine';
	if (source.includes('reddit') || feedUrl.includes('reddit.com') || homepage.includes('reddit.com') || tags.includes('reddit')) return 'reddit';
	if (
		source.includes('google news · twitter') ||
		source.includes('twitter cashtags') ||
		feedUrl.includes('twitter.com') ||
		homepage.includes('twitter.com') ||
		tags.includes('twitter.com')
	) {
		return 'x';
	}
	if (source.includes('quora') || feedUrl.includes('quora.com') || homepage.includes('quora.com') || tags.includes('quora.com')) return 'quora';
	return 'rss';
}

function getContextFeedPriority(feed = {}) {
	switch (getContextFeedFamily(feed)) {
		case 'reddit':
			return 0;
		case 'x':
			return 1;
		case 'quora':
			return 2;
		case 'rss':
			return 3;
		case 'search-engine':
			return 10;
		default:
			return 99;
	}
}

export function sortContextFeedCatalog(feeds = []) {
	return [...(Array.isArray(feeds) ? feeds : [])].sort((left, right) => {
		const priorityDifference = getContextFeedPriority(left) - getContextFeedPriority(right);
		if (priorityDifference) return priorityDifference;

		const leftContext = normalizeFeedContext(left?.context);
		const rightContext = normalizeFeedContext(right?.context);
		const contextDifference = contextPriority(rightContext) - contextPriority(leftContext);
		if (contextDifference) return contextDifference;

		return String(left?.source || left?.url || '').localeCompare(String(right?.source || right?.url || ''));
	});
}

export function partitionContextFeedCatalog(feeds = []) {
	const sortedFeeds = sortContextFeedCatalog(feeds);
	return {
		fastFeeds: sortedFeeds.filter((feed) => feed?.type !== 'search-engine'),
		backgroundFeeds: sortedFeeds.filter((feed) => feed?.type === 'search-engine'),
	};
}

function scoreSimpleKeywordMatcher(normalizedText = '', keywordMatcher = null, normalizedContext = '') {
	if (!normalizedText || !keywordMatcher?.keyword) {
		return { score: 0, matched: false };
	}

	if (keywordMatcher.isAsset) {
		const aliasHit = keywordMatcher.aliases.some((alias) => alias && normalizedText.includes(alias));
		const stockSignal = isStockRelatedText(normalizedText);
		const newsAliasHit = normalizedContext === 'news' && aliasHit;
		const directTickerHit = keywordMatcher.aliases.some((alias) =>
			alias === keywordMatcher.symbol || alias === `$${keywordMatcher.symbol}` ? normalizedText.includes(alias) : false,
		);

		if (!directTickerHit && !(aliasHit && stockSignal) && !newsAliasHit) {
			return { score: 0, matched: false };
		}

		return {
			score:
				directTickerHit ? 7
				: aliasHit && stockSignal ? 5
				: newsAliasHit ? 4
				: 0,
			matched: true,
		};
	}

	const exactMatch = normalizedText.includes(keywordMatcher.keyword);
	const partialPhraseMatch = !exactMatch && keywordMatcher.parts.length > 1 && keywordMatcher.parts.every((part) => normalizedText.includes(part));

	if (!exactMatch && !partialPhraseMatch) {
		return { score: 0, matched: false };
	}

	return {
		score:
			exactMatch ?
				keywordMatcher.parts.length > 1 ?
					6
				:	3
			:	4,
		matched: true,
	};
}

function matchWildcardTarget(target = '', rawValue = '') {
	const pattern = buildWildcardPattern(rawValue);
	if (!pattern) return false;
	return pattern.test(target);
}

function matchFieldValue(target = '', value = '', { requireAllTerms = false } = {}) {
	const normalizedTarget = normalizeOperatorComparable(target);
	const normalizedValue = normalizeOperatorComparable(value);
	if (!normalizedTarget || !normalizedValue) return false;

	if (value.includes('*')) {
		return matchWildcardTarget(normalizedTarget, value);
	}

	if (!requireAllTerms) {
		return normalizedTarget.includes(normalizedValue);
	}

	return normalizedValue.split(/\s+/).every((part) => part && normalizedTarget.includes(part));
}

function evaluateAdvancedFieldNode(node = null, itemContext = {}) {
	if (!node?.operator) return { matched: false, score: 0 };

	const value = String(node.value || '').trim();
	const normalizedSource = normalizeOperatorComparable(itemContext.source);
	const comparableText = normalizeOperatorComparable(itemContext.text);
	const comparableTitle = normalizeOperatorComparable(itemContext.title);
	const comparableUrl = normalizeOperatorComparable(itemContext.url);
	const comparableHostname = normalizeOperatorComparable(itemContext.hostname);
	const comparablePathname = normalizeOperatorComparable(itemContext.pathname);
	const publishedTime = Date.parse(itemContext.publishedAt || itemContext.discoveredAt || '') || 0;

	switch (node.operator) {
		case 'source':
			return { matched: matchFieldValue(normalizedSource, value), score: 4 };
		case 'site':
			return {
				matched: matchFieldValue(comparableHostname, value) || matchFieldValue(comparableUrl, value),
				score: 4,
			};
		case 'filetype':
		case 'ext': {
			const extension = normalizeKeyword(value).replace(/^\./, '');
			return {
				matched: Boolean(extension) && new RegExp(`\\.${extension}(?:$|[^a-z0-9])`, 'i').test(itemContext.url || ''),
				score: 4,
			};
		}
		case 'intitle':
			return { matched: matchFieldValue(comparableTitle, value), score: 4 };
		case 'allintitle':
			return { matched: matchFieldValue(comparableTitle, value, { requireAllTerms: true }), score: 5 };
		case 'inurl':
			return { matched: matchFieldValue(comparableUrl, value) || matchFieldValue(comparablePathname, value), score: 4 };
		case 'allinurl':
			return {
				matched: matchFieldValue(comparableUrl, value, { requireAllTerms: true }) || matchFieldValue(comparablePathname, value, { requireAllTerms: true }),
				score: 5,
			};
		case 'intext':
			return { matched: matchFieldValue(comparableText, value), score: 4 };
		case 'allintext':
			return { matched: matchFieldValue(comparableText, value, { requireAllTerms: true }), score: 5 };
		case 'before': {
			const cutoff = Date.parse(value);
			return { matched: Boolean(publishedTime && cutoff && publishedTime < cutoff), score: 3 };
		}
		case 'after': {
			const cutoff = Date.parse(value);
			return { matched: Boolean(publishedTime && cutoff && publishedTime > cutoff), score: 3 };
		}
		default:
			return { matched: matchFieldValue(comparableText, value), score: 2 };
	}
}

function evaluateAdvancedNode(node = null, itemContext = {}) {
	if (!node) return { matched: false, score: 0 };

	switch (node.type) {
		case 'AND': {
			const leftResult = evaluateAdvancedNode(node.left, itemContext);
			if (!leftResult.matched) return { matched: false, score: 0 };
			const rightResult = evaluateAdvancedNode(node.right, itemContext);
			if (!rightResult.matched) return { matched: false, score: 0 };
			return { matched: true, score: leftResult.score + rightResult.score + 1 };
		}
		case 'OR': {
			const leftResult = evaluateAdvancedNode(node.left, itemContext);
			const rightResult = evaluateAdvancedNode(node.right, itemContext);
			if (!leftResult.matched && !rightResult.matched) return { matched: false, score: 0 };
			return { matched: true, score: Math.max(leftResult.score, rightResult.score) };
		}
		case 'NOT': {
			const result = evaluateAdvancedNode(node.expression, itemContext);
			return { matched: !result.matched, score: 0 };
		}
		case 'ANY':
			return { matched: true, score: 0 };
		case 'FIELD':
			return evaluateAdvancedFieldNode(node, itemContext);
		case 'PHRASE': {
			const matched = node.pattern ? node.pattern.test(itemContext.text) : itemContext.text.includes(normalizeKeyword(node.value || node.raw));
			return { matched, score: matched ? 6 : 0 };
		}
		case 'WILDCARD': {
			const matched = node.pattern ? node.pattern.test(itemContext.text) : matchWildcardTarget(itemContext.text, node.raw);
			return { matched, score: matched ? 4 : 0 };
		}
		case 'SIMPLE':
		default:
			return scoreSimpleKeywordMatcher(itemContext.text, node.matcher, itemContext.context);
	}
}

function scoreKeywordMatch(text = '', keywords = [], options = {}) {
	const normalizedText = normalizeKeyword(text);
	if (!normalizedText) {
		return { score: 0, matchedKeywords: [] };
	}

	if (!keywords.length) {
		const normalizedContext = normalizeKeyword(options.context || '');
		if (normalizedContext === 'research') {
			return { score: 1, matchedKeywords: [] };
		}
		return { score: 0, matchedKeywords: [] };
	}

	const normalizedContext = normalizeKeyword(options.context || '');
	const itemUrl = String(options.url || options.link || '').trim();
	let itemHostname = '';
	let itemPathname = '';
	try {
		const parsedUrl = new URL(itemUrl);
		itemHostname = parsedUrl.hostname || '';
		itemPathname = parsedUrl.pathname || '';
	} catch {}
	const itemContext = {
		text: normalizedText,
		title: normalizeKeyword(options.title || ''),
		url: itemUrl,
		hostname: itemHostname,
		pathname: itemPathname,
		source: options.source || '',
		publishedAt: options.publishedAt || '',
		discoveredAt: options.discoveredAt || '',
		context: normalizedContext,
	};

	const matchedKeywords = [];
	let score = 0;

	for (const keywordMatcher of keywords) {
		if (!keywordMatcher?.keyword) continue;

		if (keywordMatcher.isAdvanced && keywordMatcher.ast) {
			const result = evaluateAdvancedNode(keywordMatcher.ast, itemContext);
			if (!result.matched) {
				continue;
			}

			matchedKeywords.push(keywordMatcher.keyword);
			score += result.score;
			continue;
		}

		if (keywordMatcher.isExpression && Array.isArray(keywordMatcher.groups)) {
			let bestGroupScore = 0;

			for (const group of keywordMatcher.groups) {
				let groupScore = 0;
				let groupMatched = true;

				for (const termMatcher of group) {
					const result = scoreSimpleKeywordMatcher(normalizedText, termMatcher, normalizedContext);
					if (!result.matched) {
						groupMatched = false;
						break;
					}

					groupScore += result.score;
				}

				if (groupMatched) {
					bestGroupScore = Math.max(bestGroupScore, groupScore + Math.max(0, group.length - 1));
				}
			}

			if (!bestGroupScore) {
				continue;
			}

			matchedKeywords.push(keywordMatcher.keyword);
			score += bestGroupScore;
			continue;
		}

		const result = scoreSimpleKeywordMatcher(normalizedText, keywordMatcher, normalizedContext);
		if (!result.matched) continue;

		matchedKeywords.push(keywordMatcher.keyword);
		score += result.score;
	}

	return {
		score,
		matchedKeywords: [...new Set(matchedKeywords)],
	};
}

export function matchContextText(text = '', input = [], options = {}) {
	const matchers = (Array.isArray(input) ? input : [input]).map((keyword) => buildKeywordMatcher(keyword)).filter(Boolean);
	return scoreKeywordMatch(text, matchers, options);
}

function buildMatchId(feed = {}, item = {}) {
	// Prefer a canonicalized link/guid when available to avoid duplicates caused by tracking params
	const rawLink = String(item.link || item.guid || item.id || '').trim();
	if (rawLink) {
		try {
			const stripped = stripTrackingParams(rawLink).toLowerCase();
			if (stripped) return stripped.slice(0, 500);
		} catch {
			// fall through to fallback
		}
	}

	const fallback = `${String(feed.context || '')}:${String(feed.source || '')}:${String(item.title || '')}:${String(item.publishedAt || item.discoveredAt || '')}`;
	return String(fallback).trim().slice(0, 500);
}

function isRedditDomain(value = '') {
	try {
		const hostname = new URL(String(value || '').trim()).hostname.toLowerCase();
		return /(^|\.)reddit\.com$/.test(hostname) || hostname === 'redd.it';
	} catch {
		return false;
	}
}

function isRedditCommentsUrl(value = '') {
	const normalized = String(value || '').trim();
	if (!normalized) return false;
	if (!isRedditDomain(normalized)) return false;
	return /\/comments\//i.test(normalized);
}

function extractRedditSummaryLinks(item = {}, feed = {}) {
	const baseUrl = String(item.link || item.guid || feed.homepage || feed.url || '').trim();
	const htmlFragments = [item.content, item['content:encoded'], item.summary, item.contentSnippet]
		.map((value) => String(value || '').trim())
		.filter((value) => value.includes('<a'));

	let originalLink = '';
	let commentsLink = '';

	for (const fragment of htmlFragments) {
		for (const match of fragment.matchAll(/<a\b[^>]*href=(['"])(.*?)\1[^>]*>(.*?)<\/a>/gi)) {
			const href = resolveFeedItemUrl(baseUrl, match[2] || '') || String(match[2] || '').trim();
			if (!href) continue;

			const label = normalizeFeedText(match[3] || '')
				.trim()
				.toLowerCase();

			if (!commentsLink && label === '[comments]') {
				commentsLink = href;
				continue;
			}

			if (!originalLink && label === '[link]') {
				originalLink = href;
				continue;
			}
		}
	}

	const primaryLink = String(item.link || '').trim();
	const guidLink = String(item.guid || '').trim();

	if (!commentsLink) {
		if (isRedditCommentsUrl(primaryLink)) {
			commentsLink = primaryLink;
		} else if (isRedditCommentsUrl(guidLink)) {
			commentsLink = guidLink;
		}
	}

	if (!originalLink) {
		if (primaryLink && !isRedditCommentsUrl(primaryLink)) {
			originalLink = primaryLink;
		} else if (guidLink && !isRedditCommentsUrl(guidLink)) {
			originalLink = guidLink;
		}
	}

	return {
		originalLink,
		commentsLink,
	};
}

function normalizeRedditCommentText(value = '') {
	return normalizeFeedText(value)
		.replace(/\[(?:link|comments?)\]/gi, ' ')
		.replace(/\bsubmitted by\s+\/?u\/[a-z0-9_-]+\s+to\s+r\/[a-z0-9_]+\b/gi, ' ')
		.replace(/\bsubmitted by\s+\/?u\/[a-z0-9_-]+\b/gi, ' ')
		.replace(/\bto\s+r\/[a-z0-9_]+\b/gi, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function extractRedditCommentText(item = {}, feed = {}, redditSummaryLinks = {}) {
	const possibleCommentLink = String(redditSummaryLinks.commentsLink || item.link || item.guid || '').trim();
	if (!isRedditCommentsUrl(possibleCommentLink)) return '';

	const title = normalizeFeedText(item.title || '');
	const candidates = [item.content, item['content:encoded'], item.summary, item.contentSnippet]
		.map((value) => normalizeRedditCommentText(value))
		.filter(Boolean)
		.sort((left, right) => right.length - left.length);

	for (const candidate of candidates) {
		if (candidate.length < 24) continue;
		if (title && candidate.toLowerCase() === title.toLowerCase()) continue;
		return candidate;
	}

	return '';
}

function stripRedditCommentText(value = '', commentText = '') {
	const normalizedValue = normalizeFeedText(value);
	const normalizedComment = normalizeFeedText(commentText);
	if (!normalizedValue) return '';
	if (!normalizedComment) return normalizedValue;

	return normalizedValue
		.replace(new RegExp(escapeRegExp(normalizedComment), 'i'), ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

export function buildContextMatchCandidates(feed = {}, item = {}) {
	const redditSummaryLinks = extractRedditSummaryLinks(item, feed);
	const commentText = extractRedditCommentText(item, feed, redditSummaryLinks);
	const primaryTextParts = [
		normalizeFeedText(item.title || ''),
		stripRedditCommentText(item.contentSnippet || '', commentText),
		stripRedditCommentText(item.content || '', commentText),
		stripRedditCommentText(item.summary || '', commentText),
		...(Array.isArray(item.categories) ? item.categories.map((category) => normalizeFeedText(category)).filter(Boolean) : []),
	].filter(Boolean);

	const candidates = [
		{
			...item,
			__matchVariant: 'primary',
			__matchText: primaryTextParts.join(' '),
			__redditSummaryLinks: redditSummaryLinks,
		},
	];

	if (!commentText) {
		return candidates;
	}

	const parentTitle = normalizeFeedText(item.title || 'Reddit discussion');
	const commentLink = String(redditSummaryLinks.commentsLink || item.link || item.guid || '').trim();
	candidates.push({
		...item,
		guid: `${buildMatchId(feed, item)}#comment`,
		link: commentLink || item.link || item.guid || '',
		title: summarizeText(commentText, 140) || parentTitle,
		contentSnippet: commentText,
		content: commentText,
		summary: parentTitle ? `Comment on ${parentTitle}` : 'Matching Reddit comment',
		categories: [...new Set([...(Array.isArray(item.categories) ? item.categories : []), 'comment'])],
		__matchVariant: 'comment',
		__matchText: commentText,
		__redditSummaryLinks: redditSummaryLinks,
	});

	return candidates;
}

function parseTimestamp(value = '') {
	const rawValue = String(value || '').trim();
	if (!rawValue) return 0;

	const directTimestamp = Date.parse(rawValue);
	if (!Number.isNaN(directTimestamp)) return directTimestamp;

	const normalizedIsoLikeValue = rawValue.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?)$/, '$1T$2');
	const normalizedTimestamp = Date.parse(normalizedIsoLikeValue);
	return Number.isNaN(normalizedTimestamp) ? 0 : normalizedTimestamp;
}

function parsePublishedAt(item = {}) {
	const raw =
		item.isoDate ||
		item.pubDate ||
		item.published ||
		item.updated ||
		item['dc:date'] ||
		item.datePublished ||
		item.dateCreated ||
		item.uploadDate ||
		item.createdAt ||
		item.created ||
		item.modified ||
		'';
	const timestamp = parseTimestamp(raw);
	return timestamp ? new Date(timestamp).toISOString() : '';
}

function isFuturePublishedAt(value = '') {
	const publishedTime = parseTimestamp(value);
	if (!publishedTime) return false;

	return publishedTime > Date.now() + FUTURE_DATE_TOLERANCE_MS;
}

function getSearchEngineRunner(engine = '') {
	switch (
		String(engine || '')
			.trim()
			.toLowerCase()
	) {
		case 'google':
			return googleSearch;
		case 'bing':
			return bingSearch;
		case 'yahoo':
			return yahooSearch;
		default:
			return null;
	}
}

async function fetchSearchEngineFeedItems(feed = {}) {
	const cacheKey = `${feed.engine || 'search'}:${feed.context || 'news'}:${feed.keyword || ''}`;
	const now = Date.now();
	const cached = searchEngineCache.get(cacheKey);
	// X cashtag feeds via search engines are inherently stale (indexing delay). Use the
	// shorter X_FEED_REFRESH_MS TTL so they at least re-query on every monitor cycle
	// rather than serving 3-minute-old results.
	const cacheTtl = isStatusOnlyXFeed(feed) ? X_FEED_REFRESH_MS : CONTEXT_SEARCH_ENGINE_REFRESH_MS;
	if (cached && now - cached.fetchedAt < cacheTtl) {
		return cached.items;
	}

	const runner = getSearchEngineRunner(feed.engine);
	if (!runner || !feed.keyword) return [];

	const result = await runner({ searchTerm: feed.keyword });
	const items = [
		...new Map(
			(Array.isArray(result?.results) ? result.results : [])
				.filter((entry) => entry?.url && entry?.title)
				.filter((entry) => !isStatusOnlyXFeed(feed) || isStatusOnlyXResult(entry))
				.map((entry) => [entry.url, normalizeSearchEngineResultItem(feed, entry)]),
		).values(),
	].slice(0, CONTEXT_SEARCH_ENGINE_RESULT_LIMIT);

	searchEngineCache.set(cacheKey, {
		fetchedAt: now,
		items,
	});

	return items;
}

function contextPriority(context = '') {
	switch (String(context || '').toLowerCase()) {
		case 'news':
			return 3;
		case 'research':
			return 2;
		case 'shopping':
			return 1;
		default:
			return 0;
	}
}

function sortMatches(left = {}, right = {}) {
	const leftPublishedTime = parseTimestamp(left.publishedAt || '');
	const rightPublishedTime = parseTimestamp(right.publishedAt || '');
	const leftHasPublishedTime = leftPublishedTime > 0;
	const rightHasPublishedTime = rightPublishedTime > 0;

	if (leftHasPublishedTime || rightHasPublishedTime) {
		if (leftHasPublishedTime !== rightHasPublishedTime) {
			return Number(rightHasPublishedTime) - Number(leftHasPublishedTime);
		}

		if (rightPublishedTime !== leftPublishedTime) {
			return rightPublishedTime - leftPublishedTime;
		}
	}

	const leftDiscoveredTime = parseTimestamp(left.discoveredAt || '');
	const rightDiscoveredTime = parseTimestamp(right.discoveredAt || '');
	return rightDiscoveredTime - leftDiscoveredTime || right.score - left.score || contextPriority(right.context) - contextPriority(left.context);
}

export function sortContextMatchesNewestFirst(items = []) {
	return [...items].sort(sortMatches);
}

function matchesKeywordSet(item = {}, keywordSet = new Set()) {
	if (!keywordSet.size) return false;
	const matchedKeywords = Array.isArray(item?.matchedKeywords) ? item.matchedKeywords : [];
	return matchedKeywords.some((matchedKeyword) => keywordSet.has(normalizeKeyword(matchedKeyword)));
}

function getPreferredFinanceSourceFamily(item = {}) {
	const source = String(item?.source || '').toLowerCase();
	const feedUrl = String(item?.feedUrl || '').toLowerCase();
	const homepage = String(item?.homepage || '').toLowerCase();
	const link = String(item?.link || '').toLowerCase();
	const tags = Array.isArray(item?.tags) ? item.tags.map((tag) => normalizeKeyword(tag)) : [];

	if (source.includes('reddit') || feedUrl.includes('reddit.com') || homepage.includes('reddit.com') || link.includes('reddit.com') || tags.includes('reddit')) {
		return 'reddit';
	}

	if (
		source.includes('twitter cashtags') ||
		source.includes('google news · twitter') ||
		feedUrl.includes('twitter.com') ||
		homepage.includes('twitter.com') ||
		link.includes('twitter.com') ||
		tags.includes('twitter.com')
	) {
		return 'x';
	}

	return '';
}

function getFinanceSourcePreferenceQuota(limit = CONTEXT_FEED_MATCH_LIMIT) {
	const normalizedLimit = Math.max(1, Number(limit) || CONTEXT_FEED_MATCH_LIMIT);
	if (normalizedLimit <= 2) return normalizedLimit;
	return Math.min(normalizedLimit - 1, Math.max(2, Math.ceil((normalizedLimit * 3) / 4)));
}

function getPreferredSocialSourceFamily(item = {}) {
	const source = String(item?.source || '').toLowerCase();
	const feedUrl = String(item?.feedUrl || '').toLowerCase();
	const homepage = String(item?.homepage || '').toLowerCase();
	const link = String(item?.link || '').toLowerCase();
	const tags = Array.isArray(item?.tags) ? item.tags.map((tag) => normalizeKeyword(tag)) : [];

	if (source.includes('reddit') || feedUrl.includes('reddit.com') || homepage.includes('reddit.com') || link.includes('reddit.com') || tags.includes('reddit')) {
		return 'reddit';
	}

	if (
		source.includes('twitter cashtags') ||
		source.includes('google news · twitter') ||
		feedUrl.includes('twitter.com') ||
		homepage.includes('twitter.com') ||
		link.includes('twitter.com') ||
		tags.includes('twitter.com')
	) {
		return 'x';
	}

	return '';
}

function getContextCoverageLimit(keywords = [], limit = CONTEXT_FEED_MATCH_LIMIT) {
	const normalizedLimit = Math.max(1, Number(limit) || CONTEXT_FEED_MATCH_LIMIT);
	const keywordCount = [...new Set((Array.isArray(keywords) ? keywords : []).map((keyword) => normalizeKeyword(keyword?.keyword || keyword)).filter(Boolean))].length;
	if (!keywordCount) {
		return Math.min(normalizedLimit, 8);
	}

	return Math.min(normalizedLimit, Math.max(8, keywordCount * 8));
}

export function selectMatchesWithKeywordCoverage(items = [], keywords = [], limit = CONTEXT_FEED_MATCH_LIMIT) {
	const sortedItems = sortContextMatchesNewestFirst(items);
	const normalizedLimit = Math.max(1, Number(limit) || CONTEXT_FEED_MATCH_LIMIT);
	if (sortedItems.length <= normalizedLimit) {
		return keepOnlyUniquePreviewImages(sortedItems);
	}

	const keywordOrder = [...new Set((Array.isArray(keywords) ? keywords : []).map((keyword) => normalizeKeyword(keyword?.keyword || keyword)).filter(Boolean))];
	if (!keywordOrder.length) {
		return keepOnlyUniquePreviewImages(sortedItems.slice(0, normalizedLimit));
	}
	const keywordSet = new Set(keywordOrder);
	const financeKeywordMatchers = (Array.isArray(keywords) ? keywords : [])
		.map((keyword) => {
			if (keyword?.matcher) return keyword.matcher;
			if (keyword?.keyword) return buildKeywordMatcher(keyword.keyword);
			return buildKeywordMatcher(keyword);
		})
		.filter(Boolean)
		.filter((matcher) => matcher.canUseFinanceFeeds);
	const financeKeywordSet = new Set(financeKeywordMatchers.map((matcher) => normalizeKeyword(matcher.keyword)).filter(Boolean));

	const selected = [];
	const selectedIds = new Set();
	const preferredSocialFamilies = ['reddit', 'x'];
	for (const family of preferredSocialFamilies) {
		const nextMatch = sortedItems.find((item) => {
			const itemId = item?.id || item?.link || item?.title;
			return itemId && !selectedIds.has(itemId) && matchesKeywordSet(item, keywordSet) && getPreferredSocialSourceFamily(item) === family;
		});

		if (!nextMatch || selected.length >= normalizedLimit) continue;

		const itemId = nextMatch.id || nextMatch.link || nextMatch.title;
		selected.push(nextMatch);
		selectedIds.add(itemId);
	}
	if (financeKeywordSet.size) {
		const financeSourcePreferenceQuota = getFinanceSourcePreferenceQuota(normalizedLimit);
		for (const family of ['x', 'reddit']) {
			const nextMatch = sortedItems.find((item) => {
				const itemId = item?.id || item?.link || item?.title;
				return itemId && !selectedIds.has(itemId) && matchesKeywordSet(item, financeKeywordSet) && getPreferredFinanceSourceFamily(item) === family;
			});

			if (!nextMatch || selected.length >= normalizedLimit) continue;

			const itemId = nextMatch.id || nextMatch.link || nextMatch.title;
			selected.push(nextMatch);
			selectedIds.add(itemId);
		}

		for (const item of sortedItems) {
			if (selected.length >= financeSourcePreferenceQuota || selected.length >= normalizedLimit) break;
			const itemId = item?.id || item?.link || item?.title;
			if (!itemId || selectedIds.has(itemId)) continue;
			if (!matchesKeywordSet(item, financeKeywordSet)) continue;
			if (!getPreferredFinanceSourceFamily(item)) continue;

			selected.push(item);
			selectedIds.add(itemId);
		}
	}
	const matchesByKeyword = new Map(
		keywordOrder.map((keyword) => [
			keyword,
			sortedItems.filter((item) => Array.isArray(item?.matchedKeywords) && item.matchedKeywords.some((matchedKeyword) => normalizeKeyword(matchedKeyword) === keyword)),
		]),
	);

	let addedMatch = true;
	while (selected.length < normalizedLimit && addedMatch) {
		addedMatch = false;

		for (const keyword of keywordOrder) {
			if (selected.length >= normalizedLimit) break;

			const nextMatch = (matchesByKeyword.get(keyword) || []).find((item) => {
				const itemId = item?.id || item?.link || item?.title;
				return itemId && !selectedIds.has(itemId);
			});

			if (!nextMatch) continue;

			const itemId = nextMatch.id || nextMatch.link || nextMatch.title;
			selected.push(nextMatch);
			selectedIds.add(itemId);
			addedMatch = true;
		}
	}

	for (const item of sortedItems) {
		if (selected.length >= normalizedLimit) break;
		const itemId = item?.id || item?.link || item?.title;
		if (!itemId || selectedIds.has(itemId)) continue;

		selected.push(item);
		selectedIds.add(itemId);
	}

	return keepOnlyUniquePreviewImages(sortContextMatchesNewestFirst(selected).slice(0, normalizedLimit));
}

async function loadContextFeeds() {
	let parsedFeeds = [];

	try {
		const raw = await readFile(CONTEXT_FEEDS_FILE, 'utf-8');
		const parsed = JSON.parse(raw);
		parsedFeeds = Array.isArray(parsed) ? parsed : [];
	} catch (error) {
		logger.error('Context feed config load failed', {
			error: error.message,
			file: CONTEXT_FEEDS_FILE,
		});
	}

	return dedupeContextFeeds([...buildBuiltinContextFeeds(), ...parseConfiguredAlertFeeds(), ...parsedFeeds]);
}

function hydrateMatch(feed = {}, item = {}, keywords = []) {
	const combinedText = String(
		item.__matchText || [item.title, item.contentSnippet, item.content, item.summary, ...(Array.isArray(item.categories) ? item.categories : [])].filter(Boolean).join(' '),
	).trim();
	const redditSummaryLinks = item.__redditSummaryLinks || extractRedditSummaryLinks(item, feed);
	const isTemplateDrivenFeed = feed?.type === 'tag-template-instance';
	const templateTag = normalizeKeyword(feed?.templateTag || feed?.sampleTag || feed?.replaceTagValue || '');
	let { score, matchedKeywords } = scoreKeywordMatch(combinedText, keywords, {
		context: feed.context,
		title: item.title,
		url: item.link || item.guid || '',
		source: feed.source || feed.title || '',
		publishedAt: parsePublishedAt(item),
		discoveredAt: new Date().toISOString(),
	});

	if (isTemplateDrivenFeed) {
		const normalizedMatchedKeywords = Array.isArray(matchedKeywords) ? matchedKeywords.map((keyword) => normalizeKeyword(keyword)).filter(Boolean) : [];
		if (templateTag && !normalizedMatchedKeywords.includes(templateTag)) {
			matchedKeywords = [...new Set([templateTag, ...normalizedMatchedKeywords])];
		}
		if (!score) {
			score = 1;
		}
	}

	if (!score) return null;

	return {
		id: buildMatchId(feed, item),
		context: String(feed.context || 'news').toLowerCase(),
		source: feed.source || feed.title || 'Feed',
		homepage: feed.homepage || '',
		feedUrl: feed.url || '',
		title: normalizeFeedText(item.title || 'Untitled item'),
		summary: normalizeFeedText(item.contentSnippet || item.content || item.summary || item.title || ''),
		link: item.link || item.guid || '',
		originalLink: redditSummaryLinks.originalLink || '',
		commentsLink: redditSummaryLinks.commentsLink || '',
		previewImage: extractFeedItemPreviewImage(item, feed),
		publishedAt: parsePublishedAt(item),
		discoveredAt: new Date().toISOString(),
		score,
		matchedKeywords,
		tags: [...new Set([...(feed.tags || []), ...(Array.isArray(item.categories) ? item.categories : [])].filter(Boolean))].slice(0, 6),
	};
}

async function buildMatches(feeds = [], keywords = []) {
	const contexts = createEmptyContexts();
	const matches = [];

	for (const feed of feeds) {
		if (!feed?.url || !feed?.context) continue;
		try {
			const items = await fetchContextSourceItems(feed, { limit: CONTEXT_FEED_ITEMS_PER_SOURCE });

			// Record success
			const health = state.feedHealth[feed.url] || { successCount: 0, errorCount: 0 };
			state.feedHealth[feed.url] = {
				...health,
				lastSuccessAt: new Date().toISOString(),
				lastError: '',
				successCount: health.successCount + 1,
				itemCount: items.length,
			};

			for (const item of items) {
				for (const candidate of buildContextMatchCandidates(feed, item)) {
					const match = hydrateMatch(feed, candidate, keywords);
					if (!match) continue;
					if (isFuturePublishedAt(match.publishedAt)) continue;
					matches.push(match);
					if (Array.isArray(contexts[match.context])) {
						contexts[match.context].push(match);
					}
				}
			}
		} catch (error) {
			// Record error
			const health = state.feedHealth[feed.url] || { successCount: 0, errorCount: 0 };
			state.feedHealth[feed.url] = {
				...health,
				lastError: error.message,
				lastErrorAt: new Date().toISOString(),
				errorCount: health.errorCount + 1,
			};

			logger.debug('Context feed parse failed', {
				feed: feed.source || feed.url,
				url: feed.url,
				error: error.message,
			});
		}
	}

	for (const context of CONTEXTS) {
		contexts[context] = selectMatchesWithKeywordCoverage(contexts[context] || [], keywords, getContextCoverageLimit(keywords));
	}

	return {
		contexts,
		matches: selectMatchesWithKeywordCoverage(matches, keywords, CONTEXT_FEED_MATCH_LIMIT),
	};
}

function buildMergedMatchKey(item = {}) {
	return String(item?.id || item?.link || `${item?.source || ''}:${item?.title || ''}`)
		.trim()
		.toLowerCase();
}

function mergeUniqueMatches(items = []) {
	const merged = [];
	const seenKeys = new Set();

	for (const item of Array.isArray(items) ? items : []) {
		const key = buildMergedMatchKey(item);
		if (!key || seenKeys.has(key)) continue;
		seenKeys.add(key);
		merged.push(item);
	}

	return merged;
}

function mergeContextMatchCollections(base = null, augment = null, keywords = []) {
	const mergedContexts = createEmptyContexts();

	for (const context of CONTEXTS) {
		mergedContexts[context] = selectMatchesWithKeywordCoverage(
			mergeUniqueMatches([...(base?.contexts?.[context] || []), ...(augment?.contexts?.[context] || [])]),
			keywords,
			getContextCoverageLimit(keywords),
		);
	}

	return {
		contexts: mergedContexts,
		matches: selectMatchesWithKeywordCoverage(mergeUniqueMatches([...(base?.matches || []), ...(augment?.matches || [])]), keywords, CONTEXT_FEED_MATCH_LIMIT),
	};
}

function appendNotifications(matches = []) {
	const nextNotifications = [];

	for (const match of matches) {
		if (!match?.id || state.seenMatchIds.has(match.id)) continue;
		state.seenMatchIds.add(match.id);
		nextNotifications.push({
			id: match.id,
			context: match.context,
			title: match.title,
			source: match.source,
			link: match.link,
			matchedKeywords: match.matchedKeywords,
			createdAt: match.discoveredAt || new Date().toISOString(),
		});
	}

	if (nextNotifications.length) {
		state.notifications = [...nextNotifications, ...state.notifications].slice(0, 30);
	}
	return nextNotifications;
}

function emitContextFeedSnapshot(reason = 'snapshot') {
	state.streamVersion += 1;
	const payload = {
		id: state.streamVersion,
		reason,
		snapshot: getContextFeedSnapshot(),
	};
	contextFeedEvents.emit('snapshot', payload);
	return payload;
}

function updateProgressiveFeedState(overrides = {}) {
	state.progressiveFeedState = createProgressiveFeedState({
		...(state.progressiveFeedState || {}),
		...overrides,
	});
	return state.progressiveFeedState;
}

function continueContextFeedBackgroundRefresh({ fastResult = null, backgroundFeeds = [], keywords = [], generalNewsRefreshPromise = Promise.resolve(state.generalNews) } = {}) {
	if (state.backgroundRefreshPromise) {
		return state.backgroundRefreshPromise;
	}

	state.backgroundRefreshPromise = (async () => {
		try {
			const [backgroundResult] = await Promise.all([
				backgroundFeeds.length ? buildMatches(backgroundFeeds, keywords) : Promise.resolve(null),
				generalNewsRefreshPromise.catch(() => state.generalNews),
			]);

			const mergedResult = backgroundResult ? mergeContextMatchCollections(fastResult, backgroundResult, keywords) : fastResult;
			state.contexts = mergedResult?.contexts || createEmptyContexts();
			state.matches = mergedResult?.matches || [];
			state.lastUpdatedAt = new Date().toISOString();
			state.lastError = '';
			appendNotifications(state.matches);
			updateProgressiveFeedState({
				active: false,
				phase: 'complete',
				generalNewsLoadedCount: state.generalNews.length,
				generalNewsTotal: state.generalNews.length,
				matchesLoadedCount: state.matches.length,
				matchesTotal: state.matches.length,
			});
			emitContextFeedSnapshot('refresh-augmented');
			return getContextFeedSnapshot();
		} catch (error) {
			state.lastError = error.message;
			updateProgressiveFeedState({
				active: false,
				phase: 'error',
				generalNewsLoadedCount: state.generalNews.length,
				generalNewsTotal: state.generalNews.length,
				matchesLoadedCount: state.matches.length,
				matchesTotal: state.matches.length,
			});
			logger.error('Context feed background augmentation failed', { error: error.message });
			emitContextFeedSnapshot('refresh-error');
			return getContextFeedSnapshot();
		} finally {
			state.backgroundRefreshPromise = null;
		}
	})();

	return state.backgroundRefreshPromise;
}

export async function refreshContextFeedMonitor({ force = false } = {}) {
	if (state.refreshPromise && !force) {
		return state.refreshPromise;
	}
	if (state.backgroundRefreshPromise && !force) {
		return getContextFeedSnapshot();
	}

	state.refreshPromise = (async () => {
		await ensureStockSymbolCatalog({ force });
		const generalNewsRefreshPromise = refreshGeneralNewsFeed({ force });

		const feeds = await loadContextFeeds();
		const keywords = state.keywords.map((keyword) => buildKeywordMatcher(keyword)).filter(Boolean);
		const feedCatalog = buildContextFeedCatalog(feeds, state.keywords);
		const { fastFeeds } = partitionContextFeedCatalog(feedCatalog);
		state.feedCount = feedCatalog.length;
		updateProgressiveFeedState({
			active: true,
			phase: 'initializing',
			generalNewsLoadedCount: state.generalNews.length,
			generalNewsTotal: state.generalNews.length,
			matchesLoadedCount: 0,
			matchesTotal: Math.max(1, fastFeeds.length),
		});

		if (!keywords.length) {
			const researchFeeds = feedCatalog.filter((feed) => feed?.context === 'research');
			const researchResult = researchFeeds.length ? await buildMatches(researchFeeds, keywords) : null;
			await generalNewsRefreshPromise;
			state.contexts = researchResult?.contexts || createEmptyContexts();
			state.matches = researchResult?.matches || [];
			state.lastUpdatedAt = new Date().toISOString();
			state.lastError = '';
			updateProgressiveFeedState({
				active: false,
				phase: 'complete',
				generalNewsLoadedCount: state.generalNews.length,
				generalNewsTotal: state.generalNews.length,
				matchesLoadedCount: state.matches.length,
				matchesTotal: state.matches.length,
			});
			emitContextFeedSnapshot(researchResult ? 'idle-refresh-research' : 'idle-refresh');
			return getContextFeedSnapshot();
		}

		try {
			const [fastResult] = await Promise.all([buildMatches(fastFeeds, keywords), generalNewsRefreshPromise]);
			state.contexts = fastResult.contexts;
			state.matches = fastResult.matches;
			state.lastUpdatedAt = new Date().toISOString();
			state.lastError = '';
			appendNotifications(fastResult.matches);
			updateProgressiveFeedState({
				active: false,
				phase: 'complete',
				generalNewsLoadedCount: state.generalNews.length,
				generalNewsTotal: state.generalNews.length,
				matchesLoadedCount: fastResult.matches.length,
				matchesTotal: fastResult.matches.length,
			});
			emitContextFeedSnapshot('refresh');

			return getContextFeedSnapshot();
		} catch (error) {
			await generalNewsRefreshPromise.catch(() => {});
			state.lastError = error.message;
			updateProgressiveFeedState({
				active: false,
				phase: 'error',
				generalNewsLoadedCount: state.generalNews.length,
				generalNewsTotal: state.generalNews.length,
				matchesLoadedCount: state.matches.length,
				matchesTotal: state.matches.length,
			});
			logger.error('Context feed refresh failed', { error: error.message });
			emitContextFeedSnapshot('refresh-error');
			return getContextFeedSnapshot();
		}
	})();

	try {
		return await state.refreshPromise;
	} finally {
		state.refreshPromise = null;
	}
}

export function registerContextKeywords(input = []) {
	const nextKeywords = Array.isArray(input) ? input : [input];
	state.keywords = [...new Set([...state.keywords, ...nextKeywords.map((keyword) => normalizeKeyword(keyword)).filter(Boolean)])].slice(0, 20);
	emitContextFeedSnapshot('keywords-updated');
	return state.keywords;
}

export function replaceContextKeywords(input = []) {
	const nextKeywords = Array.isArray(input) ? input : [input];
	state.keywords = [...new Set(nextKeywords.map((keyword) => normalizeKeyword(keyword)).filter(Boolean))].slice(0, 20);
	emitContextFeedSnapshot('keywords-replaced');
	return state.keywords;
}

export function removeContextKeywords(input = []) {
	const nextKeywords = new Set((Array.isArray(input) ? input : [input]).map((keyword) => normalizeKeyword(keyword)).filter(Boolean));
	if (!nextKeywords.size) {
		return state.keywords;
	}

	state.keywords = state.keywords.filter((keyword) => !nextKeywords.has(keyword));
	emitContextFeedSnapshot('keywords-removed');
	return state.keywords;
}

export function getContextFeedSnapshot() {
	return {
		started: state.started,
		streamVersion: state.streamVersion,
		tags: [...state.keywords],
		keywords: [...state.keywords],
		feedCount: state.feedCount,
		lastUpdatedAt: state.lastUpdatedAt,
		lastError: state.lastError,
		generalNews: [...state.generalNews],
		generalNewsLastUpdatedAt: state.generalNewsLastUpdatedAt,
		generalNewsLastError: state.generalNewsLastError,
		progressiveFeedState: { ...(state.progressiveFeedState || createProgressiveFeedState()) },
		contexts: {
			research: [...state.contexts.research],
			news: [...state.contexts.news],
			shopping: [...state.contexts.shopping],
		},
		matches: [...state.matches],
		notifications: [...state.notifications],
		feedHealth: { ...state.feedHealth },
	};
}

export async function getContextFeedPortalData() {
	const feeds = await loadContextFeeds();
	const catalog = buildContextFeedCatalog(feeds, state.keywords);

	// Also load just the user-added ones to identify them in the UI
	let userAdded = [];
	try {
		const raw = await readFile(CONTEXT_FEEDS_FILE, 'utf-8');
		userAdded = JSON.parse(raw);
		if (!Array.isArray(userAdded)) userAdded = [];
	} catch (err) {}

	return {
		status: {
			started: state.started,
			streamVersion: state.streamVersion,
			xRefreshEnabled: Boolean(state.xTimer),
			feedCount: state.feedCount,
			lastUpdatedAt: state.lastUpdatedAt,
			lastError: state.lastError,
			generalNewsLastUpdatedAt: state.generalNewsLastUpdatedAt,
			generalNewsLastError: state.generalNewsLastError,
		},
		config: {
			refreshMs: CONTEXT_FEED_REFRESH_MS,
			xRefreshMs: X_FEED_REFRESH_MS,
			itemsPerSource: CONTEXT_FEED_ITEMS_PER_SOURCE,
			matchLimit: CONTEXT_FEED_MATCH_LIMIT,
			searchEngineRefreshMs: CONTEXT_SEARCH_ENGINE_REFRESH_MS,
			generalNewsSourceLimit: GENERAL_NEWS_SOURCE_LIMIT,
			generalNewsItemLimit: GENERAL_NEWS_ITEM_LIMIT,
			searchEngines: CONTEXT_SEARCH_ENGINE_ENGINES,
			actuallyRelevantApiBase: ACTUALLY_RELEVANT_API_BASE_URL,
			generalNewsSourcesUrl: GENERAL_NEWS_SOURCES_URL,
		},
		tags: state.keywords,
		sources: {
			builtin: buildBuiltinContextFeeds(),
			generalNewsCatalog: selectGeneralNewsSources(state.generalNewsSourceCatalog),
			configuredAlerts: parseConfiguredAlertFeeds(),
			userAdded,
			blocked: [...state.blockedFeedUrls],
		},
		catalog,
		feedHealth: state.feedHealth,
		output: {
			matches: state.matches.slice(0, CONTEXT_FEED_MATCH_LIMIT),
			generalNews: state.generalNews.slice(0, GENERAL_NEWS_ITEM_LIMIT),
		},
	};
}

export function subscribeToContextFeedMonitor(listener) {
	if (typeof listener !== 'function') {
		return () => {};
	}

	contextFeedEvents.on('snapshot', listener);
	return () => {
		contextFeedEvents.off('snapshot', listener);
	};
}

export function stopContextFeedMonitor() {
	if (state.timer) {
		clearInterval(state.timer);
		state.timer = null;
	}
	if (state.xTimer) {
		clearInterval(state.xTimer);
		state.xTimer = null;
	}
	state.started = false;
}

export function resetContextFeedMonitorForTests() {
	stopContextFeedMonitor();
	searchEngineCache.clear();
	resetStockSymbolCatalogForTests();
	state.refreshPromise = null;
	state.backgroundRefreshPromise = null;
	state.generalNewsPromise = null;
	state.generalNewsSourceCatalog = [];
	state.generalNewsSourceCatalogFetchedAt = 0;
	state.keywords = [];
	state.feedCount = 0;
	state.lastUpdatedAt = '';
	state.lastError = '';
	state.contexts = createEmptyContexts();
	state.matches = [];
	state.generalNews = [];
	state.generalNewsLastUpdatedAt = '';
	state.generalNewsLastError = '';
	state.notifications = [];
	state.seenMatchIds = new Set();
	state.streamVersion = 0;
	state.progressiveFeedState = createProgressiveFeedState();
	if (state.xTimer) {
		clearInterval(state.xTimer);
		state.xTimer = null;
	}
	contextFeedEvents.removeAllListeners('snapshot');
}

export function startContextFeedMonitor() {
	if (state.started) return;
	state.started = true;
	emitContextFeedSnapshot('started');
	void (async () => {
		await loadBlockedFeeds();
		await refreshContextFeedMonitor().catch(() => {});
	})();
	state.timer = setInterval(() => {
		void refreshContextFeedMonitor().catch(() => {});
	}, CONTEXT_FEED_REFRESH_MS);
	syncContextFeedMonitorXSchedule();
	logger.info('Context feed monitor started', {
		refreshMs: CONTEXT_FEED_REFRESH_MS,
		xRefreshMs: hasXCredentials() ? X_FEED_REFRESH_MS : 0,
	});
}

export function syncContextFeedMonitorXSchedule() {
	if (state.xTimer) {
		clearInterval(state.xTimer);
		state.xTimer = null;
	}

	if (!state.started || !hasXCredentials()) {
		return;
	}

	state.xTimer = setInterval(() => {
		void refreshContextFeedMonitor().catch(() => {});
	}, X_FEED_REFRESH_MS);
}

export async function addContextFeedSource(feed = {}) {
	if (!feed?.url) throw new Error('Feed URL is required');

	let resolvedSource;
	try {
		resolvedSource = await resolveContextSourceInput(feed, {
			limit: WEBSITE_FEED_ITEM_LIMIT,
			fallbackTags: state.keywords,
		});
		if (!feed.source) {
			feed.source = buildDefaultContextSourceLabel(feed.url, { useTagTemplate: resolvedSource?.useTagTemplate }) || resolvedSource?.parsed?.title || '';
		}
	} catch (err) {
		const error = new Error(`Could not validate source: ${err.message}`);
		error.status = 400;
		throw error;
	}

	const feedUrl = resolvedSource.storageUrl;

	// Only get the user-added feeds from the file
	let userFeeds = [];
	try {
		const raw = await readFile(CONTEXT_FEEDS_FILE, 'utf-8');
		userFeeds = JSON.parse(raw);
		if (!Array.isArray(userFeeds)) userFeeds = [];
	} catch (err) {
		// File might not exist yet
	}

	const exists = userFeeds.some((f) => f.url === feedUrl);
	if (exists) throw new Error('Feed already exists');

	const newFeed = {
		source: feed.source || 'Custom Source',
		url: feedUrl,
		homepage: resolvedSource.homepage || feed.url,
		type:
			resolvedSource.useTagTemplate ? 'tag-template'
			: resolvedSource.type === 'website-feed' ? 'website-feed'
			: undefined,
		urlTemplate: resolvedSource.useTagTemplate ? resolvedSource.baseUrl : undefined,
		replaceTagValue: resolvedSource.useTagTemplate ? resolvedSource.replaceTagValue || undefined : undefined,
		sampleTag: resolvedSource.useTagTemplate ? resolvedSource.testTag : undefined,
		context: feed.context || 'news',
		tags:
			Array.isArray(feed.tags) && feed.tags.length ? feed.tags
			: resolvedSource.useTagTemplate ? ['custom', 'template']
			: resolvedSource.type === 'website-feed' ? ['custom', 'website']
			: ['custom'],
	};

	userFeeds.push(newFeed);
	await writeFile(CONTEXT_FEEDS_FILE, JSON.stringify(userFeeds, null, 2));
	return newFeed;
}

export async function removeContextFeedSource(url = '') {
	if (!url) throw new Error('Feed URL is required');

	let userFeeds = [];
	try {
		const raw = await readFile(CONTEXT_FEEDS_FILE, 'utf-8');
		userFeeds = JSON.parse(raw);
		if (!Array.isArray(userFeeds)) userFeeds = [];
	} catch (err) {
		return; // Nothing to remove
	}

	const initialLength = userFeeds.length;
	userFeeds = userFeeds.filter((f) => f.url !== url);

	if (userFeeds.length !== initialLength) {
		await writeFile(CONTEXT_FEEDS_FILE, JSON.stringify(userFeeds, null, 2));
	}
}

export async function getContextFeedSourcePreview(input = '') {
	const request = normalizeSourceRequest(input);
	if (!request?.url) throw new Error('URL is required');

	try {
		const resolvedSource = await resolveContextSourceInput(request, {
			limit: WEBSITE_FEED_ITEM_LIMIT,
			fallbackTags: state.keywords,
		});
		const parsed = resolvedSource.parsed;

		return {
			title: parsed.title || 'Unknown Title',
			description: parsed.description || '',
			itemCount: parsed.items.length,
			sourceType: resolvedSource.useTagTemplate ? 'tag-template' : resolvedSource.type,
			validationMethod: resolvedSource.validationMethod,
			usesTagTemplate: resolvedSource.useTagTemplate,
			baseUrl: resolvedSource.useTagTemplate ? resolvedSource.baseUrl : '',
			replaceTagValue: resolvedSource.useTagTemplate ? resolvedSource.replaceTagValue || '' : '',
			testTag: resolvedSource.useTagTemplate ? resolvedSource.testTag : '',
			testedUrl: resolvedSource.testedUrl || resolvedSource.finalUrl,
			items: parsed.items.slice(0, 3).map((item) => ({
				title: item.title,
				link: item.link,
				pubDate: parsePublishedAt(item),
			})),
			finalUrl: resolvedSource.finalUrl,
		};
	} catch (err) {
		throw new Error(`Feed Validation Failed: ${err.message}`);
	}
}

export async function updateContextFeedSource(oldUrl = '', updatedFeed = {}) {
	if (!oldUrl) throw new Error('Old feed URL is required');
	if (!updatedFeed?.url) throw new Error('New feed URL is required');

	let resolvedSource = null;
	let feedUrl = oldUrl;

	let userFeeds = [];
	try {
		const raw = await readFile(CONTEXT_FEEDS_FILE, 'utf-8');
		userFeeds = JSON.parse(raw);
		if (!Array.isArray(userFeeds)) userFeeds = [];
	} catch (err) {
		throw new Error('No custom feeds found to update');
	}

	const index = userFeeds.findIndex((f) => f.url === oldUrl);
	if (index === -1) throw new Error('Source not found');
	const existingFeed = userFeeds[index] || {};

	resolvedSource = {
		storageUrl: oldUrl,
		homepage: existingFeed.homepage || updatedFeed.url,
		type: existingFeed.type,
		useTagTemplate: existingFeed.type === 'tag-template',
		baseUrl: existingFeed.urlTemplate || existingFeed.url || '',
		replaceTagValue: existingFeed.replaceTagValue || '',
		testTag: existingFeed.sampleTag || '',
		parsed: null,
	};

	const shouldValidate = oldUrl !== updatedFeed.url || isTagTemplateSource(updatedFeed) || existingFeed.type === 'tag-template';
	if (shouldValidate) {
		try {
			resolvedSource = await resolveContextSourceInput(updatedFeed, {
				limit: WEBSITE_FEED_ITEM_LIMIT,
				fallbackTags: state.keywords,
			});
			feedUrl = resolvedSource.storageUrl;
			if (!updatedFeed.source) {
				updatedFeed.source = buildDefaultContextSourceLabel(updatedFeed.url, { useTagTemplate: resolvedSource?.useTagTemplate }) || resolvedSource?.parsed?.title || '';
			}
		} catch (err) {
			const error = new Error(`Could not validate updated source: ${err.message}`);
			error.status = 400; // Bad Request
			throw error;
		}
	}

	// Check if the new URL conflicts with another existing source (if URL is changed)
	if (oldUrl !== feedUrl) {
		const conflict = userFeeds.some((f, i) => i !== index && f.url === feedUrl);
		if (conflict) throw new Error('Another feed with this URL already exists');
	}

	userFeeds[index] = {
		source: updatedFeed.source || 'Custom Source',
		url: feedUrl,
		homepage: resolvedSource.homepage || updatedFeed.url,
		type:
			resolvedSource.useTagTemplate ? 'tag-template'
			: resolvedSource.type === 'website-feed' ? 'website-feed'
			: undefined,
		urlTemplate: resolvedSource.useTagTemplate ? resolvedSource.baseUrl : undefined,
		replaceTagValue: resolvedSource.useTagTemplate ? resolvedSource.replaceTagValue || undefined : undefined,
		sampleTag: resolvedSource.useTagTemplate ? resolvedSource.testTag : undefined,
		context: updatedFeed.context || 'news',
		tags:
			Array.isArray(updatedFeed.tags) && updatedFeed.tags.length ? updatedFeed.tags
			: resolvedSource.useTagTemplate ? ['custom', 'template']
			: resolvedSource.type === 'website-feed' ? ['custom', 'website']
			: ['custom'],
	};

	await writeFile(CONTEXT_FEEDS_FILE, JSON.stringify(userFeeds, null, 2));
	return userFeeds[index];
}

async function loadBlockedFeeds() {
	try {
		const raw = await readFile(BLOCKED_FEEDS_FILE, 'utf-8');
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			state.blockedFeedUrls = new Set(parsed);
		}
	} catch (error) {
		// File might not exist
	}
}

async function saveBlockedFeeds() {
	try {
		await writeFile(BLOCKED_FEEDS_FILE, JSON.stringify([...state.blockedFeedUrls], null, 2));
	} catch (error) {
		logger.error('Failed to save blocked feeds', { error: error.message });
	}
}

export async function blockContextFeedUrl(url = '') {
	if (!url) throw new Error('URL is required');
	state.blockedFeedUrls.add(url);
	await saveBlockedFeeds();
}

export async function unblockContextFeedUrl(url = '') {
	if (!url) throw new Error('URL is required');
	state.blockedFeedUrls.delete(url);
	await saveBlockedFeeds();
}
