import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { createPhpCliToolManager, PhpCliToolError } from '@yunpanel/host-runtime';

export class WebsitePhpToolsServiceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsitePhpToolsServiceError';
    this.code = code;
    this.status = status;
  }
}

export function createWebsitePhpToolsService({
  websiteRegistry,
  applicationRegistry,
  phpCliToolManager = createPhpCliToolManager(),
  lstatFn = lstat,
} = {}) {
  if (!websiteRegistry || typeof websiteRegistry.get !== 'function'
    || !applicationRegistry || typeof applicationRegistry.get !== 'function') {
    throw new TypeError('Website PHP tools service dependencies are invalid');
  }

  async function resolveWebsitePhpContext(websiteId) {
    if (typeof websiteId !== 'string' || !websiteId) {
      throw new WebsitePhpToolsServiceError('website_id_invalid', 'Website ID is invalid', 400);
    }
    const website = await websiteRegistry.get(websiteId);
    if (!website) {
      throw new WebsitePhpToolsServiceError('website_not_found', 'Website not found', 404);
    }

    const application = await applicationRegistry.get(website.applicationId);
    if (!application) {
      throw new WebsitePhpToolsServiceError('application_not_found', 'Application not found', 404);
    }

    const adapter = website.runtime?.adapter ?? application.runtime?.adapter;
    if (adapter !== 'php-fpm') {
      throw new WebsitePhpToolsServiceError(
        'website_runtime_not_php',
        'WP-CLI and Composer require a PHP Website runtime',
        409,
      );
    }

    const unixUser = website.unixUser ?? application.unixUser;
    if (!unixUser) {
      throw new WebsitePhpToolsServiceError('website_unix_user_missing', 'Website Unix user is missing', 409);
    }

    const appRoot = `/var/lib/yunpanel/apps/${application.id}`;
    const currentPath = path.posix.join(appRoot, 'current');
    const publicPath = path.posix.join(currentPath, 'public');

    // Determine cwd: prefer current/public if it exists, otherwise current
    let cwd = currentPath;
    try {
      const publicStat = await lstatFn(publicPath);
      if (publicStat.isDirectory()) {
        cwd = publicPath;
      }
    } catch {
      // fallback to current
    }

    return {
      website,
      application,
      unixUser,
      cwd,
      currentPath,
      publicPath,
    };
  }

  async function getWpCliStatus(websiteId) {
    const context = await resolveWebsitePhpContext(websiteId);
    const toolInfo = await phpCliToolManager.inspectWpCli();

    if (!toolInfo.available) {
      return Object.freeze({
        available: false,
        version: null,
        installed: false,
        coreVersion: null,
        plugins: [],
        themes: [],
      });
    }

    // Check if WordPress is installed in context.cwd
    let installed = false;
    let coreVersion = null;
    let plugins = [];
    let themes = [];

    const isInstalledCheck = await phpCliToolManager.runWpCli({
      unixUser: context.unixUser,
      cwd: context.cwd,
      command: 'core',
      args: ['is-installed'],
      timeout: 10_000,
    });

    if (isInstalledCheck.success) {
      installed = true;

      // Get core version
      const versionResult = await phpCliToolManager.runWpCli({
        unixUser: context.unixUser,
        cwd: context.cwd,
        command: 'core',
        args: ['version'],
        timeout: 10_000,
      });
      if (versionResult.success) {
        coreVersion = versionResult.stdout.trim();
      }

      // Get plugins
      const pluginsResult = await phpCliToolManager.runWpCli({
        unixUser: context.unixUser,
        cwd: context.cwd,
        command: 'plugin',
        args: ['list', '--format=json'],
        timeout: 15_000,
      });
      if (pluginsResult.success) {
        try {
          plugins = JSON.parse(pluginsResult.stdout);
        } catch {}
      }

      // Get themes
      const themesResult = await phpCliToolManager.runWpCli({
        unixUser: context.unixUser,
        cwd: context.cwd,
        command: 'theme',
        args: ['list', '--format=json'],
        timeout: 15_000,
      });
      if (themesResult.success) {
        try {
          themes = JSON.parse(themesResult.stdout);
        } catch {}
      }
    }

    return Object.freeze({
      available: true,
      version: toolInfo.version,
      installed,
      coreVersion,
      plugins,
      themes,
    });
  }

  async function runWpCli(websiteId, { command, args = [], timeout = 60_000 } = {}) {
    const context = await resolveWebsitePhpContext(websiteId);
    try {
      return await phpCliToolManager.runWpCli({
        unixUser: context.unixUser,
        cwd: context.cwd,
        command,
        args,
        timeout,
      });
    } catch (error) {
      if (error instanceof PhpCliToolError) {
        throw new WebsitePhpToolsServiceError(error.code, error.message, error.status);
      }
      throw error;
    }
  }

  async function getComposerStatus(websiteId) {
    const context = await resolveWebsitePhpContext(websiteId);
    const toolInfo = await phpCliToolManager.inspectComposer();

    // Check composer.json in current or public
    let hasComposerJson = false;
    let hasComposerLock = false;
    let composerCwd = context.currentPath;

    for (const testPath of [context.currentPath, context.publicPath]) {
      try {
        const jsonStat = await lstatFn(path.posix.join(testPath, 'composer.json'));
        if (jsonStat.isFile()) {
          hasComposerJson = true;
          composerCwd = testPath;
          try {
            const lockStat = await lstatFn(path.posix.join(testPath, 'composer.lock'));
            if (lockStat.isFile()) hasComposerLock = true;
          } catch {}
          break;
        }
      } catch {}
    }

    let valid = null;
    if (toolInfo.available && hasComposerJson) {
      const validateResult = await phpCliToolManager.runComposer({
        unixUser: context.unixUser,
        cwd: composerCwd,
        command: 'validate',
        args: ['--no-check-all', '--no-check-publish'],
        timeout: 15_000,
      });
      valid = validateResult.success;
    }

    return Object.freeze({
      available: toolInfo.available,
      version: toolInfo.version,
      hasComposerJson,
      hasComposerLock,
      valid,
    });
  }

  async function runComposer(websiteId, { command, args = [], timeout = 120_000 } = {}) {
    const context = await resolveWebsitePhpContext(websiteId);

    // Determine composer working directory
    let composerCwd = context.currentPath;
    try {
      const publicJson = await lstatFn(path.posix.join(context.publicPath, 'composer.json'));
      if (publicJson.isFile()) composerCwd = context.publicPath;
    } catch {}

    try {
      return await phpCliToolManager.runComposer({
        unixUser: context.unixUser,
        cwd: composerCwd,
        command,
        args,
        timeout,
      });
    } catch (error) {
      if (error instanceof PhpCliToolError) {
        throw new WebsitePhpToolsServiceError(error.code, error.message, error.status);
      }
      throw error;
    }
  }

  return Object.freeze({
    resolveWebsitePhpContext,
    getWpCliStatus,
    runWpCli,
    getComposerStatus,
    runComposer,
  });
}
