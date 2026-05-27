import test from 'node:test';
import assert from 'node:assert/strict';
		{
			source: 'DuckDuckGo Search · Twitter cashtags',
			link: 'https://twitter.com/tesla/status/1923000000000000000',
		},
	hasFreshPublishedAt,
	isAllowedLiveFeedItem,
	isDirectXStatusUrl,
	isSuppressedLiveFeedItem,
	isRedditPostUrl,
} from './liveFeedSourcePolicy';

function daysAgoIso(days = 0) {
	return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function hoursAgoIso(hours = 0) {
	return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

test('isDirectXStatusUrl recognizes direct twitter status links', () => {
	assert.equal(isDirectXStatusUrl('https://twitter.com/tesla/status/1923000000000000000'), true);
	assert.equal(isDirectXStatusUrl('https://twitter.com/tesla'), false);
});

test('isRedditPostUrl recognizes reddit thread links', () => {
	assert.equal(isRedditPostUrl('https://www.reddit.com/r/stocks/comments/1abc123/tesla_discussion_thread/'), true);
	assert.equal(isRedditPostUrl('https://www.reddit.com/r/stocks/'), false);
});

test('live feed policy keeps direct social posts, reddit posts, and google news items', () => {
	assert.equal(
		isAllowedLiveFeedItem({
			source: 'DuckDuckGo Search · X cashtags',
			link: 'https://twitter.com/tesla/status/1923000000000000000',
			title: 'Tesla update on production milestones',
			summary: 'A direct X post about production milestones.',
		}),
		true,
	);

	assert.equal(
		isAllowedLiveFeedItem({
			source: 'Reddit · r/stocks',
			link: 'https://www.reddit.com/r/stocks/comments/1abc123/tesla_discussion_thread/',
			title: 'Tesla discussion thread',
			summary: "Investors are discussing today's move.",
		}),
		true,
	);

	assert.equal(
		isAllowedLiveFeedItem({
			source: 'Google News',
			link: 'https://www.reuters.com/world/us/tesla-announces-new-factory-opening-2026-05-14/',
			title: 'Tesla announces new factory opening',
			summary: "Reuters reports on Tesla's latest factory expansion.",
		}),
		true,
	);
});

test('live feed policy keeps yahoo news and yahoo finance news articles', () => {
	assert.equal(
		isAllowedLiveFeedItem({
			source: 'Yahoo Search',
			link: 'https://news.yahoo.com/tesla-expands-robotaxi-rollout-120000000.html',
			title: 'Tesla expands robotaxi rollout',
			summary: 'Yahoo News covers the latest robotaxi expansion details.',
		}),
		true,
	);

	assert.equal(
		isAllowedLiveFeedItem({
			source: 'Yahoo Search',
			link: 'https://finance.yahoo.com/news/tesla-stock-rises-after-delivery-update-130000000.html',
			title: 'Tesla stock rises after delivery update',
			summary: 'Yahoo Finance reports on a delivery-driven stock move.',
		}),
		true,
	);
});

test('live feed policy suppresses generic search and quote pages', () => {
	assert.equal(
		isSuppressedLiveFeedItem({
			source: 'Google Search',
			link: 'https://www.google.com/search?q=tsla',
			title: 'tsla - Google Search',
			summary: 'Search results for tsla.',
		}),
		true,
	);

	assert.equal(
		isSuppressedLiveFeedItem({
			source: 'Yahoo Search',
			link: 'https://finance.yahoo.com/quote/TSLA/',
			title: 'Tesla, Inc. (TSLA) Stock Price, News, Quote & History',
			summary: 'View the latest TSLA quote and history.',
		}),
		true,
	);

	assert.equal(
		isSuppressedLiveFeedItem({
			source: 'Yahoo Search',
			link: 'https://stockanalysis.com/stocks/tsla/',
			title: 'Tesla stock price and analysis',
			summary: 'Stock analysis quote page.',
		}),
		true,
	);
});

test('live feed policy still keeps article results from search-backed feeds', () => {
	assert.equal(
		isAllowedLiveFeedItem({
			source: 'Yahoo Search',
			link: 'https://www.reuters.com/world/us/tesla-expands-service-network-across-texas-2026-05-14/',
			title: 'Tesla expands service network across Texas',
			summary: 'Reuters reports Tesla is expanding its service network across Texas after recent growth.',
			publishedAt: daysAgoIso(1),
		}),
		true,
	);
});

test('live feed policy allows fresh generic article and blog items for tagged columns', () => {
	assert.equal(
		isAllowedLiveFeedItem({
			source: 'The Verge',
			link: 'https://www.theverge.com/2026/05/14/tesla-software-update-details',
			title: 'Tesla software update adds new in-car controls',
			summary: 'The Verge reports on a newly published Tesla software update and what changed for drivers.',
			publishedAt: daysAgoIso(1),
		}),
		true,
	);

	assert.equal(
		isAllowedLiveFeedItem({
			source: 'Independent EV Blog',
			link: 'https://ev.example.com/blog/tesla-service-notes-from-this-week',
			title: 'Tesla service notes from this week',
			summary: 'A fresh blog post covering Tesla service notes, repair trends, and recent observations from owners.',
			publishedAt: daysAgoIso(2),
		}),
		true,
	);
});

test('live feed policy suppresses stale or undated generic article pages', () => {
	assert.equal(
		isSuppressedLiveFeedItem({
			source: 'Independent EV Blog',
			link: 'https://ev.example.com/blog/tesla-history-and-company-overview',
			title: 'Tesla history and company overview',
			summary: 'An overview page about Tesla history and background information.',
			publishedAt: daysAgoIso(45),
		}),
		true,
	);

	assert.equal(
		isSuppressedLiveFeedItem({
			source: 'Tech Blog',
			link: 'https://blog.example.com/2026/05/tesla-roadmap-analysis',
			title: 'Tesla roadmap analysis',
			summary: 'A blog post discussing Tesla roadmap analysis and commentary.',
		}),
		true,
	);
});

test('hasFreshPublishedAt only accepts recent published timestamps', () => {
	assert.equal(hasFreshPublishedAt({ publishedAt: daysAgoIso(3) }), true);
	assert.equal(hasFreshPublishedAt({ publishedAt: daysAgoIso(30) }), false);
	assert.equal(hasFreshPublishedAt({ discoveredAt: daysAgoIso(1) }), false);
});

test('getLiveFeedFreshnessBoost gives a stronger bump to items from the last few hours', () => {
	assert.equal(getLiveFeedFreshnessBoost({ publishedAt: hoursAgoIso(2) }), 3);
	assert.equal(getLiveFeedFreshnessBoost({ publishedAt: hoursAgoIso(12) }), 2);
	assert.equal(getLiveFeedFreshnessBoost({ publishedAt: daysAgoIso(5) }), 1);
	assert.equal(getLiveFeedFreshnessBoost({ publishedAt: daysAgoIso(20) }), 0);
});

test('live feed policy gives fast-moving tagged sources higher recency priority', () => {
	assert.equal(
		getLiveFeedRecencyPriority({
			source: 'DuckDuckGo Search · X cashtags',
			link: 'https://x.com/tesla/status/1923000000000000000',
		}),
		5,
	);

	assert.equal(
		getLiveFeedRecencyPriority({
			source: 'Reddit · r/stocks',
			link: 'https://www.reddit.com/r/stocks/comments/1abc123/tesla_discussion_thread/',
		}),
		4,
	);

	assert.equal(
		getLiveFeedRecencyPriority({
			source: 'Google News',
			link: 'https://www.reuters.com/world/us/tesla-announces-new-factory-opening-2026-05-14/',
		}),
		3,
	);

	assert.equal(
		getLiveFeedRecencyPriority({
			source: 'Yahoo Search',
			link: 'https://finance.yahoo.com/news/tesla-stock-rises-after-delivery-update-130000000.html',
		}),
		2,
	);

	assert.equal(
		getLiveFeedRecencyPriority({
			source: 'Investing.com · Company News',
			link: 'https://www.investing.com/news/company-news/tesla-expands-battery-output-4689999',
			title: 'Tesla expands battery output',
			summary: 'Investing.com reports that Tesla expanded battery output after a new production milestone.',
			publishedAt: daysAgoIso(1),
		}),
		2,
	);

	assert.equal(
		getLiveFeedRecencyPriority({
			source: 'The Verge',
			link: 'https://www.theverge.com/2026/05/14/tesla-ui-refresh',
			title: 'Tesla UI refresh',
			summary: 'A fresh report on the latest Tesla interface changes and rollout details for drivers.',
			publishedAt: daysAgoIso(1),
		}),
		1,
	);
});
