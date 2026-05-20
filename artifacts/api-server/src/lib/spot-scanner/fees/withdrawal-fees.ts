/**
 * Withdrawal fee service — cross-exchange route-aware.
 *
 * For each opportunity (buyExchange → sellExchange):
 *   1. Get all withdrawal networks on buyExchange for the coin
 *   2. Get all deposit  networks on sellExchange for the coin
 *   3. Intersect → pick cheapest common network
 *   If sell exchange has no deposit network data (static exchanges),
 *   fall back to cheapest withdrawal on buyExchange.
 *
 * Data sources:
 *  • Binance — public bapi/capital/v1/public/capital/getNetworkCoinAll (all coins, startup + 4h)
 *  • Bitget  — public /api/v2/spot/public/coins   (all coins, startup + every 4h)
 *  • KuCoin  — public /api/v2/currencies/{coin}   (lazy per-coin, cached)
 *  • Bybit   — hardcoded cheapest-network table   (v5 asset info requires auth)
 *  • Kraken  — hardcoded cheapest-network table   (no public endpoint)
 */

import { logger } from "../../logger.js";

export interface WithdrawalOption {
  network:     string;
  feeInCoin:   number;
  minWithdraw: number;
}

// ── Network name normalization ─────────────────────────────────────────────
// Maps raw API values (uppercased) → canonical name used across all exchanges.

const NETWORK_ALIASES: Record<string, string> = {
  // Ethereum mainnet — Bitget calls it "ETH", KuCoin/static call it "ERC20"
  "ETH":                  "ERC20",
  "ETHEREUM":             "ERC20",
  "ERC-20":               "ERC20",

  // BSC
  "BSC":                  "BEP20",
  "BNB":                  "BEP20",
  "BNB SMART CHAIN":      "BEP20",
  "BINANCE SMART CHAIN":  "BEP20",

  // Arbitrum — Bitget "ArbitrumOne", KuCoin "ARBITRUM"
  "ARBITRUMONE":          "ARBITRUM",
  "ARBITRUM ONE":         "ARBITRUM",

  // Lightning — KuCoin "Lightning Network", Bitget "LIGHTNING"
  "LIGHTNING NETWORK":    "LIGHTNING",
  "LIGHTNINGNETWORK":     "LIGHTNING",
  "BTCLN":                "LIGHTNING",

  // Base — KuCoin "Base", Bitget "BASE"
  "BASE":                 "BASE",

  // Optimism — consistent as "OPTIMISM" everywhere
  "OPTIMISM NETWORK":     "OPTIMISM",
  "OP":                   "OPTIMISM",

  // zkSync
  "ZKSYNCERA":            "ZKSYNC",
  "ZKSYNC ERA":           "ZKSYNC",
  "ZKSYNCER":             "ZKSYNC",

  // Tron
  "TRON":                 "TRC20",
  "TRC-20":               "TRC20",

  // Polygon
  "POLYGON":              "MATIC",
  "POLYGON NETWORK":      "MATIC",

  // Cosmos
  "COSMOS HUB":           "COSMOS",
  "COSMOSHUB":            "COSMOS",
  "ATOM NETWORK":         "COSMOS",

  // Solana
  "SOLANA":               "SOL",

  // Starknet
  "STARKNET":             "STARKNET",
  "STARK":                "STARKNET",

  // Chiliz chain — Bitget calls it "CAP20", Binance calls it "CHZ2", Bybit calls it "CHZ"
  "CAP20":                "CHZ",
  "CHZ2":                 "CHZ",

  // Bitcoin Ordinals / BRC-20 — Binance calls it "ORDIBTC", KuCoin uses "BTC"
  "ORDIBTC":              "BTC",

  // Kava EVM — KuCoin "KAVA EVM Co-Chain", Binance "KAVAEVM"
  "KAVA EVM CO-CHAIN":    "KAVAEVM",
  "KAVA EVM":             "KAVAEVM",

  // Aptos — sometimes "APTOS"
  "APTOS":                "APT",

  // Hedera — sometimes "HEDERA"
  "HEDERA":               "HBAR",

  // Bybit-specific chain name variations
  "ARBI":                 "ARBITRUM",   // Bybit's Arbitrum One name
  "ZKV2":                 "ZKSYNC",     // Bybit's zkSync Era name
  "CHILIZ":               "CHZ",        // Bybit's Chiliz Chain (CAP20/CHZ2 already → CHZ)
  "VECHAIN":              "VET",        // Bybit: VECHAIN → VET
  "CAVAX":                "AVAX",       // Bybit: Avalanche C-Chain
  "XAVAX":                "AVAX-X",     // Bybit: Avalanche X-Chain

  // Bitget-specific chain name variations
  "NEARPROTOCOL":         "NEAR",       // Bitget: NEARProtocol → NEAR
  "COREDAO":              "CORE",       // Bitget: CoreDAO → CORE
  "AVAXC-CHAIN":          "AVAX",       // Bitget: Avalanche C-Chain
  "AVAXX-CHAIN":          "AVAX-X",     // Bitget: Avalanche X-Chain
  "BRC20":                "BTC",        // Bitget: BRC-20 inscriptions on Bitcoin (SATS, ORDI)
  "KAIA":                 "KAIA",       // Bitget/KuCoin canonical Kaia chain
  "KLAY":                 "KAIA",       // Bybit old Klaytn/Kaia name

  // KuCoin-specific chain name variations
  "AVAX C-CHAIN":         "AVAX",       // KuCoin: Avalanche C-Chain
  "AVAX X-CHAIN":         "AVAX-X",     // KuCoin: Avalanche X-Chain
  "OASIS":                "ROSE",       // KuCoin: Oasis Network (ROSE token)
  "KUSAMA":               "KSM",        // KuCoin: Kusama network → KSM
  "ICON":                 "ICX",        // KuCoin: ICON chain → ICX
  "ENJIN":                "ENJ",        // KuCoin/Bybit: Enjin chain → ENJ

  // THORChain — Binance uses "RUNE", Bitget uses "THORChain"
  "THORCHAIN":            "RUNE",
  "THOR":                 "RUNE",

  // Stellar — Bitget uses "StellarLumens", some use "STELLAR"
  "STELLARLUMENS":        "XLM",
  "STELLAR":              "XLM",
  "STELLAR LUMENS":       "XLM",

  // Ontology — Bitget uses "Ontology"
  "ONTOLOGY":             "ONT",

  // Terra / LUNA — Bitget uses "Terra" for LUNA chain
  "TERRA":                "LUNA",
  "TERRA2":               "LUNA",
  "LUNA2":                "LUNA",
  "LUNC":                 "LUNA",

  // Metal DAO L2 — Bitget "MetalDAOL2", KuCoin "Metal L2"
  "METALDAOL2":           "MTL",
  "METAL L2":             "MTL",
  "METAL":                "MTL",

  // Stratis EVM — Bitget uses "StratisEVM"
  "STRATISEVM":           "STRAX",
  "STRATIS":              "STRAX",

  // Astar — Bitget uses "Astar", "AstrEvm"
  "ASTAR":                "ASTR",
  "ASTAREVM":             "ASTR",
  "ASTR EVM":             "ASTR",

  // Ronin — Binance uses "RON", KuCoin uses "Ronin", Bitget uses "RONIN"
  "RONIN":                "RONIN",
  "RON":                  "RONIN",

  // Polkadot Asset Hub (formerly Statemint) — Binance="STATEMINT",
  // Bitget="PolkadotAssetHub", KuCoin="Asset Hub(Polkadot)"
  "STATEMINT":               "POLKADOT_AH",
  "POLKADOTASSETHUB":        "POLKADOT_AH",
  "POLKADOT ASSET HUB":      "POLKADOT_AH",
  "ASSET HUB(POLKADOT)":     "POLKADOT_AH",
  "ASSET HUB (POLKADOT)":    "POLKADOT_AH",
  "ASSETHUBPOLKADOT":        "POLKADOT_AH",

  // Frax — Bitget/KuCoin use "Frax"
  "FRAX":                 "FRAX",

  // TRX as network name = TRC20 (Binance uses "TRX" as network name for TRON chain)
  "TRX":                  "TRC20",

  // Bitcoin Cash — KuCoin uses "BCHN" as the network name
  "BCHN":                 "BCH",
  "BITCOINCASH":          "BCH",

  // Kusama / Asset Hub Kusama — KuCoin uses "Asset Hub Kusama"
  "ASSET HUB KUSAMA":     "KSM",
  "ASSETHUBKUSAMA":       "KSM",

  // Base chain — KuCoin uses "Base"
  "BASE NETWORK":         "BASE",

  // Celestia chain — Bybit static uses "CELESTIA", Binance/KuCoin use "TIA"
  "CELESTIA":             "TIA",

  // Polygon POS — KuCoin uses "Polygon POS"
  "POLYGON POS":          "MATIC",
  "POLYGON MAINNET":      "MATIC",

  // Polymesh — KuCoin uses "POLYMESH" for POLYX
  "POLYMESH":             "POLYX",

  // MegaETH — new chain for MEGA token
  "MEGAETH":              "MEGA",

  // Movement — MOVE token chain
  "MOVEMENT":             "MOVE",

  // Fogo — FOGO chain
  "FOGO":                 "FOGO",

  // XAI — XAI native chain
  "XAI NETWORK":          "XAI",

  // Linea — Linea L2
  "LINEA MAINNET":        "LINEA",

  // Manta Pacific
  "MANTA PACIFIC":        "MANTA",
  "MANTAPACIFIC":         "MANTA",
};

