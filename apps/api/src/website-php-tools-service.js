import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { createPhpCliToolManager, PhpCliToolError } from '@yunpanel/host-runtime';
import { websitePhpToolActionPreview } from './website-php-tool-action.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USER = /^yunapp-[a-f0-9]{12}$/;
const version = (value) => typeof value === 'string' && /^[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:[-+.][0-9A-Za-z._-]+)?$/.test(value.trim()) && value.length <= 80 ? value.trim() : null;
const succeeded = (value) => value?.success === true && value.exitCode === 0;
const printable = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value);

export class WebsitePhpToolsServiceError extends Error {
  constructor(code, message, status = 400) {
    super(message); this.name = 'WebsitePhpToolsServiceError'; this.code = code; this.status = status;
  }
}
function contextConflict() {
  return new WebsitePhpToolsServiceError('website_php_context_changed', 'PHP Website binding could not be verified', 409);
}
function inventory(result) {
  if (!succeeded(result) || typeof result.stdout !== 'string' || result.stdout.length > 2 * 1024 * 1024) return null;
  try {
    const values = JSON.parse(result.stdout);
    if (!Array.isArray(values) || values.length > 2000) return null;
    const seen = new Set();
    return Object.freeze(values.map((item) => {
      if (!item || !printable(item.name) || !printable(item.status) || seen.has(item.name)) throw new Error('Invalid inventory');
      seen.add(item.name);
      const safe = { name: item.name, status: item.status };
      // Never expose arbitrary CLI properties, paths, stdout or stderr.
      for (const key of ['version', 'update', 'update_version']) {
        if (item[key] !== undefined) {
          if (item[key] !== '' && !printable(item[key])) throw new Error('Invalid inventory field');
          safe[key] = item[key];
        }
      }
      return Object.freeze(safe);
    }));
  } catch { return null; }
}

