import { Router, type IRouter } from "express";
import { getCachedBalances } from "../lib/wallet/index.js";

const router: IRouter = Router();

// Returns the in-memory cached balances instantly (updated every 3 s in background)
router.get("/wallet/balances", (req, res): void => {
  try {
    const balances = getCachedBalances();
    res.set("Cache-Control", "no-store");
    res.json(balances);
  } catch (err) {
    req.log.error({ err }, "wallet balances error");
    res.status(500).json({ error: "Failed to fetch wallet balances" });
  }
});

export default router;
