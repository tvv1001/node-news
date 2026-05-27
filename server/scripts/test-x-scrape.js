import 'dotenv/config';
import { scrapeXKeywordFeed, hasXCredentials } from '../services/crawler/xSearchScraper.js';

const cliArgs = process.argv.slice(2).filter((arg) => arg !== '--');
const keyword = String(cliArgs[0] || 'openai').trim();
const filter = String(cliArgs[1] || 'live').trim();

if (!keyword) {
	console.error(JSON.stringify({ ok: false, message: 'keyword is required' }));
	process.exit(1);
}

console.log(JSON.stringify({ hasXCredentials: hasXCredentials(), keyword, filter }));

try {
	const xml = await scrapeXKeywordFeed(keyword, { filter });
	console.log(JSON.stringify({ ok: true, length: xml.length, head: xml.slice(0, 300) }));
} catch (error) {
	console.error(JSON.stringify({ ok: false, message: error.message }));
	process.exitCode = 1;
}
