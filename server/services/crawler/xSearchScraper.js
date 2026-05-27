/**
 * xSearchScraper.js
 *
 * Calls X's internal GraphQL API directly using session auth tokens,
 * exactly the same requests the x.com frontend makes — no browser, no Docker.
 *
 * Required env vars (server/.env):
 *   X_AUTH_TOKEN   — value of the `auth_token` cookie from a logged-in x.com session
 *   X_CSRF_TOKEN   — value of the `ct0` cookie from a logged-in x.com session
 *
 * How to get the tokens:
 *   1. Log in to x.com in your browser
 *   2. Open DevTools → Application → Cookies → https://x.com
 *   3. Copy the values of `auth_token` and `ct0`
 *   4. Paste them into server/.env as X_AUTH_TOKEN and X_CSRF_TOKEN
 *
 * Exports:
 *   scrapeXKeywordFeed(keyword, options)  → RSS XML string
 *   scrapeXUserFeed(username, options)    → RSS XML string
 *   hasXCredentials()                     → boolean
 */

import { logger } from '../../utils/logger.js';
import { getActiveXCredentials } from './xSessionStore.js';

// ─── Config ──────────────────────────────────────────────────────────────────

// X's public frontend bearer token — constant across all x.com browser clients.
const X_BEARER_TOKEN =
	process.env.X_BEARER_TOKEN ||
	'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I6xUEXAMbCbsAAAAMUVGeHCZMRWufDorgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const X_API_ITEM_LIMIT = Math.max(10, Math.min(100, Number(process.env.X_SCRAPER_ITEM_LIMIT) || 60));
const X_USER_ACTIVITY_ITEM_LIMIT = Math.max(10, Math.min(100, Number(process.env.X_USER_ACTIVITY_ITEM_LIMIT) || 80));

// GraphQL query IDs — stable frontend-compiled IDs used by x.com.
const SEARCH_TIMELINE_QUERY_ID = process.env.X_SEARCH_TIMELINE_QUERY_ID || 'Yw6L66Pw54NHKuq4Dp7b4Q';
const USER_BY_SCREEN_NAME_QUERY_ID = process.env.X_USER_BY_SCREEN_NAME_QUERY_ID || 'G3KGOASz96M-Qu0nwmGXNg';
const USER_TWEETS_QUERY_ID = process.env.X_USER_TWEETS_QUERY_ID || 'E3opETHurmVJflFsUBVuUQ';

const X_BASE_URL = 'https://x.com';
const X_API_BASE = 'https://x.com/i/api/graphql';

// ─── Auth ─────────────────────────────────────────────────────────────────────

export function hasXCredentials() {
	return Boolean(getXCredentials());
}

function getXCredentials(credentials = null) {
	if (credentials?.authToken && credentials?.csrfToken) {
		return {
			authToken: String(credentials.authToken || '').trim(),
			csrfToken: String(credentials.csrfToken || '').trim(),
		};
	}

	return getActiveXCredentials();
}

function buildXApiHeaders(credentials = null) {
	const activeCredentials = getXCredentials(credentials);
	if (!activeCredentials) {
		throw new Error('X session tokens not configured. Set X_AUTH_TOKEN and X_CSRF_TOKEN in the server environment.');
	}

	return {
		'Authorization': `Bearer ${X_BEARER_TOKEN}`,
		'x-csrf-token': activeCredentials.csrfToken,
		'Cookie': `auth_token=${activeCredentials.authToken}; ct0=${activeCredentials.csrfToken}`,
		'Content-Type': 'application/json',
		'x-twitter-auth-type': 'OAuth2Session',
		'x-twitter-client-language': 'en',
		'x-twitter-active-user': 'yes',
		'Accept': '*/*',
		'Accept-Language': 'en-US,en;q=0.9',
		'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
		'Referer': 'https://x.com/',
		'Origin': 'https://x.com',
	};
}

function normalizeRequestedCount(value, fallback) {
	const numericValue = Number(value);
	if (!Number.isFinite(numericValue)) return fallback;
	return Math.max(10, Math.min(100, Math.floor(numericValue)));
}

// ─── Tweet normalisation ──────────────────────────────────────────────────────

