/**
 * routes/texas.js
 *
 * GET  /api/texas/city-check?city=Dallas
 *   → { isTexas: true, county: "Dallas" }
 *
 * POST /api/texas/search
 *   Body: { firstName, lastName, city, state }
 *   → { records: [...], county, fromCache }
 *
 * GET  /api/texas/cache
 *   → raw cache contents (for debugging / review)
 *
 * DELETE /api/texas/cache
 *   → clears the local records cache
 */

import { Router } from "express";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  isTexasSearch,
  maybeSearchTexasRecords,
  searchTexasRecords,
  texasCountyForCity,
} from "../services/crawler/texasScraper.js";
import { logger } from "../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.resolve(__dirname, "../data/texas/records-cache.json");

export const texasRouter = Router();

// GET /api/texas/city-check?city=San+Antonio
texasRouter.get("/city-check", async (req, res) => {
  const city = String(req.query.city || "").slice(0, 100);
  if (!city) return res.status(400).json({ error: "city query param required" });

  const county = await texasCountyForCity(city);
  res.json({ city, isTexas: county !== null, county });
});

// POST /api/texas/search
texasRouter.post("/search", async (req, res) => {
  const firstName = String(req.body.firstName || "").slice(0, 100).trim();
  const lastName = String(req.body.lastName || "").slice(0, 100).trim();
  const city = String(req.body.city || "").slice(0, 100).trim();
  const state = String(req.body.state || "").slice(0, 50).trim();

  if (!firstName || !lastName) {
    return res.status(400).json({ error: "firstName and lastName are required" });
  }

  try {
    const result = await searchTexasRecords({ firstName, lastName, city, state });
    res.json(result);
  } catch (err) {
    logger.error("Texas search route error", { error: err.message });
    res.status(500).json({ error: "Search failed" });
  }
});

// GET /api/texas/cache
texasRouter.get("/cache", async (_req, res) => {
  try {
    const raw = await readFile(CACHE_FILE, "utf-8");
    res.json(JSON.parse(raw));
  } catch {
    res.json({});
  }
});

// DELETE /api/texas/cache
texasRouter.delete("/cache", async (_req, res) => {
  try {
    await writeFile(CACHE_FILE, "{}", "utf-8");
    res.json({ cleared: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
