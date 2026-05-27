import axios from "axios";
import * as cheerio from "cheerio";

const REQUEST_TIMEOUT = Number(process.env.REQUEST_TIMEOUT_MS) || 15000;
const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const logger = {
  info: console.log,
  warn: console.warn,
  error: console.error,
};

export async function getZillowPropertyDetails(addressOrUrl) {
  const candidates = await resolvePropertyCandidates(addressOrUrl);

  for (const candidate of candidates) {
    try {
      const result = await fetchPropertyDetails(
        candidate.url,
        candidate.provider,
      );
      if (result && (result.salesHistory.length || result.taxHistory.length)) {
        return result;
      }
    } catch (error) {
      logger.warn(
        `Property history fetch skipped for ${candidate.url}: ${error.message}`,
      );
    }
  }

  return {
    sourceUrl: isHttpUrl(addressOrUrl) ? String(addressOrUrl) : "",
    address: !isHttpUrl(addressOrUrl) ? normalizeWhitespace(addressOrUrl) : "",
    salesHistory: [],
    taxHistory: [],
    resoFacts: {},
    provider: "fallback",
  };
}

async function resolvePropertyCandidates(addressOrUrl) {
  const value = normalizeWhitespace(addressOrUrl);
  if (!value) return [];

  if (isHttpUrl(value)) {
    return [{ provider: detectProvider(value), url: value }];
  }

  const listingQueries = [
    {
      query: `"${value}" site:realtor.com/realestateandhomes-detail`,
      domainRe: /realtor\.com/i,
      pathRe: /realestateandhomes-detail/i,
    },
    {
      query: `"${value}" site:redfin.com`,
      domainRe: /redfin\.com/i,
      pathRe: /\/home\//i,
    },
    {
      query: `"${value}" site:zillow.com/homedetails`,
      domainRe: /zillow\.com/i,
      pathRe: /homedetails/i,
    },
  ];

  const assessorQueries = [
    { query: `"${value}" site:bcad.us`, domainRe: /bcad\.us/i, pathRe: null },
    {
      query: `"${value}" site:oklahoma.gov`,
      domainRe: /oklahoma\.gov/i,
      pathRe: null,
    },
  ];

  const discovered = [];
  const seen = new Set();

  for (const spec of [...listingQueries, ...assessorQueries]) {
    const urls = await discoverPropertyUrls(
      spec.query,
      spec.domainRe,
      spec.pathRe,
    );
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      discovered.push({ provider: detectProvider(url), url });
    }
  }

  return discovered;
}

async function discoverPropertyUrls(
  query,
  domainRe = /realtor\.com|redfin\.com|zillow\.com/i,
  pathRe = /realestateandhomes-detail|homedetails|\/home\//i,
) {
  const endpoints = [
    {
      url: "https://html.duckduckgo.com/html/",
      params: { q: query },
      referer: "https://duckduckgo.com/",
    },
    {
      url: "https://www.bing.com/search",
      params: { q: query, count: 10 },
      referer: "https://www.bing.com/",
    },
  ];

  const matches = new Set();

  for (const endpoint of endpoints) {
    try {
      const { data } = await axios.get(endpoint.url, {
        params: endpoint.params,
        headers: {
          ...REQUEST_HEADERS,
          Referer: endpoint.referer,
        },
        timeout: REQUEST_TIMEOUT,
      });

      const $ = cheerio.load(String(data || ""));
      $("a[href]").each((_index, element) => {
        const href = normalizeResultUrl(
          $(element).attr("href") || "",
          endpoint.url,
        );
        if (!href) return;
        if (!domainRe.test(href)) return;
        if (pathRe && !pathRe.test(href)) return;
        matches.add(href);
      });

      if (matches.size) {
        return [...matches].slice(0, 6);
      }
    } catch {
      // try next endpoint
    }
  }

  return [...matches].slice(0, 6);
}

