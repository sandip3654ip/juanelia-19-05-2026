/**
 * Cross-exchange network matching for spot arbitrage fee calculation.
 *
 * Strategy:
 *  1. Get all WITHDRAWAL-enabled networks for a coin on the BUY exchange.
 *  2. Get all DEPOSIT-enabled  networks for a coin on the SELL exchange.
 *  3. Normalise both sets to canonical network names.
 *  4. Intersect → pairs where a transfer is actually possible.
 *  5. For each pair: totalFee = withdrawFee + depositFee.
 *  6. Return the cheapest pair (lowest totalFee in coin units).
 *
 * Deposit fees are 0 on all four supported exchanges; the field is included
 * for correctness and future-proofing.
 *
 * Supported exchanges: binance | kucoin | bitget | bybit
 */

import { normalizeNetwork }          from "./withdrawal-fees.js";
import { getNetworkSpeedTier, type NetworkSpeedTier } from "./network-speed.js";
import { getAddressConfirmedCount }  from "./deposit-address-service.js";
import {
  getBinanceWithdrawNetworks,
  getBinanceDepositNetworks,
}                                     from "./binance-data.js";
import {
  getKucoinWithdrawNetworks,
  getKucoinDepositNetworks,
}                                     from "./kucoin-data.js";
import {
  getBitgetWithdrawNetworks,
  getBitgetDepositNetworks,
}                                     from "./bitget-data.js";
import {
  getBybitWithdrawNetworks,
  getBybitDepositNetworks,
}                                     from "./bybit-data.js";

/**
 * Canonical network names that ALWAYS require a memo/destination-tag/comment
 * for deposits on any exchange. These are protocol-level requirements
 * (not exchange-specific), so we can hardcode them safely.
 *
 * Used as a fallback for Bybit whose deposit API does not expose a memo flag.
 * For Binance / KuCoin / Bitget we use their live `requiresMemo` field instead.
 */
const MEMO_REQUIRED_CANONICAL_NETWORKS = new Set([
  "XRP",     // Ripple — destination tag mandatory
  "XLM",     // Stellar — memo mandatory
  "COSMOS",  // Cosmos Hub (ATOM) — memo mandatory (IBC); most exchanges name it "COSMOS"
  "ATOM",    // Some exchanges (Bitget) normalise Cosmos Hub network to "ATOM" — same protocol
  "EOS",     // EOSIO — memo mandatory
  "NEM",     // NEM / XEM — message mandatory
  "HIVE",    // Hive blockchain — memo mandatory
  "STEEM",   // Steem blockchain — memo mandatory
  "BEP2",    // Binance Chain (legacy) — memo mandatory
  "TON",     // TON / Telegram — comment mandatory for exchange deposits
]);

