import { Router, type IRouter } from "express";
import {
  getCredentialStatus,
  getCredentialGroups,
  saveCredentials,
  ALL_CREDENTIAL_KEYS,
  type CredentialKey,
} from "../lib/credentials.js";

const router: IRouter = Router();

// GET /api/settings/credentials
// Returns masked status + group catalogue — never returns real values
router.get("/settings/credentials", (_req, res): void => {
  res.set("Cache-Control", "no-store");
  res.json({
    groups:      getCredentialGroups(),
    credentials: getCredentialStatus(),
  });
});

// POST /api/settings/credentials
// Body: { BINANCE_API_KEY: "...", BINANCE_API_SECRET: "...", ... }
// Send empty string "" to clear a key
router.post("/settings/credentials", async (req, res): Promise<void> => {
  const body   = req.body as Record<string, unknown>;
  const validKeys = new Set<string>(ALL_CREDENTIAL_KEYS);
  const updates: Partial<Record<CredentialKey, string>> = {};

  for (const [k, v] of Object.entries(body)) {
    if (!validKeys.has(k))          continue;
    if (typeof v !== "string")      continue;
    updates[k as CredentialKey] = v.trim();
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No valid credential keys provided" });
    return;
  }

  await saveCredentials(updates);
  req.log.info({ keys: Object.keys(updates) }, "settings: credentials updated");
  res.json({ ok: true, updated: Object.keys(updates) });
});

export default router;
