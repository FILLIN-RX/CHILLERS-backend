// @ts-nocheck
import * as express_1 from "express";
import * as torrentsController from "./torrents.controller";
const router = (0, express_1.Router)();
router.get('/health', torrentsController.healthCheck);
router.get('/stream', torrentsController.streamFile);
router.get('/download', torrentsController.downloadFile);
export default router;
