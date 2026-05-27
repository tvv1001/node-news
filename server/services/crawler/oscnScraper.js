/**
 * oscnScraper.js
 *
 * Oklahoma State Courts Network (OSCN) public records lookup.
 * https://www.oscn.net/dockets/
 *
 * Party search → GET /dockets/Results.aspx
 * Case detail  → GET /dockets/GetCaseInformation.aspx
 *
 * All data is public (no auth required). Results are cached in
 * server/data/oklahoma/oscn-cache.json to avoid repeated remote hits.
 *
 * Exports:
 *   searchOscnByName({ lastName, firstName, county, dobMin, dobMax }) → { results, fromCache }
 *   getOscnCaseDetail(url) → { caseNumber, caseType, filed, closed, judge, parties, docket, fromCache }
 *   OKLAHOMA_COUNTIES  (Map: display name → db value)
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import axios from "axios";
import { logger } from "../../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../data/oklahoma");
const CACHE_FILE = path.join(DATA_DIR, "oscn-cache.json");

const BASE = "https://www.oscn.net/dockets";
const SEARCH_URL = `${BASE}/Results.aspx`;
const CASE_URL = `${BASE}/GetCaseInformation.aspx`;

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) || 15000;
const DELAY_MS = 1000;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.oscn.net/dockets/Search.aspx",
};

// ---------------------------------------------------------------------------
// County list (display → db param value)
// ---------------------------------------------------------------------------

export const OKLAHOMA_COUNTIES = new Map([
  ["All Oklahoma Courts", "all"],
  ["Adair", "adair"],
  ["Alfalfa", "alfalfa"],
  ["Appellate Courts", "appellate"],
  ["Atoka", "atoka"],
  ["Beaver", "beaver"],
  ["Beckham", "beckham"],
  ["Blaine", "blaine"],
  ["Bryan", "bryan"],
  ["Caddo", "caddo"],
  ["Canadian", "canadian"],
  ["Carter", "carter"],
  ["Cherokee", "cherokee"],
  ["Choctaw", "choctaw"],
  ["Cimarron", "cimarron"],
  ["Cleveland", "cleveland"],
  ["Coal", "coal"],
  ["Comanche", "comanche"],
  ["Cotton", "cotton"],
  ["Craig", "craig"],
  ["Creek", "creek"],
  ["Creek (Bristow)", "bristow"],
  ["Custer", "custer"],
  ["Delaware", "delaware"],
  ["Dewey", "dewey"],
  ["Ellis", "ellis"],
  ["Garfield", "garfield"],
  ["Garvin", "garvin"],
  ["Grady", "grady"],
  ["Grant", "grant"],
  ["Greer", "greer"],
  ["Harmon", "harmon"],
  ["Harper", "harper"],
  ["Haskell", "haskell"],
  ["Hughes", "hughes"],
  ["Jackson", "jackson"],
  ["Jefferson", "jefferson"],
  ["Johnston", "johnston"],
  ["Kay", "kay"],
  ["Kingfisher", "kingfisher"],
  ["Kiowa", "kiowa"],
  ["Latimer", "latimer"],
  ["Le Flore", "leflore"],
  ["Lincoln", "lincoln"],
  ["Logan", "logan"],
  ["Love", "love"],
  ["Major", "major"],
  ["Marshall", "marshall"],
  ["Mayes", "mayes"],
  ["McClain", "mcclain"],
  ["McCurtain", "mccurtain"],
  ["McIntosh", "mcintosh"],
  ["Murray", "murray"],
  ["Muskogee", "muskogee"],
  ["Noble", "noble"],
  ["Nowata", "nowata"],
  ["Okfuskee", "okfuskee"],
  ["Oklahoma", "oklahoma"],
  ["Okmulgee", "okmulgee"],
  ["Osage", "osage"],
  ["Ottawa", "ottawa"],
  ["Pawnee", "pawnee"],
  ["Payne", "payne"],
  ["Pittsburg", "pittsburg"],
  ["Pontotoc", "pontotoc"],
  ["Pottawatomie", "pottawatomie"],
  ["Pushmataha", "pushmataha"],
  ["Roger Mills", "rogermills"],
  ["Rogers", "rogers"],
  ["Seminole", "seminole"],
  ["Sequoyah", "sequoyah"],
  ["Stephens", "stephens"],
  ["Texas County", "texas"],
  ["Tillman", "tillman"],
  ["Tulsa", "tulsa"],
  ["Wagoner", "wagoner"],
  ["Washington", "washington"],
  ["Washita", "washita"],
  ["Woods", "woods"],
  ["Woodward", "woodward"],
]);

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

async function loadCache() {
  try {
    const raw = await readFile(CACHE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveCache(cache) {
  try {
    ensureDataDir();
    await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
  } catch (err) {
    logger.warn("oscnScraper: cache write failed", { error: err.message });
  }
}

function isCacheExpired(entry) {
  return !entry?.fetchedAt || Date.now() - entry.fetchedAt > CACHE_TTL_MS;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// HTML parsing helpers
// ---------------------------------------------------------------------------

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse the Results.aspx page into an array of case summary objects.
 *
 * Each <tr> in the results table has 4 <td> cells:
 *   [0] Case number (with link to GetCaseInformation)
 *   [1] Filed date
 *   [2] Case style
 *   [3] Found party (name + role)
 */
