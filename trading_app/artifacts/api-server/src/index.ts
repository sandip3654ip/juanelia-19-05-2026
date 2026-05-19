import { loadCredentials } from "./lib/credentials.js";
import { logger } from "./lib/logger";

// ── Process-level safety nets ──────────────────────────────────────────────
process.on("uncaughtException", (err) => {
  logger.error({ err }, "uncaughtException — continuing");
});

process.on("unhandledRejection", (reason) => {
  logger.error({ reason: String(reason) }, "unhandledRejection — continuing");
});

// ── Async startup — load persisted credentials before initialising services ─
(async () => {
  // Load saved credentials first so wallet/telegram services pick them up
  await loadCredentials();

  // Dynamic import ensures app.ts (and all services) run AFTER credentials
  // are injected into process.env
  const { default: app } = await import("./app.js");

  const rawPort = process.env["PORT"];
  if (!rawPort) throw new Error("PORT environment variable is required but was not provided.");
  const port = Number(rawPort);
  if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT value: "${rawPort}"`);

  const server = app.listen(port, (err?: Error) => {
    if (err) { logger.error({ err }, "Error listening on port"); process.exit(1); }
    logger.info({ port }, "Server listening");
  });

  const { attachWsServer } = await import("./lib/ws-server.js");
  attachWsServer(server);
})();
