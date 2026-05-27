import express from 'express';
import {
	addContextFeedSource,
	blockContextFeedUrl,
	getContextFeedPortalData,
	getContextFeedSourcePreview,
	getContextFeedSnapshot,
	refreshContextFeedMonitor,
	registerContextKeywords,
	removeContextFeedSource,
	removeContextKeywords,
	replaceContextKeywords,
	subscribeToContextFeedMonitor,
	updateContextFeedSource,
} from '../services/context/contextFeedService.js';
import { logger } from '../utils/logger.js';

export const contextRouter = express.Router();

function writeSseEvent(res, { event = 'snapshot', id, data }) {
	if (id) {
		res.write(`id: ${id}\n`);
	}
	res.write(`event: ${event}\n`);
	res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function refreshContextFeedMonitorInBackground(action = 'context-tags-update') {
	void refreshContextFeedMonitor().catch((error) => {
		logger.error(`Context feed refresh failed after ${action}`, {
			error: error.message,
		});
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

contextRouter.get('/monitor', async (req, res, next) => {
	try {
		if (/^(1|true|yes|on)$/i.test(String(req.query.refresh || 'false'))) {
			await refreshContextFeedMonitor({ force: true });
		}
		res.json(getContextFeedSnapshot());
	} catch (error) {
		next(error);
	}
});

contextRouter.get('/portal', async (_req, res, next) => {
	try {
		const data = await getContextFeedPortalData();
		res.json(data);
	} catch (error) {
		next(error);
	}
});

contextRouter.get('/tags', (_req, res) => {
	const snapshot = getContextFeedSnapshot();
	res.json({ tags: snapshot.tags });
});

contextRouter.get('/rss', (_req, res) => {
	const snapshot = getContextFeedSnapshot();
	const matches = snapshot.matches || [];
	const tags = snapshot.tags || [];
	const tagLabel = tags.length ? tags.join(', ') : 'All Tags';

	res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');

	let rss = '<?xml version="1.0" encoding="UTF-8" ?>\n';
	rss += '<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">\n';
	rss += '<channel>\n';
	rss += `  <title>Query Notify RSS Builder (${escapeXml(tagLabel)})</title>\n`;
	rss += '  <link>http://localhost:3000</link>\n';
	rss += `  <description>Consolidated research feed for tags: ${escapeXml(tagLabel)}</description>\n`;
	rss += `  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>\n`;
	rss += '  <language>en-us</language>\n';

	for (const item of matches) {
		const title = item.title || 'Untitled';
		const link = item.link || '';
		const description = item.summary || item.contentSnippet || '';
		const pubDate = new Date(item.publishedAt || item.discoveredAt || Date.now()).toUTCString();
		const source = item.source || 'Context Monitor';
		const guid = item.id || link || title;

		rss += '  <item>\n';
		rss += `    <title>${escapeXml(title)}</title>\n`;
		rss += `    <link>${escapeXml(link)}</link>\n`;
		rss += `    <description>${escapeXml(description)}</description>\n`;
		rss += `    <pubDate>${pubDate}</pubDate>\n`;
		rss += `    <guid isPermaLink="false">${escapeXml(guid)}</guid>\n`;
		rss += `    <dc:creator>${escapeXml(source)}</dc:creator>\n`;
		if (item.tags && item.tags.length) {
			for (const tag of item.tags) {
				rss += `    <category>${escapeXml(tag)}</category>\n`;
			}
		}
		rss += '  </item>\n';
	}

	rss += '</channel>\n';
	rss += '</rss>';

	res.send(rss);
});

contextRouter.get('/stream', (req, res) => {
	res.setHeader('Content-Type', 'text/event-stream');
	res.setHeader('Cache-Control', 'no-cache, no-transform');
	res.setHeader('Connection', 'keep-alive');
	res.setHeader('X-Accel-Buffering', 'no');
	if (typeof res.flushHeaders === 'function') {
		res.flushHeaders();
	}
	if (typeof req.socket?.setKeepAlive === 'function') {
		req.socket.setKeepAlive(true);
	}

	res.write('retry: 5000\n\n');
	writeSseEvent(res, {
		event: 'snapshot',
		id: getContextFeedSnapshot().streamVersion || 0,
		data: {
			reason: 'initial',
			snapshot: getContextFeedSnapshot(),
		},
	});

	const unsubscribe = subscribeToContextFeedMonitor((payload) => {
		writeSseEvent(res, {
			event: 'snapshot',
			id: payload.id,
			data: payload,
		});
	});

	const heartbeat = setInterval(() => {
		res.write(': keep-alive\n\n');
	}, 25000);

	req.on('close', () => {
		clearInterval(heartbeat);
		unsubscribe();
		res.end();
	});
});

function filterSnapshotForFamily(snapshot = {}, family = 'rss') {
	const cloned = JSON.parse(JSON.stringify(snapshot || {}));
	try {
		const matches = Array.isArray(cloned.output?.matches) ? cloned.output.matches : cloned.matches || [];
		const isRss = (item = {}) => {
			const src = String(item.discoverySource || item.source || item.feedUrl || '').toLowerCase();
			if (String(item.discoverySource || '').toLowerCase() === 'rss') return true;
			if (/\b(rss|feed|google news|wired|investing|news)\b/.test(src)) return true;
			if (String(item.parentUrl || item.link || '').match(/(\.rss$|\/feed(?:$|\/)|\.xml$)/i)) return true;
			return false;
		};

		if (family === 'rss') {
			cloned.output = cloned.output || {};
			cloned.output.matches = matches.filter((m) => isRss(m));
		} else {
			cloned.output = cloned.output || {};
			cloned.output.matches = matches.filter((m) => !isRss(m));
		}
	} catch (e) {
		// noop: fall back to unmodified snapshot
	}
	return cloned;
}

contextRouter.get('/rss-stream', (req, res) => {
	res.setHeader('Content-Type', 'text/event-stream');
	res.setHeader('Cache-Control', 'no-cache, no-transform');
	res.setHeader('Connection', 'keep-alive');
	res.setHeader('X-Accel-Buffering', 'no');
	if (typeof res.flushHeaders === 'function') {
		res.flushHeaders();
	}
	if (typeof req.socket?.setKeepAlive === 'function') {
		req.socket.setKeepAlive(true);
	}

	res.write('retry: 5000\n\n');
	writeSseEvent(res, {
		event: 'snapshot',
		id: getContextFeedSnapshot().streamVersion || 0,
		data: {
			reason: 'initial',
			snapshot: filterSnapshotForFamily(getContextFeedSnapshot(), 'rss'),
		},
	});

	const unsubscribe = subscribeToContextFeedMonitor((payload) => {
		writeSseEvent(res, {
			event: 'snapshot',
			id: payload.id,
			data: {
				...payload,
				snapshot: filterSnapshotForFamily(payload.snapshot || {}, 'rss'),
			},
		});
	});

	const heartbeat = setInterval(() => {
		res.write(': keep-alive\n\n');
	}, 25000);

	req.on('close', () => {
		clearInterval(heartbeat);
		unsubscribe();
		res.end();
	});
});

contextRouter.get('/crawl-stream', (req, res) => {
	res.setHeader('Content-Type', 'text/event-stream');
	res.setHeader('Cache-Control', 'no-cache, no-transform');
	res.setHeader('Connection', 'keep-alive');
	res.setHeader('X-Accel-Buffering', 'no');
	if (typeof res.flushHeaders === 'function') {
		res.flushHeaders();
	}
	if (typeof req.socket?.setKeepAlive === 'function') {
		req.socket.setKeepAlive(true);
	}

	res.write('retry: 5000\n\n');
	writeSseEvent(res, {
		event: 'snapshot',
		id: getContextFeedSnapshot().streamVersion || 0,
		data: {
			reason: 'initial',
			snapshot: filterSnapshotForFamily(getContextFeedSnapshot(), 'crawl'),
		},
	});

	const unsubscribe = subscribeToContextFeedMonitor((payload) => {
		writeSseEvent(res, {
			event: 'snapshot',
			id: payload.id,
			data: {
				...payload,
				snapshot: filterSnapshotForFamily(payload.snapshot || {}, 'crawl'),
			},
		});
	});

	const heartbeat = setInterval(() => {
		res.write(': keep-alive\n\n');
	}, 25000);

	req.on('close', () => {
		clearInterval(heartbeat);
		unsubscribe();
		res.end();
	});
});

contextRouter.post('/keywords', async (req, res, next) => {
	try {
		const values = Array.isArray(req.body?.keywords) ? req.body.keywords : [req.body?.keyword].filter(Boolean);
		const keywords = registerContextKeywords(values);
		refreshContextFeedMonitorInBackground('keyword update');
		const snapshot = getContextFeedSnapshot();
		res.json({ keywords, snapshot });
	} catch (error) {
		next(error);
	}
});

contextRouter.post('/tags', async (req, res, next) => {
	try {
		const values = Array.isArray(req.body?.tags) ? req.body.tags : [req.body?.tag].filter(Boolean);
		const tags = registerContextKeywords(values);
		refreshContextFeedMonitorInBackground('tag update');
		const snapshot = getContextFeedSnapshot();
		res.json({ tags, snapshot });
	} catch (error) {
		next(error);
	}
});

contextRouter.put('/tags', async (req, res, next) => {
	try {
		const values = Array.isArray(req.body?.tags) ? req.body.tags : [];
		const tags = replaceContextKeywords(values);
		refreshContextFeedMonitorInBackground('tag replacement');
		const snapshot = getContextFeedSnapshot();
		res.json({ tags, snapshot });
	} catch (error) {
		next(error);
	}
});

contextRouter.delete('/tags', async (req, res, next) => {
	try {
		const values = Array.isArray(req.body?.tags) ? req.body.tags : [req.body?.tag].filter(Boolean);
		const tags = values.length ? removeContextKeywords(values) : replaceContextKeywords([]);
		refreshContextFeedMonitorInBackground('tag removal');
		const snapshot = getContextFeedSnapshot();
		res.json({ tags, snapshot });
	} catch (error) {
		next(error);
	}
});

contextRouter.post('/sources', async (req, res, next) => {
	try {
		const { source, url, homepage, context, tags, useTagTemplate, urlTemplate, testTag, sampleTag, replaceTagValue } = req.body || {};
		const newSource = await addContextFeedSource({ source, url, homepage, context, tags, useTagTemplate, urlTemplate, testTag, sampleTag, replaceTagValue });
		refreshContextFeedMonitorInBackground('source addition');
		res.json(newSource);
	} catch (error) {
		next(error);
	}
});

contextRouter.delete('/sources', async (req, res, next) => {
	try {
		const url = req.body?.url || req.query?.url;
		await removeContextFeedSource(url);
		refreshContextFeedMonitorInBackground('source removal');
		res.json({ status: 'removed', url });
	} catch (error) {
		next(error);
	}
});

contextRouter.put('/sources', async (req, res, next) => {
	try {
		const { oldUrl, source, url, homepage, context, tags, useTagTemplate, urlTemplate, testTag, sampleTag, replaceTagValue } = req.body || {};
		const updated = await updateContextFeedSource(oldUrl, { source, url, homepage, context, tags, useTagTemplate, urlTemplate, testTag, sampleTag, replaceTagValue });
		refreshContextFeedMonitorInBackground('source update');
		res.json(updated);
	} catch (error) {
		next(error);
	}
});

contextRouter.post('/sources/test', async (req, res, next) => {
	try {
		const { url, useTagTemplate, urlTemplate, testTag, sampleTag, replaceTagValue } = req.body || {};
		const preview = await getContextFeedSourcePreview({ url, useTagTemplate, urlTemplate, testTag, sampleTag, replaceTagValue });
		res.json(preview);
	} catch (error) {
		next(error);
	}
});

contextRouter.post('/sources/block', async (req, res, next) => {
	try {
		const { url } = req.body || {};
		await blockContextFeedUrl(url);
		refreshContextFeedMonitorInBackground('source blocking');
		res.json({ status: 'blocked', url });
	} catch (error) {
		next(error);
	}
});

contextRouter.delete('/sources/block', async (req, res, next) => {
	try {
		const url = req.body?.url || req.query?.url;
		await unblockContextFeedUrl(url);
		refreshContextFeedMonitorInBackground('source unblocking');
		res.json({ status: 'unblocked', url });
	} catch (error) {
		next(error);
	}
});

export default contextRouter;