function normaliseTweetResult(result) {
	if (!result) return null;
	const tweet = result.__typename === 'TweetWithVisibilityResults' ? result.tweet : result;
	if (!tweet?.legacy) return null;

	const legacy = tweet.legacy;
	const userLegacy = tweet.core?.user_results?.result?.legacy || {};
	const tweetId = legacy.id_str || tweet.rest_id || '';
	const screenName = userLegacy.screen_name || '';
	const fullText = legacy.full_text || '';
	const createdAt = legacy.created_at || '';

	if (!tweetId || !fullText) return null;

	const link = `${X_BASE_URL}/${screenName}/status/${tweetId}`;
	const cleanText = fullText.replace(/https:\/\/t\.co\/\S+/g, '').trim();
	const title = cleanText.slice(0, 140) + (cleanText.length > 140 ? '…' : '');

	return {
		guid: link,
		link,
		title,
		summary: cleanText,
		author: screenName ? `@${screenName}` : '',
		publishedAt: createdAt ? new Date(createdAt).toISOString() : new Date().toISOString(),
		previewImage: extractTweetPreviewImage(tweet),
	};
}

function extractTweetPreviewImage(tweet = {}) {
	const mediaEntries = tweet?.legacy?.extended_entities?.media || tweet?.legacy?.entities?.media || [];
	const primaryMedia = Array.isArray(mediaEntries) ? mediaEntries.find((entry) => entry?.media_url_https || entry?.media_url) : null;
	if (!primaryMedia) return null;

	return {
		src: primaryMedia.media_url_https || primaryMedia.media_url || '',
		alt: primaryMedia.ext_alt_text || tweet?.legacy?.full_text || 'X post image',
		caption: '',
	};
}

function extractTweetsFromResponse(data) {
	const tweets = [];
	const seen = new Set();

	function walk(node) {
		if (!node || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			node.forEach(walk);
			return;
		}

		if (node.__typename === 'Tweet' || node.__typename === 'TweetWithVisibilityResults') {
			const t = normaliseTweetResult(node);
			if (t && !seen.has(t.guid)) {
				seen.add(t.guid);
				tweets.push(t);
			}
			return;
		}

		if (node.tweet_results?.result) {
			const t = normaliseTweetResult(node.tweet_results.result);
			if (t && !seen.has(t.guid)) {
				seen.add(t.guid);
				tweets.push(t);
			}
		}

		for (const val of Object.values(node)) {
			walk(val);
		}
	}

	walk(data);
	return tweets;
}

function getTweetSortTimestamp(tweet = {}) {
	const publishedAt = tweet?.publishedAt ? Date.parse(tweet.publishedAt) : Number.NaN;
	return Number.isFinite(publishedAt) ? publishedAt : 0;
}

function mergeTweetCollections(...collections) {
	const merged = [];
	const seen = new Set();

	for (const collection of collections) {
		for (const tweet of collection || []) {
			if (!tweet?.guid || seen.has(tweet.guid)) continue;
			seen.add(tweet.guid);
			merged.push(tweet);
		}
	}

	return merged.sort((left, right) => getTweetSortTimestamp(right) - getTweetSortTimestamp(left));
}

// ─── GraphQL calls ────────────────────────────────────────────────────────────

const DEFAULT_GQL_FEATURES = {
	rweb_video_timestamps_enabled: true,
	longform_notetweets_consumption_enabled: true,
	responsive_web_twitter_article_tweet_consumption_enabled: true,
	tweet_awards_web_tipping_enabled: false,
	freedom_of_speech_not_reach_fetch_enabled: true,
	standardized_nudges_misinfo: true,
	tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
	longform_notetweets_rich_text_read_enabled: true,
	longform_notetweets_inline_media_enabled: false,
	responsive_web_graphql_exclude_directive_enabled: true,
	verified_phone_label_enabled: false,
	creator_subscriptions_tweet_preview_api_enabled: true,
	responsive_web_graphql_timeline_navigation_enabled: true,
	responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
	tweetypie_unmention_optimization_enabled: true,
	responsive_web_edit_tweet_api_enabled: true,
	graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
	view_counts_everywhere_api_enabled: true,
	articles_preview_enabled: true,
	responsive_web_enhance_cards_enabled: false,
	rweb_video_screen_enabled: false,
	rweb_cashtags_enabled: true,
	profile_label_improvements_pcf_label_in_post_enabled: true,
	responsive_web_profile_redirect_enabled: false,
	rweb_tipjar_consumption_enabled: false,
	premium_content_api_read_enabled: false,
	communities_web_enable_tweet_community_results_fetch: true,
	c9s_tweet_anatomy_moderator_badge_enabled: true,
	responsive_web_grok_analyze_button_fetch_trends_enabled: false,
	responsive_web_grok_analyze_post_followups_enabled: true,
	rweb_cashtags_composer_attachment_enabled: true,
	responsive_web_jetfuel_frame: true,
	responsive_web_grok_share_attachment_enabled: true,
	responsive_web_grok_annotations_enabled: true,
	rweb_conversational_replies_downvote_enabled: false,
	content_disclosure_indicator_enabled: true,
	content_disclosure_ai_generated_indicator_enabled: true,
	responsive_web_grok_show_grok_translated_post: true,
	responsive_web_grok_analysis_button_from_backend: true,
	post_ctas_fetch_enabled: true,
	responsive_web_grok_image_annotation_enabled: true,
	responsive_web_grok_imagine_annotation_enabled: true,
	responsive_web_grok_community_note_auto_translation_is_enabled: true,
};

