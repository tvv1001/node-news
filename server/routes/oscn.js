/**
 * routes/oscn.js
 *
 * Oklahoma State Courts Network (OSCN) public-records routes.
 *
 * GET  /api/oscn/counties
 *   → { counties: [{ label, value }] }
 *
 * POST /api/oscn/search
 *   Body: { lastName, firstName?, county?, dobMin?, dobMax? }
 *   → { results: [...], fromCache, fetchedAt }
 *
 * POST /api/oscn/case
 *   Body: { url }
 *   → { caseNumber, caseType, filed, closed, judge, parties, docket, fromCache }
 *
 * DELETE /api/oscn/cache
 *   → clears the local OSCN cache
 */

import { Router } from "express";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  searchOscnByName,
  getOscnCaseDetail,
  OKLAHOMA_COUNTIES,
} from "../services/crawler/oscnScraper.js";
import { logger } from "../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.resolve(__dirname, "../data/oklahoma/oscn-cache.json");

export const oscnRouter = Router();

// GET /api/oscn/counties
oscnRouter.get("/counties", (_req, res) => {
  const counties = Array.from(OKLAHOMA_COUNTIES.entries()).map(
    ([label, value]) => ({ label, value }),
  );
  res.json({ counties });
});

// POST /api/oscn/search
oscnRouter.post("/search", async (req, res) => {
  const lastName = String(req.body.lastName || "")
    .slice(0, 100)
    .trim();
  const firstName = String(req.body.firstName || "")
    .slice(0, 100)
    .trim();
  const county = String(req.body.county || "all")
    .slice(0, 50)
    .trim();
  const dobMin = String(req.body.dobMin || "")
    .slice(0, 20)
    .trim();
  const dobMax = String(req.body.dobMax || "")
    .slice(0, 20)
    .trim();

  if (!lastName) {
    return res.status(400).json({ error: "lastName is required" });
  }

  // Validate county value against known list
  const validCounty = Array.from(OKLAHOMA_COUNTIES.values()).includes(county)
    ? county
    : "all";

  try {
    const result = await searchOscnByName({
      lastName,
      firstName,
      county: validCounty,
      dobMin,
      dobMax,
    });
    res.json(result);
  } catch (err) {
    logger.error("OSCN search route error", { error: err.message });
    res.status(500).json({ error: "OSCN search failed" });
  }
});

// POST /api/oscn/case
oscnRouter.post("/case", async (req, res) => {
  const url = String(req.body.url || "")
    .slice(0, 500)
    .trim();

  if (!url) {
    return res.status(400).json({ error: "url is required" });
  }

  // Only allow OSCN URLs to prevent SSRF
  if (!url.startsWith("https://www.oscn.net/dockets/GetCaseInformation")) {
    return res.status(400).json({ error: "Invalid OSCN case URL" });
  }

  try {
    const result = await getOscnCaseDetail(url);
    res.json(result);
  } catch (err) {
    logger.error("OSCN case detail route error", { error: err.message });
    res.status(500).json({ error: "OSCN case fetch failed" });
  }
});

// DELETE /api/oscn/cache
oscnRouter.delete("/cache", async (_req, res) => {
  try {
    await writeFile(CACHE_FILE, "{}", "utf-8");
    res.json({ cleared: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
