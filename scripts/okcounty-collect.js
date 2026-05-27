/**
 * okcounty-collect.js
 *
 * Collects real-time records from okcountyrecords.com for every site
 * listed on /site-list?updated.
 *
 * Strategy:
 *  1. Open browser visibly so Cloudflare managed-challenge can be solved.
 *  2. Navigate to /site-list?updated, wait for real content, scrape site slugs.
 *  3. For each slug, request /real-time?site=<slug>&limit=1000 from within
 *     the page context (same-origin, carries CF cookies).
 *  4. Random delay between each site to avoid rate-limiting.
 *  5. Incrementally write results to --output file (default: server/data/okcounty-collected.json).
 *
 * Usage:
 *   node scripts/okcounty-collect.js [--output path/to/out.json] [--limit 500] [--delay-min 4] [--delay-max 12]
 */

import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { writeFile, readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

puppeteer.use(StealthPlugin());

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const get = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};

const OUTPUT = get(
  "--output",
  path.resolve(__dirname, "../server/data/okcounty-collected.json"),
);
const LIMIT = parseInt(get("--limit", "1000"), 10);
const DELAY_MIN = parseInt(get("--delay-min", "4"), 10) * 1000;
const DELAY_MAX = parseInt(get("--delay-max", "12"), 10) * 1000;
const BASE_URL = "https://okcountyrecords.com";

// ── Helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () =>
  Math.floor(Math.random() * (DELAY_MAX - DELAY_MIN) + DELAY_MIN);

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  ensureDir(OUTPUT);

  const browser = await puppeteer.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    defaultViewport: null,
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  );

  // ── Step 1: load site-list and wait for human to pass CF if needed ────────
  console.log(`\nOpening ${BASE_URL}/site-list?updated …`);
  console.log(
    "If a Cloudflare challenge appears, solve it in the browser window.\n",
  );

  await page.goto(`${BASE_URL}/site-list?updated`, {
    waitUntil: "networkidle2",
    timeout: 180_000,
  });

  // Wait until the page body contains actual site links (not the CF challenge page)
  await page.waitForFunction(
    () =>
      document.querySelectorAll("a[href*='/real-time']").length > 0 ||
      document.querySelectorAll("table tr td").length > 5,
    { timeout: 180_000 },
  );

  // ── Step 2: extract site slugs ────────────────────────────────────────────
  const sites = await page.evaluate(() => {
    const results = [];

    // Try anchor tags that link to /real-time?site=...
    document.querySelectorAll("a[href]").forEach((a) => {
      const m = a.href.match(/[?&]site=([^&]+)/);
      if (m) results.push({ slug: m[1], label: a.textContent.trim() });
    });

    // Fallback: look for data-site attributes
    if (results.length === 0) {
      document.querySelectorAll("[data-site]").forEach((el) => {
        results.push({ slug: el.dataset.site, label: el.textContent.trim() });
      });
    }

    // Fallback: scan all links for /real-time or /search/oklahoma/<slug>
    if (results.length === 0) {
      document.querySelectorAll("a[href]").forEach((a) => {
        const m = a.pathname.match(/\/search\/oklahoma\/([^/]+)/);
        if (m) results.push({ slug: m[1], label: a.textContent.trim() });
      });
    }

    // Deduplicate by slug
    const seen = new Set();
    return results.filter(({ slug }) => {
      if (seen.has(slug)) return false;
      seen.add(slug);
      return true;
    });
  });

  if (sites.length === 0) {
    console.error("Could not find any site slugs on the page.");
    console.log(
      "Dumping page HTML to /tmp/sitelist-debug.html for inspection.",
    );
    const html = await page.content();
    await writeFile("/tmp/sitelist-debug.html", html);
    await browser.close();
    process.exit(1);
  }

  console.log(
    `Found ${sites.length} sites:`,
    sites.map((s) => s.slug).join(", "),
    "\n",
  );

  // ── Step 3: load existing output so we can resume ────────────────────────
  let collected = {};
  if (existsSync(OUTPUT)) {
    try {
      collected = JSON.parse(await readFile(OUTPUT, "utf8"));
      console.log(
        `Resuming — ${Object.keys(collected).length} sites already collected.\n`,
      );
    } catch {
      collected = {};
    }
  }

  // ── Step 4: fetch each site with delays ───────────────────────────────────
  for (const { slug, label } of sites) {
    if (collected[slug]) {
      console.log(
        `  skip  ${slug} (already collected ${collected[slug].items.length} records)`,
      );
      continue;
    }

    const url = `${BASE_URL}/real-time?site=${encodeURIComponent(slug)}&limit=${LIMIT}`;
    console.log(`  fetch ${slug} (${label}) …`);

    try {
      const result = await page.evaluate(async (fetchUrl) => {
        const res = await fetch(fetchUrl, { credentials: "same-origin" });
        const ct = res.headers.get("content-type") || "";
        if (!ct.includes("json")) {
          const text = await res.text();
          return {
            error: `non-JSON response (${res.status})`,
            preview: text.slice(0, 200),
          };
        }
        return res.json();
      }, url);

      if (result.error) {
        console.warn(`    ! ${slug}: ${result.error} — ${result.preview}`);
      } else {
        const items = result.items ?? [];
        console.log(`    ✓ ${items.length} records`);
        collected[slug] = {
          slug,
          label,
          fetchedAt: new Date().toISOString(),
          hash: result.hash,
          items,
        };
        // Write incrementally after each success
        await writeFile(OUTPUT, JSON.stringify(collected, null, 2));
      }
    } catch (err) {
      console.warn(`    ! ${slug}: ${err.message}`);
    }

    const delay = jitter();
    console.log(`    … waiting ${(delay / 1000).toFixed(1)}s`);
    await sleep(delay);
  }

  // ── Step 5: summary ───────────────────────────────────────────────────────
  const total = Object.values(collected).reduce(
    (n, v) => n + (v.items?.length ?? 0),
    0,
  );
  console.log(
    `\nDone. ${Object.keys(collected).length} sites, ${total} total records.`,
  );
  console.log(`Output: ${OUTPUT}\n`);

  await browser.close();
})();
