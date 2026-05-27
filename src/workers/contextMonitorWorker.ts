const DEFAULT_RETRY_MS = 15000;

let contextBase = 'http://localhost:3001';
let retryMs = DEFAULT_RETRY_MS;
let stream: any = null;
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

	closeStream();

	if (typeof EventSource === 'undefined') {
		postWorkerMessage('status', { status: 'unsupported' });
		return;
	}

	stream = new EventSource(buildContextUrl('/api/context/stream'));
	stream.addEventListener('snapshot', (event: any) => {
		try {
			const payload = JSON.parse(event.data);
			latestSnapshot = payload?.snapshot || payload;
			postWorkerMessage('status', { status: 'connected' });
			postWorkerMessage('snapshot', { reason: payload?.reason || 'snapshot', snapshot: latestSnapshot });
		} catch (error: any) {
			postWorkerMessage('worker-error', { error: error?.message || 'Invalid context stream payload.' });
		}
	});

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