// ── Native coin-network pairs ─────────────────────────────────────────────────
// When COIN is the base/gas asset of NETWORK, no contract address exists —
// the coin IS the network currency. Transfer via matching network is always safe.
const NATIVE_COIN_NETWORK: ReadonlySet<string> = new Set([
  // Major L1s
  "BTC:BTC", "ETH:ERC20", "BNB:BEP20", "SOL:SOL", "XRP:XRP", "ADA:ADA",
  "DOGE:DOGE", "AVAX:AVAX", "MATIC:MATIC", "POL:MATIC", "DOT:DOT",
  "ATOM:COSMOS", "ATOM:ATOM",   // Binance uses "ATOM" as network id for Cosmos Hub
  "NEAR:NEAR", "APT:APT", "SUI:SUI", "TRX:TRC20", "TON:TON",
  "LUNA:LUNA", "LUNC:LUNA",    // Terra Classic native on Luna chain
  "XTZ:XTZ", "MINA:MINA", "KSM:KSM", "ALGO:ALGO", "ICP:ICP",
  "STX:STX", "FIL:FIL", "FLOW:FLOW", "EGLD:EGLD", "ROSE:ROSE",
  "AXL:AXL", "DYDX:DYDX", "HBAR:HBAR", "VET:VET", "VTHO:VET",
  "ICX:ICX", "ZIL:ZIL", "QTUM:QTUM", "WAVES:WAVES", "THETA:THETA", "TFUEL:THETA",
  "RUNE:THORCHAIN", "RUNE:RUNE",  // some exchanges use "RUNE" directly
  "XLM:XLM", "ETC:ETC", "FTM:FTM",
  "S:S", "S:SONIC",              // S token on Sonic network (different naming)
  "CHZ:CHZ", "ASTR:ASTR", "RONIN:RONIN", "MOVR:MOONRIVER", "MOVR:MOVR",  // MOVR = Moonriver (both naming conventions)
  "HYPE:HYPE", "HYPE:HYPEREVM",  // HYPE native on HyperEVM
  "SYS:SYS", "IOTX:IOTX", "FRAX:FRAXTAL", "WLD:WLD",
  "STRAX:STRAX", "ENJ:ENJ", "ONE:ONE", "FOGO:FOGO",
  // Cosmos ecosystem (native on own chain)
  "OSMO:OSMO", "TIA:CELESTIA", "TIA:TIA", "BAND:BAND",
  "MANTRA:MANTRA", "INJ:INJ", "SEI:SEI", "AXL:AXELAR",
  // EVM L1/L2 native tokens
  "CELO:CELO", "GLMR:GLMR", "KAVA:KAVA", "KAIA:KAIA",
  "CORE:CORE", "CFX:CFX", "BERA:BERA", "XION:XION",
  "VANA:VANA", "PLUME:PLUME", "INIT:INIT", "MON:MONAD",
  // Other L1s
  "AR:AR",           // Arweave native
  "SC:SC",           // Siacoin native
  "CKB:CKB",         // Nervos Network
  "XDC:XDC",         // XinFin
  "DCR:DCR",         // Decred
  "XEC:XEC",         // eCash
  "HIVE:HIVE",       // Hive blockchain
  "WEMIX:WEMIX",     // WEMIX chain
  "MAPO:MAPO",       // MAP Protocol
  "IP:STORY",        // IP on Story blockchain
  "BB:BOUNCEBIT",    // BB on BounceBit
  "VIC:VIC",         // Viction (formerly TomoChain)
  "XPL:PLASMA",      // XPL on Plasma network
  "KAS:KAS",         // Kaspa native
  "GUN:GUNZ",        // GUN on GUNZ network
  "MOVE:MOVE", "MOVE:MOVEMENT",  // Movement network (both canonical names in use)
  // ETH is native gas on all L2s (no contract address on any of them)
  "ETH:ARBITRUM", "ETH:OPTIMISM", "ETH:BASE", "ETH:STARKNET", "ETH:ZKSYNC",
  // Additional L1 natives surfaced at runtime
  "IOST:IOST",       // IOST blockchain native
  "G:GRAVITY",       // G on Gravity chain
  "MNT:MANTLE",      // MNT on Mantle chain
  "CC:CANTON",       // CC on Canton network
  "SOMI:SOMNIA",     // SOMI on Somnia network
  "0G:0G",           // 0G network native
  "SAGA:SAGA",       // Saga blockchain native
  "ALLO:ALLORA",     // ALLO on Allora network
  "POLYX:POLYX",     // POLYX on Polymesh network
  "TAO:TAO",         // TAO on Bittensor network
  "METIS:METIS",     // METIS on Metis Andromeda network
  "XAI:XAI",         // XAI gaming chain (Arbitrum stack) native
  "DOT:POLKADOT_AH", // DOT native on Polkadot Asset Hub parachain
  "AVAIL:AVAIL",     // AVAIL native on Avail DA chain
  "XEM:NEM",         // XEM native on NEM blockchain
  "DYM:DYM",         // DYM native on Dymension rollchain
  "XNO:NANO",        // XNO native on Nano blockchain (formerly NANO)
]);

function isNativeCoin(coin: string, network: string): boolean {
  return NATIVE_COIN_NETWORK.has(`${coin.toUpperCase()}:${network.toUpperCase()}`);
}

// ── Public result type ────────────────────────────────────────────────────────

