import { Router } from 'express';
import * as genresController from './genres.controller';

const router = Router();

router.get('/movie', genresController.getMovieGenres);
router.get('/tv', genresController.getTvGenres);

export default router;
