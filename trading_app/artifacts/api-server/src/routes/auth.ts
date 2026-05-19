import { Router, type IRouter, type Request, type Response } from "express";
import crypto from "node:crypto";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// ── Config ────────────────────────────────────────────────────────────────────
const OTP_EXPIRY_MS  = 5 * 60 * 1000;   // 5 minutes
const MAX_ATTEMPTS   = 3;
const RATE_LIMIT_MS  = 30 * 1_000;      // 30s cooldown between sends
const TOKEN_EXPIRY_H = 24;              // session valid 24 hours

// ── In-memory OTP store (single user — no DB needed) ─────────────────────────
interface OtpEntry { otp: string; expiresAt: number; attempts: number; }
let _otpStore: OtpEntry | null = null;
let _lastSentAt = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────
function registeredPhone(): string { return (process.env["REGISTERED_PHONE"] ?? "").trim(); }
function apiKey():          string { return (process.env["FAST2SMS_API_KEY"]  ?? "").trim(); }
function sessionSecret():   string { return (process.env["SESSION_SECRET"]    ?? "mm-fallback-secret").trim(); }

function generateOtp(): string {
  return String(Math.floor(100_000 + Math.random() * 900_000));
}

function makeToken(phone: string): string {
  const payload = Buffer.from(JSON.stringify({
    phone,
    exp: Date.now() + TOKEN_EXPIRY_H * 3_600_000,
  })).toString("base64url");
  const sig = crypto.createHmac("sha256", sessionSecret()).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function checkToken(token: string): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const sig     = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", sessionSecret()).update(payload).digest("hex");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  } catch { return false; } // length mismatch → invalid token
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof data.exp === "number" && data.exp > Date.now();
  } catch { return false; }
}

async function sendSms(phone: string, otp: string): Promise<void> {
  const key = apiKey();
  if (!key) throw new Error("FAST2SMS_API_KEY not configured on server");

  const url = new URL("https://www.fast2sms.com/dev/bulkV2");
  url.searchParams.set("authorization",    key);
  url.searchParams.set("route",            "dlt");
  url.searchParams.set("sender_id",        "QQICKS");
  url.searchParams.set("message",          "180132");
  url.searchParams.set("variables_values", otp);
  url.searchParams.set("numbers",          phone);
  url.searchParams.set("flash",            "0");

  const res  = await fetch(url.toString(), { signal: AbortSignal.timeout(12_000) });
  const data = await res.json() as { return: boolean; message: string[] };
  if (!data.return) throw new Error(`Fast2SMS: ${(data.message ?? []).join(", ")}`);
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/auth/send-otp  body: { phone: "9XXXXXXXXX" }
router.post("/auth/send-otp", async (req: Request, res: Response): Promise<void> => {
  const { phone } = req.body as { phone?: string };
  const registered = registeredPhone();

  if (!registered) {
    res.status(500).json({ error: "REGISTERED_PHONE not configured on server" });
    return;
  }

  // Constant-time comparison — don't reveal whether number exists
  const inputPhone = (phone ?? "").trim();
  const match = inputPhone.length === registered.length &&
    crypto.timingSafeEqual(Buffer.from(inputPhone), Buffer.from(registered));
  if (!match) {
    res.status(400).json({ error: "This number is not authorized" });
    return;
  }

  // Rate limit
  const elapsed = Date.now() - _lastSentAt;
  if (_lastSentAt > 0 && elapsed < RATE_LIMIT_MS) {
    const wait = Math.ceil((RATE_LIMIT_MS - elapsed) / 1_000);
    res.status(429).json({ error: `Wait ${wait}s before requesting another OTP` });
    return;
  }

  const otp = generateOtp();
  _otpStore  = { otp, expiresAt: Date.now() + OTP_EXPIRY_MS, attempts: 0 };
  _lastSentAt = Date.now();

  try {
    await sendSms(registered, otp);
    logger.info({ tail: registered.slice(-4) }, "auth: OTP sent");
    res.json({ ok: true, message: "OTP sent to your registered number" });
  } catch (err) {
    _otpStore   = null;
    _lastSentAt = 0;
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "auth: OTP send failed");
    res.status(500).json({ error: `SMS failed: ${msg}` });
  }
});

// POST /api/auth/verify-otp  body: { otp: "123456" }
router.post("/auth/verify-otp", (req: Request, res: Response): void => {
  const { otp } = req.body as { otp?: string };

  if (!otp?.trim()) {
    res.status(400).json({ error: "OTP is required" });
    return;
  }
  if (!_otpStore) {
    res.status(400).json({ error: "No OTP found — please request a new one" });
    return;
  }
  if (Date.now() > _otpStore.expiresAt) {
    _otpStore = null;
    res.status(400).json({ error: "OTP expired — please request a new one" });
    return;
  }

  _otpStore.attempts++;
  if (_otpStore.attempts > MAX_ATTEMPTS) {
    _otpStore = null;
    res.status(400).json({ error: "Too many attempts — request a new OTP" });
    return;
  }

  if (otp.trim() !== _otpStore.otp) {
    const left = MAX_ATTEMPTS - _otpStore.attempts;
    res.status(400).json({
      error: `Wrong OTP — ${left} attempt${left !== 1 ? "s" : ""} remaining`,
    });
    return;
  }

  // ✅ Correct
  _otpStore = null;
  const token = makeToken(registeredPhone());
  logger.info("auth: login successful");
  res.json({ ok: true, token });
});

// GET /api/auth/verify-token  (called by frontend on page load)
router.get("/auth/verify-token", (req: Request, res: Response): void => {
  const auth  = (req.headers["authorization"] ?? "") as string;
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  res.json({ valid: checkToken(token) });
});

export default router;