export interface TransferRoute {
  /** Canonical network name, e.g. "ARBITRUM", "BEP20", "SOL" */
  canonicalNetwork: string;
  /** Withdrawal fee in base-coin units from the buy exchange */
  withdrawFee:      number;
  /** Deposit fee in base-coin units at the sell exchange (almost always 0) */
  depositFee:       number;
  /** withdrawFee + depositFee */
  totalFee:         number;
  /** Minimum withdrawal amount allowed by the buy exchange */
  minWithdraw:      number;
  /** "api" = fee came from live exchange API; "static" = manually maintained table */
  feeSource:        "api" | "static";
  /**
   * true  = contract address verified on both exchanges AND deposit address has been
   *         confirmed stable for ≥10 consecutive daily refreshes.
   * false = contract unverified OR address not yet confirmed 10 times.
   */
  addressVerified:  boolean;
  /**
   * Number of consecutive daily refreshes that returned the same deposit address
   * for this coin on the sell exchange. Bot eligibility requires ≥10.
   */
  confirmedCount:   number;
  /** Total number of compatible (network + address) routes considered before picking this cheapest one. ≥1. */
  routesConsidered: number;
  /** Speed tier of the chosen network: "fast" (<5min) | "medium" (5–30min). Slow networks are never chosen. */
  speedTier:        NetworkSpeedTier;
}

// ── Per-exchange withdrawal helper ────────────────────────────────────────────

interface WithdrawOption {
  canonicalNetwork: string;
  fee:              number;
  minWithdraw:      number;
  source:           "api" | "static";
  /** Lowercased contract address; null = native/unknown */
  contractAddress:  string | null;
}

function normaliseAddress(addr: string | null | undefined): string | null {
  if (!addr) return null;
  const trimmed = addr.trim();
  return trimmed === "" ? null : trimmed.toLowerCase();
}

function getWithdrawOptions(exchange: string, coin: string): WithdrawOption[] {
  switch (exchange) {
    case "binance": {
      return getBinanceWithdrawNetworks(coin).map(n => ({
        canonicalNetwork: normalizeNetwork(n.network),
        fee:              n.withdrawFee,
        minWithdraw:      n.minWithdraw,
        source:           "api" as const,
        contractAddress:  normaliseAddress(n.contractAddress),
      }));
    }

    case "kucoin": {
      return getKucoinWithdrawNetworks(coin).map(n => ({
        canonicalNetwork: normalizeNetwork(n.chainName),
        fee:              n.withdrawFee,
        minWithdraw:      n.minWithdraw,
        source:           "api" as const,
        contractAddress:  normaliseAddress(n.contractAddress),
      }));
    }

    case "bitget": {
      return getBitgetWithdrawNetworks(coin).map(n => ({
        canonicalNetwork: normalizeNetwork(n.chain),
        fee:              n.withdrawFee,
        minWithdraw:      n.minWithdraw,
        source:           "api" as const,
        contractAddress:  normaliseAddress(n.contractAddress),
      }));
    }

    case "bybit": {
      return getBybitWithdrawNetworks(coin).map(wd => ({
        canonicalNetwork: normalizeNetwork(wd.network),
        fee:              wd.withdrawFee,
        minWithdraw:      wd.minWithdraw,
        source:           wd.source,
        contractAddress:  wd.contractAddress,
      }));
    }

    default:
      return [];
  }
}

// ── Per-exchange deposit helper ───────────────────────────────────────────────

interface DepositOption {
  canonicalNetwork: string;
  fee:              number;  // always 0 on all four exchanges
  contractAddress:  string | null;
  /**
   * true  = this deposit network requires a memo / destination-tag / comment.
   * Such routes are excluded from arbitrage — sending without a memo risks losing funds.
   */
  requiresMemo:     boolean;
}