export function normalizeNetwork(raw: string): string {
  const upper = raw.toUpperCase().trim();
  return NETWORK_ALIASES[upper] ?? upper;
}

// ── Internal types ─────────────────────────────────────────────────────────

interface NetworkEntry extends WithdrawalOption {
  canDeposit: boolean;
}

// ── Static tables (Binance / Bybit / Kraken) ──────────────────────────────
// Single cheapest-network entry per coin. Used as buy-side source only.
// Sell-side deposit data for static exchanges is unknown (no public API).

type StaticTable = Record<string, WithdrawalOption>;

const BINANCE_STATIC: StaticTable = {
  BTC:    { network: "BTC",        feeInCoin: 0.00020,  minWithdraw: 0.001  },
  ETH:    { network: "ARBITRUM",   feeInCoin: 0.00064,  minWithdraw: 0.001  },
  SOL:    { network: "SOL",        feeInCoin: 0.01,     minWithdraw: 0.02   },
  BNB:    { network: "BEP20",      feeInCoin: 0.00028,  minWithdraw: 0.01   },
  XRP:    { network: "XRP",        feeInCoin: 0.25,     minWithdraw: 20     },
  ADA:    { network: "ADA",        feeInCoin: 1.0,      minWithdraw: 10     },
  DOGE:   { network: "DOGE",       feeInCoin: 10.0,     minWithdraw: 50     },
  AVAX:   { network: "AVAX",       feeInCoin: 0.01,     minWithdraw: 0.1    },
  MATIC:  { network: "MATIC",      feeInCoin: 0.1,      minWithdraw: 10     },
  POL:    { network: "MATIC",      feeInCoin: 0.1,      minWithdraw: 10     },
  DOT:    { network: "DOT",        feeInCoin: 0.1,      minWithdraw: 1      },
  LINK:   { network: "BEP20",      feeInCoin: 0.05,     minWithdraw: 0.5    },
  LTC:    { network: "LTC",        feeInCoin: 0.001,    minWithdraw: 0.01   },
  BCH:    { network: "BCH",        feeInCoin: 0.0001,   minWithdraw: 0.01   },
  TRX:    { network: "TRC20",      feeInCoin: 1.0,      minWithdraw: 10     },
  ATOM:   { network: "COSMOS",     feeInCoin: 0.1,      minWithdraw: 1      },
  UNI:    { network: "BEP20",      feeInCoin: 0.06,     minWithdraw: 0.6    },
  ALGO:   { network: "ALGO",       feeInCoin: 0.1,      minWithdraw: 1      },
  VET:    { network: "VET",        feeInCoin: 20.0,     minWithdraw: 100    },
  FIL:    { network: "FIL",        feeInCoin: 0.001,    minWithdraw: 0.01   },
  NEAR:   { network: "NEAR",       feeInCoin: 0.01,     minWithdraw: 0.1    },
  ICP:    { network: "ICP",        feeInCoin: 0.0001,   minWithdraw: 0.01   },
  AAVE:   { network: "BEP20",      feeInCoin: 0.02,     minWithdraw: 0.1    },
  APT:    { network: "APT",        feeInCoin: 0.01,     minWithdraw: 0.1    },
  ARB:    { network: "ARBITRUM",   feeInCoin: 0.1,      minWithdraw: 1      },
  OP:     { network: "OPTIMISM",   feeInCoin: 0.07,     minWithdraw: 0.5    },
  SUI:    { network: "SUI",        feeInCoin: 0.02,     minWithdraw: 0.5    },
  INJ:    { network: "INJ",        feeInCoin: 0.005,    minWithdraw: 0.05   },
  SEI:    { network: "SEI",        feeInCoin: 0.1,      minWithdraw: 1      },
  TIA:    { network: "CELESTIA",   feeInCoin: 0.01,     minWithdraw: 0.1    },
  WLD:    { network: "OPTIMISM",   feeInCoin: 0.1,      minWithdraw: 1      },
  STX:    { network: "STX",        feeInCoin: 0.1,      minWithdraw: 1      },
  JUP:    { network: "SOL",        feeInCoin: 0.02,     minWithdraw: 0.5    },
  RNDR:   { network: "SOL",        feeInCoin: 0.1,      minWithdraw: 1      },
  STRK:   { network: "STARKNET",   feeInCoin: 0.5,      minWithdraw: 1      },
  EIGEN:  { network: "ERC20",      feeInCoin: 0.25,     minWithdraw: 1      },
  ENA:    { network: "BEP20",      feeInCoin: 0.5,      minWithdraw: 5      },
  MANTA:  { network: "MANTA",      feeInCoin: 0.1,      minWithdraw: 1      },
  ZRO:    { network: "BEP20",      feeInCoin: 0.1,      minWithdraw: 1      },
  W:      { network: "SOL",        feeInCoin: 0.02,     minWithdraw: 0.5    },
  POPCAT: { network: "SOL",        feeInCoin: 0.02,     minWithdraw: 0.5    },
  NOT:    { network: "TON",        feeInCoin: 1.0,      minWithdraw: 10     },
  HMSTR:  { network: "TON",        feeInCoin: 1.0,      minWithdraw: 10     },
  // ── Extended (high-frequency unknowns) ─────────────────────────────────────
  ETC:    { network: "ETC",        feeInCoin: 0.01,     minWithdraw: 0.1    },
  HBAR:   { network: "HBAR",       feeInCoin: 1.0,      minWithdraw: 10     },
  XTZ:    { network: "XTZ",        feeInCoin: 0.1,      minWithdraw: 1      },
  RUNE:   { network: "THORCHAIN",  feeInCoin: 0.02,     minWithdraw: 1      },
  BLUR:   { network: "ERC20",      feeInCoin: 1.5,      minWithdraw: 5      },
  MINA:   { network: "MINA",       feeInCoin: 1.0,      minWithdraw: 1      },
  KSM:    { network: "KSM",        feeInCoin: 0.005,    minWithdraw: 0.05   },
  FIDA:   { network: "SOL",        feeInCoin: 0.1,      minWithdraw: 1      },
  IO:     { network: "SOL",        feeInCoin: 0.02,     minWithdraw: 0.5    },
  CYBER:  { network: "BEP20",      feeInCoin: 0.5,      minWithdraw: 1      },
  TWT:    { network: "BEP20",      feeInCoin: 1.0,      minWithdraw: 1      },
  CVX:    { network: "ERC20",      feeInCoin: 1.5,      minWithdraw: 1      },
  STG:    { network: "BEP20",      feeInCoin: 5.0,      minWithdraw: 1      },
  PAXG:   { network: "ERC20",      feeInCoin: 0.003,    minWithdraw: 0.001  },
  WIN:    { network: "TRC20",      feeInCoin: 200.0,    minWithdraw: 500    },
  SAFE:   { network: "ERC20",      feeInCoin: 0.5,      minWithdraw: 1      },
  MOVR:   { network: "MOONRIVER",  feeInCoin: 0.01,     minWithdraw: 0.1    },
  DOGS:   { network: "TON",        feeInCoin: 50.0,     minWithdraw: 100    },
  WCT:    { network: "SOL",        feeInCoin: 1.0,      minWithdraw: 1      },
  KMNO:   { network: "SOL",        feeInCoin: 0.2,      minWithdraw: 1      },
  BAND:   { network: "BEP20",      feeInCoin: 0.1,      minWithdraw: 1      },
  PEPE:   { network: "ERC20",      feeInCoin: 300000.0, minWithdraw: 1000000},
  SHIB:   { network: "ERC20",      feeInCoin: 100000.0, minWithdraw: 500000 },
  FLOKI:  { network: "BEP20",      feeInCoin: 1000.0,   minWithdraw: 5000   },
  BONK:   { network: "SOL",        feeInCoin: 5000.0,   minWithdraw: 10000  },
  LUNC:   { network: "LUNC",       feeInCoin: 100.0,    minWithdraw: 500    },
  GALA:   { network: "BEP20",      feeInCoin: 10.0,     minWithdraw: 50     },
  GMT:    { network: "SOL",        feeInCoin: 0.1,      minWithdraw: 1      },
  CHZ:    { network: "CHZ",        feeInCoin: 1.0,      minWithdraw: 10     },
  HOT:    { network: "ERC20",      feeInCoin: 1000.0,   minWithdraw: 5000   },
  SAND:   { network: "BEP20",      feeInCoin: 0.5,      minWithdraw: 5      },
  MANA:   { network: "BEP20",      feeInCoin: 0.5,      minWithdraw: 5      },
  AXS:    { network: "BEP20",      feeInCoin: 0.02,     minWithdraw: 0.2    },
  GRT:    { network: "BEP20",      feeInCoin: 1.0,      minWithdraw: 10     },
  CRV:    { network: "ERC20",      feeInCoin: 1.0,      minWithdraw: 5      },
  LDO:    { network: "ERC20",      feeInCoin: 0.5,      minWithdraw: 5      },
  SNX:    { network: "BEP20",      feeInCoin: 0.1,      minWithdraw: 1      },
  MKR:    { network: "ERC20",      feeInCoin: 0.001,    minWithdraw: 0.01   },
  COMP:   { network: "ERC20",      feeInCoin: 0.02,     minWithdraw: 0.1    },
  CAKE:   { network: "BEP20",      feeInCoin: 0.1,      minWithdraw: 1      },
  CHR:    { network: "BEP20",      feeInCoin: 1.0,      minWithdraw: 10     },
  OCEAN:  { network: "BEP20",      feeInCoin: 1.0,      minWithdraw: 10     },
  ANKR:   { network: "BEP20",      feeInCoin: 10.0,     minWithdraw: 100    },
  ONE:    { network: "ONE",        feeInCoin: 1.0,      minWithdraw: 100    },
  ZIL:    { network: "ZIL",        feeInCoin: 1.0,      minWithdraw: 10     },
  IOTA:   { network: "IOTA",       feeInCoin: 0.1,      minWithdraw: 1      },
  FTM:    { network: "FTM",        feeInCoin: 0.1,      minWithdraw: 10     },
  S:      { network: "S",          feeInCoin: 0.1,      minWithdraw: 1      },
  XLM:    { network: "XLM",        feeInCoin: 0.1,      minWithdraw: 1      },
  XMR:    { network: "XMR",        feeInCoin: 0.0001,   minWithdraw: 0.01   },
  DASH:   { network: "DASH",       feeInCoin: 0.001,    minWithdraw: 0.01   },
  ZEC:    { network: "ZEC",        feeInCoin: 0.0005,   minWithdraw: 0.01   },
  EOS:    { network: "EOS",        feeInCoin: 0.1,      minWithdraw: 0.1    },
  IOST:   { network: "IOST",       feeInCoin: 10.0,     minWithdraw: 100    },
  WAVES:  { network: "WAVES",      feeInCoin: 0.01,     minWithdraw: 0.1    },
  ICX:    { network: "ICX",        feeInCoin: 0.1,      minWithdraw: 1      },
  ONT:    { network: "ONT",        feeInCoin: 1.0,      minWithdraw: 5      },
  QTUM:   { network: "QTUM",       feeInCoin: 0.01,     minWithdraw: 0.1    },
  SC:     { network: "SC",         feeInCoin: 0.1,      minWithdraw: 100    },
  LSK:    { network: "LSK",        feeInCoin: 0.1,      minWithdraw: 1      },
  KNC:    { network: "ERC20",      feeInCoin: 1.0,      minWithdraw: 5      },
  BAT:    { network: "BEP20",      feeInCoin: 1.0,      minWithdraw: 10     },
  ZEN:    { network: "ZEN",        feeInCoin: 0.005,    minWithdraw: 0.05   },
  SKL:    { network: "ERC20",      feeInCoin: 10.0,     minWithdraw: 100    },
  CELR:   { network: "BEP20",      feeInCoin: 10.0,     minWithdraw: 100    },
  RLC:    { network: "ERC20",      feeInCoin: 0.5,      minWithdraw: 5      },
  OGN:    { network: "ERC20",      feeInCoin: 5.0,      minWithdraw: 50     },
  CTSI:   { network: "ERC20",      feeInCoin: 2.0,      minWithdraw: 20     },
  NKN:    { network: "ERC20",      feeInCoin: 5.0,      minWithdraw: 50     },
};

