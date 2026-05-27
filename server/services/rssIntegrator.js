import axios from 'axios';
import Parser from 'rss-parser';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

const parser = new Parser();

const DEFAULT_FEEDS_JSON = process.env.FEEDS_JSON_URL || 'https://raw.githubusercontent.com/rumca-js/RSS-Link-Database-2024/main/sources.json';

export function parseFeedItemTimestamp(item = {}) {
	const raw = item.isoDate || item.pubDate || item.published || item.updated || item['dc:date'] || '';
	const timestamp = Date.parse(raw);
	return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function sortFeedItemsNewestFirst(items = []) {
	return [...items].sort((left, right) => parseFeedItemTimestamp(right) - parseFeedItemTimestamp(left));
}

async function loadFeedsList() {
	try {
		const res = await axios.get(DEFAULT_FEEDS_JSON, { timeout: 10000 });
		return Array.isArray(res.data) ? res.data : [];
	} catch (err) {
		console.warn('Could not load feeds list', err?.message);
		return [];
	}
}

async function fetchArticleText(url) {
	if (!url) return '';
	try {
		const res = await axios.get(url, {
			timeout: 10000,
			headers: { 'User-Agent': 'Mozilla/5.0 (rss-integrator)' },
		});

		const dom = new JSDOM(res.data, { url });
		const reader = new Readability(dom.window.document);
		const article = reader.parse();
		if (article && article.textContent) return article.textContent;

		// fallback to textContent of body
		return dom.window.document?.body?.textContent?.trim() || '';
	} catch (err) {
		console.warn('fetchArticleText failed', err?.message);
		return '';
	}
}

async function summarizeWithOpenAI(text) {
	const key = process.env.OPENAI_API_KEY;
	if (!key || !text) return null;

	try {
		const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
		const prompt = `Summarize the article below in up to three concise bullet points, then give a one-sentence overview. Keep it factual and neutral.\n\n${text}`;

		const resp = await axios.post(
			'https://api.openai.com/v1/chat/completions',
			{
				model,
				messages: [
					{ role: 'system', content: 'You are a concise article summarizer.' },
					{ role: 'user', content: prompt },
				],
				temperature: 0.2,
				max_tokens: 400,
			},
			{ headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' } },
		);

		return resp.data?.choices?.[0]?.message?.content || null;
	} catch (err) {
		console.warn('OpenAI summarization failed', err?.message);
		return null;
	}
}

function fallbackSummary(text) {
	if (!text) return '';
	// simple extractive: first 3 sentences
	const sentences = text
		.replace(/\s+/g, ' ')
		.trim()
		.split(/(?<=[.!?])\s+/);
	return sentences.slice(0, 3).join(' ').substring(0, 800);
}

export async function fetchFeedsSummaries({ limit = 10, itemsPerFeed = 1 } = {}) {
	const sources = await loadFeedsList();

	// pick newsy, enabled, english sources first
	const candidates = sources
		.filter((s) => s && s.enabled)
		.filter((s) => {
			const cat = `${s.category_name || ''} ${s.subcategory_name || ''} ${s.title || ''}`;
			const isNews = /news|world|topstories|top stories/i.test(cat) || /news/i.test(s.category_name || '');
			const isEnglish = /(en|en-US|en-UK|en-GB)/i.test(s.language || '') || !s.language;
			return isNews && isEnglish;
		});

	const sourceLimit = Math.max(limit * 5, 20);
	const selected = candidates.slice(0, sourceLimit);
	const results = [];

	for (const src of selected) {
		if (results.length >= limit) break;
		try {
			const feed = await parser.parseURL(src.url);
			const items = sortFeedItemsNewestFirst(feed.items || []).slice(0, itemsPerFeed);
			for (const item of items) {
				const link = item.link || item.guid || item.id;
				const articleText = await fetchArticleText(link);
				let summary = null;
				if (process.env.OPENAI_API_KEY && articleText) {
					summary = await summarizeWithOpenAI(articleText);
				}
				if (!summary) summary = fallbackSummary(articleText || item.contentSnippet || item.content || item.title || '');

				results.push({
					source: src.title,
					feedUrl: src.url,
					itemTitle: item.title,
					link,
					pubDate: item.pubDate,
					summary,
				});

				if (results.length >= limit) break;
			}
		} catch (err) {
			console.warn(`Failed to process feed ${src.title} (${src.url}): ${err?.message}`);
		}
	}

	return results.sort((left, right) => parseFeedItemTimestamp(right) - parseFeedItemTimestamp(left));
}

export default { fetchFeedsSummaries };
