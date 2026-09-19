import express from 'express';
import { requirePanelRouteAccess } from './panel-http-guard.js';

export function mountWebsiteCacheRoutes(app, {
  websiteCacheService,
} = {}) {
  if (!app || typeof app.use !== 'function'
    || !websiteCacheService) {
    throw new TypeError('Website cache HTTP dependencies are invalid');
  }

  const router = express.Router({ mergeParams: true });

  router.get('/cache', requirePanelRouteAccess, async (req, res, next) => {
    try {
      const policy = await websiteCacheService.getCachePolicy(req.params.websiteId);
      res.json(policy);
    } catch (error) {
      next(error);
    }
  });

  router.post('/cache/redis/enable', requirePanelRouteAccess, async (req, res, next) => {
    try {
      const { keyPrefix, allowedDb } = req.body ?? {};
      const result = await websiteCacheService.enableRedisCache(req.params.websiteId, {
        keyPrefix,
        allowedDb,
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/cache/redis/rotate-password', requirePanelRouteAccess, async (req, res, next) => {
    try {
      const result = await websiteCacheService.rotateRedisPassword(req.params.websiteId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/cache/memcached/enable', requirePanelRouteAccess, async (req, res, next) => {
    try {
      const result = await websiteCacheService.enableMemcached(req.params.websiteId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/cache', requirePanelRouteAccess, async (req, res, next) => {
    try {
      const result = await websiteCacheService.disableCache(req.params.websiteId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.use('/api/websites/:websiteId', router);
}