const BYBIT_STATIC: StaticTable = {
  BTC:    { network: "BTC",        feeInCoin: 0.00050,  minWithdraw: 0.001  },
  ETH:    { network: "ARBITRUM",   feeInCoin: 0.0010,   minWithdraw: 0.005  },
  SOL:    { network: "SOL",        feeInCoin: 0.01,     minWithdraw: 0.02   },
  BNB:    { network: "BEP20",      feeInCoin: 0.00025,  minWithdraw: 0.01   },
  XRP:    { network: "XRP",        feeInCoin: 0.25,     minWithdraw: 25     },
  ADA:    { network: "ADA",        feeInCoin: 1.0,      minWithdraw: 10     },
  DOGE:   { network: "DOGE",       feeInCoin: 5.0,      minWithdraw: 50     },
  AVAX:   { network: "AVAX",       feeInCoin: 0.01,     minWithdraw: 0.1    },
  MATIC:  { network: "MATIC",      feeInCoin: 0.1,      minWithdraw: 10     },
  POL:    { network: "MATIC",      feeInCoin: 0.1,      minWithdraw: 10     },
  DOT:    { network: "DOT",        feeInCoin: 0.08,     minWithdraw: 1      },
  LINK:   { network: "BEP20",      feeInCoin: 0.05,     minWithdraw: 0.5    },
  LTC:    { network: "LTC",        feeInCoin: 0.001,    minWithdraw: 0.01   },
  BCH:    { network: "BCH",        feeInCoin: 0.0001,   minWithdraw: 0.01   },
  TRX:    { network: "TRC20",      feeInCoin: 1.0,      minWithdraw: 10     },
  ATOM:   { network: "COSMOS",     feeInCoin: 0.1,      minWithdraw: 1      },
  UNI:    { network: "BEP20",      feeInCoin: 0.05,     minWithdraw: 0.5    },
  NEAR:   { network: "NEAR",       feeInCoin: 0.01,     minWithdraw: 0.1    },
  APT:    { network: "APT",        feeInCoin: 0.01,     minWithdraw: 0.1    },
  ARB:    { network: "ARBITRUM",   feeInCoin: 0.1,      minWithdraw: 1      },
  OP:     { network: "OPTIMISM",   feeInCoin: 0.05,     minWithdraw: 0.5    },
  SUI:    { network: "SUI",        feeInCoin: 0.02,     minWithdraw: 0.5    },
  INJ:    { network: "INJ",        feeInCoin: 0.005,    minWithdraw: 0.05   },
  SEI:    { network: "SEI",        feeInCoin: 0.1,      minWithdraw: 1      },
  ENA:    { network: "ERC20",      feeInCoin: 5.0,      minWithdraw: 20     },
  ZRO:    { network: "BEP20",      feeInCoin: 0.1,      minWithdraw: 1      },
  W:      { network: "SOL",        feeInCoin: 0.02,     minWithdraw: 0.5    },
  POPCAT: { network: "SOL",        feeInCoin: 0.02,     minWithdraw: 0.5    },
  NOT:    { network: "TON",        feeInCoin: 1.0,      minWithdraw: 10     },
  // ── Extended (high-frequency unknowns) ─────────────────────────────────────
  ETC:    { network: "ETC",        feeInCoin: 0.01,     minWithdraw: 0.1    },
  HBAR:   { network: "HBAR",       feeInCoin: 1.0,      minWithdraw: 10     },
  XTZ:    { network: "XTZ",        feeInCoin: 0.2,      minWithdraw: 1      },
  RUNE:   { network: "THORCHAIN",  feeInCoin: 0.02,     minWithdraw: 1      },
  BLUR:   { network: "ERC20",      feeInCoin: 1.5,      minWithdraw: 5      },
  MINA:   { network: "MINA",       feeInCoin: 1.0,      minWithdraw: 1      },
  KSM:    { network: "KSM",        feeInCoin: 0.005,    minWithdraw: 0.05   },
  FIDA:   { network: "SOL",        feeInCoin: 0.1,      minWithdraw: 1      },
  TWT:    { network: "BEP20",      feeInCoin: 1.0,      minWithdraw: 1      },
  CVX:    { network: "ERC20",      feeInCoin: 2.0,      minWithdraw: 1      },
  STG:    { network: "BEP20",      feeInCoin: 5.0,      minWithdraw: 1      },
  SAFE:   { network: "ERC20",      feeInCoin: 0.5,      minWithdraw: 1      },
  DOGS:   { network: "TON",        feeInCoin: 50.0,     minWithdraw: 100    },
  HMSTR:  { network: "TON",        feeInCoin: 1.0,      minWithdraw: 10     },
  MOVR:   { network: "MOONRIVER",  feeInCoin: 0.01,     minWithdraw: 0.1    },
  CYBER:  { network: "BEP20",      feeInCoin: 0.5,      minWithdraw: 1      },
  GALA:   { network: "BEP20",      feeInCoin: 10.0,     minWithdraw: 50     },
  GMT:    { network: "SOL",        feeInCoin: 0.1,      minWithdraw: 1      },
  CHZ:    { network: "CHZ",        feeInCoin: 1.0,      minWithdraw: 10     },
  SAND:   { network: "BEP20",      feeInCoin: 0.5,      minWithdraw: 5      },
  MANA:   { network: "BEP20",      feeInCoin: 0.5,      minWithdraw: 5      },
  AXS:    { network: "BEP20",      feeInCoin: 0.02,     minWithdraw: 0.2    },
  GRT:    { network: "BEP20",      feeInCoin: 1.0,      minWithdraw: 10     },
  CRV:    { network: "ERC20",      feeInCoin: 1.0,      minWithdraw: 5      },
  LDO:    { network: "ERC20",      feeInCoin: 0.5,      minWithdraw: 5      },
  SNX:    { network: "BEP20",      feeInCoin: 0.1,      minWithdraw: 1      },
  MKR:    { network: "ERC20",      feeInCoin: 0.001,    minWithdraw: 0.01   },
  COMP:   { network: "ERC20",      feeInCoin: 0.02,     minWithdraw: 0.1    },
  CAKE:   { network: "BEP20",      feeInCoin: 0.1,      minWithdraw: 1      },
  FTM:    { network: "FTM",        feeInCoin: 0.1,      minWithdraw: 10     },
  S:      { network: "S",          feeInCoin: 0.1,      minWithdraw: 1      },
  XLM:    { network: "XLM",        feeInCoin: 0.1,      minWithdraw: 1      },
  PEPE:   { network: "ERC20",      feeInCoin: 300000.0, minWithdraw: 1000000},
  SHIB:   { network: "ERC20",      feeInCoin: 100000.0, minWithdraw: 500000 },
  FLOKI:  { network: "BEP20",      feeInCoin: 1000.0,   minWithdraw: 5000   },
  BONK:   { network: "SOL",        feeInCoin: 5000.0,   minWithdraw: 10000  },
  ALGO:   { network: "ALGO",       feeInCoin: 0.1,      minWithdraw: 1      },
  ICP:    { network: "ICP",        feeInCoin: 0.0001,   minWithdraw: 0.01   },
  AAVE:   { network: "BEP20",      feeInCoin: 0.02,     minWithdraw: 0.1    },
  TIA:    { network: "CELESTIA",   feeInCoin: 0.01,     minWithdraw: 0.1    },
  STRK:   { network: "STARKNET",   feeInCoin: 0.5,      minWithdraw: 1      },
  JUP:    { network: "SOL",        feeInCoin: 0.02,     minWithdraw: 0.5    },
  STX:    { network: "STX",        feeInCoin: 0.1,      minWithdraw: 1      },
  FIL:    { network: "FIL",        feeInCoin: 0.001,    minWithdraw: 0.01   },
  // ── Wave 3 (bybit-BUY unknowns, fees from Binance public API as reference) ──
  TON:    { network: "TON",        feeInCoin: 0.03,     minWithdraw: 0.1    },
  MAJOR:  { network: "TON",        feeInCoin: 1.0,      minWithdraw: 10     },
  JTO:    { network: "SOL",        feeInCoin: 0.5,      minWithdraw: 1      },
  RENDER: { network: "SOL",        feeInCoin: 0.2,      minWithdraw: 0.5    },
  RNDR:   { network: "SOL",        feeInCoin: 0.2,      minWithdraw: 0.5    },
  WIF:    { network: "SOL",        feeInCoin: 1.0,      minWithdraw: 2      },
  TRUMP:  { network: "SOL",        feeInCoin: 0.2,      minWithdraw: 0.5    },
  PYTH:   { network: "SOL",        feeInCoin: 5.0,      minWithdraw: 10     },
  PENDLE: { network: "BEP20",      feeInCoin: 0.02,     minWithdraw: 0.1    },
  MASK:   { network: "BEP20",      feeInCoin: 0.1,      minWithdraw: 0.5    },
  SUSHI:  { network: "BEP20",      feeInCoin: 0.1,      minWithdraw: 1      },
  "1INCH":{ network: "BEP20",      feeInCoin: 0.5,      minWithdraw: 5      },
  PEOPLE: { network: "BEP20",      feeInCoin: 3.0,      minWithdraw: 30     },
  SOLV:   { network: "BEP20",      feeInCoin: 5.0,      minWithdraw: 20     },
  ANKR:   { network: "BEP20",      feeInCoin: 10.0,     minWithdraw: 100    },
  VET:    { network: "VET",        feeInCoin: 20.0,     minWithdraw: 100    },
  VTHO:   { network: "VET",        feeInCoin: 100.0,    minWithdraw: 1000   },
  ONE:    { network: "ONE",        feeInCoin: 1.0,      minWithdraw: 10     },
  ICX:    { network: "ICX",        feeInCoin: 0.1,      minWithdraw: 1      },
  ZIL:    { network: "ZIL",        feeInCoin: 1.0,      minWithdraw: 10     },
  QTUM:   { network: "QTUM",       feeInCoin: 0.01,     minWithdraw: 0.1    },
  WAVES:  { network: "WAVES",      feeInCoin: 0.01,     minWithdraw: 0.1    },
  THETA:  { network: "THETA",      feeInCoin: 0.15,     minWithdraw: 1      },
  EGLD:   { network: "EGLD",       feeInCoin: 0.001,    minWithdraw: 0.01   },
  FLOW:   { network: "FLOW",       feeInCoin: 0.01,     minWithdraw: 0.1    },
  ROSE:   { network: "ROSE",       feeInCoin: 0.1,      minWithdraw: 1      },
  AXL:    { network: "AXL",        feeInCoin: 0.05,     minWithdraw: 0.5    },
  DYDX:   { network: "DYDX",       feeInCoin: 0.02,     minWithdraw: 0.1    },
  GMX:    { network: "ARBITRUM",   feeInCoin: 0.02,     minWithdraw: 0.1    },
  MAGIC:  { network: "ARBITRUM",   feeInCoin: 1.5,      minWithdraw: 5      },
  ORDI:   { network: "BTC",        feeInCoin: 1.2,      minWithdraw: 3      },
  SATS:   { network: "BTC",        feeInCoin: 500000.0, minWithdraw: 2000000},
  WLD:    { network: "WLD",        feeInCoin: 0.1,      minWithdraw: 0.5    },
  QNT:    { network: "ERC20",      feeInCoin: 0.01,     minWithdraw: 0.05   },
  ENS:    { network: "ERC20",      feeInCoin: 0.1,      minWithdraw: 0.5    },
  IMX:    { network: "ERC20",      feeInCoin: 4.0,      minWithdraw: 10     },
  RPL:    { network: "ERC20",      feeInCoin: 0.5,      minWithdraw: 2      },
  SSV:    { network: "ERC20",      feeInCoin: 0.3,      minWithdraw: 1      },
  WBTC:   { network: "ERC20",      feeInCoin: 0.00001,  minWithdraw: 0.0001 },
  YFI:    { network: "BEP20",      feeInCoin: 0.00001,  minWithdraw: 0.0001 },
  GRASS:  { network: "SOL",        feeInCoin: 0.5,      minWithdraw: 2      },
  EIGEN:  { network: "ERC20",      feeInCoin: 3.5,      minWithdraw: 10     },
  // ── Wave 4 (targeted remaining unknowns) ────────────────────────────────
  JUV:    { network: "CHZ",        feeInCoin: 0.5,      minWithdraw: 5      },
  UMA:    { network: "ERC20",      feeInCoin: 1.5,      minWithdraw: 5      },
  TNSR:   { network: "SOL",        feeInCoin: 5.0,      minWithdraw: 10     },
  KMNO:   { network: "SOL",        feeInCoin: 10.0,     minWithdraw: 50     },
  SPELL:  { network: "ERC20",      feeInCoin: 4000.0,   minWithdraw: 10000  },
  BREV:   { network: "BEP20",      feeInCoin: 0.2,      minWithdraw: 1      },
  FOGO:   { network: "FOGO",       feeInCoin: 0.01,     minWithdraw: 0.1    },
  HAEDAL: { network: "BEP20",      feeInCoin: 0.5,      minWithdraw: 2      },
  ZKP:    { network: "BEP20",      feeInCoin: 0.3,      minWithdraw: 1      },
  ASTER:  { network: "BEP20",      feeInCoin: 0.05,     minWithdraw: 0.5    },
  CFG:    { network: "ERC20",      feeInCoin: 2.5,      minWithdraw: 10     },
  SUN:    { network: "TRC20",      feeInCoin: 1000.0,   minWithdraw: 5000   },
  JST:    { network: "TRC20",      feeInCoin: 50.0,     minWithdraw: 200    },
  ENJ:    { network: "ENJ",        feeInCoin: 0.001,    minWithdraw: 0.01   },
  LUNA:   { network: "LUNA",       feeInCoin: 0.1,      minWithdraw: 1      },
  STRAX:  { network: "STRAX",      feeInCoin: 0.01,     minWithdraw: 0.1    },
  MTL:    { network: "MTL",        feeInCoin: 0.1,      minWithdraw: 1      },
  FLUX:   { network: "BEP20",      feeInCoin: 0.5,      minWithdraw: 2      },
  ASTR:   { network: "ASTR",       feeInCoin: 0.5,      minWithdraw: 5      },
  RONIN:  { network: "RONIN",      feeInCoin: 0.01,     minWithdraw: 0.1    },
  ONDO:   { network: "ERC20",      feeInCoin: 2.0,      minWithdraw: 5      },
  VIRTUAL:{ network: "BASE",       feeInCoin: 0.5,      minWithdraw: 2      },
  PENGU:  { network: "SOL",        feeInCoin: 20.0,     minWithdraw: 100    },
  DOOD:   { network: "SOL",        feeInCoin: 1.0,      minWithdraw: 5      },
  GOAT:   { network: "SOL",        feeInCoin: 5.0,      minWithdraw: 20     },
  MEW:    { network: "SOL",        feeInCoin: 5.0,      minWithdraw: 20     },
  PNUT:   { network: "SOL",        feeInCoin: 2.0,      minWithdraw: 10     },
  AI16Z:  { network: "SOL",        feeInCoin: 2.0,      minWithdraw: 10     },
  ACT:    { network: "SOL",        feeInCoin: 5.0,      minWithdraw: 20     },
  DRIFT:  { network: "SOL",        feeInCoin: 2.0,      minWithdraw: 10     },
  HYPE:   { network: "HYPE",       feeInCoin: 0.5,      minWithdraw: 2      },
  LAYER:  { network: "SOL",        feeInCoin: 2.0,      minWithdraw: 10     },
  MOVE:   { network: "MOVEMENT",   feeInCoin: 0.1,      minWithdraw: 1      },
  COOKIE: { network: "SOL",        feeInCoin: 5.0,      minWithdraw: 20     },
  NEIROCTO:{ network: "SOL",       feeInCoin: 5.0,      minWithdraw: 20     },
};

