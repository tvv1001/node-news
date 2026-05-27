import test from 'node:test';
import assert from 'node:assert/strict';

import { extractLinkifiedFeedTokens, getFeedSourceHref } from './feedCardUtils.ts';

test('extractLinkifiedFeedTokens links explicit urls found in summary text', () => {
	const tokens = extractLinkifiedFeedTokens('Read more at https://example.com/story for the full post.');
	const linkToken = tokens.find((token) => token.type === 'link');

	assert.equal(linkToken?.value, 'https://example.com/story');
	assert.equal(linkToken?.href, 'https://example.com/story');
});

test('extractLinkifiedFeedTokens links x handles against the original site when the card points to x', () => {
	const tokens = extractLinkifiedFeedTokens('Fresh note from @querynotify on the thread.', {
		link: 'https://twitter.com/querynotify/status/1234567890',
	});
	const linkToken = tokens.find((token) => token.type === 'link');

	assert.equal(linkToken?.value, '@querynotify');
	assert.equal(linkToken?.href, 'https://twitter.com/querynotify');
});

test('extractLinkifiedFeedTokens links reddit user tags when the card originates from reddit', () => {
	const tokens = extractLinkifiedFeedTokens('Discussion via u/example_user is trending.', {
		link: 'https://www.reddit.com/r/technology/comments/example',
	});
	const linkToken = tokens.find((token) => token.type === 'link');

	assert.equal(linkToken?.value, 'u/example_user');
	assert.equal(linkToken?.href, 'https://www.reddit.com/user/example_user/');
});

test('extractLinkifiedFeedTokens links reddit subreddit tokens when the card originates from reddit', () => {
	const tokens = extractLinkifiedFeedTokens('submitted by /u/kiramis to r/Gangstalking', {
		link: 'https://www.reddit.com/r/Gangstalking/comments/example-thread',
	});
	const subredditToken = tokens.find((token) => token.type === 'link' && token.value === 'r/Gangstalking');

	assert.equal(subredditToken?.href, 'https://www.reddit.com/r/Gangstalking/');
});

test('extractLinkifiedFeedTokens removes reddit [link] and [comments] labels from summaries', () => {
	const tokens = extractLinkifiedFeedTokens('submitted by /u/kiramis to r/Gangstalking [link] [comments]', {
		link: 'https://www.reddit.com/r/Gangstalking/comments/example-thread',
		originalLink: 'https://example.com/original-story',
		commentsLink: 'https://www.reddit.com/r/Gangstalking/comments/example-thread',
	});

	const externalLinkToken = tokens.find((token) => token.type === 'link' && token.value.toLowerCase() === '[link]');
	const commentsLinkToken = tokens.find((token) => token.type === 'link' && token.value.toLowerCase() === '[comments]');
	const plainText = tokens
		.filter((token) => token.type === 'text')
		.map((token) => token.value)
		.join('');

	assert.equal(externalLinkToken, undefined);
	assert.equal(commentsLinkToken, undefined);
	assert.doesNotMatch(plainText, /\[link\]/i);
	assert.doesNotMatch(plainText, /\[comments\]/i);
	assert.match(plainText, /submitted by/i);
	assert.match(plainText, /r\/Gangstalking/i);
});

test('getFeedSourceHref prefers the homepage before the feed url', () => {
	assert.equal(getFeedSourceHref({ homepage: 'https://example.com', feedUrl: 'https://example.com/feed.xml' }), 'https://example.com');
});
