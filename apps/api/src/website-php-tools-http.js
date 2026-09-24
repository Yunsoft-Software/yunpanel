import express from 'express';
import { requirePanelRouteAccess } from './panel-http-guard.js';
import { WebsitePhpToolsServiceError } from './website-php-tools-service.js';

export function mountWebsitePhpToolsRoutes(app, {
  websitePhpToolsService,
  websitePhpToolActionService = null,
} = {}) {
  if (!app || typeof app.use !== 'function'
    || !websitePhpToolsService) {
    throw new TypeError('Website PHP tools HTTP dependencies are invalid');
  }

  const router = express.Router({ mergeParams: true });
  const requireOwnerMutation = (req, res, next) => {
    if (req.auth?.user?.role === 'owner' && req.auth?.access?.mode === 'management'
      && req.auth?.security?.managementAllowed === true) return next();
    return res.status(403).json({ error: {
      code: 'php_tool_raw_run_owner_only',
      message: 'Raw PHP tool execution is restricted to the Owner until reviewed durable actions are enabled.',
    } });
  };

  router.post('/actions/preview', requirePanelRouteAccess, async (req, res, next) => {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).length !== 1 || typeof body.actionId !== 'string') {
        return res.status(400).json({ error: {
          code: 'php_tool_action_preview_input_invalid',
          message: 'actionId is required to preview a PHP tool action',
        } });
      }
      const preview = await websitePhpToolsService.getActionPreview(req.params.websiteId, body.actionId);
      return res.json({ data: preview });
    } catch (error) { return next(error); }
  });

  if (websitePhpToolActionService) {
    router.post('/actions/queue', requirePanelRouteAccess, async (req, res, next) => {
      try {
        const actor = {
          sessionId: req.auth?.id,
          userId: req.auth?.user?.id,
          role: req.auth?.user?.role,
        };
        const result = await websitePhpToolActionService.queue(req.params.websiteId, req.body, actor);
        return res.status(202).json({ data: result });
      } catch (error) { return next(error); }
    });
  }

  router.get('/wp-cli/status', requirePanelRouteAccess, async (req, res, next) => {
    try {
      const status = await websitePhpToolsService.getWpCliStatus(req.params.websiteId);
      // Preserve legacy top-level fields while supporting the panel JSON client.
      res.json({ ...status, data: status });
    } catch (error) {
      next(error);
    }
  });

  router.post('/wp-cli/run', requirePanelRouteAccess, requireOwnerMutation, async (req, res, next) => {
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

  router.post('/composer/run', requirePanelRouteAccess, requireOwnerMutation, async (req, res, next) => {
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
