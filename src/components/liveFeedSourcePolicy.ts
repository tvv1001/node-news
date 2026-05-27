function normalizeText(value = '') {
	return String(value || '')
		.toLowerCase()
		.trim();
}

const FRESH_LIVE_FEED_PUBLISHED_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const LIVE_FEED_HOT_WINDOW_MS = 6 * 60 * 60 * 1000;
const LIVE_FEED_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

function getUrlParts(value = '') {
	try {
		const url = new URL(String(value || '').trim());
		return {
			hostname: url.hostname.toLowerCase().replace(/^www\./, ''),
			pathname: url.pathname.toLowerCase(),
			search: url.search.toLowerCase(),
		};
	} catch {
		return {
			hostname: '',
			pathname: '',
			search: '',
		};
	}
}

function getPathSegments(pathname = '') {
	return String(pathname || '')
		.split('/')
		.map((segment) => segment.trim())
		.filter(Boolean);
}

export function isDirectXStatusUrl(value = '') {
	const { hostname, pathname } = getUrlParts(value);
	return /(^|\.)(twitter\.com)$/i.test(hostname) && /\/status\/\d+/i.test(pathname);
}

export function isRedditPostUrl(value = '') {
	const { hostname, pathname } = getUrlParts(value);
	if (hostname === 'redd.it') return pathname.length > 1;
	if (!/(^|\.)reddit\.com$/i.test(hostname)) return false;
	return /\/comments\//i.test(pathname);
}

function isGoogleNewsSource(source = '') {
	return normalizeText(source).includes('google news');
}

function isYahooSource(source = '') {
	return normalizeText(source).includes('yahoo');
}

function isInvestingSource(source = '') {
	return normalizeText(source).includes('investing.com');
}

function isRedditSource(source = '') {
	return normalizeText(source).includes('reddit');
}

function isSearchSource(source = '') {
	return normalizeText(source).includes('search');
}

function isSearchResultsPage(link = '') {
	const { hostname, pathname } = getUrlParts(link);
	if (!hostname) return false;
	if (/^news\.google\.com$/i.test(hostname)) return false;
	if (/^search\.yahoo\.com$/i.test(hostname)) return true;
	if (/^duckduckgo\.com$/i.test(hostname)) return true;
	if (/^bing\.com$/i.test(hostname) && pathname.startsWith('/search')) return true;
	if (/(^|\.)google\.com$/i.test(hostname) && pathname.startsWith('/search')) return true;
	return false;
}

function isYahooNewsArticleUrl(link = '') {
	const { hostname, pathname } = getUrlParts(link);
	return /^news\.yahoo\.com$/i.test(hostname) && pathname !== '/' && !pathname.startsWith('/video');
}

function isYahooFinanceNewsArticleUrl(link = '') {
	const { hostname, pathname } = getUrlParts(link);
	return /^finance\.yahoo\.com$/i.test(hostname) && /^\/news(?:\/|$)/i.test(pathname);
}

function isLowValueFinanceLandingPage(link = '', title = '', summary = '') {
	const { hostname, pathname, search } = getUrlParts(link);
	const normalizedTitle = normalizeText(title);
	const normalizedSummary = normalizeText(summary);

	const matchesQuoteCopy =
		normalizedTitle.includes('stock price') ||
		normalizedTitle.includes('stock quote') ||
		normalizedTitle.includes('quote & history') ||
		normalizedTitle.includes('price, news, quote') ||
		normalizedTitle.includes('price & news') ||
		normalizedSummary.includes('stock price') ||
		normalizedSummary.includes('stock quote') ||
		normalizedSummary.includes('quote & history');

	if (/^finance\.yahoo\.com$/i.test(hostname) && /^\/quote(?:\/|$)/i.test(pathname)) return true;
	if (/^marketwatch\.com$/i.test(hostname) && /^\/investing\/stock(?:\/|$)/i.test(pathname)) return true;
	if (/^stockanalysis\.com$/i.test(hostname) && /^\/stocks(?:\/|$)/i.test(pathname)) return true;
	if (/^cnbc\.com$/i.test(hostname) && /^\/quotes(?:\/|$)/i.test(pathname)) return true;
	if (/^wsj\.com$/i.test(hostname) && /^\/market-data\/quotes(?:\/|$)/i.test(pathname)) return true;
	if (/^markets\.financialcontent\.com$/i.test(hostname) && pathname.startsWith('/stocks/quote')) return true;
	if (/^research\.investors\.com$/i.test(hostname) && /^\/stock-quotes(?:\/|$)/i.test(pathname)) return true;
	if (/^google\.com$/i.test(hostname) && pathname.startsWith('/finance')) return true;
	if ((pathname.includes('/quote/') || search.includes('quote')) && matchesQuoteCopy) return true;

	return false;
}

