import { Router } from 'express';
import * as subtitlesController from './subtitles.controller';

const router = Router();

router.get('/find', subtitlesController.findSubs);
router.get('/file/:fileId', subtitlesController.getSubFile);

export default router;
