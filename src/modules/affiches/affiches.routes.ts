import { Router, Response } from 'express';
import { adminMiddleware, AuthRequest } from '../../modules/admin/admin.middleware';
import {
  generateOne,
  generateAll,
  listAffiches,
  affichesProgress,
  PosterSource,
} from './affiches.service';
import { generateCardPNG } from './affiches.card';
import Movie from '../../models/Movie';
import Serie from '../../models/Serie';

const router = Router();

router.post('/generate', adminMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { type, id } = req.body as { type?: string; id?: string };

    if (id) {
      if (!['movie', 'series'].includes(type || '')) {
        res.status(400).json({ success: false, data: null, message: 'Type invalide (movie|series)' });
        return;
      }
      await generateOne(type as 'movie' | 'series', id);
      const doc = type === 'movie' ? await Movie.findById(id).select('titre posterUrl posterSource speech') : await Serie.findById(id).select('titre posterUrl posterSource speech');
      res.json({ success: true, data: doc, message: 'Affiche + speech générés' });
      return;
    }

    const t = type || 'all';
    if (!['all', 'movie', 'series'].includes(t)) {
      res.status(400).json({ success: false, data: null, message: 'Type invalide (all|movie|series)' });
      return;
    }
    if (affichesProgress.running) {
      res.status(409).json({ success: false, data: null, message: 'Une génération est déjà en cours' });
      return;
    }
    generateAll(t as any).catch(err => console.error('[Affiches] Erreur génération:', err));
    res.json({ success: true, data: { launched: true, type: t }, message: 'Génération lancée (tendances en priorité)' });
  } catch (err: any) {
    res.status(500).json({ success: false, data: null, message: err.message });
  }
});

router.get('/status', adminMiddleware, (_req: AuthRequest, res: Response) => {
  res.json({ success: true, data: affichesProgress, message: null });
});

router.get('/', adminMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { type, disponible, source, q, page, limit } = req.query;
    const data = await listAffiches({
      type: (type as any) || 'all',
      disponible: disponible !== undefined ? disponible === 'true' || disponible === '1' : undefined,
      source: source as PosterSource | undefined,
      q: q as string,
      page: parseInt(page as string) || 1,
      limit: Math.min(parseInt(limit as string) || 50, 200),
    });
    res.json({ success: true, data, message: null });
  } catch (err: any) {
    res.status(500).json({ success: false, data: null, message: err.message });
  }
});

router.get('/:id/poster', async (req: AuthRequest, res: Response) => {
  try {
    const type = (req.query.type as string) || 'movie';
    const doc = type === 'series'
      ? await Serie.findById(req.params.id).select('posterUrl titre')
      : await Movie.findById(req.params.id).select('posterUrl titre');
    if (!doc?.posterUrl) {
      res.status(404).json({ success: false, data: null, message: 'Pas d\'affiche pour ce titre' });
      return;
    }
    res.redirect(doc.posterUrl);
  } catch (err: any) {
    res.status(500).json({ success: false, data: null, message: err.message });
  }
});

router.get('/:id/card', async (req: AuthRequest, res: Response) => {
  try {
    const type = (req.query.type as string) === 'series' ? 'series' : 'movie';
    const doc = type === 'series'
      ? await Serie.findById(req.params.id).select('titre year tmdbId posterUrl speech')
      : await Movie.findById(req.params.id).select('titre year tmdbId posterUrl speech');

    if (!doc) {
      res.status(404).json({ success: false, data: null, message: 'Titre introuvable' });
      return;
    }

    const link = doc.tmdbId ? `/media/${doc.tmdbId}?type=${type === 'series' ? 'tv' : 'movie'}` : null;
    const png = await generateCardPNG({
      titre: doc.titre,
      year: doc.year,
      type,
      speech: doc.speech,
      posterUrl: doc.posterUrl,
      link,
    });

    const safeName = doc.titre.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="chillers-${safeName}.png"`);
    res.send(png);
  } catch (err: any) {
    console.error('[Affiches] Erreur carte:', err.message);
    res.status(500).json({ success: false, data: null, message: err.message });
  }
});

export default router;
