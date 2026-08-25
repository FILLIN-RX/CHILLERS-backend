// @ts-nocheck
import * as express_1 from "express";
import * as admin_middleware_1 from "../admin/admin.middleware";
import * as liveController from "./live.controller";
const router = (0, express_1.Router)();
// Public
router.get('/channels', liveController.getChannels);
router.get('/channels/categories', liveController.getCategories);
router.get('/channels/:slug', liveController.getChannel);
router.get('/proxy', liveController.proxy);
// Admin (même JWT que le reste de l'admin CHILLERS)
router.post('/sync', admin_middleware_1.adminMiddleware, liveController.syncChannels);
router.get('/admin/all', admin_middleware_1.adminMiddleware, liveController.listAll);
router.post('/', admin_middleware_1.adminMiddleware, liveController.createChannel);
router.put('/:id', admin_middleware_1.adminMiddleware, liveController.updateChannel);
router.delete('/:id', admin_middleware_1.adminMiddleware, liveController.deleteChannel);
export default router;
