import { Router, Request, Response } from 'express';
import { getFrenchStreamMovie, searchFrenchStream } from './frenchstream.service';
import axios from 'axios';

const router = Router();

/**
 * Recherche rapide sur FrenchStream
 */
router.get('/search', async (req: Request, res: Response) => {
  try {
    const { title } = req.query as { title?: string };
    if (!title) {
      return res.status(400).json({ success: false, message: 'Paramètre ?title= requis' });
    }

    const results = await searchFrenchStream(title);
    return res.json({ success: true, data: results });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * Obtenir le lien direct haute résolution (1080p) pour la lecture
 */
router.get('/stream', async (req: Request, res: Response) => {
  try {
    const { title } = req.query as { title?: string };
    if (!title) {
      return res.status(400).json({ success: false, message: 'Paramètre ?title= requis' });
    }

    const result = await getFrenchStreamMovie(title);
    if (!result) {
      return res.status(404).json({ success: false, message: `Film non trouvé en 1080p sur FrenchStream` });
    }

    return res.json({
      success: true,
      data: result
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * Téléchargement direct ou proxy du fichier 1080p pour les utilisateurs Premium
 */
router.get('/download', async (req: Request, res: Response) => {
  try {
    const { title, url } = req.query as { title?: string; url?: string };
    let streamUrl = url;

    if (!streamUrl && title) {
      const result = await getFrenchStreamMovie(title);
      streamUrl = result?.streamUrl;
    }

    if (!streamUrl) {
      return res.status(404).json({ success: false, message: 'Lien de téléchargement introuvable' });
    }

    // Redirige directement vers le fichier MP4 haute résolution ou pipe le stream
    return res.redirect(streamUrl);
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