const KRAKEN_STATIC: StaticTable = {
  BTC:   { network: "BTC",       feeInCoin: 0.00002,  minWithdraw: 0.0001 },
  ETH:   { network: "ERC20",     feeInCoin: 0.0035,   minWithdraw: 0.01   },
  SOL:   { network: "SOL",       feeInCoin: 0.002,    minWithdraw: 0.05   },
  XRP:   { network: "XRP",       feeInCoin: 0.02,     minWithdraw: 10     },
  ADA:   { network: "ADA",       feeInCoin: 0.35,     minWithdraw: 1      },
  DOGE:  { network: "DOGE",      feeInCoin: 2.0,      minWithdraw: 10     },
  DOT:   { network: "DOT",       feeInCoin: 0.05,     minWithdraw: 1      },
  LTC:   { network: "LTC",       feeInCoin: 0.001,    minWithdraw: 0.005  },
  TRX:   { network: "TRC20",     feeInCoin: 0.5,      minWithdraw: 10     },
  ATOM:  { network: "COSMOS",    feeInCoin: 0.005,    minWithdraw: 0.1    },
  LINK:  { network: "ERC20",     feeInCoin: 0.1,      minWithdraw: 1      },
  MATIC: { network: "MATIC",     feeInCoin: 0.05,     minWithdraw: 5      },
  POL:   { network: "MATIC",     feeInCoin: 0.05,     minWithdraw: 5      },
  UNI:   { network: "ERC20",     feeInCoin: 0.1,      minWithdraw: 1      },
  AVAX:  { network: "AVAX",      feeInCoin: 0.005,    minWithdraw: 0.1    },
  NEAR:  { network: "NEAR",      feeInCoin: 0.01,     minWithdraw: 0.1    },
  APT:   { network: "APT",       feeInCoin: 0.01,     minWithdraw: 0.1    },
};

