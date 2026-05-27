import { promises as fs } from 'fs';
import { join } from 'path';
import { randomUUID } from 'node:crypto';

const STORAGE_DIR = join(process.cwd(), 'server', 'data', 'search-runs');

async function ensureStorageDir() {
	try {
		await fs.mkdir(STORAGE_DIR, { recursive: true });
	} catch (e) {
		// ignore
	}
}

async function listSearchRuns(limit = 200) {
	await ensureStorageDir();
	const files = await fs.readdir(STORAGE_DIR);
	const runs = [];

	for (const f of files) {
		if (!f.endsWith('.json')) continue;
		try {
			const content = await fs.readFile(join(STORAGE_DIR, f), 'utf8');
			runs.push(JSON.parse(content));
		} catch (e) {
			// ignore corrupt files
		}
	}

	runs.sort((a, b) => String(b.savedAt || b.updatedAt || '').localeCompare(String(a.savedAt || a.updatedAt || '')));
	return runs.slice(0, limit);
}

async function getSearchRunById(runId) {
	const file = join(STORAGE_DIR, `${runId}.json`);
	try {
		const content = await fs.readFile(file, 'utf8');
		return JSON.parse(content);
	} catch (e) {
		return null;
	}
}

async function getRecentSearchRunQueries(limit = 20) {
	const runs = await listSearchRuns(limit);
	return runs
		.map((r) => r.query || r.params || {})
		.filter(Boolean)
		.slice(0, limit);
}

async function saveSearchRun(params = {}, result = {}, metadata = {}) {
	await ensureStorageDir();
	const runId = randomUUID();
	const now = new Date().toISOString();

	const persisted = {
		runId,
		savedAt: now,
		updatedAt: now,
		status: metadata.status || 'completed',
		trigger: metadata.trigger || 'manual',
		jobId: metadata.jobId || null,
		querySignature: JSON.stringify(params || {}),
		query: params || {},
		result: result || {},
		metadata: metadata || {},
	};

	const file = join(STORAGE_DIR, `${runId}.json`);
	await fs.writeFile(file, JSON.stringify(persisted, null, 2), 'utf8');
	return persisted;
}

export { listSearchRuns, getSearchRunById, getRecentSearchRunQueries, saveSearchRun };

export default { listSearchRuns, getSearchRunById, getRecentSearchRunQueries, saveSearchRun };
