import test from 'node:test';
import assert from 'node:assert/strict';

function createGraphqlResponse(body) {
	return {
		ok: true,
		status: 200,
		text: async () => JSON.stringify(body),
		json: async () => body,
	};
}

test('scrapeXUserFeed merges timeline posts with reply search results', async () => {
	const originalEnv = {
		X_AUTH_TOKEN: process.env.X_AUTH_TOKEN,
		X_CSRF_TOKEN: process.env.X_CSRF_TOKEN,
		X_USER_ACTIVITY_ITEM_LIMIT: process.env.X_USER_ACTIVITY_ITEM_LIMIT,
	};
	const originalFetch = globalThis.fetch;
	const fetchCalls = [];

	process.env.X_AUTH_TOKEN = 'test-auth-token';
	process.env.X_CSRF_TOKEN = 'test-csrf-token';
	process.env.X_USER_ACTIVITY_ITEM_LIMIT = '10';

	globalThis.fetch = async (input) => {
		const url = new URL(String(input));
		const operationName = url.pathname.split('/').at(-1) || '';
		fetchCalls.push({ url, operationName });

		if (operationName === 'UserByScreenName') {
			return createGraphqlResponse({
				data: {
					user: {
						result: {
							rest_id: '123',
						},
					},
				},
			});
		}

		if (operationName === 'UserTweets') {
			return createGraphqlResponse({
				data: {
					userTimeline: {
						tweet_results: {
							result: {
								__typename: 'Tweet',
								rest_id: '100',
								legacy: {
									id_str: '100',
									full_text: 'Main post https://t.co/main',
									created_at: 'Mon, 01 Jan 2024 00:00:00 +0000',
									extended_entities: {
										media: [
											{
												type: 'photo',
												media_url_https: 'https://pbs.twimg.com/media/main-post.jpg',
												ext_alt_text: 'Main post image',
											},
										],
									},
								},
								core: {
									user_results: {
										result: {
											legacy: {
												screen_name: 'acct',
											},
										},
									},
								},
							},
						},
					},
				},
			});
		}

		if (operationName === 'SearchTimeline') {
			return createGraphqlResponse({
				data: {
					search: {
						tweet_results: {
							result: {
								__typename: 'Tweet',
								rest_id: '200',
								legacy: {
									id_str: '200',
									full_text: 'Reply/comment https://t.co/reply',
									created_at: 'Tue, 02 Jan 2024 00:00:00 +0000',
								},
								core: {
									user_results: {
										result: {
											legacy: {
												screen_name: 'acct',
											},
										},
									},
								},
							},
						},
					},
				},
			});
		}

		throw new Error(`Unexpected GraphQL operation: ${operationName}`);
	};

	try {
		const { scrapeXUserFeed } = await import('./services/crawler/xSearchScraper.js');
		const rss = await scrapeXUserFeed('acct');

		assert.match(rss, /acct\/status\/100/);
		assert.match(rss, /pbs\.twimg\.com\/media\/main-post\.jpg/);
		assert.match(rss, /<enclosure /);
		assert.match(rss, /<media:content /);
		assert.match(rss, /acct\/status\/200/);
		assert.ok(rss.indexOf('/status/200') < rss.indexOf('/status/100'));
		assert.equal(
			fetchCalls.some((call) => {
				if (call.operationName !== 'SearchTimeline') return false;
				const variables = JSON.parse(call.url.searchParams.get('variables') || '{}');
				return variables.rawQuery === 'from:acct -filter:retweets';
			}),
			true,
		);
		assert.equal(
			fetchCalls.some((call) => call.operationName === 'UserTweets'),
			true,
		);
	} finally {
		globalThis.fetch = originalFetch;
		process.env.X_AUTH_TOKEN = originalEnv.X_AUTH_TOKEN;
		process.env.X_CSRF_TOKEN = originalEnv.X_CSRF_TOKEN;
		process.env.X_USER_ACTIVITY_ITEM_LIMIT = originalEnv.X_USER_ACTIVITY_ITEM_LIMIT;
	}
});
