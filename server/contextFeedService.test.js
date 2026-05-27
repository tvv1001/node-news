import test from 'node:test';
import assert from 'node:assert/strict';

import {
	applyTagToUrlTemplate,
	buildContextMatchCandidates,
	buildTagTemplateBaseUrl,
	buildDefaultContextSourceLabel,
	buildActuallyRelevantFeedUrl,
	buildFeedSearchKeywords,
	buildGoogleNewsFeedUrl,
	buildGoogleSearchHomepageUrl,
	buildGoogleNewsSearchHomepageUrl,
	buildGoogleNewsQuoraFeedUrl,
	buildInvestingStockNewsFeeds,
	expandTagTemplateFeed,
	getBuiltinGeneralNewsSources,
	buildGoogleXStockSearchFeed,
	buildGoogleXStockSearchKeyword,
	buildGoogleNewsTopicFeedUrl,
	buildGoogleNewsXFeedUrl,
	buildXSearchFeed,
	buildXPlatformFallbackFeedUrls,
	discoverAlternateFeedUrlsFromHtml,
	extractWebsiteFeedItemsFromHtml,
	buildRedditFeedUrl,
	buildRedditSubredditFeedUrl,
	buildRedditWallStreetBetsFeedUrl,
	extractFeedItemPreviewImage,
	extractPublishedAtFromSearchResult,
	getContextFeedSnapshot,
	matchContextText,
	normalizeSearchEngineResultItem,
	normalizeActuallyRelevantStory,
	normalizeHackerNewsStoryItem,
	parseConfiguredAlertFeeds,
	registerContextKeywords,
	removeContextKeywords,
	replaceContextKeywords,
	resolveContextMatchPreviewImage,
	resetContextFeedMonitorForTests,
	partitionContextFeedCatalog,
	selectMatchesWithKeywordCoverage,
	selectGeneralNewsSources,
	sortContextFeedCatalog,
	sortContextMatchesNewestFirst,
	subscribeToContextFeedMonitor,
} from './services/context/contextFeedService.js';
import { resetStockSymbolCatalogForTests, seedStockSymbolCatalogForTests } from './services/context/stockSymbolRegistry.js';
import { buildSearchEngineQueries, buildYahooSearchQueries } from './services/crawler/searchEngines.js';

test.beforeEach(() => {
	resetContextFeedMonitorForTests();
	resetStockSymbolCatalogForTests();
});

test('registerContextKeywords normalizes and deduplicates keywords', () => {
	registerContextKeywords(['Quantum Lattice', 'quantum lattice', 'news alerts']);
	const snapshot = getContextFeedSnapshot();

	assert.ok(snapshot.keywords.includes('quantum lattice'));
	assert.ok(snapshot.keywords.includes('news alerts'));
	assert.equal(snapshot.keywords.filter((keyword) => keyword === 'quantum lattice').length, 1);
});

test('getContextFeedSnapshot exposes progressive feed state by default', () => {
	const snapshot = getContextFeedSnapshot();

	assert.deepEqual(snapshot.progressiveFeedState, {
		active: false,
		phase: 'complete',
		generalNewsLoadedCount: 0,
		generalNewsTotal: 0,
		matchesLoadedCount: 0,
		matchesTotal: 0,
	});
});

test('buildDefaultContextSourceLabel keeps x search templates labeled as x instead of Google News fallback titles', () => {
	assert.equal(buildDefaultContextSourceLabel('https://x.com/search?q=tsla&f=live', { useTagTemplate: true }), 'X Search Template');
	assert.equal(buildDefaultContextSourceLabel('https://x.com/search?q=tsla&f=live'), 'X Search');
});

test('subscribeToContextFeedMonitor receives keyword update snapshots', () => {
	const events = [];
	const unsubscribe = subscribeToContextFeedMonitor((payload) => {
		events.push(payload);
	});

	registerContextKeywords(['breaking updates']);
	unsubscribe();

	assert.equal(events.length, 1);
	assert.equal(events[0].reason, 'keywords-updated');
	assert.ok(events[0].snapshot.keywords.includes('breaking updates'));
	assert.equal(events[0].snapshot.streamVersion, 1);
});

test('replaceContextKeywords swaps tag words and removeContextKeywords deletes selected tags', () => {
	replaceContextKeywords(['ai policy', 'research tools']);
	removeContextKeywords(['ai policy']);
	const snapshot = getContextFeedSnapshot();

	assert.deepEqual(snapshot.tags, ['research tools']);
	assert.deepEqual(snapshot.keywords, ['research tools']);
});

test('asset tags match stock-related company news even without a dollar ticker in the article', () => {
	const match = matchContextText('Tesla stock climbs after analysts raise price targets and Wall Street cheers earnings guidance.', ['$tsla']);

	assert.equal(match.score > 0, true);
	assert.deepEqual(match.matchedKeywords, ['$tsla']);
});

test('bare known stock symbols inherit finance alias matching', () => {
	seedStockSymbolCatalogForTests({ symbols: ['TSLA', 'MSFT', 'AAPL'] });
	const match = matchContextText('Tesla stock climbs after analysts raise price targets and Wall Street cheers earnings guidance.', ['tsla']);

	assert.equal(match.score > 0, true);
	assert.deepEqual(match.matchedKeywords, ['tsla']);
});

test('asset tags match broader Tesla stock market language', () => {
	const match = matchContextText('Tesla shares rally as analysts upgrade the stock and options volume spikes after earnings.', ['$tsla']);

	assert.equal(match.score > 0, true);
	assert.deepEqual(match.matchedKeywords, ['$tsla']);
});

test('asset tags match Tesla equity coverage with shareholder language', () => {
	const match = matchContextText('Tesla equity investors watch shareholder sentiment, market cap swings, and bullish call options activity.', ['$tsla']);

	assert.equal(match.score > 0, true);
	assert.deepEqual(match.matchedKeywords, ['$tsla']);
});

test('asset tags do not match broad company mentions when the article is not stock-related', () => {
	const match = matchContextText('Microsoft launches a new Copilot feature for Windows developers this week.', ['$msft']);

	assert.equal(match.score, 0);
	assert.deepEqual(match.matchedKeywords, []);
});

test('asset tags match news feed items that mention the ticker alias even without stock-market wording', () => {
	const match = matchContextText('Tesla unveils a refreshed vehicle lineup for summer deliveries.', ['$tsla'], { context: 'news' });

	assert.equal(match.score > 0, true);
	assert.deepEqual(match.matchedKeywords, ['$tsla']);
});

test('asset tags still match direct ticker mentions', () => {
	const match = matchContextText('Market recap: $MSFT rallies as traders react to earnings.', ['$msft']);

	assert.equal(match.score > 0, true);
	assert.deepEqual(match.matchedKeywords, ['$msft']);
});

test('OR expressions match when either term is present', () => {
	const match = matchContextText('Nvidia unveils another AI chip for data centers.', ['tesla or nvidia']);

	assert.equal(match.score > 0, true);
	assert.deepEqual(match.matchedKeywords, ['tesla or nvidia']);
});