async function callXGraphQL(queryId, operationName, variables = {}, extraFeatures = {}, credentials = null) {
	const url = new URL(`${X_API_BASE}/${queryId}/${operationName}`);
	url.searchParams.set('variables', JSON.stringify(variables));
	url.searchParams.set('features', JSON.stringify({ ...DEFAULT_GQL_FEATURES, ...extraFeatures }));

	const response = await fetch(url.toString(), { headers: buildXApiHeaders(credentials) });

	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw new Error(`X API ${operationName} returned ${response.status}: ${body.slice(0, 300)}`);
	}

	return response.json();
}

// ─── Search timeline ──────────────────────────────────────────────────────────

async function fetchXSearchTimeline(query = '', count = X_API_ITEM_LIMIT, product = 'Latest', credentials = null) {
	const data = await callXGraphQL(
		SEARCH_TIMELINE_QUERY_ID,
		'SearchTimeline',
		{
			rawQuery: query,
			count,
			querySource: '',
			product,
			withGrokTranslatedBio: false,
			withQuickPromoteEligibilityTweetFields: false,
		},
		{},
		credentials,
	);
	return extractTweetsFromResponse(data);
}

// ─── User timeline ────────────────────────────────────────────────────────────

async function fetchXUserId(screenName = '', credentials = null) {
	const data = await callXGraphQL(
		USER_BY_SCREEN_NAME_QUERY_ID,
		'UserByScreenName',
		{ screen_name: screenName, withSafetyModeUserFields: true },
		{
			hidden_profile_likes_enabled: true,
			hidden_profile_subscriptions_enabled: true,
			subscriptions_verification_info_is_identity_verified_enabled: true,
			subscriptions_verification_info_verified_since_enabled: true,
			highlights_tweets_tab_ui_enabled: true,
			responsive_web_twitter_article_notes_tab_enabled: false,
		},
		credentials,
	);
	return data?.data?.user?.result?.rest_id || null;
}

