/**
 * Credential store — persists API keys / secrets to data/credentials.json
 * and injects them into process.env so all existing modules pick them up
 * transparently on the next read (wallet refresh, telegram loop, etc.).
 *
 * Priority: file > Replit env secret
 * (file values are written into process.env at load time, overwriting any
 *  pre-existing env value for that key)
 */

import fs   from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";

// ── Credential catalogue ────────────────────────────────────────────────────

export const CREDENTIAL_GROUPS = [
  {
    id:    "binance",
    label: "Binance",
    keys:  ["BINANCE_API_KEY", "BINANCE_API_SECRET"] as const,
  },
  {
    id:    "bybit",
    label: "Bybit",
    keys:  ["BYBIT_API_KEY", "BYBIT_API_SECRET"] as const,
  },
  {
    id:    "kucoin",
    label: "KuCoin",
    keys:  ["KUCOIN_API_KEY", "KUCOIN_API_SECRET", "KUCOIN_API_PASSPHRASE"] as const,
  },
  {
    id:    "bitget",
    label: "Bitget",
    keys:  ["BITGET_API_KEY", "BITGET_API_SECRET", "BITGET_API_PASSPHRASE"] as const,
  },
  {
    id:    "coinswitch",
    label: "CoinSwitch",
    keys:  ["COINSWITCH_API_KEY", "COINSWITCH_API_SECRET"] as const,
  },
  {
    id:    "telegram",
    label: "Telegram",
    keys:  ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] as const,
  },
] as const;

type Groups      = typeof CREDENTIAL_GROUPS;
type GroupKeys<G extends Groups[number]> = G["keys"][number];
export type CredentialKey = GroupKeys<Groups[number]>;

export const ALL_CREDENTIAL_KEYS: readonly CredentialKey[] = CREDENTIAL_GROUPS.flatMap(
  (g) => [...g.keys] as CredentialKey[],
);

// ── Storage ─────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.resolve(__dirname, "../../data");
const CREDS_FILE = path.join(DATA_DIR, "credentials.json");

let _stored: Partial<Record<CredentialKey, string>> = {};

// ── Helpers ─────────────────────────────────────────────────────────────────

function mask(val: string): string {
  if (val.length <= 8) return "••••••••";
  return `${val.slice(0, 4)}••••••••${val.slice(-4)}`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Load persisted credentials and inject into process.env. Call before starting services. */
export async function loadCredentials(): Promise<void> {
  try {
    const raw = await fs.readFile(CREDS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<Record<CredentialKey, string>>;
    _stored = parsed;
    let count = 0;
    for (const key of ALL_CREDENTIAL_KEYS) {
      const v = _stored[key];
      if (v) { process.env[key] = v; count++; }
    }
    logger.info({ count }, "credentials: loaded from file");
  } catch {
    _stored = {};
    logger.debug("credentials: no saved file, using env only");
  }
}

export interface CredentialStatus {
  configured: boolean;
  source:     "file" | "env" | "none";
  masked:     string;
}

/** Return masked status of every key — safe to send to the frontend. */
export function getCredentialStatus(): Record<CredentialKey, CredentialStatus> {
  const out = {} as Record<CredentialKey, CredentialStatus>;
  for (const key of ALL_CREDENTIAL_KEYS) {
    const fromFile = _stored[key];
    const fromEnv  = fromFile ? undefined : process.env[key];
    if (fromFile) {
      out[key] = { configured: true,  source: "file", masked: mask(fromFile) };
    } else if (fromEnv) {
      out[key] = { configured: true,  source: "env",  masked: mask(fromEnv)  };
    } else {
      out[key] = { configured: false, source: "none", masked: ""             };
    }
  }
  return out;
}

/** Return the catalogue groups for the frontend (no values). */
export function getCredentialGroups() {
  return CREDENTIAL_GROUPS.map((g) => ({ id: g.id, label: g.label, keys: [...g.keys] }));
}

/**
 * Persist a batch of credential updates.
 * Pass empty string `""` to clear a key (reverts to env fallback).
 */
export async function saveCredentials(
  updates: Partial<Record<CredentialKey, string>>,
): Promise<void> {
  const validSet = new Set<string>(ALL_CREDENTIAL_KEYS);
  for (const [k, v] of Object.entries(updates)) {
    if (!validSet.has(k)) continue;
    const key = k as CredentialKey;
    if (v === "") {
      delete _stored[key];
    } else {
      _stored[key] = v;
      process.env[key] = v; // immediate effect for running services
    }
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CREDS_FILE, JSON.stringify(_stored, null, 2), "utf-8");
  logger.info({ keys: Object.keys(updates) }, "credentials: saved");
}