test('AND expressions require both terms to be present', () => {
	const positiveMatch = matchContextText('AI policy talks continue as lawmakers debate new AI safety rules.', ['ai and policy']);
	const negativeMatch = matchContextText('AI safety rules are being debated again this week.', ['ai and policy']);

	assert.equal(positiveMatch.score > 0, true);
	assert.deepEqual(positiveMatch.matchedKeywords, ['ai and policy']);
	assert.equal(negativeMatch.score, 0);
	assert.deepEqual(negativeMatch.matchedKeywords, []);
});

test('mixed AND/OR expressions support grouped matching with AND precedence', () => {
	const firstClauseMatch = matchContextText('Tesla opens a new battery plant in Texas.', ['tesla or ai and policy']);
	const secondClauseMatch = matchContextText('AI policy negotiations intensify in Brussels.', ['tesla or ai and policy']);
	const noMatch = matchContextText('Policy negotiations intensify in Brussels.', ['tesla or ai and policy']);

	assert.equal(firstClauseMatch.score > 0, true);
	assert.deepEqual(firstClauseMatch.matchedKeywords, ['tesla or ai and policy']);
	assert.equal(secondClauseMatch.score > 0, true);
	assert.deepEqual(secondClauseMatch.matchedKeywords, ['tesla or ai and policy']);
	assert.equal(noMatch.score, 0);
	assert.deepEqual(noMatch.matchedKeywords, []);
});

test('quoted phrases and exclusion operators work in tag matching', () => {
	const positiveMatch = matchContextText('Quantum computing startups keep growing across the sector.', ['"quantum computing" -crypto']);
	const negativeMatch = matchContextText('Quantum computing and crypto startups keep growing together.', ['"quantum computing" -crypto']);

	assert.equal(positiveMatch.score > 0, true);
	assert.deepEqual(positiveMatch.matchedKeywords, ['"quantum computing" -crypto']);
	assert.equal(negativeMatch.score, 0);
	assert.deepEqual(negativeMatch.matchedKeywords, []);
});

test('site and source operators work in tag matching', () => {
	const siteMatch = matchContextText('AI policy coverage from The Verge', ['site:theverge.com ai'], {
		title: 'AI policy coverage',
		url: 'https://www.theverge.com/2026/05/13/ai-policy',
		source: 'The Verge',
		context: 'news',
	});
	const sourceMatch = matchContextText('AI policy coverage from The Verge', ['source:the_verge ai'], {
		title: 'AI policy coverage',
		url: 'https://www.example.com/2026/05/13/ai-policy',
		source: 'The Verge',
		context: 'news',
	});

	assert.equal(siteMatch.score > 0, true);
	assert.deepEqual(siteMatch.matchedKeywords, ['site:theverge.com ai']);
	assert.equal(sourceMatch.score > 0, true);
	assert.deepEqual(sourceMatch.matchedKeywords, ['source:the_verge ai']);
});

test('before and after operators work in tag matching', () => {
	const beforeMatch = matchContextText('Older AI policy coverage', ['ai before:2026-01-01'], {
		title: 'Older AI policy coverage',
		url: 'https://example.com/old',
		source: 'Example',
		publishedAt: '2025-12-31T12:00:00.000Z',
		context: 'news',
	});
	const afterMatch = matchContextText('Newer AI policy coverage', ['ai after:2026-01-01'], {
		title: 'Newer AI policy coverage',
		url: 'https://example.com/new',
		source: 'Example',
		publishedAt: '2026-05-13T12:00:00.000Z',
		context: 'news',
	});
	const noMatch = matchContextText('Older AI policy coverage', ['ai after:2026-01-01'], {
		title: 'Older AI policy coverage',
		url: 'https://example.com/old',
		source: 'Example',
		publishedAt: '2025-12-31T12:00:00.000Z',
		context: 'news',
	});

	assert.equal(beforeMatch.score > 0, true);
	assert.equal(afterMatch.score > 0, true);
	assert.equal(noMatch.score, 0);
});

test('buildGoogleNewsFeedUrl preserves advanced Google-style operators', () => {
	const url = new URL(buildGoogleNewsFeedUrl('site:theverge.com "ai policy" after:2026-01-01'));
	const query = url.searchParams.get('q') || '';

	assert.equal(query, 'site:theverge.com "ai policy" after:2026-01-01');
});

test('buildFeedSearchKeywords expands pipe-separated expressions into separate RSS queries', () => {
	assert.deepEqual(buildFeedSearchKeywords('(tsla | pltr | quantum | karp)'), ['tsla', 'pltr', 'quantum', 'karp']);
});

test('buildFeedSearchKeywords preserves shared filters while splitting OR branches', () => {
	assert.deepEqual(buildFeedSearchKeywords('site:x.com (tsla | pltr)'), ['site:x.com tsla', 'site:x.com pltr']);
});

test('advanced search operators are preserved for search engine queries', () => {
	assert.deepEqual(buildSearchEngineQueries({ searchTerm: 'site:gov "land records" after:2025-01-01', city: 'Austin', state: 'TX' }), ['site:gov "land records" after:2025-01-01']);
	assert.deepEqual(buildYahooSearchQueries({ searchTerm: 'site:gov "land records" after:2025-01-01', city: 'Austin', state: 'TX' }), ['site:gov "land records" after:2025-01-01']);
});

test('buildRedditFeedUrl preserves boolean expressions for non-asset tags', () => {
	const url = new URL(buildRedditFeedUrl('ai and policy'));

	assert.equal(url.searchParams.get('q'), 'ai AND policy');
	assert.equal(url.searchParams.get('sort'), 'new');
});

test('buildGoogleNewsFeedUrl builds a tag-scoped Google News RSS feed', () => {
	const url = new URL(buildGoogleNewsFeedUrl('quantum lattice'));

	assert.equal(url.origin, 'https://news.google.com');
	assert.equal(url.pathname, '/rss/search');
	assert.equal(url.searchParams.get('q'), 'quantum lattice');
	assert.equal(url.searchParams.get('hl'), 'en-US');
	assert.equal(url.searchParams.get('gl'), 'US');
	assert.equal(url.searchParams.get('ceid'), 'US:en');
});

test('buildGoogleNewsFeedUrl expands asset tags into stock-aware Google News queries', () => {
	const url = new URL(buildGoogleNewsFeedUrl('$tsla'));
	const query = url.searchParams.get('q') || '';

	assert.match(query, /tesla/i);
	assert.match(query, /tsla/i);
	assert.match(query, /stock/i);
});

test('buildGoogleNewsXFeedUrl adds an x.com site restriction for live social feeds', () => {
	const url = new URL(buildGoogleNewsXFeedUrl('$tsla'));
	const query = url.searchParams.get('q') || '';

	assert.equal(url.origin, 'https://news.google.com');
	assert.equal(url.pathname, '/rss/search');
	assert.match(query, /\$TSLA/i);
	assert.match(query, /tesla/i);
	assert.match(query, /tsla/i);
	assert.match(query, /\bOR\b/i);
	assert.match(query, /site:x\.com/i);
	assert.equal(url.searchParams.get('hl'), 'en-US');
	assert.equal(url.searchParams.get('gl'), 'US');
	assert.equal(url.searchParams.get('ceid'), 'US:en');
});