async function fetchXUserTimeline(userId = '', count = X_API_ITEM_LIMIT, credentials = null) {
	const data = await callXGraphQL(
		USER_TWEETS_QUERY_ID,
		'UserTweets',
		{
			userId,
			count,
			includePromotedContent: false,
			withQuickPromoteEligibilityTweetFields: false,
			withVoice: true,
			withV2Timeline: true,
		},
		{},
		credentials,
	);
	return extractTweetsFromResponse(data);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch X search results for a keyword and return RSS XML.
 * @param {string} keyword
 * @param {{ filter?: 'live'|'top' }} options
 * @returns {Promise<string>} RSS XML
 */
export async function scrapeXKeywordFeed(keyword = '', options = {}) {
	const normalizedKeyword = String(keyword || '').trim();
	if (!normalizedKeyword) throw new Error('keyword is required');
	const credentials = getXCredentials(options.credentials);
	const requestedCount = normalizeRequestedCount(options.count, X_API_ITEM_LIMIT);

	if (!credentials) {
		throw new Error('X session tokens not configured. Set X_AUTH_TOKEN and X_CSRF_TOKEN in server/.env.');
	}

	const filter = String(options.filter || 'live').toLowerCase();
	const product = filter === 'top' ? 'Top' : 'Latest';

	logger.debug('X GraphQL keyword search', { keyword: normalizedKeyword, product, count: requestedCount });
	let tweets = await fetchXSearchTimeline(normalizedKeyword, requestedCount, product, credentials);
	if (!tweets.length && product !== 'Top') {
		logger.debug('X GraphQL keyword search empty, retrying with Top', { keyword: normalizedKeyword });
		tweets = await fetchXSearchTimeline(normalizedKeyword, requestedCount, 'Top', credentials);
	}
	if (!tweets.length) {
		throw new Error(`X GraphQL keyword search returned no tweets for "${normalizedKeyword}".`);
	}
	logger.debug('X GraphQL keyword result', { keyword: normalizedKeyword, count: tweets.length });

	return buildRssXml(tweets, {
		title: `X Search: ${normalizedKeyword}`,
		link: `${X_BASE_URL}/search?q=${encodeURIComponent(normalizedKeyword)}&f=${filter}`,
		description: `${product} X results for: ${normalizedKeyword}`,
	});
}

/**
 * Fetch a user's timeline and return RSS XML.
 * @param {string} username  — with or without leading @
 * @returns {Promise<string>} RSS XML
 */
export async function scrapeXUserFeed(username = '', options = {}) {
	const screenName = String(username || '')
		.replace(/^@/, '')
		.trim();
	if (!screenName) throw new Error('username is required');
	const includeReplies = options.includeReplies !== false;
	const credentials = getXCredentials(options.credentials);
	const requestedCount = normalizeRequestedCount(options.count, X_USER_ACTIVITY_ITEM_LIMIT);

	if (!credentials) {
		throw new Error('X session tokens not configured. Set X_AUTH_TOKEN and X_CSRF_TOKEN in server/.env.');
	}

	logger.debug('X GraphQL user timeline', { screenName });
	const userId = await fetchXUserId(screenName, credentials);
	if (!userId) throw new Error(`Could not resolve user ID for @${screenName}`);

	const timelineTweets = await fetchXUserTimeline(userId, requestedCount, credentials);
	let tweets = timelineTweets;

	if (includeReplies) {
		try {
			const searchQuery = `from:${screenName} -filter:retweets`;
			const replyTweets = await fetchXSearchTimeline(searchQuery, requestedCount, 'Latest', credentials);
			tweets = mergeTweetCollections(timelineTweets, replyTweets);
			logger.debug('X GraphQL user reply search merged', {
				screenName,
				userTimelineCount: timelineTweets.length,
				replySearchCount: replyTweets.length,
				mergedCount: tweets.length,
			});
		} catch (error) {
			logger.debug('X GraphQL user reply search failed; continuing with timeline only', {
				screenName,
				error: error.message,
			});
		}
	}

	if (!tweets.length) {
		throw new Error(`X GraphQL user timeline returned no tweets for @${screenName}.`);
	}
	logger.debug('X GraphQL user result', { screenName, count: tweets.length });

	return buildRssXml(tweets, {
		title: `@${screenName} on X`,
		link: `${X_BASE_URL}/${screenName}`,
		description: `Latest tweets from @${screenName}`,
	});
}

function escapeXml(unsafe = '') {
	return String(unsafe || '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function buildMediaMarkup(tweet = {}) {
	const media = tweet?.previewImage?.src ? tweet.previewImage : null;
	if (!media?.src) return '';

	const safeUrl = escapeXml(media.src);
	const safeAlt = escapeXml(media.alt || tweet.title || 'Preview image');
	const mediaType = /^https?:\/\/.+\.(mp4|mov)(?:[?#].*)?$/i.test(media.src) ? 'video/mp4' : 'image/jpeg';

	return `    <enclosure url="${safeUrl}" type="${mediaType}" />\n    <media:content url="${safeUrl}" medium="image" type="${mediaType}" />\n    <media:description>${safeAlt}</media:description>\n`;
}

function buildRssXml(items = [], metadata = {}) {
	const normalizedItems = Array.isArray(items) ? items : [];
	const title = metadata?.title || 'X Feed';
	const link = metadata?.link || X_BASE_URL;
	const description = metadata?.description || 'Latest X items';

	let rss = '<?xml version="1.0" encoding="UTF-8" ?>\n';
	rss += '<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:dc="http://purl.org/dc/elements/1.1/">\n';
	rss += '<channel>\n';
	rss += `  <title>${escapeXml(title)}</title>\n`;
	rss += `  <link>${escapeXml(link)}</link>\n`;
	rss += `  <description>${escapeXml(description)}</description>\n`;
	rss += `  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>\n`;
	rss += '  <language>en-us</language>\n';

	for (const item of normalizedItems) {
		const itemTitle = item?.title || 'Untitled';
		const itemLink = item?.link || link;
		const itemSummary = item?.summary || '';
		const itemGuid = item?.guid || itemLink || itemTitle;
		const itemAuthor = item?.author || '';
		const publishedAt = new Date(item?.publishedAt || Date.now()).toUTCString();

		rss += '  <item>\n';
		rss += `    <title>${escapeXml(itemTitle)}</title>\n`;
		rss += `    <link>${escapeXml(itemLink)}</link>\n`;
		rss += `    <description>${escapeXml(itemSummary)}</description>\n`;
		rss += `    <pubDate>${publishedAt}</pubDate>\n`;
		rss += `    <guid isPermaLink="false">${escapeXml(itemGuid)}</guid>\n`;
		if (itemAuthor) {
			rss += `    <dc:creator>${escapeXml(itemAuthor)}</dc:creator>\n`;
		}
		rss += buildMediaMarkup(item);
		rss += '  </item>\n';
	}

	rss += '</channel>\n';
	rss += '</rss>\n';
	return rss;
}
