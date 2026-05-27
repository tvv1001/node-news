const DEFAULT_RETRY_MS = 15000;

let contextBase = 'http://localhost:3001';
let retryMs = DEFAULT_RETRY_MS;
let stream: any = null;
let rssStream: any = null;
let crawlStream: any = null;
let retryTimer: any = null;
let active = false;
let hasConnectedToStream = false;
let latestSnapshot: any = null;

function buildContextUrl(pathname: string) {
	return new URL(pathname, contextBase).toString();
}

function postWorkerMessage(type: string, payload = {}) {
	(self as any).postMessage({ type, ...payload });
}

function clearRetryTimer() {
	if (retryTimer) {
		self.clearTimeout(retryTimer);
		retryTimer = null;
	}
}

function closeStream() {
	if (stream) {
		stream.close();
		stream = null;
	}
}

async function handleResponse(res: Response) {
	const data = await res.json();
	if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
	return data;
}

function scheduleReconnect() {
	if (!active || retryTimer) return;
	retryTimer = self.setTimeout(() => {
		retryTimer = null;
		void bootstrapContextMonitor();
	}, retryMs);
}

async function loadContextMonitor({ refresh = false } = {}) {
	const url = new URL(buildContextUrl('/api/context/monitor'));
	if (refresh) {
		url.searchParams.set('refresh', '1');
	}

	const response = await fetch(url as any, { cache: 'no-store' });
	return handleResponse(response);
}

function connectStream() {
	if (!active) return;

	// close existing streams
	closeStream();

	if (typeof EventSource === 'undefined') {
		postWorkerMessage('status', { status: 'unsupported' });
		return;
	}

	// Primary combined stream (compatibility)
	stream = new EventSource(buildContextUrl('/api/context/stream'));
	stream.addEventListener('snapshot', (event: any) => {
		try {
			const payload = JSON.parse(event.data);
			// full snapshot fallback
			latestSnapshot = mergeSnapshots(latestSnapshot, payload?.snapshot || payload);
			postWorkerMessage('status', { status: 'connected' });
			postWorkerMessage('snapshot', { reason: payload?.reason || 'snapshot', snapshot: latestSnapshot });
		} catch (error: any) {
			postWorkerMessage('worker-error', { error: error?.message || 'Invalid context stream payload.' });
		}
	});

	// Support diff events
	stream.addEventListener('diff', (event: any) => {
		try {
			const payload = JSON.parse(event.data);
			const diff = payload?.diff || {};
			// apply diffs to latestSnapshot
			latestSnapshot = applyDiffToSnapshot(latestSnapshot, diff);
			postWorkerMessage('status', { status: 'connected' });
			postWorkerMessage('snapshot', { reason: payload?.reason || 'diff', snapshot: latestSnapshot });
		} catch (error: any) {
			postWorkerMessage('worker-error', { error: error?.message || 'Invalid diff payload.' });
		}
	});

	// RSS-focused low-latency stream
	rssStream = new EventSource(buildContextUrl('/api/context/rss-stream'));
	rssStream.addEventListener('snapshot', (event: any) => {
		try {
			const payload = JSON.parse(event.data);
			latestSnapshot = mergeSnapshots(latestSnapshot, payload?.snapshot || payload);
			postWorkerMessage('status', { status: 'connected' });
			postWorkerMessage('snapshot', { reason: `rss:${payload?.reason || 'snapshot'}`, snapshot: payload?.snapshot || payload });
		} catch (error: any) {
			postWorkerMessage('worker-error', { error: error?.message || 'Invalid rss stream payload.' });
		}
	});

	rssStream.addEventListener('diff', (event: any) => {
		try {
			const payload = JSON.parse(event.data);
			const diff = payload?.diff || {};
			latestSnapshot = applyDiffToSnapshot(latestSnapshot, diff);
			postWorkerMessage('snapshot', { reason: `rss:${payload?.reason || 'diff'}`, snapshot: latestSnapshot });
		} catch (error: any) {
			postWorkerMessage('worker-error', { error: error?.message || 'Invalid rss diff payload.' });
		}
	});

	// Crawl/background stream
	crawlStream = new EventSource(buildContextUrl('/api/context/crawl-stream'));
	crawlStream.addEventListener('snapshot', (event: any) => {
		try {
			const payload = JSON.parse(event.data);
			latestSnapshot = mergeSnapshots(latestSnapshot, payload?.snapshot || payload);
			postWorkerMessage('snapshot', { reason: `crawl:${payload?.reason || 'snapshot'}`, snapshot: payload?.snapshot || payload });
		} catch (error: any) {
			postWorkerMessage('worker-error', { error: error?.message || 'Invalid crawl stream payload.' });
		}
	});

	crawlStream.addEventListener('diff', (event: any) => {
		try {
			const payload = JSON.parse(event.data);
			const diff = payload?.diff || {};
			latestSnapshot = applyDiffToSnapshot(latestSnapshot, diff);
			postWorkerMessage('snapshot', { reason: `crawl:${payload?.reason || 'diff'}`, snapshot: latestSnapshot });
		} catch (error: any) {
			postWorkerMessage('worker-error', { error: error?.message || 'Invalid crawl diff payload.' });
		}
	});

	function applyDiffToSnapshot(base = null, diff = { added: [], updated: [], removed: [] }) {
		if (!base) base = { output: { matches: [] } };
		const matches = Array.isArray(base.output?.matches) ? [...base.output.matches] : [];
		const map = new Map();
		for (const m of matches) if (m && m.id) map.set(String(m.id), m);
		for (const u of diff.updated || []) {
			if (u && u.id) map.set(String(u.id), u);
		}
		for (const a of diff.added || []) {
			if (a && a.id) map.set(String(a.id), a);
		}
		for (const r of diff.removed || []) {
			map.delete(String(r));
		}
		const merged = Array.from(map.values());
		const out = JSON.parse(JSON.stringify(base));
		out.output = out.output || {};
		out.output.matches = merged;
		return out;
	}

	stream.onopen = () => {
		hasConnectedToStream = true;
		postWorkerMessage('status', { status: 'connected' });
	};

	stream.onerror = () => {
		closeStream();
		postWorkerMessage('status', {
			status: hasConnectedToStream ? 'reconnecting' : 'offline',
		});
		scheduleReconnect();
	};
}

