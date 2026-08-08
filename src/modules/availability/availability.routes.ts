import { Router, Request, Response } from 'express';
import { adminMiddleware, AuthRequest } from '../../modules/admin/admin.middleware';
import { scanAvailability, getBatchAvailability, scanProgress } from './availability.service';

const router = Router();

router.post('/scan', adminMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const type = (req.body.type as string) || 'all';
    if (!['all', 'movie', 'series'].includes(type)) {
      res.status(400).json({ success: false, data: null, message: 'Type invalide (all|movie|series)' });
      return;
    }
    if (scanProgress.running) {
      res.status(409).json({ success: false, data: null, message: 'Un scan est déjà en cours' });
      return;
    }
    scanAvailability(type as any).catch(err => console.error('[Availability] Scan error:', err));
    res.json({ success: true, data: { launched: true, type }, message: 'Scan disponibilité lancé' });
  } catch (err: any) {
    res.status(500).json({ success: false, data: null, message: err.message });
  }
});

router.get('/status', adminMiddleware, (_req: AuthRequest, res: Response) => {
  res.json({ success: true, data: scanProgress, message: null });
});

router.get('/batch', async (req: Request, res: Response) => {
  try {
    const type = (req.query.type as string) === 'tv' ? 'tv' : 'movie';
    const ids = String(req.query.ids || '')
      .split(',')
      .map((s: string) => parseInt(s.trim(), 10))
      .filter((n: number) => !isNaN(n));
    const data = await getBatchAvailability(type, ids);
    res.json({ success: true, data, message: null });
  } catch (err: any) {
    res.status(500).json({ success: false, data: null, message: err.message });
  }
});

export default router;
