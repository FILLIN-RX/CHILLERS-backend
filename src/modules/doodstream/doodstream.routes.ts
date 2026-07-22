import { Router } from 'express';
import * as doodController from './doodstream.controller';
import { getDownloadByTitle, proxyDownload, proxyStream, getSeriesDownloadCheck } from './doodstream.download';

const router = Router();

router.get('/download', getDownloadByTitle);
router.get('/download/proxy', proxyDownload);
router.get('/stream', proxyStream);

router.get('/account', doodController.getAccountInfo);
router.get('/account/stats', doodController.getAccountStats);

router.get('/upload/url', doodController.remoteUploadAdd);
router.get('/upload/slots', doodController.remoteUploadSlots);
router.get('/upload/list', doodController.remoteUploadList);
router.get('/upload/status', doodController.remoteUploadStatus);
router.get('/upload/actions', doodController.remoteUploadActions);

router.get('/folder/create', doodController.createFolder);
router.get('/folder/rename', doodController.renameFolder);
router.get('/folder/list', doodController.listFolders);

router.get('/file/list', doodController.listFiles);
router.get('/file/info', doodController.getFileInfo);
router.get('/file/check', doodController.checkFileStatus);
router.get('/file/image', doodController.getFileImage);
router.get('/file/rename', doodController.renameFile);
router.get('/file/move', doodController.moveFile);
router.get('/file/clone', doodController.cloneFile);
router.get('/file/search', doodController.searchFiles);

/* ── Series Episode Management ── */
router.post('/series/episode', doodController.addSeriesEpisode);
router.get('/series/episodes/:tmdbId', doodController.listSeriesEpisodes);
router.get('/series/download-check', getSeriesDownloadCheck);

export default router;
