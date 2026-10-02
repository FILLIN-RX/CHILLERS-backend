import { Router } from 'express';
import { adminMiddleware } from '../admin/admin.middleware';
import * as liveController from './live.controller';

const router = Router();

// Public
router.get('/channels', liveController.getChannels);
router.get('/channels/categories', liveController.getCategories);
router.get('/channels/:slug', liveController.getChannel);
router.get('/proxy', liveController.proxy);

// Admin (même JWT que le reste de l'admin CHILLERS)
router.post('/sync', adminMiddleware, liveController.syncChannels);
router.get('/admin/all', adminMiddleware, liveController.listAll);
router.post('/', adminMiddleware, liveController.createChannel);
router.put('/:id', adminMiddleware, liveController.updateChannel);
router.delete('/:id', adminMiddleware, liveController.deleteChannel);

export default router;