function getDepositOptions(exchange: string, coin: string): DepositOption[] {
  switch (exchange) {
    case "binance": {
      return getBinanceDepositNetworks(coin).map(n => {
        const canonical = normalizeNetwork(n.network);
        return {
          canonicalNetwork: canonical,
          fee:              n.depositFee,
          contractAddress:  normaliseAddress(n.contractAddress),
          // Exchange flag OR protocol-level set — whichever says memo required wins
          requiresMemo:     n.requiresMemo || MEMO_REQUIRED_CANONICAL_NETWORKS.has(canonical),
        };
      });
    }

    case "kucoin": {
      return getKucoinDepositNetworks(coin).map(n => {
        const canonical = normalizeNetwork(n.chainName);
        return {
          canonicalNetwork: canonical,
          fee:              n.depositFee,
          contractAddress:  normaliseAddress(n.contractAddress),
          requiresMemo:     n.requiresMemo || MEMO_REQUIRED_CANONICAL_NETWORKS.has(canonical),
        };
      });
    }

    case "bitget": {
      // Bitget's API sometimes reports requiresMemo=false for memo-required networks
      // (e.g. ATOM native chain). Always cross-check against the protocol-level set.
      return getBitgetDepositNetworks(coin).map(n => {
        const canonical = normalizeNetwork(n.chain);
        return {
          canonicalNetwork: canonical,
          fee:              n.depositFee,
          contractAddress:  normaliseAddress(n.contractAddress),
          requiresMemo:     n.requiresMemo || MEMO_REQUIRED_CANONICAL_NETWORKS.has(canonical),
        };
      });
    }

    case "bybit": {
      // Bybit's public deposit API does not expose a memo flag at all.
      // Rely entirely on the hardcoded protocol-level set.
      return getBybitDepositNetworks(coin).map(n => {
        const canonical = normalizeNetwork(n.chain);
        return {
          canonicalNetwork: canonical,
          fee:              n.depositFee,
          contractAddress:  normaliseAddress(n.contractAddress),
          requiresMemo:     MEMO_REQUIRED_CANONICAL_NETWORKS.has(canonical),
        };
      });
    }

    default:
      return [];
  }
}

// ── Main matching function ─────────────────────────────────────────────────────

/**
 * Find the cheapest network to transfer `coin` from `buyExchange` to `sellExchange`.
 *
 * Returns null when:
 *  - No withdrawal data available for the buy exchange
 *  - No deposit data available for the sell exchange
 *  - No network is supported by both exchanges for this coin
 */
export function findCheapestTransferRoute(
  buyExchange:  string,
  coin:         string,
  sellExchange: string,
): TransferRoute | null {
  const withdrawOptions = getWithdrawOptions(buyExchange,  coin);
  const depositOptions  = getDepositOptions (sellExchange, coin);

  if (withdrawOptions.length === 0 || depositOptions.length === 0) return null;

  // Build a lookup: canonical network → list of deposit options on that network
  const depositByNetwork = new Map<string, DepositOption[]>();
  for (const d of depositOptions) {
    const list = depositByNetwork.get(d.canonicalNetwork);
    if (list) list.push(d); else depositByNetwork.set(d.canonicalNetwork, [d]);
  }

  // Speed-tier ranking: fast=2, medium=1, slow=0 (slow is filtered out below)
  const tierRank = (t: NetworkSpeedTier): number =>
    t === "fast" ? 2 : t === "medium" ? 1 : 0;

  let best: TransferRoute | null = null;
  let bestTierRank = -1;
  let routesConsidered = 0;
  let bestAddressVerifiedByContract = false;
  // Track whether the currently-best route has a fully stable deposit address (≥10 same).
  // Used so a stable-address route is preferred over a cheaper but unstable one.
  let bestFullyVerified = false;

  for (const wd of withdrawOptions) {
    const dList = depositByNetwork.get(wd.canonicalNetwork);
    if (!dList) continue; // network not available on sell side

    // MEMO FILTER: skip networks where any deposit option requires a memo/tag.
    // Sending to a memo-required address without the correct memo loses funds.
    if (dList.every(d => d.requiresMemo)) continue;

    // SPEED FILTER: skip networks where the deposit will be slow
    // (BTC, LTC, DOGE, BCH, etc — many-confirmation chains).
    const speedTier = getNetworkSpeedTier(wd.canonicalNetwork);
    if (speedTier === "slow") continue;

    // Contract-address verification:
    //  • Native coins (coin IS the network's base asset): skip contract check entirely —
    //    there is only one BTC, one SEI, one ATOM, etc. Network match is sufficient.
    //  • Tokens: BOTH sides must expose matching contract addresses to confirm it's the
    //    same token. If either side has no address, accept on network-name match only
    //    (flagged unverified) so we never silently route through a wrong contract.
    let compatible: DepositOption | undefined;
    let addressVerified = false;

    if (isNativeCoin(coin, wd.canonicalNetwork)) {
      // Native asset — no contract can exist; first deposit option on this network is fine.
      compatible = dList[0];
      addressVerified = true;
    } else {
      // Token — prefer a strictly address-verified match; fall back to network-only.
      for (const d of dList) {
        if (wd.contractAddress !== null && d.contractAddress !== null) {
          if (wd.contractAddress === d.contractAddress) {
            compatible = d;
            addressVerified = true;
            break;
          }
        } else if (compatible === undefined) {
          compatible = d;
          addressVerified = false;
        }
      }
    }
    if (!compatible) continue; // same network but DIFFERENT token contract — would lose funds

    const totalFee: number = wd.fee + compatible.fee;
    const thisTierRank    = tierRank(speedTier);

    // Address-stability check for this specific network:
    // How many consecutive daily refreshes has the sell-side deposit address stayed identical?
    // A count ≥ 10 means the address is stable and safe for automated withdrawals.
    // Example: BEP20 returned same address 12 times → thisConfirmedCount=12, thisFullyVerified=true
    //          ERC20 keeps changing after 2-3 times  → thisConfirmedCount=1-3, thisFullyVerified=false
    const thisConfirmedCount = getAddressConfirmedCount(sellExchange, coin, wd.canonicalNetwork);
    const thisFullyVerified  = addressVerified && thisConfirmedCount >= 10;

    routesConsidered += 1;

    // Selection priority (in order):
    //   1. Higher speed tier wins (fast > medium)
    //   2. Within the same tier: a route whose deposit address is stable (≥10 same) wins
    //      over one whose address keeps changing — even if the stable route costs more.
    //      Rationale: an unstable address risks sending funds to the wrong destination.
    //   3. Within the same tier AND same stability: lower total fee wins.
    const isBetter =
      best === null ||
      thisTierRank > bestTierRank ||
      (thisTierRank === bestTierRank && thisFullyVerified && !bestFullyVerified) ||
      (thisTierRank === bestTierRank && thisFullyVerified === bestFullyVerified && totalFee < best.totalFee);

    if (isBetter) {
      best = {
        canonicalNetwork: wd.canonicalNetwork,
        withdrawFee:      wd.fee,
        depositFee:       compatible.fee,
        totalFee,
        minWithdraw:      wd.minWithdraw,
        feeSource:        wd.source,
        addressVerified:  thisFullyVerified, // contract match AND ≥10 stable confirmations
        confirmedCount:   thisConfirmedCount,
        routesConsidered: 0, // patched below once total is known
        speedTier,
      };
      bestAddressVerifiedByContract = addressVerified;
      bestTierRank     = thisTierRank;
      bestFullyVerified = thisFullyVerified;
    }
  }

  if (best !== null) {
    best.routesConsidered = routesConsidered;
    // confirmedCount and addressVerified are already set inline inside the loop above.
    // Final guard: re-confirm addressVerified uses both contract match and stability count.
    best.addressVerified = bestAddressVerifiedByContract && best.confirmedCount >= 10;
  }
  return best;
}

