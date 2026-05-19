/**
 * Network speed tiers for cross-exchange transfers.
 *
 * Tiers reflect typical end-to-end deposit-credit time on major CEXs
 * (block time × required confirmations + small processing buffer).
 *
 *   FAST   — usually credited in < 5 minutes (modern L1/L2s, fast finality)
 *   MEDIUM — typically 5–30 minutes (Ethereum L1, classic chains)
 *   SLOW   — > 30 minutes due to many required confirmations
 *            (BTC, LTC, DOGE, BCH, ZEC, …) — these get FILTERED OUT
 *
 * Unknown networks default to MEDIUM so we don't accidentally drop new chains
 * we haven't classified yet.
 *
 * Tier names use the canonical names produced by `normalizeNetwork()`.
 */

export type NetworkSpeedTier = "fast" | "medium" | "slow";

const FAST_NETWORKS = new Set<string>([
  // L2s & sidechains (all rollups settle to L1 fast on the deposit side)
  "ARBITRUM", "OPTIMISM", "BASE", "LINEA", "ZKSYNC", "SCROLL",
  "BLAST", "MANTLE", "MANTA", "STARKNET", "MOVE", "FOGO", "XAI",
  // High-throughput L1s
  "SOL", "TRC20", "TRX", "BEP20", "BSC", "MATIC", "POLYGON",
  "AVAX", "AVAXC", "TON", "NEAR", "APT", "SUI", "HBAR", "ICP",
  "STX", "INJ", "SEI", "CELESTIA", "FANTOM", "FTM", "CRO",
  "KLAY", "KLAYTN", "OKT", "OASIS", "RONIN", "CHZ", "KAVA",
  // Fast-finality payment chains
  "XRP", "XLM", "ALGO",
]);

const SLOW_NETWORKS = new Set<string>([
  "BTC", "BCH", "BSV", "LTC", "DOGE", "ZEC", "XMR", "DASH", "BTG",
  "LUNC", "RVN", "DGB",
]);

/**
 * Return the speed tier for a canonical network name.
 * Unknown networks are treated as MEDIUM (safe default — never accidentally slow).
 */
export function getNetworkSpeedTier(canonicalNetwork: string): NetworkSpeedTier {
  const upper = canonicalNetwork.toUpperCase();
  if (FAST_NETWORKS.has(upper)) return "fast";
  if (SLOW_NETWORKS.has(upper)) return "slow";
  return "medium";
}
