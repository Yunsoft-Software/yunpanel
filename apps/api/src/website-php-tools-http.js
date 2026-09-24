import express from 'express';
import { requirePanelRouteAccess } from './panel-http-guard.js';
import { WebsitePhpToolsServiceError } from './website-php-tools-service.js';

export function mountWebsitePhpToolsRoutes(app, {
  websitePhpToolsService,
} = {}) {
  if (!app || typeof app.use !== 'function'
    || !websitePhpToolsService) {
    throw new TypeError('Website PHP tools HTTP dependencies are invalid');
  }

  const router = express.Router({ mergeParams: true });

  router.get('/wp-cli/status', requirePanelRouteAccess, async (req, res, next) => {
    try {
      const status = await websitePhpToolsService.getWpCliStatus(req.params.websiteId);
      // Preserve legacy top-level fields while supporting the panel JSON client.
      res.json({ ...status, data: status });
    } catch (error) {
      next(error);
    }
  });

  router.post('/wp-cli/run', requirePanelRouteAccess, async (req, res, next) => {
    try {
      const { command, args, timeout } = req.body ?? {};
      if (typeof command !== 'string' || !command) {
        return res.status(400).json({
          error: {
            code: 'wp_cli_command_required',
            message: 'WP-CLI command is required',
          },
        });
      }
      if (args !== undefined && (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))) {
        return res.status(400).json({
          error: {
            code: 'wp_cli_args_invalid',
            message: 'WP-CLI args must be an array of strings',
          },
        });
      }

      const result = await websitePhpToolsService.runWpCli(req.params.websiteId, {
        command,
        args,
        timeout: typeof timeout === 'number' ? timeout : undefined,
      });

      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/composer/status', requirePanelRouteAccess, async (req, res, next) => {
    try {
      const status = await websitePhpToolsService.getComposerStatus(req.params.websiteId);
      // Preserve legacy top-level fields while supporting the panel JSON client.
      res.json({ ...status, data: status });
    } catch (error) {
      next(error);
    }
  });

  router.post('/composer/run', requirePanelRouteAccess, async (req, res, next) => {
    try {
      const { command, args, timeout } = req.body ?? {};
      if (typeof command !== 'string' || !command) {
        return res.status(400).json({
          error: {
            code: 'composer_command_required',
            message: 'Composer command is required',
          },
        });
      }
      if (args !== undefined && (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))) {
        return res.status(400).json({
          error: {
            code: 'composer_args_invalid',
            message: 'Composer args must be an array of strings',
          },
        });
      }

      const result = await websitePhpToolsService.runComposer(req.params.websiteId, {
        command,
        args,
        timeout: typeof timeout === 'number' ? timeout : undefined,
      });

      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.use('/api/websites/:websiteId', router);
}