function mergeSnapshots(base = null, incoming = null) {
	if (!incoming) return base || incoming;
	if (!base) return incoming;
	try {
		const baseMatches = Array.isArray(base.output?.matches) ? base.output.matches : base.matches || [];
		const incomingMatches = Array.isArray(incoming.output?.matches) ? incoming.output.matches : incoming.matches || [];
		const map = new Map();
		for (const m of baseMatches) {
			if (m && m.id) map.set(String(m.id), m);
		}
		for (const m of incomingMatches) {
			if (m && m.id) map.set(String(m.id), m);
		}
		const merged = Array.from(map.values());
		const out = JSON.parse(JSON.stringify(base));
		out.output = out.output || {};
		out.output.matches = merged;
		return out;
	} catch {
		return incoming || base;
	}
}

async function bootstrapContextMonitor() {
	try {
		const shouldRefreshOnBootstrap = !hasConnectedToStream && !latestSnapshot;
		const snapshot = await loadContextMonitor({ refresh: shouldRefreshOnBootstrap });
		if (!active) return;

		latestSnapshot = snapshot;
		postWorkerMessage('snapshot', { reason: 'initial', snapshot });
		postWorkerMessage('status', { status: 'connecting' });
		connectStream();
	} catch (error: any) {
		if (!active) return;
		postWorkerMessage('worker-error', {
			error: error?.message || 'Unable to load context monitor.',
		});
		postWorkerMessage('status', { status: 'offline' });
		scheduleReconnect();
	}
}

async function refreshContextMonitor() {
	try {
		const snapshot = await loadContextMonitor({ refresh: true });
		if (!active) return;
		latestSnapshot = snapshot;
		postWorkerMessage('snapshot', { reason: 'manual-refresh', snapshot });
	} catch (error: any) {
		postWorkerMessage('worker-error', {
			error: error?.message || 'Unable to refresh context monitor.',
		});
	}
}

self.addEventListener('message', (event: any) => {
	const { type, payload = {} } = event.data || {};

	switch (type) {
		case 'init': {
			active = true;
			contextBase = payload.contextBase || contextBase;
			retryMs = Math.max(1000, Number(payload.retryMs) || DEFAULT_RETRY_MS);
			hasConnectedToStream = false;
			clearRetryTimer();
			void bootstrapContextMonitor();
			break;
		}
		case 'refresh': {
			if (active) {
				void refreshContextMonitor();
			}
			break;
		}
		case 'stop': {
			active = false;
			latestSnapshot = null;
			clearRetryTimer();
			closeStream();
			break;
		}
		default:
			break;
	}
});
