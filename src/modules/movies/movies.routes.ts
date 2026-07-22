import { Router } from 'express';
import * as moviesController from './movies.controller';

const router = Router();

router.get('/popular', moviesController.getPopular);
router.get('/trending', moviesController.getTrending);
router.get('/upcoming', moviesController.getUpcoming);
router.get('/top-rated', moviesController.getTopRated);
router.get('/genre/:genreId', moviesController.getByGenre);
router.get('/:id/recommendations', moviesController.getRecommendations);
router.get('/:id/trailer', moviesController.getTrailer);
router.get('/:id', moviesController.getDetails);

export default router;
