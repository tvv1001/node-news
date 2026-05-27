#!/usr/bin/env node
// One-shot script: launches Chrome with your existing profile, reads x.com cookies,
// and writes X_AUTH_TOKEN + X_CSRF_TOKEN into server/.env
import puppeteer from 'puppeteer';
import { readFile, writeFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.resolve(__dirname, '../server/.env');
const CHROME_PROFILE = path.join(os.homedir(), '.config/google-chrome');
// Copy profile to a temp dir so Puppeteer doesn't conflict with a running Chrome.
const TMP_PROFILE = path.join(os.tmpdir(), `chrome-cookie-extract-${Date.now()}`);
console.log('Copying Chrome profile to temp dir...');
await cp(CHROME_PROFILE, TMP_PROFILE, { recursive: true });
// Remove lock files so headless Chrome can start even while the real Chrome runs
for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'Default/lockfile']) {
	await rm(path.join(TMP_PROFILE, lock), { force: true });
}

console.log('Launching headless Chrome with copied profile...');

const browser = await puppeteer.launch({
	executablePath: '/usr/bin/google-chrome',
	userDataDir: TMP_PROFILE,
	headless: true,
	args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--password-store=basic'],
});

const page = await browser.newPage();
// Navigate to x.com to ensure cookies are loaded
await page.goto('https://x.com', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

const cookies = await page.cookies('https://x.com');
await browser.close();

const authToken = cookies.find((c) => c.name === 'auth_token')?.value;
const ct0 = cookies.find((c) => c.name === 'ct0')?.value;

if (!authToken || !ct0) {
	console.error('❌ Could not find auth_token or ct0 cookies. Make sure you are logged in to x.com in Chrome.');
	console.error('Found cookies:', cookies.map((c) => c.name).join(', ') || '(none)');
	process.exit(1);
}

console.log(`✓ auth_token: ${authToken.slice(0, 8)}...`);
console.log(`✓ ct0: ${ct0.slice(0, 8)}...`);

// Read existing .env and update/add the two keys
let env = '';
try {
	env = await readFile(ENV_FILE, 'utf8');
} catch {
	// file may not exist yet
}

function setEnvKey(content, key, value) {
	const re = new RegExp(`^${key}=.*$`, 'm');
	const line = `${key}=${value}`;
	return re.test(content) ? content.replace(re, line) : content + (content.endsWith('\n') ? '' : '\n') + line + '\n';
}

env = setEnvKey(env, 'X_AUTH_TOKEN', authToken);
env = setEnvKey(env, 'X_CSRF_TOKEN', ct0);

await writeFile(ENV_FILE, env, 'utf8');
await rm(TMP_PROFILE, { recursive: true, force: true });
console.log(`✓ Written to ${ENV_FILE}`);
console.log('Restart the server (pnpm run dev:server) to pick up the new credentials.');
