import { Router } from 'express';
import { scrapeXKeywordFeed, scrapeXUserFeed } from '../services/crawler/xSearchScraper.js';
import { logger } from '../utils/logger.js';

export const xRouter = Router();

async function serveScrapedXFeed(res, scraperFn, label) {
	try {
		const xml = await scraperFn();
		res.set('Content-Type', 'application/rss+xml; charset=utf-8');
		res.set('Cache-Control', 'no-store');
		return res.send(xml);
	} catch (error) {
		logger.error('X scraper feed failed', { label, error: error.message });
		return res.status(502).json({
			error: 'X feed scrape failed.',
			label,
			details: error.message,
			hint: 'Set X_AUTH_TOKEN and X_CSRF_TOKEN in server/.env using your logged-in twitter.com auth_token and ct0 cookies. The scraper uses Twitter GraphQL directly.',
		});
	}
}

xRouter.get('/health', (_req, res) => {
	res.json({
		status: 'ok',
		source: 'local-x-scraper',
		timestamp: new Date().toISOString(),
	});
});

xRouter.get('/twitter/user/:username', async (req, res) => {
	const username = String(req.params.username || '').trim();
	if (!username) return res.status(400).json({ error: 'username is required' });
	const includeReplies = String(req.query.includeReplies ?? '1') !== '0';
	const count = Number.parseInt(String(req.query.count || ''), 10);
	return serveScrapedXFeed(res, () => scrapeXUserFeed(username, { includeReplies, count }), `user:${username}`);
});

xRouter.get('/twitter/user/:username/{*path}', async (req, res) => {
	const username = String(req.params.username || '').trim();
	if (!username) return res.status(400).json({ error: 'username is required' });
	const includeReplies = String(req.query.includeReplies ?? '1') !== '0';
	const count = Number.parseInt(String(req.query.count || ''), 10);
	return serveScrapedXFeed(res, () => scrapeXUserFeed(username, { includeReplies, count }), `user:${username}`);
});

xRouter.get('/twitter/keyword/:keyword', async (req, res) => {
	const keyword = String(req.params.keyword || '').trim();
	if (!keyword) return res.status(400).json({ error: 'keyword is required' });
	const filter = String(req.query.filter || req.query.f || 'live');
	const count = Number.parseInt(String(req.query.count || ''), 10);
	return serveScrapedXFeed(res, () => scrapeXKeywordFeed(keyword, { filter, count }), `keyword:${keyword}`);
});

xRouter.get('/twitter/keyword/:keyword/{*path}', async (req, res) => {
	const keyword = String(req.params.keyword || '').trim();
	if (!keyword) return res.status(400).json({ error: 'keyword is required' });
	const filter = String(req.query.filter || req.query.f || 'live');
	const count = Number.parseInt(String(req.query.count || ''), 10);
	return serveScrapedXFeed(res, () => scrapeXKeywordFeed(keyword, { filter, count }), `keyword:${keyword}`);
});

xRouter.get('/twitter/list/:id', async (req, res) => {
	const listId = String(req.params.id || '').trim();
	if (!listId) return res.status(400).json({ error: 'id is required' });
	return serveScrapedXFeed(res, () => scrapeXKeywordFeed(`list:${listId}`, { filter: 'top' }), `list:${listId}`);
});

xRouter.get('/twitter/list/:id/{*path}', async (req, res) => {
	const listId = String(req.params.id || '').trim();
	if (!listId) return res.status(400).json({ error: 'id is required' });
	return serveScrapedXFeed(res, () => scrapeXKeywordFeed(`list:${listId}`, { filter: 'top' }), `list:${listId}`);
});

xRouter.get('/proxy/{*path}', (_req, res) => {
	res.status(501).json({
		error: 'Proxy mode has been removed.',
		hint: 'Use built-in X scraper routes under /api/x/twitter/* instead.',
	});
});
