import { Router } from 'express';
import * as nexstreamController from './nexstream.controller';

const router = Router();

router.get('/movie/:id', nexstreamController.getMovieStreamFast);
router.get('/tv/:id/:season/:episode', nexstreamController.getEpisodeStreamFast);

export default router;