/**
 * Given (exchange, coin, canonicalNetwork), return the exchange-native chain ID
 * that should be passed to the withdrawal API.
 *
 * - Binance: `network` field (e.g. "BNB", "ETH", "SOL")
 * - Bybit:   `network` field (e.g. "BEP20", "ARBITRUM", "SOL")
 * - KuCoin:  `chainId` slug (e.g. "eth", "bsc", "sol")
 * - Bitget:  `chain`  field (e.g. "BNB_BEP20", "SOL", "ETH")
 *
 * Returns null if no matching network found for that coin.
 */
export function getNativeWithdrawChainId(
  exchange:         string,
  coin:             string,
  canonicalNetwork: string,
): string | null {
  switch (exchange) {
    case "binance": {
      const nets = getBinanceWithdrawNetworks(coin);
      return nets.find(n => normalizeNetwork(n.network) === canonicalNetwork)?.network ?? null;
    }
    case "bybit": {
      const nets = getBybitWithdrawNetworks(coin);
      return nets.find(n => normalizeNetwork(n.network) === canonicalNetwork)?.network ?? null;
    }
    case "kucoin": {
      const nets = getKucoinWithdrawNetworks(coin);
      const match = nets.find(n => normalizeNetwork(n.chainName) === canonicalNetwork);
      return match?.chainId ?? null;
    }
    case "bitget": {
      const nets = getBitgetWithdrawNetworks(coin);
      return nets.find(n => normalizeNetwork(n.chain) === canonicalNetwork)?.chain ?? null;
    }
    default:
      return null;
  }
}