const STATIC_TABLES: Record<string, StaticTable> = {
  bybit:   BYBIT_STATIC,
  kraken:  KRAKEN_STATIC,
};

// ── Dynamic caches (Bitget + KuCoin) ──────────────────────────────────────

/**
 * `${exchange}:${COIN}` → withdrawal networks sorted cheapest-first.
 * Each entry includes canDeposit flag (does this exchange/network accept deposits?).
 */
const withdrawNetworkCache = new Map<string, NetworkEntry[]>();

/**
 * `${exchange}:${COIN}` → set of normalized network names the exchange
 * accepts for DEPOSIT of that coin.
 */
const depositNetworkCache = new Map<string, Set<string>>();

const kucoinPending = new Set<string>();
const REFRESH_MS = 60_000; // 1 minute — re-verify networks/addresses frequently

// ── Binance (all coins at startup, public endpoint) ───────────────────────

async function fetchBinanceAll(): Promise<void> {
  try {
    const res = await fetch(
      "https://www.binance.com/bapi/capital/v1/public/capital/getNetworkCoinAll",
      {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      code: string;
      data: Array<{
        coin: string;
        networkList: Array<{
          network:        string;
          withdrawFee:    string;
          withdrawMin:    string;
          withdrawEnable: boolean;
          depositEnable:  boolean;
        }>;
      }>;
    };
    if (body.code !== "000000") throw new Error(`Binance code ${body.code}`);

    let wdCount = 0;
    for (const entry of body.data) {
      const coin     = entry.coin.toUpperCase();
      const wdNets:  NetworkEntry[] = [];
      const depNets: Set<string>    = new Set();

      for (const n of entry.networkList) {
        const net = normalizeNetwork(n.network);
        if (n.depositEnable)  depNets.add(net);
        if (n.withdrawEnable) {
          const fee = parseFloat(n.withdrawFee);
          if (isFinite(fee) && fee >= 0) {
            wdNets.push({
              network:     net,
              feeInCoin:   fee,
              minWithdraw: parseFloat(n.withdrawMin) || 0,
              canDeposit:  n.depositEnable,
            });
          }
        }
      }

      wdNets.sort((a, b) => a.feeInCoin - b.feeInCoin);
      withdrawNetworkCache.set(`binance:${coin}`, wdNets);
      depositNetworkCache.set(`binance:${coin}`, depNets);
      if (wdNets.length) wdCount++;
    }
    logger.info({ coins: body.data.length, withWithdraw: wdCount }, "binance withdrawal networks loaded");
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "binance withdrawal network fetch failed — using static fallback",
    );
    // Fall back to static table for any coins not yet cached
    for (const [coin, opt] of Object.entries(BINANCE_STATIC)) {
      const key = `binance:${coin}`;
      if (!withdrawNetworkCache.has(key)) {
        withdrawNetworkCache.set(key, [{
          network:     opt.network,
          feeInCoin:   opt.feeInCoin,
          minWithdraw: opt.minWithdraw,
          canDeposit:  true,
        }]);
        depositNetworkCache.set(key, new Set([opt.network]));
      }
    }
  }
}

