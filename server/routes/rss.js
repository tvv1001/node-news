import express from 'express';
import { fetchFeedsSummaries } from '../services/rssIntegrator.js';

export const rssRouter = express.Router();

// GET /api/rss/summaries?limit=5&per=1
rssRouter.get('/summaries', async (req, res, next) => {
	try {
		const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 10));
		const per = Math.max(1, Math.min(5, Number(req.query.per) || 1));
		const results = await fetchFeedsSummaries({ limit, itemsPerFeed: per });
		res.json({ count: results.length, results });
	} catch (err) {
		next(err);
	}
});

export default rssRouter;
