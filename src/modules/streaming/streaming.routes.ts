import { Router } from 'express';
import * as streamingController from './streaming.controller';

const router = Router();

router.get('/movie/:id', streamingController.getMovieStream);
router.get('/tv/:id/:season/:episode', streamingController.getEpisodeStream);

export default router;