// ── Bybit deposit networks (all coins at startup, public endpoint) ────────

async function fetchBybitDepositAll(): Promise<void> {
  try {
    const res = await fetch(
      "https://api.bybit.com/v5/asset/deposit/query-allowed-list",
      {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      retCode: number;
      result?: {
        configList?: Array<{
          coin:  string;
          chain: string;
        }>;
      };
    };
    if (body.retCode !== 0) throw new Error(`Bybit retCode ${body.retCode}`);

    const depMap = new Map<string, Set<string>>();
    for (const entry of body.result?.configList ?? []) {
      const coin = entry.coin.toUpperCase();
      const net  = normalizeNetwork(entry.chain);
      if (!depMap.has(coin)) depMap.set(coin, new Set());
      depMap.get(coin)!.add(net);
    }

    for (const [coin, nets] of depMap) {
      depositNetworkCache.set(`bybit:${coin}`, nets);
    }
    logger.info({ coins: depMap.size }, "bybit deposit networks loaded");
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "bybit deposit network fetch failed",
    );
  }
}

// ── Bitget (all coins at startup) ─────────────────────────────────────────

async function fetchBitgetAll(): Promise<void> {
  try {
    const res = await fetch("https://api.bitget.com/api/v2/spot/public/coins", {
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      data: Array<{
        coin: string;
        chains: Array<{
          chain:             string;
          withdrawable:      string;
          rechargeable:      string;
          withdrawFee:       string;
          minWithdrawAmount: string;
        }>;
      }>;
    };

    let wdCount = 0;
    for (const entry of body.data) {
      const coin     = entry.coin.toUpperCase();
      const wdNets:  NetworkEntry[] = [];
      const depNets: Set<string>    = new Set();

      for (const c of entry.chains) {
        const net = normalizeNetwork(c.chain);
        if (c.rechargeable === "true") depNets.add(net);
        if (c.withdrawable === "true") {
          const fee = parseFloat(c.withdrawFee);
          if (isFinite(fee) && fee >= 0) {
            wdNets.push({
              network:    net,
              feeInCoin:  fee,
              minWithdraw:parseFloat(c.minWithdrawAmount) || 0,
              canDeposit: c.rechargeable === "true",
            });
          }
        }
      }

      wdNets.sort((a, b) => a.feeInCoin - b.feeInCoin);
      withdrawNetworkCache.set(`bitget:${coin}`, wdNets);
      depositNetworkCache.set(`bitget:${coin}`, depNets);
      if (wdNets.length) wdCount++;
    }
    logger.info({ coins: body.data.length, withWithdraw: wdCount }, "bitget withdrawal networks loaded");
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "bitget withdrawal network fetch failed",
    );
  }
}

