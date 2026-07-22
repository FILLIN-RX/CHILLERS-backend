import { Request, Response, NextFunction } from 'express';
import * as genresService from './genres.service';

export const getMovieGenres = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const language = req.query.language as string | undefined;
    const data = await genresService.getMovieGenres(language);
    res.json({ success: true, data, message: null });
  } catch (error) {
    next(error);
  }
};

export const getTvGenres = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const language = req.query.language as string | undefined;
    const data = await genresService.getTvGenres(language);
    res.json({ success: true, data, message: null });
  } catch (error) {
    next(error);
  }
};
