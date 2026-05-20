export const SPOT_DEFAULTS_KEY = "spot-arb-defaults";

const VALID_RANGES = ["4H", "8H", "12H", "24H"];

export function loadSpotDefaults() {
  try {
    const d = JSON.parse(localStorage.getItem(SPOT_DEFAULTS_KEY) || "{}");
    return {
      tradeAmount:       typeof d.tradeAmount       === "number" ? d.tradeAmount       : 100,
      targetedNetProfit: typeof d.targetedNetProfit === "number" ? d.targetedNetProfit : 1.0,
      chartDefaultRange: VALID_RANGES.includes(d.chartDefaultRange) ? d.chartDefaultRange : "24H",
      hedgeChartRange:   VALID_RANGES.includes(d.hedgeChartRange)   ? d.hedgeChartRange   : "4H",
    };
  } catch {
    return { tradeAmount: 100, targetedNetProfit: 1.0, chartDefaultRange: "24H", hedgeChartRange: "4H" };
  }
}

export function saveSpotDefaults(patch) {
  try {
    const current = JSON.parse(localStorage.getItem(SPOT_DEFAULTS_KEY) || "{}");
    localStorage.setItem(SPOT_DEFAULTS_KEY, JSON.stringify({ ...current, ...patch }));
  } catch {}
}