function parseSearchResults(html) {
  const results = [];

  // Find all <tr> rows
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const row = rowMatch[1];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells = [];
    let tdMatch;
    while ((tdMatch = tdRe.exec(row)) !== null) {
      cells.push(tdMatch[1]);
    }
    if (cells.length < 3) continue;

    const caseNumberText = stripTags(cells[0]);
    if (!/^[A-Z]{1,4}-\d{4}-/.test(caseNumberText)) continue;

    // Extract link from cell[0]
    const linkMatch = cells[0].match(/href="(GetCaseInformation\.aspx[^"]+)"/);
    const url = linkMatch ? `${BASE}/${linkMatch[1]}` : null;

    results.push({
      caseNumber: caseNumberText,
      filed: stripTags(cells[1]),
      style: stripTags(cells[2]),
      foundParty: cells[3] ? stripTags(cells[3]) : null,
      url,
    });
  }

  return results;
}

/**
 * Parse a GetCaseInformation.aspx page into structured case data.
 *
 * The page has two key tables:
 *   class="caseStyle"  — parties + metadata (case number, type, dates, judge)
 *   class="docketlist" — docket event rows (date, code, description, amount)
 */
function parseCaseDetail(html) {
  // ---- Case style table ----
  const styleMatch = html.match(/class="caseStyle"([\s\S]*?)<\/table>/);
  let parties = [];
  let caseNumber = null;
  let caseType = null;
  let filed = null;
  let closed = null;
  let judge = null;

  if (styleMatch) {
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let m;
    const tds = [];
    while ((m = tdRe.exec(styleMatch[1])) !== null) {
      tds.push(stripTags(m[1]));
    }

    // td[0]: parties block
    // td[1]: "No. CJ-2024-100 (Case type) Filed: MM/DD/YYYY Closed: MM/DD/YYYY Judge: Name"
    const partiesRaw = tds[0] || "";
    const metaRaw = tds[1] || "";

    // Parse parties text: names separated by "v.", commas, "AND"
    // Roles appear as "Plaintiff" / "Defendant" on their own line
    const partyLines = partiesRaw
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    let currentRole = null;
    for (const line of partyLines) {
      if (/^plaintiff[.,]?$/i.test(line)) {
        currentRole = "Plaintiff";
        continue;
      }
      if (/^defendant[.,]?$/i.test(line)) {
        currentRole = "Defendant";
        continue;
      }
      if (/^v[.,]?$/.test(line)) continue;
      if (/^AND$/i.test(line)) continue;
      const clean = line.replace(/,$/, "").replace(/\.$/, "").trim();
      if (clean) parties.push({ name: clean, role: currentRole });
    }

    // Parse meta line
    const noMatch = metaRaw.match(/No\.\s+([A-Z]+-\d{4}-\d+)/);
    if (noMatch) caseNumber = noMatch[1];

    const typeMatch = metaRaw.match(/\(([^)]+)\)/);
    if (typeMatch) caseType = typeMatch[1].trim();

    const filedMatch = metaRaw.match(/Filed:\s*([\d/]+)/);
    if (filedMatch) filed = filedMatch[1];

    const closedMatch = metaRaw.match(/Closed:\s*([\d/]+)/);
    if (closedMatch) closed = closedMatch[1];

    const judgeMatch = metaRaw.match(/Judge:\s*(.+)$/);
    if (judgeMatch) judge = judgeMatch[1].trim();
  }

  // ---- Docket table ----
  const docket = [];
  const docketStart = html.indexOf('<table class="docketlist');
  if (docketStart >= 0) {
    const docketEnd = html.indexOf("</table>", docketStart) + 8;
    const docketHtml = html.slice(docketStart, docketEnd);

    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    let headerSkipped = false;
    while ((rowMatch = rowRe.exec(docketHtml)) !== null) {
      if (!headerSkipped) {
        headerSkipped = true;
        continue;
      }
      const row = rowMatch[1];
      const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      const cells = [];
      let tdMatch;
      while ((tdMatch = tdRe.exec(row)) !== null) {
        cells.push(stripTags(tdMatch[1]));
      }
      const nonEmpty = cells.filter(Boolean);
      if (!nonEmpty.length) continue;
      // Date is first cell, must look like a date
      if (!/^\d{2}-\d{2}-\d{4}/.test(nonEmpty[0])) continue;

      docket.push({
        date: nonEmpty[0].replace(/&nbsp;/g, "").trim(),
        code: nonEmpty[1] || null,
        description: nonEmpty[2] || null,
        count: nonEmpty[3] || null,
        amount: nonEmpty.find((c) => /^\$/.test(c)) || null,
      });
    }
  }

  return { caseNumber, caseType, filed, closed, judge, parties, docket };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search OSCN by person name.
 *
 * @param {object} params
 * @param {string} params.lastName   - Required
 * @param {string} params.firstName  - Optional
 * @param {string} [params.county]   - db param value (default: "all")
 * @param {string} [params.dobMin]   - MM/DD/YYYY
 * @param {string} [params.dobMax]   - MM/DD/YYYY
 * @returns {Promise<{ results: Array, fromCache: boolean, fetchedAt: number }>}
 */