// ── KuCoin (lazy per-coin) ─────────────────────────────────────────────────

function fetchKucoinCoin(coin: string): void {
  const key = `kucoin:${coin}`;
  if (kucoinPending.has(coin) || withdrawNetworkCache.has(key)) return;
  kucoinPending.add(coin);

  void (async () => {
    try {
      const res = await fetch(
        `https://api.kucoin.com/api/v2/currencies/${encodeURIComponent(coin)}`,
        { signal: AbortSignal.timeout(8_000) },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        data?: {
          chains?: Array<{
            chainName:         string;
            withdrawalMinFee:  string;
            withdrawalMinSize: string;
            isWithdrawEnabled: boolean;
            isDepositEnabled:  boolean;
          }>;
        };
      };

      const wdNets:  NetworkEntry[] = [];
      const depNets: Set<string>    = new Set();

      for (const c of body.data?.chains ?? []) {
        const net = normalizeNetwork(c.chainName);
        if (c.isDepositEnabled) depNets.add(net);
        if (c.isWithdrawEnabled) {
          const fee = parseFloat(c.withdrawalMinFee);
          if (isFinite(fee) && fee >= 0) {
            wdNets.push({
              network:    net,
              feeInCoin:  fee,
              minWithdraw:parseFloat(c.withdrawalMinSize) || 0,
              canDeposit: c.isDepositEnabled,
            });
          }
        }
      }

      wdNets.sort((a, b) => a.feeInCoin - b.feeInCoin);
      withdrawNetworkCache.set(key, wdNets);
      depositNetworkCache.set(key, depNets);
    } catch {
      withdrawNetworkCache.set(key, []);
      depositNetworkCache.set(key, new Set());
    } finally {
      kucoinPending.delete(coin);
    }
  })();
}

