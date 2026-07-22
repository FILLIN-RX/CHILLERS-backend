import { Router, Request, Response } from 'express';
import { searchOtaku, searchAndCache } from './otaku.service';

const router = Router();

router.get('/search', async (req: Request, res: Response) => {
  try {
    const { title, type = 'movie' } = req.query as { title?: string; type?: string };

    if (!title) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Missing ?title= param',
      });
    }

    console.log(`[Otaku API] Searching "${title}" (type: ${type})`);
    const result = await searchOtaku(title, type as 'movie' | 'series');

    if (result) {
      return res.json({
        success: true,
        data: result,
        message: null,
      });
    }

    return res.json({
      success: false,
      data: null,
      message: `No results found on open-otaku.me for "${title}"`,
    });
  } catch (error: any) {
    console.error('[Otaku API] Error:', error.message);
    return res.status(500).json({
      success: false,
      data: null,
      message: error.message || 'Otaku search failed',
    });
  }
});

router.get('/search-and-cache', async (req: Request, res: Response) => {
  try {
    const { title, type = 'movie' } = req.query as { title?: string; type?: string };

    if (!title) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Missing ?title= param',
      });
    }

    console.log(`[Otaku API] Search & cache "${title}" (type: ${type})`);
    const result = await searchAndCache(title, type as 'movie' | 'series');

    if (result) {
      return res.json({
        success: true,
        data: result,
        message: null,
      });
    }

    return res.json({
      success: false,
      data: null,
      message: `No results found on open-otaku.me for "${title}"`,
    });
  } catch (error: any) {
    console.error('[Otaku API] Error:', error.message);
    return res.status(500).json({
      success: false,
      data: null,
      message: error.message || 'Otaku search failed',
    });
  }
});

export default router;