function normalizeResultUrl(href = "", baseUrl = "https://duckduckgo.com") {
  if (!href) return "";

  try {
    const url = new URL(href, baseUrl);

    if (/duckduckgo\.com$/i.test(url.hostname)) {
      const uddg = url.searchParams.get("uddg");
      if (uddg) return decodeURIComponent(uddg);
    }

    if (/google\./i.test(url.hostname) && url.pathname === "/url") {
      const target = url.searchParams.get("q");
      if (target) return target;
    }

    if (/bing\.com$/i.test(url.hostname)) {
      const target = url.searchParams.get("u") || url.searchParams.get("url");
      if (target && /^https?:/i.test(target)) return target;
    }

    return /^https?:$/i.test(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

async function fetchPropertyDetails(url, providerHint = "") {
  const { data } = await axios.get(url, {
    headers: REQUEST_HEADERS,
    timeout: REQUEST_TIMEOUT,
  });

  const html = String(data || "");
  const $ = cheerio.load(html);
  const provider = providerHint || detectProvider(url);

  const extracted =
    provider === "zillow"
      ? extractZillowPayload($)
      : extractGenericPropertyPayload($, html, provider);

  return formatPropertyData(extracted, url, provider);
}

function extractZillowPayload($) {
  const nextDataScript = $("#__NEXT_DATA__").html();
  if (nextDataScript) {
    const data = safeJsonParse(nextDataScript);
    const props = data?.props?.pageProps?.componentProps?.gdpClientCache || {};
    const propertyKey = Object.keys(props).find((key) =>
      key.includes("Property"),
    );
    const propertyData = props[propertyKey]?.property || {};
    if (propertyData && Object.keys(propertyData).length) {
      return propertyData;
    }
  }

  const apolloDataScript = $("#hdpApolloPreloadedData").html();
  if (apolloDataScript) {
    const parsedData = safeJsonParse(apolloDataScript);
    const cache = safeJsonParse(parsedData?.apiCache);
    const propertyKey = Object.keys(cache || {}).find(
      (key) => cache[key]?.property,
    );
    const propertyData = cache?.[propertyKey]?.property || {};
    if (propertyData && Object.keys(propertyData).length) {
      return propertyData;
    }
  }

  logger.warn("Could not find Zillow embedded property data.");
  return {};
}

function extractGenericPropertyPayload($, html = "", provider = "property") {
  const payloads = [];

  const nextData = $("#__NEXT_DATA__").html();
  if (nextData) {
    const parsed = safeJsonParse(nextData);
    if (parsed) payloads.push(parsed);
  }

  $("script[type='application/ld+json']").each((_index, element) => {
    const parsed = safeJsonParse($(element).html() || "");
    if (parsed) payloads.push(parsed);
  });

  const propertyHistoryMatches = [
    ...html.matchAll(
      /"(?:priceHistory|propertyHistory|property_history)"\s*:\s*(\[[\s\S]*?\])/g,
    ),
  ];

  for (const match of propertyHistoryMatches) {
    const parsed = safeJsonParse(match[1]);
    if (parsed) {
      payloads.push({ priceHistory: parsed });
    }
  }

  const priceHistory = pickBestHistory(payloads, provider);
  const taxHistory = pickBestTaxHistory(payloads, provider);
  const address = normalizeWhitespace(
    $("h1").first().text() || $("title").text(),
  );

  return {
    address,
    priceHistory,
    taxHistory,
    resoFacts: {},
  };
}

function pickBestHistory(payloads = [], provider = "") {
  const candidates = payloads
    .flatMap((payload) => collectHistoryArrays(payload, provider))
    .sort((left, right) => right.length - left.length);

  return candidates[0] || [];
}

function pickBestTaxHistory(payloads = [], provider = "") {
  const candidates = payloads
    .flatMap((payload) => collectTaxArrays(payload, provider))
    .sort((left, right) => right.length - left.length);

  return candidates[0] || [];
}

function collectHistoryArrays(value, provider = "", seen = new WeakSet()) {
  if (!value || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);

  const found = [];

  if (Array.isArray(value)) {
    const normalized = dedupeHistoryEntries(
      value
        .map((entry) => normalizeHistoryEntry(entry, provider))
        .filter(Boolean),
    );

    if (normalized.length) {
      found.push(normalized);
    }

    for (const entry of value) {
      found.push(...collectHistoryArrays(entry, provider, seen));
    }

    return found;
  }

  for (const entry of Object.values(value)) {
    found.push(...collectHistoryArrays(entry, provider, seen));
  }

  return found;
}

function collectTaxArrays(value, provider = "", seen = new WeakSet()) {
  if (!value || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);

  const found = [];

  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => normalizeTaxEntry(entry, provider))
      .filter(Boolean);

    if (normalized.length) {
      found.push(normalized);
    }

    for (const entry of value) {
      found.push(...collectTaxArrays(entry, provider, seen));
    }

    return found;
  }

  for (const entry of Object.values(value)) {
    found.push(...collectTaxArrays(entry, provider, seen));
  }

  return found;
}

function normalizeHistoryEntry(entry = {}, provider = "") {
  if (!entry || typeof entry !== "object") return null;

  const date = pickFirstValue(entry, [
    "date",
    "eventDate",
    "time",
    "listingDate",
    "soldDate",
    "statusDate",
    "priceDate",
  ]);
  const event = pickFirstValue(entry, [
    "event",
    "eventName",
    "description",
    "status",
    "statusText",
    "listingType",
    "title",
  ]);
  const rawPrice = pickFirstValue(entry, [
    "price",
    "listPrice",
    "soldPrice",
    "amount",
    "value",
    "list_price",
    "sold_price",
  ]);
  const pricePerSquareFoot = pickFirstValue(entry, [
    "pricePerSquareFoot",
    "pricePerSqft",
    "price_per_sqft",
    "pricePerSquareFeet",
  ]);
  const source =
    pickFirstValue(entry, [
      "source",
      "sourceName",
      "provider",
      "listingSource",
      "brokerName",
      "attribution",
      "mlsName",
      "mls",
    ]) || provider;

  if (!date && !event && !rawPrice) {
    return null;
  }

  return {
    date: normalizeWhitespace(date),
    event: normalizeWhitespace(
      event || (rawPrice ? "Price update" : "History"),
    ),
    price: formatMoney(rawPrice),
    pricePerSquareFoot: formatMoney(pricePerSquareFoot),
    source: normalizeWhitespace(source),
  };
}

function normalizeTaxEntry(entry = {}, provider = "") {
  if (!entry || typeof entry !== "object") return null;

  const year = pickFirstValue(entry, ["year", "time", "date"]);
  const value = pickFirstValue(entry, [
    "value",
    "assessedValue",
    "taxAssessedValue",
  ]);
  const taxPaid = pickFirstValue(entry, ["taxPaid", "taxes", "amount"]);

  if (!year && !value && !taxPaid) {
    return null;
  }

  return {
    year: normalizeWhitespace(year),
    value: formatMoney(value),
    taxPaid: formatMoney(taxPaid),
    source: provider,
  };
}

function formatPropertyData(propertyData = {}, sourceUrl = "", provider = "") {
  const addressValue = propertyData.address;
  const address =
    typeof addressValue === "string"
      ? addressValue
      : normalizeWhitespace(
          [
            addressValue?.streetAddress,
            addressValue?.city,
            addressValue?.state,
            addressValue?.zipcode,
          ]
            .filter(Boolean)
            .join(", "),
        );

  const salesHistory = dedupeHistoryEntries(
    (propertyData.priceHistory || [])
      .map((entry) => normalizeHistoryEntry(entry, provider))
      .filter(Boolean),
  );
  const taxHistory = (propertyData.taxHistory || [])
    .map((entry) => normalizeTaxEntry(entry, provider))
    .filter(Boolean);

  return {
    sourceUrl,
    address: address || null,
    salesHistory,
    taxHistory,
    resoFacts: propertyData.resoFacts || {},
    provider,
  };
}

function dedupeHistoryEntries(entries = []) {
  const seen = new Set();

  return [...entries]
    .filter((entry) => {
      const key = [entry.date, entry.event, entry.price, entry.source]
        .join("|")
        .toLowerCase();
      if (!key.replace(/\|/g, "")) return false;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (left, right) => parseDateValue(right.date) - parseDateValue(left.date),
    );
}

function parseDateValue(value = "") {
  const parsed = Date.parse(String(value || ""));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function pickFirstValue(source = {}, keys = []) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && normalizeWhitespace(value)) {
      return value;
    }
  }

  return "";
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeWhitespace(value = "") {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatMoney(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string" && value.includes("$")) {
    return normalizeWhitespace(value);
  }

  const numeric = Number(String(value).replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(numeric) || numeric === 0) {
    return normalizeWhitespace(value);
  }

  return `$${numeric.toLocaleString()}`;
}

function isHttpUrl(value = "") {
  try {
    const url = new URL(String(value));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function detectProvider(value = "") {
  const host = isHttpUrl(value) ? new URL(value).hostname : String(value || "");
  if (/zillow\./i.test(host)) return "zillow";
  if (/realtor\./i.test(host)) return "realtor";
  if (/redfin\./i.test(host)) return "redfin";
  if (/bcad\.us$/i.test(host)) return "bcad";
  if (/oklahoma\.gov$/i.test(host)) return "oklahoma-assessor";
  return "property";
}
