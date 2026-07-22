import { Router } from 'express';
import { adminMiddleware, adminSseMiddleware } from './admin.middleware';
import * as adminController from './admin.controller';

const router = Router();

router.post('/auth/login', adminController.login);
router.get('/auth/verify', adminMiddleware, adminController.verify);
router.get('/dashboard', adminMiddleware, adminController.dashboard);
router.get('/logs', adminMiddleware, adminController.logs);
router.get('/dead-links', adminMiddleware, adminController.deadLinks);
router.post('/dead-links/appeal/:id', adminMiddleware, adminController.appealDeadLink);
router.post('/dead-links/rescrape/:id', adminMiddleware, adminController.rescrapeDeadLink);
router.put('/dead-links/:id', adminMiddleware, adminController.updateDeadLink);
router.get('/settings', adminMiddleware, adminController.getSettings);
router.put('/settings', adminMiddleware, adminController.updateSettings);
router.post('/scrape/trigger', adminMiddleware, adminController.triggerScrape);
router.post('/maintenance/run', adminMiddleware, adminController.runMaintenance);
router.post('/cron/start', adminMiddleware, adminController.cronStart);
router.post('/cron/stop', adminMiddleware, adminController.cronStop);
router.get('/cron/status', adminMiddleware, adminController.cronStatus);
router.post('/cron/run/:taskId', adminMiddleware, adminController.runTask);
router.get('/cron/processes', adminMiddleware, adminController.listProcesses);
router.post('/cron/kill/:pid', adminMiddleware, adminController.killProcess);
router.get('/cron/system', adminMiddleware, adminController.systemCron);
router.get('/tasks/running', adminMiddleware, adminController.runningTasks);
router.post('/tasks/stop/:name', adminMiddleware, adminController.stopTaskHandler);
router.post('/clear-cache', adminMiddleware, adminController.clearTmdbCache);
router.get('/logs/stream', adminSseMiddleware, adminController.logStream);
router.get('/collection', adminMiddleware, adminController.collection);
router.get('/collection/links', adminMiddleware, adminController.getConvertedLinks);
router.get('/scraper-state', adminMiddleware, adminController.scraperState);
router.get('/serie/:id', adminMiddleware, adminController.getSerie);
router.get('/movie/:id', adminMiddleware, adminController.getMovie);
router.get('/tmdb/stats', adminMiddleware, adminController.tmdbStats);
router.post('/tmdb/link', adminMiddleware, adminController.triggerTmdbLink);
router.post('/collection/link-tmdb', adminMiddleware, adminController.linkTmdb);
router.post('/series/fix-seasons', adminMiddleware, adminController.fixSeriesSeasons);

router.post('/uqload/upload/movies', adminMiddleware, adminController.uqloadUploadMovies);
router.post('/uqload/upload/series', adminMiddleware, adminController.uqloadUploadSeries);
router.post('/uqload/upload/movie/:id', adminMiddleware, adminController.uqloadUploadMovie);
router.post('/uqload/upload/serie/:id/episode/:index', adminMiddleware, adminController.uqloadUploadEpisode);
router.post('/uqload/stop', adminMiddleware, adminController.uqloadStop);
router.get('/uqload/status', adminMiddleware, adminController.uqloadStatus);
router.get('/uqload/pending', adminMiddleware, adminController.uqloadPending);
router.get('/uqload/pending-both', adminMiddleware, adminController.uqloadPendingBoth);

export default router;
