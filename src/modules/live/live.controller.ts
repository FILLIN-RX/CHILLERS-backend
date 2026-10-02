import { Request, Response, NextFunction } from 'express';
import * as liveService from './live.service';

export const getChannels = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const category = req.query.category as string | undefined;
    const country = req.query.country as string | undefined;
    const channels = await liveService.listEnabled({ category, country });
    res.json({ success: true, data: channels, message: null });
  } catch (error) {
    next(error);
  }
};

export const getChannel = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const channel = await liveService.getBySlug(String(req.params.slug));
    if (!channel) {
      res.status(404).json({ success: false, data: null, message: 'Chaîne introuvable' });
      return;
    }
    res.json({ success: true, data: channel, message: null });
  } catch (error) {
    next(error);
  }
};

export const getCategories = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const categories = await liveService.getCategories();
    res.json({ success: true, data: categories, message: null });
  } catch (error) {
    next(error);
  }
};

export const listAll = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const channels = await liveService.listAll();
    res.json({ success: true, data: channels, message: null });
  } catch (error) {
    next(error);
  }
};

export const createChannel = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const channel = await liveService.createChannel(req.body);
    res.status(201).json({ success: true, data: channel, message: 'Chaîne créée' });
  } catch (error) {
    next(error);
  }
};

export const updateChannel = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const channel = await liveService.updateChannel(String(req.params.id), req.body);
    if (!channel) {
      res.status(404).json({ success: false, data: null, message: 'Chaîne introuvable' });
      return;
    }
    res.json({ success: true, data: channel, message: 'Chaîne mise à jour' });
  } catch (error) {
    next(error);
  }
};

export const deleteChannel = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deleted = await liveService.deleteChannel(String(req.params.id));
    res.json({ success: true, data: { deleted }, message: deleted ? 'Chaîne supprimée' : 'Chaîne introuvable' });
  } catch (error) {
    next(error);
  }
};

export const syncChannels = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const updateStreams = req.body?.updateStreams === true;
    const result = await liveService.syncSeed({ updateStreams });
    res.json({
      success: true,
      data: result,
      message: `Seed synchronisé : ${result.added} ajoutée(s), ${result.updated} mise(s) à jour`,
    });
  } catch (error) {
    next(error);
  }
};

export const proxy = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const url = String(req.query.url || '');
    const referer = String(req.query.referer || '');
    const userAgent = String(req.query.ua || '');
    const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;

    const stream = await liveService.proxyStream(url, { referer, userAgent, range });
    res.status(stream.status);
    res.setHeader('Content-Type', stream.contentType);
    res.setHeader('Cache-Control', 'no-store');
    if (stream.contentLength) res.setHeader('Content-Length', stream.contentLength);
    if (stream.contentRange) res.setHeader('Content-Range', stream.contentRange);
    if (stream.acceptRanges) res.setHeader('Accept-Ranges', stream.acceptRanges);
    stream.body.on('error', () => res.destroy());
    stream.body.pipe(res);
  } catch (error) {
    res.status(502).json({ success: false, data: null, message: (error as Error).message });
  }
};
