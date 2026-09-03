import { Router } from 'express';
import * as userController from './user.controller';
import { requireAuth } from '../auth/../../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);

router.post('/favorites', userController.toggleFavorite);
router.put('/progress', userController.updateProgress);
router.post('/history', userController.markAsWatched);
router.put('/preferences', userController.updatePreferences);

export default router;