test('buildXSearchFeed builds a tag-driven live x search feed', () => {
	const feed = buildXSearchFeed('tsla');

	assert.ok(feed);
	assert.equal(feed.source, 'X Search');
	assert.equal(feed.context, 'research');
	assert.equal(feed.homepage, 'https://x.com/search?q=tsla&f=live');
assert.equal(feed.url, 'http://localhost:3001/api/x/twitter/keyword/tsla');
assert.equal(feed.urlTemplate, 'https://x.com/search?q={tag}&f=live');
assert.equal(feed.parentUrl, 'https://x.com/search?q={tag}&f=live');
assert.equal(feed.templateTag, 'tsla');
assert.equal(feed.tags.includes('x.com'), true);
assert.equal(feed.tags.includes('live-search'), true);
});

test('buildXPlatformFallbackFeedUrls includes a Google News fallback for X keyword routes', () => {
	const fallbackUrls = buildXPlatformFallbackFeedUrls('http://localhost:3001/api/x/twitter/keyword/%23finra');

test('buildXPlatformFallbackFeedUrls keeps profile routes on RSS-native fallbacks only', () => {
	const fallbackUrls = buildXPlatformFallbackFeedUrls('http://localhost:3001/api/x/twitter/user/finra');

	assert.deepEqual(fallbackUrls, ['https://nitter.poast.org/finra/rss']);
});

test('applyTagToUrlTemplate appends encoded tags and supports explicit placeholders', () => {
	assert.equal(applyTagToUrlTemplate('https://x.com/search?q=', 'gang stalking'), 'https://x.com/search?q=gang%20stalking');
	assert.equal(applyTagToUrlTemplate('https://example.com/search?q={tag}&sort=latest', '#finra'), 'https://example.com/search?q=%23finra&sort=latest');
});

test('expandTagTemplateFeed builds concrete catalog entries for each active tag', () => {
	const feeds = expandTagTemplateFeed(
		{
			source: 'X Search Base',
			url: 'https://x.com/search?q=',
			type: 'tag-template',
			tags: ['custom', 'template'],
			context: 'news',
		},
		['gangstalking', '#finra'],
	);

	assert.deepEqual(
		feeds.map((feed) => ({ source: feed.source, url: feed.url, parentUrl: feed.parentUrl, templateTag: feed.templateTag })),
		[
			{
				source: 'X Search Base · gangstalking',
				url: 'https://x.com/search?q=gangstalking',
				parentUrl: 'https://x.com/search?q=',
				templateTag: 'gangstalking',
			},
			{
				source: 'X Search Base · #finra',
				url: 'https://x.com/search?q=%23finra',
				parentUrl: 'https://x.com/search?q=',
				templateTag: '#finra',
			},
		],
	);
});

test('discoverAlternateFeedUrlsFromHtml finds RSS links from a normal website page', () => {
	const feedUrls = discoverAlternateFeedUrlsFromHtml(
		`<html><head>
			<link rel="alternate" type="application/rss+xml" href="/feed.xml" />
		</head><body><a href="/rss">RSS</a></body></html>`,
		'https://example.com/news',
	);

	assert.deepEqual(feedUrls, ['https://example.com/feed.xml', 'https://example.com/rss']);
});

test('extractWebsiteFeedItemsFromHtml builds items from JSON-LD article lists', () => {
	const items = extractWebsiteFeedItemsFromHtml(
		`<html><head><title>Example News</title></head><body>
		<script type="application/ld+json">
		{
			"@context": "https://schema.org",
			"@type": "ItemList",
			"itemListElement": [
				{
					"@type": "ListItem",
					"position": 1,
					"item": {
						"@type": "NewsArticle",
						"headline": "Major policy update",
						"url": "/articles/policy-update",
						"datePublished": "2026-05-14T12:00:00.000Z",
						"description": "A big change happened.",
						"keywords": ["policy", "news"]
					}
				}
			]
		}
		</script>
		</body></html>`,
		'https://example.com/news',
	);

	assert.equal(items.length, 1);
	assert.equal(items[0].title, 'Major policy update');
	assert.equal(items[0].link, 'https://example.com/articles/policy-update');
	assert.equal(items[0].published, '2026-05-14T12:00:00.000Z');
	assert.deepEqual(items[0].categories, ['policy', 'news']);
});

test('extractWebsiteFeedItemsFromHtml falls back to DOM heuristics for article cards', () => {
	const items = extractWebsiteFeedItemsFromHtml(
		`<html><body>
			<nav><a href="/about">About</a></nav>
			<section>
				<article>
					<h2><a href="/2026/05/14/alpha-breakthrough">Alpha breakthrough changes the roadmap</a></h2>
					<time datetime="2026-05-14T10:00:00.000Z">May 14, 2026</time>
					<p>The team announced a detailed roadmap update with practical milestones.</p>
				</article>
				<article>
					<h2><a href="/2026/05/13/beta-analysis">Beta analysis shows resilient demand</a></h2>
					<p>Analysts shared a full breakdown of the latest results.</p>
				</article>
			</section>
		</body></html>`,
		'https://example.com/news',
	);

	assert.equal(items.length, 2);
	assert.equal(items[0].title, 'Alpha breakthrough changes the roadmap');
	assert.equal(items[0].link, 'https://example.com/2026/05/14/alpha-breakthrough');
	assert.equal(items[0].published, '2026-05-14T10:00:00.000Z');
	assert.match(items[0].summary || '', /roadmap update/i);
	assert.equal(items[1].title, 'Beta analysis shows resilient demand');
	assert.equal(items[1].link, 'https://example.com/2026/05/13/beta-analysis');
});

test('buildGoogleNewsQuoraFeedUrl adds a quora.com site restriction for quick-answer feeds', () => {
	const url = new URL(buildGoogleNewsQuoraFeedUrl('lattice holography'));
	const query = url.searchParams.get('q') || '';

	assert.equal(url.origin, 'https://news.google.com');
	assert.equal(url.pathname, '/rss/search');
	assert.match(query, /lattice holography/i);
	assert.match(query, /site:quora\.com/i);
	assert.equal(url.searchParams.get('hl'), 'en-US');
	assert.equal(url.searchParams.get('gl'), 'US');
	assert.equal(url.searchParams.get('ceid'), 'US:en');
});

test('buildGoogleSearchHomepageUrl uses the plain Google web search structure for general search', () => {
	const url = new URL(buildGoogleSearchHomepageUrl('example', { site: 'facebook.com' }));

	assert.equal(url.origin, 'https://www.google.com');
	assert.equal(url.pathname, '/search');
	assert.equal(url.searchParams.get('q'), 'example site:facebook.com');
	assert.equal(url.searchParams.get('num'), '10');
	assert.equal(url.searchParams.get('newwindow'), '1');
	assert.equal(url.searchParams.get('tbm'), null);
	assert.equal(url.searchParams.get('tbs'), null);
	assert.equal(url.searchParams.get('sxsrf'), null);
});

test('buildGoogleNewsSearchHomepageUrl uses the clean newest-first Google News search parameters', () => {
	const url = new URL(buildGoogleNewsSearchHomepageUrl('$tsla', { site: 'x.com' }));
	const query = url.searchParams.get('q') || '';

	assert.equal(url.origin, 'https://www.google.com');
	assert.equal(url.pathname, '/search');
	assert.equal(url.searchParams.get('num'), '10');
	assert.equal(url.searchParams.get('newwindow'), '1');
	assert.equal(url.searchParams.get('tbm'), 'nws');
	assert.equal(url.searchParams.get('tbs'), 'sbd:1');
	assert.match(query, /^\(/);
	assert.match(query, /\$TSLA/i);
	assert.match(query, /tesla/i);
	assert.match(query, /tsla/i);
	assert.match(query, /site:x\.com/i);
	assert.equal(url.searchParams.get('ved'), null);
	assert.equal(url.searchParams.get('biw'), null);
	assert.equal(url.searchParams.get('bih'), null);
});

test('buildGoogleXStockSearchKeyword uses a site-scoped cashtag query for asset tags', () => {
	assert.equal(buildGoogleXStockSearchKeyword('$tsla'), 'site:x.com $tsla');
	assert.equal(buildGoogleXStockSearchKeyword('tsla'), 'site:x.com $tsla');
	assert.equal(buildGoogleXStockSearchKeyword('quantum'), '');
});

test('buildGoogleXStockSearchKeyword suppresses unknown cashtags when the stock catalog is loaded', () => {
	seedStockSymbolCatalogForTests({ symbols: ['TSLA', 'MSFT', 'AAPL'] });

	assert.equal(buildGoogleXStockSearchKeyword('$tsla'), 'site:x.com $tsla');
	assert.equal(buildGoogleXStockSearchKeyword('$notarealsymbol'), '');
});

test('buildGoogleXStockSearchFeed builds a dedicated Google web-search fallback for stock cashtags', () => {
	const feed = buildGoogleXStockSearchFeed('$tsla');

	assert.ok(feed);
	assert.equal(feed.type, 'search-engine');
	assert.equal(feed.engine, 'google');
	assert.equal(feed.source, 'Google Search · X cashtags');
	assert.equal(feed.keyword, 'site:x.com $tsla');
	assert.ok(feed.tags.includes('x.com'));
	assert.ok(feed.tags.includes('cashtag'));

	const url = new URL(feed.homepage);
	assert.equal(url.origin, 'https://www.google.com');
	assert.equal(url.pathname, '/search');
	assert.equal(url.searchParams.get('q'), 'site:x.com $tsla');
	assert.equal(url.searchParams.get('num'), '10');
	assert.equal(url.searchParams.get('newwindow'), '1');
	assert.equal(feed.url, feed.homepage);
});

test('buildGoogleXStockSearchFeed skips unknown cashtags when the stock catalog is loaded', () => {
	seedStockSymbolCatalogForTests({ symbols: ['TSLA', 'MSFT', 'AAPL'] });

	assert.equal(buildGoogleXStockSearchFeed('$notarealsymbol'), null);
});

test('buildGoogleNewsTopicFeedUrl builds a topic-scoped Google News RSS feed', () => {
	const topicId = 'CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pWVXlnQVAB';
	const url = new URL(buildGoogleNewsTopicFeedUrl(topicId));

	assert.equal(url.origin, 'https://news.google.com');
	assert.equal(url.pathname, `/rss/topics/${encodeURIComponent(topicId)}`);
	assert.equal(url.searchParams.get('hl'), 'en-US');
	assert.equal(url.searchParams.get('gl'), 'US');
	assert.equal(url.searchParams.get('ceid'), 'US:en');
});

test('buildActuallyRelevantFeedUrl builds global and issue-scoped RSS feed URLs', () => {
	assert.equal(buildActuallyRelevantFeedUrl(), 'https://actually-relevant-api.onrender.com/api/feed');
	assert.equal(buildActuallyRelevantFeedUrl('science-technology'), 'https://actually-relevant-api.onrender.com/api/feed/science-technology');
});

test('parseConfiguredAlertFeeds accepts string and object feed entries', () => {
	const feeds = parseConfiguredAlertFeeds(
		JSON.stringify([
			'https://www.google.com/alerts/feeds/111/aaa',
			{
				url: 'https://www.google.com/alerts/feeds/222/bbb',
				source: 'Google Alerts · deed notice',
				context: 'research',
				tags: ['Research', 'Google Alerts', 'Deed Notice'],
			},
		]),
	);

	assert.equal(feeds.length, 2);
	assert.deepEqual(feeds[0], {
		context: 'news',
		source: 'Google Alerts',
		homepage: 'https://www.google.com/alerts',
		url: 'https://www.google.com/alerts/feeds/111/aaa',
		tags: ['news', 'google-alerts'],
	});
	assert.deepEqual(feeds[1], {
		context: 'research',
		source: 'Google Alerts · deed notice',
		homepage: 'https://www.google.com/alerts',
		url: 'https://www.google.com/alerts/feeds/222/bbb',
		tags: ['research', 'google alerts', 'deed notice'],
	});
});

test('buildRedditFeedUrl builds a newest-first global Reddit search RSS feed', () => {
	const url = new URL(buildRedditFeedUrl('quantum lattice'));

	assert.equal(url.origin, 'https://www.reddit.com');
	assert.equal(url.pathname, '/search.rss');
	assert.equal(url.searchParams.get('q'), 'quantum lattice');
	assert.equal(url.searchParams.get('sort'), 'new');
	assert.equal(url.searchParams.get('restrict_sr'), null);
});

test('buildRedditWallStreetBetsFeedUrl builds a newest-first subreddit search RSS feed', () => {
	const url = new URL(buildRedditWallStreetBetsFeedUrl('quantum lattice'));

	assert.equal(url.origin, 'https://www.reddit.com');
	assert.equal(url.pathname, '/r/wallstreetbets/search.rss');
	assert.equal(url.searchParams.get('q'), 'quantum lattice');
	assert.equal(url.searchParams.get('sort'), 'new');
	assert.equal(url.searchParams.get('restrict_sr'), '1');
});

test('buildRedditSubredditFeedUrl builds a finance subreddit RSS feed for asset tags', () => {
	const url = new URL(buildRedditSubredditFeedUrl('stocks', '$tsla'));
	const query = url.searchParams.get('q') || '';

	assert.equal(url.origin, 'https://www.reddit.com');
	assert.equal(url.pathname, '/r/stocks/search.rss');
	assert.match(query, /^\(/);
	assert.match(query, /\btsla\b/i);
	assert.match(query, /\btesla\b/i);
	assert.match(query, /\bOR\b/);
	assert.equal(url.searchParams.get('sort'), 'new');
	assert.equal(url.searchParams.get('restrict_sr'), '1');
});

test('buildRedditFeedUrl expands stock tags into ticker and company aliases for Reddit searches', () => {
	const url = new URL(buildRedditFeedUrl('$tsla'));
	const query = url.searchParams.get('q') || '';

	assert.match(query, /^\(/);
	assert.match(query, /\btsla\b/i);
	assert.match(query, /\btesla\b/i);
	assert.match(query, /"tesla inc"/i);
	assert.match(query, /\bOR\b/);
});

test('buildRedditFeedUrl expands bare known stock symbols into ticker and company aliases for Reddit searches', () => {
	seedStockSymbolCatalogForTests({ symbols: ['TSLA', 'MSFT', 'AAPL'] });
	const url = new URL(buildRedditFeedUrl('tsla'));
	const query = url.searchParams.get('q') || '';

	assert.match(query, /^\(/);
	assert.match(query, /\btsla\b/i);
	assert.match(query, /\btesla\b/i);
	assert.match(query, /\bOR\b/);
});

test('buildContextMatchCandidates promotes matching reddit comments into standalone card candidates', () => {
	const candidates = buildContextMatchCandidates(
		{
			source: 'Reddit · r/stocks',
			context: 'research',
			homepage: 'https://www.reddit.com/r/stocks/search',
			url: 'https://www.reddit.com/r/stocks/search.rss',
			tags: ['research', 'reddit', 'stocks'],
		},
		{
			title: 'Macro discussion thread',
			link: 'https://www.reddit.com/r/stocks/comments/example-thread',
			summary: 'submitted by /u/example_user to r/stocks [link] [comments] TSLA demand is surging in Europe after the latest delivery update.',
			categories: ['discussion'],
		},
	);

	assert.equal(candidates.length, 2);
	assert.equal(candidates[0].__matchVariant, 'primary');
	assert.equal(/TSLA demand is surging/i.test(candidates[0].__matchText || ''), false);
	assert.equal(candidates[1].__matchVariant, 'comment');
	assert.match(candidates[1].title || '', /TSLA demand is surging/i);
	assert.match(candidates[1].summary || '', /Comment on Macro discussion thread/i);
	assert.equal(candidates[1].link, 'https://www.reddit.com/r/stocks/comments/example-thread');
	assert.equal(/TSLA demand is surging/i.test(candidates[1].__matchText || ''), true);
	assert.equal(Array.isArray(candidates[1].categories), true);
	assert.equal(candidates[1].categories.includes('comment'), true);
});

test('selectMatchesWithKeywordCoverage keeps x and reddit coverage visible for finance tags', () => {
	const selected = selectMatchesWithKeywordCoverage(
		[
			{
				id: 'google-search',
				source: 'Google Search',
				context: 'news',
				matchedKeywords: ['$tsla'],
				publishedAt: '2026-05-14T12:05:00.000Z',
				score: 10,
			},
			{
				id: 'google-news',
				source: 'Google News',
				context: 'news',
				matchedKeywords: ['$tsla'],
				publishedAt: '2026-05-14T12:04:00.000Z',
				score: 9,
			},
			{
				id: 'x-cashtags',
				source: 'Google Search · X cashtags',
				context: 'news',
				matchedKeywords: ['$tsla'],
				publishedAt: '2026-05-14T12:03:00.000Z',
				score: 8,
				tags: ['news', 'x.com'],
			},
			{
				id: 'reddit-stocks',
				source: 'Reddit · r/stocks',
				context: 'news',
				matchedKeywords: ['$tsla'],
				publishedAt: '2026-05-14T12:02:00.000Z',
				score: 7,
			},
		],
		['$tsla'],
		3,
	);

	assert.equal(selected.length, 3);
	assert.equal(
		selected.some((item) => item.source === 'Google Search · X cashtags'),
		true,
	);
	assert.equal(
		selected.some((item) => item.source === 'Reddit · r/stocks'),
		true,
	);
});

test('selectMatchesWithKeywordCoverage prefers multiple x and reddit matches for finance tags before generic sources', () => {
	const selected = selectMatchesWithKeywordCoverage(
		[
			{
				id: 'google-search',
				source: 'Google Search',
				context: 'news',
				matchedKeywords: ['$tsla'],
				publishedAt: '2026-05-14T12:09:00.000Z',
				score: 10,
			},
			{
				id: 'google-news',
				source: 'Google News',
				context: 'news',
				matchedKeywords: ['$tsla'],
				publishedAt: '2026-05-14T12:08:00.000Z',
				score: 9,
			},
			{
				id: 'x-cashtags-1',
				source: 'Google Search · X cashtags',
				context: 'news',
				matchedKeywords: ['$tsla'],
				publishedAt: '2026-05-14T12:07:00.000Z',
				score: 8,
				tags: ['news', 'x.com'],
			},
			{
				id: 'reddit-stocks',
				source: 'Reddit · r/stocks',
				context: 'news',
				matchedKeywords: ['$tsla'],
				publishedAt: '2026-05-14T12:06:00.000Z',
				score: 7,
			},
			{
				id: 'x-cashtags-2',
				source: 'Google News · X',
				context: 'news',
				matchedKeywords: ['$tsla'],
				publishedAt: '2026-05-14T12:05:00.000Z',
				score: 6,
				tags: ['news', 'x.com'],
			},
			{
				id: 'reddit-wsjbets',
				source: 'Reddit · r/wallstreetbets',
				context: 'news',
				matchedKeywords: ['$tsla'],
				publishedAt: '2026-05-14T12:04:00.000Z',
				score: 5,
			},
		],
		['$tsla'],
		5,
	);

	assert.equal(selected.length, 5);
	assert.equal(selected.filter((item) => /x cashtags|google news · x/i.test(item.source)).length >= 2, true);
	assert.equal(selected.filter((item) => /reddit/i.test(item.source)).length >= 2, true);
	assert.equal(
		selected.some((item) => item.source === 'Google Search'),
		true,
	);
	assert.equal(
		selected.some((item) => item.source === 'Google News'),
		false,
	);
});

test('selectMatchesWithKeywordCoverage promotes x and reddit matches for non-finance tags in the left lanes', () => {
	const selected = selectMatchesWithKeywordCoverage(
		[
			{
				id: 'google-search',
				source: 'Google Search',
				context: 'news',
				matchedKeywords: ['quantum lattice'],
				publishedAt: '2026-05-14T12:03:00.000Z',
				score: 1,
			},
			{
				id: 'reddit-science',
				source: 'Reddit · r/science',
				context: 'news',
				matchedKeywords: ['quantum lattice'],
				publishedAt: '2026-05-14T12:05:00.000Z',
				score: 2,
			},
			{
				id: 'x-news',
				source: 'Google News · X',
				context: 'news',
				matchedKeywords: ['quantum lattice'],
				publishedAt: '2026-05-14T12:04:00.000Z',
				score: 3,
				tags: ['news', 'x.com'],
			},
		],
		['quantum lattice'],
		3,
	);

	assert.equal(selected.length, 3);
	assert.equal(selected[0].source.includes('Reddit'), true);
	assert.equal(selected[1].source.includes('X'), true);
	assert.equal(
		selected.some((item) => item.source === 'Google Search'),
		true,
	);
});

test('sortContextFeedCatalog prioritizes reddit, x, and quora RSS feeds ahead of search-engine crawls', () => {
	const sorted = sortContextFeedCatalog([
		{ source: 'Google Search', type: 'search-engine', context: 'news', url: 'https://www.google.com/search?q=example', tags: ['news', 'search-engine'] },
		{ source: 'Google News · Quora', context: 'news', url: 'https://news.google.com/rss/search?q=site%3Aquora.com+example', tags: ['news', 'google-news', 'quora.com'] },
		{ source: 'Google News · X', context: 'research', url: 'https://news.google.com/rss/search?q=site%3Ax.com+example', tags: ['research', 'google-news', 'x.com'] },
		{ source: 'Reddit · r/stocks', context: 'research', url: 'https://www.reddit.com/r/stocks/search.rss?q=example', tags: ['research', 'reddit'] },
	]);

	assert.deepEqual(
		sorted.map((feed) => feed.source),
		['Reddit · r/stocks', 'Google News · X', 'Google News · Quora', 'Google Search'],
	);
});

test('partitionContextFeedCatalog serves RSS feeds first and leaves search-engine feeds for background augmentation', () => {
	const partitioned = partitionContextFeedCatalog([
		{ source: 'Google Search', type: 'search-engine', context: 'news', url: 'https://www.google.com/search?q=example', tags: ['news', 'search-engine'] },
		{ source: 'Google News · X', context: 'research', url: 'https://news.google.com/rss/search?q=site%3Ax.com+example', tags: ['research', 'google-news', 'x.com'] },
		{ source: 'Reddit · r/stocks', context: 'research', url: 'https://www.reddit.com/r/stocks/search.rss?q=example', tags: ['research', 'reddit'] },
		{ source: 'Google News · Quora', context: 'news', url: 'https://news.google.com/rss/search?q=site%3Aquora.com+example', tags: ['news', 'google-news', 'quora.com'] },
	]);

	assert.deepEqual(
		partitioned.fastFeeds.map((feed) => feed.source),
		['Reddit · r/stocks', 'Google News · X', 'Google News · Quora'],
	);
	assert.deepEqual(
		partitioned.backgroundFeeds.map((feed) => feed.source),
		['Google Search'],
	);
});

test('buildInvestingStockNewsFeeds returns stock-news RSS sources for finance asset tags', () => {
	const feeds = buildInvestingStockNewsFeeds('news');

	assert.deepEqual(
		feeds.map((feed) => feed.source),
		['Investing.com · Stock Market News', 'Investing.com · Company News', 'Investing.com · Stock Analyst Ratings', 'Investing.com · Earnings Reports and Whispers'],
	);
	assert.deepEqual(
		feeds.map((feed) => feed.url),
		[
			'https://www.investing.com/rss/news_25.rss',
			'https://www.investing.com/rss/news_356.rss',
			'https://www.investing.com/rss/news_1061.rss',
			'https://www.investing.com/rss/news_1062.rss',
		],
	);
	assert.equal(
		feeds.every((feed) => feed.context === 'news'),
		true,
	);
	assert.equal(
		feeds.every((feed) => feed.tags.includes('investing.com')),
		true,
	);
});

test('getBuiltinGeneralNewsSources includes Investing.com and curated Wired feeds for the far-left feed', () => {
	const feeds = getBuiltinGeneralNewsSources();
	assert.equal(
		feeds.some(
			(feed) =>
				feed.source === 'Investing.com · Economy News' &&
				feed.url === 'https://www.investing.com/rss/news_14.rss' &&
				feed.homepage === 'https://www.investing.com/news/economy-news',
		),
		true,
	);
	assert.equal(
		feeds.some(
			(feed) =>
				feed.source === 'Investing.com · Stock Market News' &&
				feed.url === 'https://www.investing.com/rss/news_25.rss' &&
				feed.homepage === 'https://www.investing.com/news/stock-market-news',
		),
		true,
	);
	assert.equal(
		feeds.some(
			(feed) =>
				feed.source === 'Investing.com · Economic Indicators News' &&
				feed.url === 'https://www.investing.com/rss/news_95.rss' &&
				feed.homepage === 'https://www.investing.com/news/economic-indicators',
		),
		true,
	);
	assert.equal(
		feeds.some(
			(feed) =>
				feed.source === 'Investing.com · Press Releases' &&
				feed.url === 'https://www.investing.com/rss/news_355.rss' &&
				feed.homepage === 'https://www.investing.com/news/press-releases',
		),
		true,
	);
	assert.equal(
		feeds.some(
			(feed) =>
				feed.source === 'WIRED · Artificial Intelligence' && feed.url === 'https://www.wired.com/feed/tag/ai/latest/rss' && feed.homepage === 'https://www.wired.com/tag/ai/',
		),
		true,
	);
	assert.equal(
		feeds.some(
			(feed) =>
				feed.source === 'WIRED · Security' &&
				feed.url === 'https://www.wired.com/feed/category/security/latest/rss' &&
				feed.homepage === 'https://www.wired.com/category/security/',
		),
		true,
	);
	assert.equal(
		feeds.some(
			(feed) =>
				feed.source === 'WIRED · Science' && feed.url === 'https://www.wired.com/feed/category/science/latest/rss' && feed.homepage === 'https://www.wired.com/category/science/',
		),
		true,
	);
	assert.equal(
		feeds.some(
			(feed) => feed.source === 'WFAA (ABC 8) · Top Stories & Local News' && feed.url === 'https://rssfeeds.wfaa.com/wfaa/home' && feed.homepage === 'https://www.wfaa.com/',
		),
		true,
	);
	assert.equal(
		feeds.some((feed) => feed.source === 'NBC 5 DFW · Regional News & Weather' && feed.url === 'https://www.nbcdfw.com/?rss=y' && feed.homepage === 'https://www.nbcdfw.com/'),
		true,
	);
	assert.equal(
		feeds.some(
			(feed) =>
				feed.source === 'Dallas City News · Official Municipal Updates' && feed.url === 'https://dallascitynews.net/feed' && feed.homepage === 'https://dallascitynews.net/',
		),
		true,
	);
	assert.equal(
		feeds.some(
			(feed) =>
				feed.source === 'Dallas Observer · Local Reporting & Culture' &&
				feed.url === 'https://www.dallasobserver.com/news/rss' &&
				feed.homepage === 'https://www.dallasobserver.com/news',
		),
		true,
	);
	assert.equal(
		feeds.some(
			(feed) =>
				feed.source === 'Fort Worth Star-Telegram · FW & Tarrant County' &&
				feed.url === 'https://www.star-telegram.com/?widgetName=rssfeed&widgetContentId=6199&getXmlFeed=true' &&
				feed.homepage === 'https://www.star-telegram.com/',
		),
		true,
	);
});

test('extractPublishedAtFromSearchResult reads relative dates from search result snippets', () => {
	const publishedAt = extractPublishedAtFromSearchResult({
		snippet: '3 hours ago ... Tesla approves a wider robotaxi rollout after new safety review.',
	});

	assert.equal(Boolean(publishedAt), true);
	assert.equal(Number.isNaN(Date.parse(publishedAt)), false);
	assert.equal(Date.now() - Date.parse(publishedAt) < 5 * 60 * 60 * 1000, true);
});

test('extractPublishedAtFromSearchResult reads date metadata from crawled page dataLayer entries', () => {
	const publishedAt = extractPublishedAtFromSearchResult({
		dataLayer: {
			entries: [
				{
					article: {
						datePublished: '2026-05-14T09:30:00.000Z',
					},
				},
			],
		},
	});

	assert.equal(publishedAt, '2026-05-14T09:30:00.000Z');
});

test('extractPublishedAtFromSearchResult derives the publish date from an x.com status url', () => {
	const expectedPublishedAt = '2024-01-02T03:04:05.000Z';
	const snowflakeId = ((BigInt(Date.parse(expectedPublishedAt)) - 1288834974657n) << 22n).toString();
	const publishedAt = extractPublishedAtFromSearchResult({
		url: `https://x.com/example/status/${snowflakeId}`,
	});

	assert.equal(publishedAt, expectedPublishedAt);
});

test('normalizeSearchEngineResultItem keeps a best preview image for live feed cards', () => {
	const item = normalizeSearchEngineResultItem(
		{ engine: 'google' },
		{
			title: 'Example article',
			url: 'https://example.com/story',
			snippet: 'Example summary',
			imageContext: {
				renderableEntries: [
					{
						src: 'data:image/jpeg;base64,abc',
						alt: 'Example hero image',
						caption: 'Hero image caption',
					},
				],
			},
		},
	);

	assert.equal(item.previewImage?.src, 'data:image/jpeg;base64,abc');
	assert.equal(item.previewImage?.alt, 'Example hero image');
	assert.equal(item.previewImage?.caption, 'Hero image caption');
});

test('extractFeedItemPreviewImage picks image enclosures and inline images for RSS items', () => {
	const enclosureImage = extractFeedItemPreviewImage(
		{
			link: 'https://example.com/article',
			enclosure: { url: 'https://cdn.example.com/hero.jpg', type: 'image/jpeg' },
		},
		{ source: 'Example Feed', url: 'https://example.com/feed.xml' },
	);

	const inlineImage = extractFeedItemPreviewImage(
		{
			link: 'https://example.com/article-2',
			content: '<p><img src="/images/story.png" alt="Inline story image" /></p>',
		},
		{ source: 'Example Feed', homepage: 'https://example.com' },
	);

	assert.equal(enclosureImage?.src, 'https://cdn.example.com/hero.jpg');
	assert.equal(inlineImage?.src, 'https://example.com/images/story.png');
	assert.equal(inlineImage?.alt, 'Inline story image');
});

test('extractFeedItemPreviewImage skips generic logos and promotional image assets', () => {
	const genericLogo = extractFeedItemPreviewImage(
		{
			link: 'https://example.com/article-3',
			image: {
				url: 'https://example.com/static/logo.svg',
				type: 'image/svg+xml',
				caption: 'Example logo',
			},
		},
		{ source: 'Example Feed', homepage: 'https://example.com' },
	);

	const genericMarketing = extractFeedItemPreviewImage(
		{
			link: 'https://example.com/article-4',
			content: '<p><img src="/images/banner-promo.jpg" alt="Learn more about our sponsor" /></p>',
		},
		{ source: 'Example Feed', homepage: 'https://example.com' },
	);

	assert.equal(genericLogo, null);
	assert.equal(genericMarketing, null);
});

test('extractFeedItemPreviewImage skips ad-network and ad-tracking image URLs', () => {
	const adImage = extractFeedItemPreviewImage(
		{
			link: 'https://example.com/article-ad-image',
			image: {
				url: 'https://cdn.example.com/ads/banner.jpg?adid=1234',
				type: 'image/jpeg',
				caption: 'Article art',
			},
		},
		{ source: 'Example Feed', homepage: 'https://example.com' },
	);

	const trackedAdImage = extractFeedItemPreviewImage(
		{
			link: 'https://example.com/article-ad-image-2',
			content: '<p><img src="https://images.example.com/hero.jpg?utm_medium=display&utm_campaign=spring" alt="Story image" /></p>',
		},
		{ source: 'Example Feed', homepage: 'https://example.com' },
	);

	assert.equal(adImage, null);
	assert.equal(trackedAdImage, null);
});

test('resolveContextMatchPreviewImage loads a fallback image for google-news-backed x live matches', async () => {
	const previewImage = await resolveContextMatchPreviewImage(
		{
			source: 'X Live Tag Feed · memes',
			homepage: 'https://x.com/search?q=memes&f=live',
			feedUrl: 'https://x.com/search?q=memes&f=live',
			link: 'https://news.google.com/rss/articles/example?oc=5',
			previewImage: null,
			tags: ['custom', 'template', 'memes'],
		},
		{
			loader: async () => ({
				previewImage: {
					src: 'https://cdn.example.com/memes-hero.jpg',
					alt: 'Memes hero image',
					caption: 'Hero image',
				},
			}),
		},
	);

	assert.equal(previewImage?.src, 'https://cdn.example.com/memes-hero.jpg');
	assert.equal(previewImage?.alt, 'Memes hero image');
});

test('selectMatchesWithKeywordCoverage keeps only the first instance of duplicate preview images', () => {
	const selected = selectMatchesWithKeywordCoverage(
		[
			{
				id: 'match-1',
				context: 'news',
				title: 'First item',
				source: 'Reddit',
				matchedKeywords: ['quantum'],
				publishedAt: '2026-05-14T12:03:00.000Z',
				previewImage: { src: 'https://i.redd.it/example-image.jpg?width=1024' },
			},
			{
				id: 'match-2',
				context: 'news',
				title: 'Second item',
				source: 'Reddit',
				matchedKeywords: ['quantum'],
				publishedAt: '2026-05-14T12:02:00.000Z',
				previewImage: { src: 'https://i.redd.it/example-image.jpg?width=640' },
			},
		],
		['quantum'],
		2,
	);

	assert.equal(selected.length, 2);
	assert.equal(selected[0]?.previewImage?.src, 'https://i.redd.it/example-image.jpg?width=1024');
	assert.equal(selected[1]?.previewImage, null);
});

test('sortContextMatchesNewestFirst keeps published items ahead of discovery-only items while remaining newest-first', () => {
	const sorted = sortContextMatchesNewestFirst([
		{ id: 'older', publishedAt: '2026-05-13T18:00:00.000Z', score: 10, context: 'news' },
		{ id: 'latest', publishedAt: '2026-05-13T21:00:00.000Z', score: 1, context: 'news' },
		{ id: 'middle', discoveredAt: '2026-05-13T19:30:00.000Z', score: 100, context: 'research' },
	]);

	assert.deepEqual(
		sorted.map((item) => item.id),
		['latest', 'older', 'middle'],
	);
});

test('sortContextMatchesNewestFirst keeps published items ahead of discovery-only items', () => {
	const sorted = sortContextMatchesNewestFirst([
		{ id: 'published', publishedAt: '2026-05-14T10:00:00.000Z', discoveredAt: '2026-05-14T10:05:00.000Z', score: 1, context: 'news' },
		{ id: 'undated', discoveredAt: '2026-05-14T11:59:00.000Z', score: 100, context: 'news' },
		{ id: 'older-undated', discoveredAt: '2026-05-14T08:00:00.000Z', score: 100, context: 'research' },
	]);

	assert.deepEqual(
		sorted.map((item) => item.id),
		['published', 'undated', 'older-undated'],
	);
});

test('selectMatchesWithKeywordCoverage keeps quieter tags visible when noisier tags dominate the newest feed', () => {
	const items = [
		...Array.from({ length: 8 }, (_, index) => ({
			id: `quantum-${index + 1}`,
			context: 'news',
			title: `Quantum story ${index + 1}`,
			source: 'Google News',
			matchedKeywords: ['(tsia | pltr | quantum | karp)'],
			publishedAt: new Date(Date.UTC(2026, 4, 13, 20, 59 - index, 0)).toISOString(),
		})),
		{
			id: 'tsla-1',
			context: 'news',
			title: 'Tesla story 1',
			source: 'Google News',
			matchedKeywords: ['$tsla'],
			publishedAt: '2026-05-13T19:30:00.000Z',
		},
		{
			id: 'tsla-2',
			context: 'news',
			title: 'Tesla story 2',
			source: 'Google News',
			matchedKeywords: ['$tsla'],
			publishedAt: '2026-05-13T19:15:00.000Z',
		},
	];

	const selected = selectMatchesWithKeywordCoverage(items, [{ keyword: '$tsla' }, { keyword: '(tsia | pltr | quantum | karp)' }], 6);

	assert.equal(selected.length, 6);
	assert.equal(
		selected.some((item) => item.matchedKeywords?.includes('$tsla')),
		true,
	);
	assert.deepEqual(
		selected.map((item) => item.id),
		['quantum-1', 'quantum-2', 'quantum-3', 'quantum-4', 'tsla-1', 'tsla-2'],
	);
});

test('selectGeneralNewsSources keeps enabled article-news feeds and de-duplicates repeated domains', () => {
	const selected = selectGeneralNewsSources([
		{
			enabled: true,
			category_name: 'News',
			source_type: 'BaseRssPlugin',
			title: 'Reuters - All',
			url: 'https://www.reutersagency.com/feed/?taxonomy=best-topics&post_type=best',
			language: 'en-US',
		},
		{
			enabled: true,
			category_name: 'News',
			source_type: 'BaseRssPlugin',
			title: 'Reuters - Tech',
			url: 'https://www.reutersagency.com/feed/?best-topics=tech&post_type=best',
			language: 'en-US',
		},
		{
			enabled: true,
			category_name: 'News',
			source_type: 'BaseRssPlugin',
			title: 'BBC',
			url: 'https://feeds.bbci.co.uk/news/rss.xml',
			language: 'en-GB',
		},
		{
			enabled: true,
			category_name: 'News',
			source_type: 'YouTubeChannelPlugin',
			title: 'Not Article News',
			url: 'https://www.youtube.com/feeds/videos.xml?channel_id=abc',
			language: 'en-US',
		},
		{
			enabled: true,
			category_name: 'News',
			source_type: 'BaseRssPlugin',
			title: 'Reddit News',
			url: 'https://www.reddit.com/r/news/.rss',
			language: 'en-US',
		},
	]);

	assert.equal(selected.length, 2);
	assert.equal(selected[0].source, 'Reuters - All');
	assert.equal(selected[1].source, 'BBC');
	assert.ok(selected.every((item) => !/reddit|youtube/i.test(item.url)));
});

test('normalizeHackerNewsStoryItem maps a Hacker News story into the left-lane news shape', () => {
	const item = normalizeHackerNewsStoryItem({
		id: 12345,
		type: 'story',
		title: 'Show HN: Query Notify plugs into Hacker News',
		url: 'https://example.com/hn-story',
		by: 'pg',
		score: 98,
		descendants: 17,
		time: 1778697600,
	});

	assert.deepEqual(item, {
		id: 'general:hacker-news:12345',
		context: 'news',
		type: 'general-news',
		source: 'Hacker News',
		homepage: 'https://news.ycombinator.com/',
		feedUrl: 'https://hacker-news.firebaseio.com/v0/topstories.json',
		title: 'Show HN: Query Notify plugs into Hacker News',
		summary: 'by pg • 98 points • 17 comments',
		link: 'https://example.com/hn-story',
		publishedAt: '2026-05-13T18:40:00.000Z',
		discoveredAt: '2026-05-13T18:40:00.000Z',
		tags: ['technology', 'hacker-news'],
	});
});

test('normalizeActuallyRelevantStory maps an API story into the shared left-lane news shape', () => {
	const item = normalizeActuallyRelevantStory({
		id: 'story-1',
		slug: 'important-ai-policy-shift',
		sourceUrl: 'https://example.com/ai-policy',
		sourceTitle: 'Example Source',
		title: 'Important AI policy shift',
		summary: 'A detailed summary of the shift.',
		emotionTag: 'calm',
		datePublished: '2026-05-13T20:15:00.000Z',
		issue: {
			name: 'Science & Technology',
			slug: 'science-technology',
		},
		feed: {
			title: 'The Guardian Environment',
			displayTitle: 'The Guardian',
			issue: {
				slug: 'science-technology',
			},
		},
	});

	assert.deepEqual(item, {
		id: 'general:actually-relevant:important-ai-policy-shift',
		context: 'news',
		type: 'general-news',
		source: 'Actually Relevant · Science & Technology',
		homepage: 'https://actuallyrelevant.news/issues/science-technology',
		feedUrl: 'https://actually-relevant-api.onrender.com/api/feed/science-technology',
		title: 'Important AI policy shift',
		summary: 'A detailed summary of the shift. • Feed: The Guardian • Source: Example Source',
		link: 'https://example.com/ai-policy',
		publishedAt: '2026-05-13T20:15:00.000Z',
		discoveredAt: '2026-05-13T20:15:00.000Z',
		tags: ['news', 'actually-relevant', 'science-technology', 'science & technology', 'calm'],
	});
});

test('normalizeHackerNewsStoryItem falls back to the Hacker News discussion URL when no story URL exists', () => {
	const item = normalizeHackerNewsStoryItem({
		id: 456,
		type: 'story',
		title: 'Ask HN: What should power the left column?',
		text: 'Use the top stories endpoint.',
		time: 1778697600,
	});

	assert.equal(item?.link, 'https://news.ycombinator.com/item?id=456');
	assert.equal(item?.summary, 'Use the top stories endpoint.');
});
