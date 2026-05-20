import { Router, type IRouter } from "express";
import healthRouter    from "./health";
import scannerRouter   from "./scanner";
import marketsRouter   from "./markets";
import spotRouter      from "./spot";
import walletRouter    from "./wallet";
import alertsRouter    from "./alerts";
import settingsRouter  from "./settings";
import botRouter       from "./bot";
import dataRouter      from "./data";
import spotHedgeRouter from "./spot-hedge";
import authRouter      from "./auth";
import aiRouter        from "./ai";

const router: IRouter = Router();

router.use(authRouter);
router.use(healthRouter);
router.use(scannerRouter);
router.use(marketsRouter);
router.use(spotRouter);
router.use(walletRouter);
router.use(alertsRouter);
router.use(settingsRouter);
router.use(botRouter);
router.use(dataRouter);
router.use(spotHedgeRouter);
router.use(aiRouter);

export default router;
