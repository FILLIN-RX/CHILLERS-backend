import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';

const router = Router();

/**
 * GET /api/download/stream
 *
 * Proxy de téléchargement : pipe le flux HLS via FFmpeg directement
 * vers le navigateur client. Aucun fichier stocké sur le serveur.
 *
 * Query: ?m3u8=<encoded_url>&filename=<nom_fichier>
 */
router.get('/stream', (req: Request, res: Response) => {
  const m3u8Url = req.query.m3u8 as string;
  if (!m3u8Url) {
    res.status(400).json({ success: false, error: 'm3u8 query param required' });
    return;
  }

  const filename = (req.query.filename as string) || 'video.mp4';

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'video/mp4');

  const ffmpeg = spawn('ffmpeg', [
    '-y',
    '-i', m3u8Url,
    '-c', 'copy',
    '-bsf:a', 'aac_adtstoasc',
    '-movflags', '+faststart',
    '-f', 'mp4',
    'pipe:1',
  ]);

  ffmpeg.stdout.pipe(res);

  ffmpeg.stderr.on('data', () => {
    // FFmpeg logs — ignorés, seulement pour debug
  });

  ffmpeg.on('close', (code: number | null) => {
    if (code !== 0 && !res.headersSent) {
      res.status(500).json({ success: false, error: `FFmpeg exited code ${code}` });
    }
  });

  ffmpeg.on('error', () => {
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'FFmpeg not found' });
    }
  });

  // Timeout global 10 minutes
  req.on('close', () => {
    ffmpeg.kill();
  });
});

export default router;
