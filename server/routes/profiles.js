/**
 * /api/profiles routes
 *
 *  GET    /api/profiles          – list all saved profiles
 *  GET    /api/profiles/:id      – get one profile by ID
 *  DELETE /api/profiles/:id      – delete a profile
 */

import { Router } from "express";
import {
  getAllProfiles,
  getProfileById,
  deleteProfile,
} from "../services/dataLayer/db.js";
import { logger } from "../utils/logger.js";

export const profilesRouter = Router();

// Validate that :id looks like a UUID (basic check to avoid log injection)
function isValidId(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    id,
  );
}

profilesRouter.get("/", (_req, res) => {
  const profiles = getAllProfiles();
  res.json({ profiles, total: profiles.length });
});

profilesRouter.get("/:id", (req, res) => {
  const { id } = req.params;
  if (!isValidId(id))
    return res.status(400).json({ error: "Invalid profile ID format" });

  const profile = getProfileById(id);
  if (!profile) return res.status(404).json({ error: "Profile not found" });

  res.json({ profile });
});

profilesRouter.delete("/:id", (req, res) => {
  const { id } = req.params;
  if (!isValidId(id))
    return res.status(400).json({ error: "Invalid profile ID format" });

  const deleted = deleteProfile(id);
  if (!deleted) return res.status(404).json({ error: "Profile not found" });

  logger.info("Profile deleted", { id });
  res.json({ message: "Profile deleted", id });
});
