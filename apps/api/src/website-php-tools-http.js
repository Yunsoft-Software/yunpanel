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

  const enforceSiteAccess = (req, res, next) => {
    if (req.auth?.user?.role !== 'owner') {
      if (Array.isArray(req.auth?.user?.websiteIds) && !req.auth.user.websiteIds.includes(req.params.websiteId)) {
        return res.status(403).json({ error: {
          code: 'forbidden',
          message: 'Access to this website is not permitted',
        } });
      }
    }
    next();
  };

  const requireOwnerMutation = (req, res, next) => {
    if (req.auth?.user?.role === 'owner' && req.auth?.access?.mode === 'management'
      && req.auth?.security?.managementAllowed === true) return next();
    return res.status(403).json({ error: {
      code: 'php_tool_raw_run_owner_only',
      message: 'Raw PHP tool execution is restricted to the Owner until reviewed durable actions are enabled.',
    } });
  };

  const handleError = (error, res, next) => {
    if (error instanceof WebsitePhpToolsServiceError) {
      return res.status(error.status ?? 400).json({
        error: {
          code: error.code,
          message: error.message,
        },
      });
    }
    return next(error);
  };

  const handleActionPreview = async (req, res, next) => {
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
    } catch (error) {
      return handleError(error, res, next);
    }
  };

  router.post('/actions/preview', requirePanelRouteAccess, enforceSiteAccess, handleActionPreview);
  router.post('/php-tools/actions/preview', requirePanelRouteAccess, enforceSiteAccess, handleActionPreview);

  if (websitePhpToolActionService) {
    const handleActionQueue = async (req, res, next) => {
      try {
        const actor = {
          sessionId: req.auth?.id,
          userId: req.auth?.user?.id,
          role: req.auth?.user?.role,
        };
        const result = await websitePhpToolActionService.queue(req.params.websiteId, req.body, actor);
        return res.status(202).json({ data: result });
      } catch (error) {
        return handleError(error, res, next);
      }
    };

    router.post('/actions/queue', requirePanelRouteAccess, enforceSiteAccess, handleActionQueue);
    router.post('/php-tools/actions/queue', requirePanelRouteAccess, enforceSiteAccess, handleActionQueue);
  }

  const handleWpCliStatus = async (req, res, next) => {
    try {
      const status = await websitePhpToolsService.getWpCliStatus(req.params.websiteId);
      // Preserve legacy top-level fields while supporting the panel JSON client.
      res.json({ ...status, data: status });
    } catch (error) {
      return handleError(error, res, next);
    }
  };

  router.get('/wp-cli/status', requirePanelRouteAccess, enforceSiteAccess, handleWpCliStatus);
  router.get('/php-tools/wp-cli/status', requirePanelRouteAccess, enforceSiteAccess, handleWpCliStatus);

  const handleWpCliRun = async (req, res, next) => {
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
      return handleError(error, res, next);
    }
  };

  router.post('/wp-cli/run', requirePanelRouteAccess, requireOwnerMutation, enforceSiteAccess, handleWpCliRun);
  router.post('/php-tools/wp-cli/run', requirePanelRouteAccess, requireOwnerMutation, enforceSiteAccess, handleWpCliRun);

  const handleComposerStatus = async (req, res, next) => {
    try {
      const status = await websitePhpToolsService.getComposerStatus(req.params.websiteId);
      // Preserve legacy top-level fields while supporting the panel JSON client.
      res.json({ ...status, data: status });
    } catch (error) {
      return handleError(error, res, next);
    }
  };

  router.get('/composer/status', requirePanelRouteAccess, enforceSiteAccess, handleComposerStatus);
  router.get('/php-tools/composer/status', requirePanelRouteAccess, enforceSiteAccess, handleComposerStatus);

  const handleComposerRun = async (req, res, next) => {
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
      return handleError(error, res, next);
    }
  };

  router.post('/composer/run', requirePanelRouteAccess, requireOwnerMutation, enforceSiteAccess, handleComposerRun);
  router.post('/php-tools/composer/run', requirePanelRouteAccess, requireOwnerMutation, enforceSiteAccess, handleComposerRun);

  const handlePhpStatus = async (req, res, next) => {
    try {
      const status = typeof websitePhpToolsService.getPhpStatus === 'function'
        ? await websitePhpToolsService.getPhpStatus(req.params.websiteId)
        : {
          wpCli: await websitePhpToolsService.getWpCliStatus(req.params.websiteId),
          composer: await websitePhpToolsService.getComposerStatus(req.params.websiteId),
        };
      return res.json({ status, data: status });
    } catch (error) {
      return handleError(error, res, next);
    }
  };

  router.get('/status', requirePanelRouteAccess, enforceSiteAccess, handlePhpStatus);
  router.get('/php-tools/status', requirePanelRouteAccess, enforceSiteAccess, handlePhpStatus);

  const handlePhpConfig = async (req, res, next) => {
    try {
      const config = await websitePhpToolsService.getPhpFpmConfig(req.params.websiteId);
      return res.json({ config, data: config });
    } catch (error) {
      return handleError(error, res, next);
    }
  };

  router.get('/config', requirePanelRouteAccess, enforceSiteAccess, handlePhpConfig);
  router.get('/php-tools/config', requirePanelRouteAccess, enforceSiteAccess, handlePhpConfig);

  const handlePhpConfigPreview = async (req, res, next) => {
    try {
      const preview = await websitePhpToolsService.previewPhpFpmConfig(req.params.websiteId, req.body ?? {});
      return res.json({ data: preview });
    } catch (error) {
      return handleError(error, res, next);
    }
  };

  router.post('/config/preview', requirePanelRouteAccess, enforceSiteAccess, handlePhpConfigPreview);
  router.post('/php-tools/config/preview', requirePanelRouteAccess, enforceSiteAccess, handlePhpConfigPreview);

  const handlePhpConfigUpdate = async (req, res, next) => {
    try {
      const result = await websitePhpToolsService.updatePhpFpmConfig(req.params.websiteId, req.body ?? {});
      return res.json({ data: result });
    } catch (error) {
      return handleError(error, res, next);
    }
  };

  router.post('/config', requirePanelRouteAccess, enforceSiteAccess, handlePhpConfigUpdate);
  router.post('/php-tools/config', requirePanelRouteAccess, enforceSiteAccess, handlePhpConfigUpdate);

  app.use('/api/websites/:websiteId', router);
}