export function createWebsitePhpToolsService({
  websiteRegistry, applicationRegistry, phpCliToolManager = createPhpCliToolManager(), lstatFn = lstat,
} = {}) {
  if (typeof websiteRegistry?.getWebsite !== 'function' || typeof applicationRegistry?.getApplication !== 'function') {
    throw new TypeError('Website PHP tools service dependencies are invalid');
  }
  async function resolveWebsitePhpContext(websiteId) {
    if (typeof websiteId !== 'string' || !UUID.test(websiteId)) {
      throw new WebsitePhpToolsServiceError('website_id_invalid', 'Website ID is invalid', 400);
    }
    const website = await websiteRegistry.getWebsite(websiteId);
    if (!website) throw new WebsitePhpToolsServiceError('website_not_found', 'Website not found', 404);
    if (website.id !== websiteId || !UUID.test(website.applicationId ?? '')) throw contextConflict();
    const application = await applicationRegistry.getApplication(website.applicationId);
    if (!application) throw new WebsitePhpToolsServiceError('application_not_found', 'Application not found', 404);
    if (website.runtimeType !== 'php' || application.type !== 'php') {
      throw new WebsitePhpToolsServiceError('website_runtime_not_php', 'WP-CLI and Composer require a PHP Website runtime', 409);
    }
    if (!website.unixUser) throw new WebsitePhpToolsServiceError('website_unix_user_missing', 'Website Unix user is missing', 409);
    if (application.id !== website.applicationId || !UUID.test(website.serverId ?? '')
      || application.serverId !== website.serverId || !USER.test(website.unixUser)
      || (application.unixUser != null && application.unixUser !== website.unixUser)) throw contextConflict();
    const currentPath = `/var/lib/yunpanel/apps/${application.id}/current`;
    const publicPath = path.posix.join(currentPath, 'public');
    let cwd = currentPath;
    try { if ((await lstatFn(publicPath)).isDirectory()) cwd = publicPath; }
    catch (error) {
      if (error.code !== 'ENOENT') throw new WebsitePhpToolsServiceError('website_php_path_unavailable', 'PHP working directory could not be inspected', 503);
    }
    // Copy registry projections: a shared mutable object is not a stable snapshot.
    return { website: { ...website }, application: { ...application }, unixUser: website.unixUser, cwd, currentPath, publicPath };
  }
  function binding(context) {
    return { websiteId: context.website.id, serverId: context.website.serverId,
      applicationId: context.application.id, unixUser: context.unixUser };
  }
  async function revalidate(context) {
    const latest = await resolveWebsitePhpContext(context.website.id);
    const before = binding(context), after = binding(latest);
    if (Object.keys(before).some((key) => before[key] !== after[key]) || context.cwd !== latest.cwd
      || context.website.revision !== latest.website.revision) throw contextConflict();
    return latest;
  }
  async function inspectTool(method) {
    try {
      const result = await phpCliToolManager[method]();
      return { available: typeof result?.available === 'boolean' ? result.available : null, version: version(result?.version) };
    } catch { return { available: null, version: null }; }
  }
  async function inspectCommand(context, method, options) {
    await revalidate(context);
    let result;
    try { result = await phpCliToolManager[method]({ unixUser: context.unixUser, cwd: context.cwd, ...options }); }
    catch { result = null; }
    await revalidate(context);
    return result;
  }
  async function getWpCliStatus(websiteId) {
    const context = await resolveWebsitePhpContext(websiteId);
    const tool = await inspectTool('inspectWpCli');
    const checks = { installation: 'not_checked', coreVersion: 'not_checked', plugins: 'not_checked', themes: 'not_checked' };
    let installed = null, coreVersion = null, plugins = [], themes = [];
    if (tool.available === true) {
      const check = await inspectCommand(context, 'runWpCli', { command: 'core', args: ['is-installed'], timeout: 10_000 });
      installed = succeeded(check) ? true : null;
      // The manager maps timeouts and nonzero exits to the same failure shape.
      // Such a failure cannot prove that WordPress is absent.
      checks.installation = installed ? 'ready' : 'unknown';
      if (installed) {
        const core = await inspectCommand(context, 'runWpCli', { command: 'core', args: ['version'], timeout: 10_000 });
        coreVersion = succeeded(core) ? version(core.stdout) : null;
        checks.coreVersion = coreVersion ? 'ready' : 'unknown';
        for (const [command, key] of [['plugin', 'plugins'], ['theme', 'themes']]) {
          const values = inventory(await inspectCommand(context, 'runWpCli', { command, args: ['list', '--format=json'], timeout: 15_000 }));
          checks[key] = values === null ? 'unknown' : 'ready';
          if (key === 'plugins') plugins = values ?? []; else themes = values ?? [];
        }
      }
    }
    await revalidate(context);
    return Object.freeze({ schemaVersion: 1, ...binding(context), ...tool, installed, coreVersion,
      plugins, themes, checks: Object.freeze(checks), inspectedAt: new Date().toISOString() });
  }
  async function probeFile(file) {
    try { return (await lstatFn(file)).isFile() === true ? 'present' : 'unknown'; }
    catch (error) { return error.code === 'ENOENT' ? 'absent' : 'unknown'; }
  }
  async function composerProject(context) {
    for (const cwd of [context.currentPath, context.publicPath]) {
      const state = await probeFile(path.posix.join(cwd, 'composer.json'));
      if (state !== 'absent') return { cwd, state };
    }
    return { cwd: context.currentPath, state: 'absent' };
  }
  async function getComposerStatus(websiteId) {
    const context = await resolveWebsitePhpContext(websiteId);
    const tool = await inspectTool('inspectComposer');
    const project = await composerProject(context);
    const lock = project.state === 'present' ? await probeFile(path.posix.join(project.cwd, 'composer.lock')) : 'not_checked';
    let valid = null, validation = 'not_checked';
    if (tool.available === true && project.state === 'present') {
      const result = await inspectCommand(context, 'runComposer', { cwd: project.cwd, command: 'validate',
        args: ['--no-check-all', '--no-check-publish'], timeout: 15_000 });
      valid = succeeded(result) ? true : null;
      validation = valid ? 'ready' : 'unknown';
    }
    await revalidate(context);
    const latest = await composerProject(context);
    if (latest.state !== project.state || latest.cwd !== project.cwd) throw contextConflict();
    return Object.freeze({ schemaVersion: 1, ...binding(context), ...tool,
      hasComposerJson: project.state === 'unknown' ? null : project.state === 'present',
      hasComposerLock: ['unknown', 'not_checked'].includes(lock) ? null : lock === 'present', valid,
      projectLocation: project.state === 'present' ? (project.cwd === context.currentPath ? 'root' : 'public') : null,
      checks: Object.freeze({ project: project.state, lock, validation }), inspectedAt: new Date().toISOString() });
  }
  async function getActionPreview(websiteId, actionId) {
    const context = await resolveWebsitePhpContext(websiteId);
    if (!Number.isSafeInteger(context.website.revision) || context.website.revision < 1) throw contextConflict();
    const preview = websitePhpToolActionPreview({
      ...binding(context),
      websiteRevision: context.website.revision,
    }, actionId);
    await revalidate(context);
    return preview;
  }
  async function runTool(context, method, options) {
    await revalidate(context);
    try {
      const result = await phpCliToolManager[method]({ unixUser: context.unixUser, cwd: context.cwd, ...options });
      await revalidate(context);
      return result;
    } catch (error) {
      if (error instanceof PhpCliToolError) throw new WebsitePhpToolsServiceError(error.code, error.message, error.status);
      throw error;
    }
  }
  async function runWpCli(websiteId, { command, args = [], timeout = 60_000 } = {}) {
    const context = await resolveWebsitePhpContext(websiteId);
    return runTool(context, 'runWpCli', { command, args, timeout });
  }
  async function runComposer(websiteId, { command, args = [], timeout = 120_000 } = {}) {
    const context = await resolveWebsitePhpContext(websiteId);
    const project = await composerProject(context);
    if (project.state === 'unknown') throw new WebsitePhpToolsServiceError('composer_project_unknown', 'Composer project could not be inspected', 503);
    // Status and execution must address the same project when root and public both exist.
    return runTool(context, 'runComposer', { cwd: project.cwd, command, args, timeout });
  }
  return Object.freeze({ resolveWebsitePhpContext, getWpCliStatus, getComposerStatus, getActionPreview, runWpCli, runComposer });
}