export async function searchOscnByName({
  lastName,
  firstName = "",
  county = "all",
  dobMin = "",
  dobMax = "",
} = {}) {
  if (!lastName) throw new Error("lastName is required");

  const cacheKey = `search:${county}:${lastName.toLowerCase()}:${firstName.toLowerCase()}`;
  const cache = await loadCache();

  if (cache[cacheKey] && !isCacheExpired(cache[cacheKey])) {
    return { ...cache[cacheKey], fromCache: true };
  }

  await delay(DELAY_MS);

  const params = new URLSearchParams({
    db: county,
    number: "",
    lname: lastName,
    fname: firstName,
    mname: "",
    DoBMin: dobMin,
    DoBMax: dobMax,
    partytype: "0",
    casetype: "",
    dcct: "",
    FiledDateL: "",
    FiledDateH: "",
    ClosedDateL: "",
    ClosedDateH: "",
    lowerCourt: "",
    lowerCourtNumber: "",
    lowerCourtYear: "",
    citation: "",
    generatedBy: "0",
    cmdSearch: "Search",
  });

  let html;
  try {
    const resp = await axios.get(`${SEARCH_URL}?${params}`, {
      headers: HEADERS,
      timeout: REQUEST_TIMEOUT_MS,
    });
    html = resp.data;
  } catch (err) {
    logger.error("oscnScraper: search request failed", { error: err.message });
    throw new Error("OSCN search request failed");
  }

  const results = parseSearchResults(html);
  const entry = { results, fetchedAt: Date.now() };
  cache[cacheKey] = entry;
  await saveCache(cache);

  logger.info("oscnScraper: search complete", {
    lastName,
    firstName,
    county,
    count: results.length,
  });
  return { ...entry, fromCache: false };
}

/**
 * Fetch and parse a single OSCN case detail page.
 *
 * @param {string} caseUrl  Full URL to GetCaseInformation.aspx (from search results)
 * @returns {Promise<object>} Parsed case detail with fromCache flag
 */
export async function getOscnCaseDetail(caseUrl) {
  if (!caseUrl || !caseUrl.includes("GetCaseInformation")) {
    throw new Error("Invalid OSCN case URL");
  }

  const cacheKey = `case:${caseUrl}`;
  const cache = await loadCache();

  if (cache[cacheKey] && !isCacheExpired(cache[cacheKey])) {
    return { ...cache[cacheKey].data, fromCache: true };
  }

  await delay(DELAY_MS);

  let html;
  try {
    const resp = await axios.get(caseUrl, {
      headers: HEADERS,
      timeout: REQUEST_TIMEOUT_MS,
    });
    html = resp.data;
  } catch (err) {
    logger.error("oscnScraper: case detail request failed", {
      url: caseUrl,
      error: err.message,
    });
    throw new Error("OSCN case detail request failed");
  }

  const data = parseCaseDetail(html);
  data.sourceUrl = caseUrl;
  data.fetchedAt = Date.now();

  cache[cacheKey] = { data, fetchedAt: Date.now() };
  await saveCache(cache);

  logger.info("oscnScraper: case detail fetched", {
    caseNumber: data.caseNumber,
  });
  return { ...data, fromCache: false };
}
