/**
 * WebSocket push server for funding arb real-time data.
 * Attaches to the existing HTTP server and pushes a snapshot to all
 * connected clients every 500 ms — no polling overhead on the frontend.
 *
 * Payload: { type, opportunities, status, ts }
 * Slow-changing data (priceMovements, markets) is fetched via REST instead
 * so the WS message stays small.
 *
 * Compression: perMessageDeflate enabled — repetitive JSON (same 24 keys ×
 * N opportunities) compresses 85-90% on the wire (~50 KB vs ~460 KB raw).
 *
 * Serialisation cache: opportunities are re-serialised only when
 * scanner.lastUpdatedAt changes, avoiding redundant JSON.stringify when
 * data is unchanged between 500 ms ticks.
 */

import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { logger } from "./logger.js";
import { scanner } from "./scanner/index.js";

const PUSH_INTERVAL_MS = 500;

let _cachedOppStr   = "[]";
let _cachedOppCount = 0;
let _cachedOppAt:   number | null = null;

function buildPayload(): string {
  const lastUpdatedAt = scanner.lastUpdatedAt;

  // Re-serialise opportunities only when the underlying data has changed.
  if (_cachedOppAt !== lastUpdatedAt) {
    const opps      = scanner.opportunitiesWithTarget(Infinity);
    _cachedOppStr   = JSON.stringify(opps);
    _cachedOppCount = opps.length;
    _cachedOppAt    = lastUpdatedAt;
  }

  const status = JSON.stringify({
    running:          scanner.running,
    exchanges:        scanner.getExchangeStatuses(),
    opportunityCount: _cachedOppCount,
    lastUpdatedAt,
  });

  return `{"type":"funding_arb","opportunities":${_cachedOppStr},"status":${status},"ts":${Date.now()}}`;
}

export function attachWsServer(server: HttpServer): void {
  const wss = new WebSocketServer({
    noServer: true,
    // permessage-deflate: repetitive JSON compresses 85-90%; level 1 = fastest
    perMessageDeflate: {
      zlibDeflateOptions: { level: 1 },
      zlibInflateOptions: { chunkSize: 10 * 1024 },
      threshold: 512,
    },
  });

  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/api/ws") {
      wss.handleUpgrade(req, socket as import("node:net").Socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (ws: WebSocket) => {
    ws.on("error", () => {});
    const snap = buildPayload();
    ws.send(snap, () => {});
  });

  const timer = setInterval(() => {
    if (wss.clients.size === 0) return;
    const payload = buildPayload();
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload, () => {});
      }
    }
  }, PUSH_INTERVAL_MS);

  server.on("close", () => {
    clearInterval(timer);
    wss.close();
  });

  logger.info("ws server attached at /api/ws");
}
