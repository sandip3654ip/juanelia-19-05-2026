/**
 * Symbol normalization utilities.
 * Converts exchange-specific symbol formats to a canonical BASE symbol.
 *
 * Pi42:        "BTCINR"    → "BTC"  (strip INR/USDT/USDC suffix)
 * Aster:       "BTCUSDT"   → "BTC"  (strip USDT/BUSD/USDC suffix)
 * Delta:       "BTCUSDT"   → "BTC"  (strip USDT/USDC/USD suffix)
 * CoinSwitch:  "BTCUSDT"   → "BTC"  (strip USDT suffix)
 * Bitunix:     "BTCUSDT"   → "BTC"  (strip USDT suffix)
 */

const ASCII_RE = /^[\x20-\x7E]+$/;

export function normalizeSymbol(
  raw: string,
  exchange: "pi42" | "aster" | "delta" | "coinswitch" | "bitunix",
): string | null {
  if (!raw || typeof raw !== "string") return null;

  let canonical = raw.trim();

  switch (exchange) {
    case "pi42":
      // Pi42 format: BTCINR, ETHINR, BTCUSDT, etc.
      if (canonical.endsWith("INR")) {
        canonical = canonical.slice(0, -3);
      } else if (canonical.endsWith("USDT")) {
        canonical = canonical.slice(0, -4);
      } else if (canonical.endsWith("USDC")) {
        canonical = canonical.slice(0, -4);
      } else {
        return null;
      }
      break;

    case "aster":
      // Strip USDT, USDC, BUSD suffixes
      if (canonical.endsWith("USDT")) {
        canonical = canonical.slice(0, -4);
      } else if (canonical.endsWith("USDC")) {
        canonical = canonical.slice(0, -4);
      } else if (canonical.endsWith("BUSD")) {
        canonical = canonical.slice(0, -4);
      } else {
        // Non-standard symbol like SOLUSD1 — skip
        return null;
      }
      break;

    case "delta":
      // Delta format: SOLUSDT, BTCUSDT, XRPUSDT, etc. — strip USDT/USDC/USD suffix
      if (canonical.endsWith("USDT")) {
        canonical = canonical.slice(0, -4);
      } else if (canonical.endsWith("USDC")) {
        canonical = canonical.slice(0, -4);
      } else if (canonical.endsWith("USD")) {
        canonical = canonical.slice(0, -3);
      } else {
        return null;
      }
      break;

    case "coinswitch":
      // CoinSwitch futures: BTCUSDT, ETHUSDT, 1000PEPEUSDT, etc.
      if (canonical.endsWith("USDT")) {
        canonical = canonical.slice(0, -4);
      } else if (canonical.endsWith("USDC")) {
        canonical = canonical.slice(0, -4);
      } else {
        return null;
      }
      break;

  }

  if (!canonical) return null;

  // Skip non-ASCII symbols (e.g. Chinese characters on Aster)
  if (!ASCII_RE.test(canonical)) return null;

  return canonical.toUpperCase();
}
