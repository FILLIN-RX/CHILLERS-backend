import { Request, Response, NextFunction } from 'express';
import * as tvService from './tv.service';
import { AppError } from '../../types';

function getLang(req: Request): string | undefined {
  return req.query.language as string | undefined;
}

export const getPopular = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Number(req.query.page) || 1;
    const data = await tvService.getPopular(page, getLang(req));
    res.json({ success: true, data, message: null });
  } catch (error) {
    next(error);
  }
};

export const getTrending = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await tvService.getTrending(getLang(req));
    res.json({ success: true, data, message: null });
  } catch (error) {
    next(error);
  }
};

export const getTopRated = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Number(req.query.page) || 1;
    const data = await tvService.getTopRated(page, getLang(req));
    res.json({ success: true, data, message: null });
  } catch (error) {
    next(error);
  }
};

export const getByGenre = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const genreId = req.params.genreId as string;
    const page = Number(req.query.page) || 1;
    if (!genreId) throw new AppError('Genre ID is required', 400);
    const data = await tvService.getByGenre(genreId, page, getLang(req));
    res.json({ success: true, data, message: null });
  } catch (error) {
    next(error);
  }
};

export const getAnime = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Number(req.query.page) || 1;
    const data = await tvService.getAnime(page, getLang(req));
    res.json({ success: true, data, message: null });
  } catch (error) {
    next(error);
  }
};

export const getDetails = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    if (!id) throw new AppError('TV show ID is required', 400);
    const data = await tvService.getDetails(id, getLang(req));
    res.json({ success: true, data, message: null });
  } catch (error) {
    next(error);
  }
};

export const getSeasonDetails = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const seasonNumber = req.params.seasonNumber as string;
    if (!id || !seasonNumber) throw new AppError('TV show ID and season number are required', 400);
    const data = await tvService.getSeasonDetails(id, seasonNumber, getLang(req));
    res.json({ success: true, data, message: null });
  } catch (error) {
    next(error);
  }
};