function hasArticleLikePath(link = '') {
	const { pathname } = getUrlParts(link);
	const segments = getPathSegments(pathname);
	if (!segments.length) return false;
	if (/\/(news|article|articles|story|stories|post|posts)(\/|$)/i.test(pathname)) return true;
	if (/\/20\d{2}\/\d{1,2}\/\d{1,2}(\/|$)/.test(pathname)) return true;

	const lastSegment = segments.at(-1) || '';
	if (lastSegment.includes('-') && lastSegment.length >= 12) return true;
	return segments.length >= 3;
}

function hasArticleLikeCopy(title = '', summary = '') {
	const normalizedTitle = normalizeText(title);
	const normalizedSummary = normalizeText(summary);
	const titleWordCount = normalizedTitle.split(/\s+/).filter(Boolean).length;

	if (titleWordCount >= 5 && normalizedTitle.length >= 24) return true;
	return normalizedSummary.length >= 80;
}

function isLikelyNewsArticleUrl(link = '', title = '', summary = '') {
	if (!link || isSearchResultsPage(link) || isLowValueFinanceLandingPage(link, title, summary)) return false;
	if (isYahooNewsArticleUrl(link) || isYahooFinanceNewsArticleUrl(link)) return true;

	const { hostname, pathname } = getUrlParts(link);
	if (!hostname || pathname === '/') return false;
	if (/^search\.yahoo\.com$/i.test(hostname)) return false;
	if (/^duckduckgo\.com$/i.test(hostname)) return false;
	if (/^bing\.com$/i.test(hostname) && pathname.startsWith('/search')) return false;
	if (/(^|\.)google\.com$/i.test(hostname) && pathname.startsWith('/search')) return false;

	return hasArticleLikePath(link) || hasArticleLikeCopy(title, summary);
}

function getPublishedTime(item: any = {}) {
	const value = item?.publishedAt || item?.discoveredAt;
	const timestamp = Date.parse(String(value || '').trim());
	return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function getLiveFeedFreshnessBoost(item: any = {}) {
	const publishedTime = getPublishedTime(item);
	if (!publishedTime) return 0;

	const ageMs = Math.max(0, Date.now() - publishedTime);
	if (ageMs <= LIVE_FEED_HOT_WINDOW_MS) return 3;
	if (ageMs <= LIVE_FEED_RECENT_WINDOW_MS) return 2;
	if (ageMs <= FRESH_LIVE_FEED_PUBLISHED_LOOKBACK_MS) return 1;
	return 0;
}

export function hasFreshPublishedAt(item: any = {}) {
	return getLiveFeedFreshnessBoost(item) > 0;
}

export function isAllowedLiveFeedItem(item: any = {}) {
	const source = String(item?.source || '');
	const title = String(item?.title || '');
	const summary = String(item?.summary || '');
	const link = String(item?.link || '');
	const isArticleLike = isLikelyNewsArticleUrl(link, title, summary);

	if (!link) return false;
	if (isLowValueFinanceLandingPage(link, title, summary)) return false;
	if (isDirectXStatusUrl(link)) return true;
	if (isRedditPostUrl(link) || isRedditSource(source)) return true;
	if (isGoogleNewsSource(source)) return true;
	if (isYahooNewsArticleUrl(link) || isYahooFinanceNewsArticleUrl(link)) return true;

	// Always allow general news from curated sources if they are fresh
	if (item.type === 'general-news' || item.context === 'research') return hasFreshPublishedAt(item);

	if (isSearchResultsPage(link)) return false;
	if (!isArticleLike) return false;
	if (isSearchSource(source)) return hasFreshPublishedAt(item);

	return hasFreshPublishedAt(item);
}

export function getLiveFeedRecencyPriority(item: any = {}) {
	const source = String(item?.source || '');
	const link = String(item?.link || '');

	if (isDirectXStatusUrl(link)) return 5;
	if (isRedditPostUrl(link) || isRedditSource(source)) return 4;
	if (isGoogleNewsSource(source)) return 3;
	if (isYahooNewsArticleUrl(link) || isYahooFinanceNewsArticleUrl(link)) return 2;
	if (isInvestingSource(source) && isAllowedLiveFeedItem(item)) return 2;
	if (isYahooSource(source) && isAllowedLiveFeedItem(item)) return 1;
	if (hasFreshPublishedAt(item) && isAllowedLiveFeedItem(item)) return 1;
	return 0;
}

export function isSuppressedLiveFeedItem(item: any = {}) {
	return !isAllowedLiveFeedItem(item);
}
