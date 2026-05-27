import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRAPY_RUNNER = path.resolve(__dirname, 'scrapy_crawler.py');
const DEFAULT_TIMEOUT_MS = Math.max(5000, Number(process.env.SCRAPY_TIMEOUT_MS) || 45000);

function normalizeUrl(value = '') {
	try {
		const parsed = new URL(String(value || '').trim());
		if (!/^https?:$/i.test(parsed.protocol)) return '';
		return parsed.toString();
	} catch {
		return '';
	}
}

export async function runScrapyCrawler(options = {}) {
	const url = normalizeUrl(options.url);
	if (!url) {
		throw new Error('A valid http or https URL is required.');
	}

	const python = process.env.PYTHON_BIN || 'python3';
	const maxPages = Math.max(1, Math.min(100, Number(options.maxPages) || 100));
	const maxDepth = Math.max(0, Math.min(5, Number(options.maxDepth) || 5));
	const allowOffsite = Boolean(options.allowOffsite);

	const args = [SCRAPY_RUNNER, url, '--max-pages', String(maxPages), '--max-depth', String(maxDepth)];
	if (allowOffsite) {
		args.push('--allow-offsite');
	}

	return await new Promise((resolve, reject) => {
		const child = spawn(python, args, { env: { ...process.env } });
		let stdout = '';
		let stderr = '';
		let settled = false;

		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill('SIGTERM');
			reject(new Error(`Scrapy crawl timed out after ${DEFAULT_TIMEOUT_MS}ms.`));
		}, DEFAULT_TIMEOUT_MS);

		child.stdout.on('data', (chunk) => {
			stdout += chunk.toString();
		});

		child.stderr.on('data', (chunk) => {
			stderr += chunk.toString();
		});

		child.on('error', (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(error);
		});

		child.on('close', (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);

			try {
				const payload = JSON.parse(String(stdout || '').trim() || '{}');
				if (!payload?.ok) {
					const errorMessage = payload?.error || stderr.trim() || `Scrapy crawler exited with code ${code}`;
					return reject(new Error(errorMessage));
				}

				return resolve({
					startUrl: payload.startUrl || url,
					pageCount: Number(payload.pageCount) || 0,
					pages: Array.isArray(payload.pages) ? payload.pages : [],
					stats: payload.stats && typeof payload.stats === 'object' ? payload.stats : {},
					engine: 'scrapy',
				});
			} catch (error) {
				logger.error('Scrapy output parse error', {
					url,
					code,
					stderr: stderr.trim(),
					error: error.message,
				});
				reject(new Error(stderr.trim() || error.message || 'Failed to parse Scrapy output.'));
			}
		});
	});
}
