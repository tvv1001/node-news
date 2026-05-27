import test from 'node:test';
import assert from 'node:assert/strict';

import { ALL_NEWS_TAG, isAllNewsTag, normalizeContextTagForSync, normalizeContextTagValue } from './contextFeedTagUtils';

test('normalizeContextTagValue lowercases and trims context tags', () => {
	assert.equal(normalizeContextTagValue('  AI Policy  '), 'ai policy');
});

test('isAllNewsTag recognizes the special all-news tag', () => {
	assert.equal(isAllNewsTag('all-news'), true);
	assert.equal(isAllNewsTag('  All-News  '), true);
	assert.equal(isAllNewsTag('news'), false);
	assert.equal(ALL_NEWS_TAG, 'all-news');
});

test('normalizeContextTagForSync strips the local-only all-news tag', () => {
	assert.equal(normalizeContextTagForSync('all-news'), '');
	assert.equal(normalizeContextTagForSync(' AI Policy '), 'ai policy');
});
