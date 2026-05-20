/**
 * Lightweight in-process HTTP response cache for GET endpoints.
 *
 * Purpose: reduce redundant computation when multiple browser tabs
 * (or rapid polling) hit the same endpoint within a short window.
 *
 * • Cache key = full URL including query string
 * • TTL is per-route, set at middleware registration time
 * • Only caches 200-range JSON responses
 * • Adds X-Cache: HIT/MISS header for observability
 * • Zero logic change to routes — purely at the HTTP layer
 */

import type { Request, Response, NextFunction } from "express";
import { logger } from "./logger.js";

interface CacheEntry {
  body:      string;   // pre-serialised JSON string
  ts:        number;   // epoch ms when cached
  ttlMs:     number;
}

const store = new Map<string, CacheEntry>();

let pruneTimer: ReturnType<typeof setInterval> | null = null;

/** Call once at server startup to start the prune loop (every 30 s). */
export function startRouteCachePruner(): void {
  if (pruneTimer) return;
  pruneTimer = setInterval(() => {
    const now  = Date.now();
    let pruned = 0;
    for (const [key, entry] of store) {
      if (now - entry.ts >= entry.ttlMs) { store.delete(key); pruned++; }
    }
    if (pruned > 0) logger.debug({ pruned, remaining: store.size }, "route-cache: pruned stale entries");
  }, 30_000);
}

/**
 * Returns an Express middleware that caches GET responses for `ttlMs` ms.
 * Non-GET requests and non-2xx responses are never cached.
 */
export function routeCache(ttlMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== "GET") { next(); return; }

    const key    = req.originalUrl ?? req.url;
    const entry  = store.get(key);
    const now    = Date.now();

    if (entry && now - entry.ts < entry.ttlMs) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("X-Cache", "HIT");
      res.setHeader("Cache-Control", "no-store");
      res.end(entry.body);
      return;
    }

    // Intercept res.json to save the serialised response
    const origJson = res.json.bind(res) as (body: unknown) => Response;
    res.json = function (body: unknown): Response {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const serialised = JSON.stringify(body);
        store.set(key, { body: serialised, ts: now, ttlMs });
        res.setHeader("X-Cache", "MISS");
      }
      return origJson(body);
    };

    next();
  };
}
