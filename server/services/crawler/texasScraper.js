/**
 * texasScraper.js
 *
 * Texas public property-record lookup via texasfile.com.
 *
 * Fuzzy-matches the search city against all 1,335 known Texas cities to
 * detect TX residents even when `state` is blank.  If the person appears to
 * be in Texas, it queries the texasfile.com grantor/grantee search and
 * appends deed / instrument records to the caller's profile.
 *
 * Results are cached in server/data/texas/records-cache.json so repeated
 * searches for the same name don't hit the remote.
 *
 * NOTE: texasfile.com requires an account for full document access.
 *       This module only consumes the publicly visible search-results page
 *       (no login, no document downloads).
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import axios from "axios";
import * as cheerio from "cheerio";
import { logger } from "../../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../data/texas");
const CITY_MAP_FILE = path.join(DATA_DIR, "city-county-map.json");
const CACHE_FILE = path.join(DATA_DIR, "records-cache.json");

const BASE_SEARCH_URL = "https://www.texasfile.com/search/texas/";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) || 15000;
const DELAY_MS = 1500;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.texasfile.com/",
};

// ---------------------------------------------------------------------------
// City → County lookup (loaded once)
// ---------------------------------------------------------------------------

let _cityToCounty = null;

async function getCityMap() {
  if (_cityToCounty) return _cityToCounty;
  try {
    const raw = await readFile(CITY_MAP_FILE, "utf-8");
    _cityToCounty = JSON.parse(raw).cityToCounty ?? {};
  } catch {
    _cityToCounty = {};
  }
  return _cityToCounty;
}

/**
 * Returns the Texas county for a city name, or null if not found.
 * Matching is case-insensitive and trims common suffixes ("city", "town").
 */
export async function texasCountyForCity(city = "") {
  const map = await getCityMap();
  const norm = city.toLowerCase().trim();
  if (!norm) return null;

  // Exact match
  if (map[norm]) return map[norm];

  // Try stripping trailing punctuation / "city" / "town"
  const stripped = norm.replace(/\s+(city|town|village|township)$/i, "").trim();
  if (stripped !== norm && map[stripped]) return map[stripped];

  // Partial prefix match (e.g. "san antonio" inside "san antonio tx")
  for (const [key, county] of Object.entries(map)) {
    if (norm.startsWith(key) || key.startsWith(norm)) return county;
  }

  return null;
}

/**
 * Returns true when the search params point to Texas.
 * Checks explicit state value first, then falls back to city lookup.
 */
export async function isTexasSearch(params = {}) {
  const state = String(params.state || "").trim().toUpperCase();
  if (state === "TX" || state === "TEXAS") return true;
  if (state && state !== "TX" && state !== "TEXAS") return false; // explicit non-TX state

  // No state given — try city inference
  const city = String(params.city || "").trim();
  if (!city) return false;
  const county = await texasCountyForCity(city);
  return county !== null;
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

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
    await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
  } catch (err) {
    logger.warn("texasScraper: cache write failed", { error: err.message });
  }
}

function cacheKey(firstName, lastName, county) {
  return [firstName, lastName, county]
    .map((s) => String(s || "").toLowerCase().trim())
    .join("|");
}

// ---------------------------------------------------------------------------
// Parser — extract records from the texasfile.com search-results HTML
// ---------------------------------------------------------------------------

function parseSearchResults($) {
  const records = [];

  // texasfile renders results in a table or card list.
  // Try the table layout first (most common on the grantor/grantee search).
  $("table.results-table tbody tr, table tbody tr").each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length < 3) return;

    const record = {
      source: "texasfile",
      type: "property-record",
      grantor: $(cells[0]).text().trim(),
      grantee: $(cells[1]).text().trim(),
      instrument: $(cells[2]).text().trim(),
      date: $(cells[3])?.text().trim() || "",
      county: $(cells[4])?.text().trim() || "",
      docUrl: $(cells).find("a").attr("href") || "",
    };

    if (record.grantor || record.grantee) {
      records.push(record);
    }
  });

  // Fallback: card / list layout
  if (records.length === 0) {
    $(".result-item, .search-result, [class*='result']").each((_, el) => {
      const text = $(el).text().replace(/\s+/g, " ").trim();
      const link = $(el).find("a").attr("href") || "";
      if (text.length > 10) {
        records.push({
          source: "texasfile",
          type: "property-record",
          summary: text.slice(0, 300),
          docUrl: link,
        });
      }
    });
  }

  return records;
}

// ---------------------------------------------------------------------------
// Core search function
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches public grantor/grantee search results from texasfile.com.
 *
 * @param {string} firstName
 * @param {string} lastName
 * @param {string} county  - Texas county name (e.g. "Harris")
 * @returns {Promise<Array>} array of record objects
 */
async function fetchTexasfileRecords(firstName, lastName, county) {
  const params = new URLSearchParams({
    grantor_grantee: `${lastName} ${firstName}`.trim(),
    county: county || "",
    record_type: "",
    date_from: "",
    date_to: "",
  });

  const url = `${BASE_SEARCH_URL}?${params.toString()}`;

  try {
    const response = await axios.get(url, {
      headers: HEADERS,
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 3,
    });

    const $ = cheerio.load(response.data);
    return parseSearchResults($);
  } catch (err) {
    logger.warn("texasScraper: fetch error", {
      name: `${firstName} ${lastName}`,
      county,
      error: err.message,
    });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Searches Texas public records for a person and returns an array of records.
 * Uses a local cache to avoid redundant remote calls.
 *
 * @param {{ firstName: string, lastName: string, city?: string, state?: string }} params
 * @returns {Promise<{ records: Array, county: string|null, fromCache: boolean }>}
 */
export async function searchTexasRecords(params = {}) {
  const firstName = String(params.firstName || "").trim();
  const lastName = String(params.lastName || "").trim();

  if (!firstName || !lastName) {
    return { records: [], county: null, fromCache: false };
  }

  const county = await texasCountyForCity(params.city || "");
  const key = cacheKey(firstName, lastName, county ?? "");

  const cache = await loadCache();
  const cached = cache[key];
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    logger.info("texasScraper: cache hit", { key });
    return { records: cached.records, county: cached.county, fromCache: true };
  }

  await delay(DELAY_MS);
  logger.info("texasScraper: querying texasfile.com", {
    name: `${firstName} ${lastName}`,
    county,
  });

  const records = await fetchTexasfileRecords(firstName, lastName, county ?? "");

  cache[key] = { fetchedAt: Date.now(), county, records };
  await saveCache(cache);

  return { records, county, fromCache: false };
}

/**
 * Convenience wrapper: runs searchTexasRecords only when the params look like
 * a Texas search.  Returns an empty result otherwise.
 */
export async function maybeSearchTexasRecords(params = {}) {
  const isTX = await isTexasSearch(params);
  if (!isTX) return { records: [], county: null, fromCache: false, skipped: true };
  return searchTexasRecords(params);
}
