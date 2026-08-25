// @ts-nocheck
import * as express_1 from "express";
import * as nexstreamController from "./nexstream.controller";
const router = (0, express_1.Router)();
router.get('/movie/:id', nexstreamController.getMovieStreamFast);
router.get('/tv/:id/:season/:episode', nexstreamController.getEpisodeStreamFast);
export default router;