// ── Internal helpers ───────────────────────────────────────────────────────

/** All withdrawal networks on exchange for coin (sorted cheapest-first). Null if unknown. */
function getWithdrawNetworks(exchange: string, coin: string): WithdrawalOption[] | null {
  const staticTable = STATIC_TABLES[exchange];
  if (staticTable) {
    const opt = staticTable[coin.toUpperCase()];
    if (!opt) return null;
    // Normalize the network name so static entries intersect correctly with deposit Sets
    return [{ ...opt, network: normalizeNetwork(opt.network) }];
  }

  const key = `${exchange}:${coin.toUpperCase()}`;
  if (exchange === "kucoin" && !withdrawNetworkCache.has(key)) {
    fetchKucoinCoin(coin.toUpperCase());
    return null; // not ready yet — will populate on next rebuild cycle
  }
  const nets = withdrawNetworkCache.get(key);
  return nets ?? null;
}

/** Set of normalized deposit network names for exchange+coin. Null if unknown. */
function getDepositNetworks(exchange: string, coin: string): Set<string> | null {
  const key = `${exchange}:${coin.toUpperCase()}`;

  // KuCoin: trigger lazy fetch if not yet cached
  if (exchange === "kucoin" && !depositNetworkCache.has(key)) {
    fetchKucoinCoin(coin.toUpperCase());
    return null; // not ready yet — will be correct on next rebuild cycle
  }

  // Check dynamic cache — covers Binance, Bitget, KuCoin, and Bybit deposit data
  const cached = depositNetworkCache.get(key);
  if (cached !== undefined) return cached;

  // Exchange has no deposit network data (Bybit withdrawal / Kraken)
  return null;
}

// ── Public interface ───────────────────────────────────────────────────────

/**
 * Returns the cheapest viable withdrawal route for this specific arbitrage leg:
 *   • Withdrawing coin from buyExchange
 *   • Depositing it onto sellExchange
 *
 * Algorithm:
 *   1. Get all withdrawal networks on buyExchange (sorted by fee, cheapest first)
 *   2. Get all deposit  networks on sellExchange
 *   3. If both are known → filter to common networks → pick cheapest
 *   4. If sellExchange deposit data is unavailable (static exchange) → pick
 *      cheapest withdrawal regardless (conservative — might not deposit)
 *   5. If buyExchange withdrawal data is unavailable → return null
 */
export function getWithdrawalFee(
  buyExchange:  string,
  sellExchange: string,
  coin:         string,
): WithdrawalOption | null {
  const wdNets = getWithdrawNetworks(buyExchange, coin);
  if (!wdNets || wdNets.length === 0) return null;

  const depNets = getDepositNetworks(sellExchange, coin);

  if (depNets !== null) {
    // Both sides have network data — intersect
    const common = wdNets.filter((n) => depNets.has(n.network));
    if (common.length === 0) return null; // no viable transfer route
    const best = common[0]; // already sorted cheapest-first
    return { network: best.network, feeInCoin: best.feeInCoin, minWithdraw: best.minWithdraw };
  }

  // Sell side has no deposit data (static exchange) — use cheapest withdrawal
  const best = wdNets[0];
  return { network: best.network, feeInCoin: best.feeInCoin, minWithdraw: best.minWithdraw };
}

/** Start background fee fetching. Call once at startup. */
export function startWithdrawalFeeService(): void {
  void fetchBinanceAll();
  void fetchBitgetAll();
  void fetchBybitDepositAll();
  setInterval(() => void fetchBinanceAll(),       REFRESH_MS);
  setInterval(() => void fetchBitgetAll(),        REFRESH_MS);
  setInterval(() => void fetchBybitDepositAll(),  REFRESH_MS);
}
