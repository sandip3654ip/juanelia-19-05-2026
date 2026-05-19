export { getTradingFees }           from "./trading-fees.js";

// Deposit address service (Bybit HMAC auth — actual wallet deposit addresses)
export {
  startDepositAddressService,
  refreshDepositAddresses,
  getDepositAddress,
  getAllDepositAddresses,
  getDepositAddressStatus,
} from "./deposit-address-service.js";
export type {
  DepositAddressEntry,
} from "./deposit-address-service.js";
export { getWithdrawalFee, startWithdrawalFeeService } from "./withdrawal-fees.js";
export type { TradingFees }         from "./trading-fees.js";
export type { WithdrawalOption }    from "./withdrawal-fees.js";

// Bybit data store (deposit from API + withdrawal from static table, saved to disk)
export {
  startBybitDataService,
  fetchAndSaveBybit,
  getAllBybitData,
  getBybitCoin,
  getBybitDepositNetworks,
  getBybitWithdrawalEntry,
  getBybitFullCoverageCoins,
  getBybitFetchStatus,
} from "./bybit-data.js";
export type {
  BybitDepositEntry,
  BybitWithdrawalEntry,
  BybitCoinData,
  BybitData,
} from "./bybit-data.js";

// Bitget data store (per-coin, per-network, saved to disk)
export {
  startBitgetDataService,
  fetchAndSaveBitget,
  getAllBitgetData,
  getBitgetCoin,
  getBitgetWithdrawNetworks,
  getBitgetDepositNetworks,
  getBitgetBidirectionalNetworks,
  getBitgetFetchStatus,
} from "./bitget-data.js";
export type {
  BitgetNetworkEntry,
  BitgetCoinData,
  BitgetData,
} from "./bitget-data.js";

// KuCoin data store (per-coin, per-network, saved to disk)
export {
  startKucoinDataService,
  fetchAndSaveKucoin,
  getAllKucoinData,
  getKucoinCoin,
  getKucoinWithdrawNetworks,
  getKucoinDepositNetworks,
  getKucoinBidirectionalNetworks,
  getKucoinFetchStatus,
} from "./kucoin-data.js";
export type {
  KucoinNetworkEntry,
  KucoinCoinData,
  KucoinData,
} from "./kucoin-data.js";

// Binance data store (per-coin, per-network, saved to disk)
export {
  startBinanceDataService,
  fetchAndSaveBinance,
  getAllBinanceData,
  getBinanceCoin,
  getBinanceWithdrawNetworks,
  getBinanceDepositNetworks,
  getBinanceBidirectionalNetworks,
  getBinanceFetchStatus,
} from "./binance-data.js";
export type {
  BinanceNetworkEntry,
  BinanceCoinData,
  BinanceData,
} from "./binance-data.js";
