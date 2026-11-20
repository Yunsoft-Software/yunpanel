import { requirePanelRouteAccess } from './panel-http-guard.js';
import { PleskImporterError } from './plesk-importer.js';

export function isPleskImporterHttpError(error) {
  return error instanceof PleskImporterError;
}

export function mountPleskImporterRoutes(app, { pleskImporter } = {}) {
  if (!app || typeof app.post !== 'function') {
    throw new Error('Express application is required');
  }
  if (!pleskImporter || typeof pleskImporter.importFromOfflineExport !== 'function') {
    throw new Error('Plesk importer is required');
  }

  app.post('/api/importer/plesk/preview', requirePanelRouteAccess, async (request, response, next) => {
    if (request.auth.user.role !== 'owner') {
      return response.status(403).json({
        error: { code: 'forbidden', message: 'Only the owner can preview a Plesk import.' },
      });
    }
    try {
      const exportData = request.body?.exportData ?? request.body;
      const preview = pleskImporter.importFromOfflineExport(exportData);
      return response.json({ preview });
    } catch (err) {
      return next(err);
    }
  });
}
