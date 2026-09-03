import { Router, Request, Response } from 'express';
import axios from 'axios';
import {
  searchOmniSave,
  getOmniSaveDetail,
  getOmniSaveDownloads
} from './omnisave.service';

const router = Router();

/**
 * Recherche de médias (films, séries, animes)
 * GET /api/omnisave/search?q=naruto&page=1&perPage=10
 */
router.get('/search', async (req: Request, res: Response) => {
  try {
    const { q, page = '1', perPage = '10', lang = 'en' } = req.query as {
      q?: string;
      page?: string;
      perPage?: string;
      lang?: string;
    };

    if (!q || !q.trim()) {
      return res.status(400).json({ success: false, message: 'Paramètre ?q= requis' });
    }

    const data = await searchOmniSave(
      q,
      parseInt(page, 10) || 1,
      parseInt(perPage, 10) || 10,
      lang
    );

    return res.json({ success: true, data });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * Récupération des détails d'un média (épisodes, saisons, synopsis)
 * GET /api/omnisave/detail?subjectId=...&detailPath=...
 */
router.get('/detail', async (req: Request, res: Response) => {
  try {
    const { subjectId, detailPath, lang = 'en' } = req.query as {
      subjectId?: string;
      detailPath?: string;
      lang?: string;
    };

    if (!subjectId || !detailPath) {
      return res.status(400).json({
        success: false,
        message: 'Paramètres ?subjectId= et ?detailPath= requis'
      });
    }

    const detail = await getOmniSaveDetail(subjectId, detailPath, lang);
    if (!detail) {
      return res.status(404).json({ success: false, message: 'Média introuvable' });
    }

    return res.json({ success: true, data: detail });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * Récupération des liens MP4 et sous-titres
 * GET /api/omnisave/downloads?subjectId=...&detailPath=...&season=1&episode=1
 */
router.get('/downloads', async (req: Request, res: Response) => {
  try {
    const { subjectId, detailPath, season = '1', episode = '1', lang = 'en' } = req.query as {
      subjectId?: string;
      detailPath?: string;
      season?: string;
      episode?: string;
      lang?: string;
    };

    if (!subjectId || !detailPath) {
      return res.status(400).json({
        success: false,
        message: 'Paramètres ?subjectId= et ?detailPath= requis'
      });
    }

    const result = await getOmniSaveDownloads(
      subjectId,
      detailPath,
      parseInt(season, 10) || 1,
      parseInt(episode, 10) || 1,
      lang
    );

    return res.json({ success: true, data: result });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * Proxy de streaming vidéo pour contourner les restrictions d'en-tête (Referer/CORS)
 * GET /api/omnisave/proxy?url=https://...
 */
router.get('/proxy', async (req: Request, res: Response) => {
  try {
    const { url } = req.query as { url?: string };
    if (!url) {
      return res.status(400).json({ success: false, message: 'Paramètre ?url= requis' });
    }

    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://videodownloader.site/'
    };

    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    const response = await axios({
      method: 'GET',
      url,
      headers,
      responseType: 'stream',
      validateStatus: status => status >= 200 && status < 400
    });

    res.status(response.status);

    for (const [key, val] of Object.entries(response.headers)) {
      if (['content-type', 'content-length', 'accept-ranges', 'content-range', 'content-disposition'].includes(key.toLowerCase())) {
        res.setHeader(key, val as string);
      }
    }

    response.data.pipe(res);
  } catch (error: any) {
    console.error('[OmniSave Proxy] Erreur:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Erreur proxy de streaming' });
    }
  }
});

export default router;
