import { Request, Response, NextFunction } from 'express';
import * as searchService from './search.service';
import { AppError } from '../../types';

export const search = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = String(req.query.q || '');
    if (!query.trim()) throw new AppError('Query parameter "q" is required', 400);
    const page = Number(req.query.page) || 1;
    const language = req.query.language as string | undefined;
    const data = await searchService.searchMulti(query, page, language);
    res.json({ success: true, data, message: null });
  } catch (error) {
    next(error);
  }
};
