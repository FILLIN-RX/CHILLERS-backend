import { Router } from 'express';
import * as tvController from './tv.controller';

const router = Router();

router.get('/popular', tvController.getPopular);
router.get('/trending', tvController.getTrending);
router.get('/top-rated', tvController.getTopRated);
router.get('/anime', tvController.getAnime);
router.get('/genre/:genreId', tvController.getByGenre);
router.get('/:id/season/:seasonNumber', tvController.getSeasonDetails);
router.get('/:id', tvController.getDetails);

export default router;
