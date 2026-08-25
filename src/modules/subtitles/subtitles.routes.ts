// @ts-nocheck
import * as express_1 from "express";
import * as subtitlesController from "./subtitles.controller";
const router = (0, express_1.Router)();
router.get('/find', subtitlesController.findSubs);
router.get('/file/:fileId', subtitlesController.getSubFile);
export default router;
