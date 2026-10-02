import { Router } from 'express';
import * as torrentsController from './torrents.controller';

const router = Router();

router.get('/health', torrentsController.healthCheck);
router.get('/stream', torrentsController.streamFile);
router.get('/download', torrentsController.downloadFile);

export default router;
