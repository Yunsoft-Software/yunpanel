import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createWebsiteResourceBackupCodec } from './website-resource-backup-codec.js';
import { createWebsiteHttpHealthInspector } from '@yunpanel/host-runtime/website-http-health-inspector';

const within = (value, root) => value === root || value.startsWith(root + '/');
const fail = code => Object.assign(new Error('Site ortam değişkenlerinin yedeği doğrulanamadı'), { code, status: 409 });
export function createWebsiteEnvironmentBackupAdapter({ applicationRegistry, applicationEnvironmentRegistry,
  domainRegistry = null, healthInspector = createWebsiteHttpHealthInspector(),
  codec = createWebsiteResourceBackupCodec(), runtimeManager = null,
} = {}) {
  async function scope(backupSet) {
    const website = backupSet.website;
    const application = website?.applicationId ? await applicationRegistry.getApplication(website.applicationId) : null;
    const target = path.posix.join(backupSet.stagedRoot, 'env-metadata.json');
    if (!application || application.id !== website.applicationId || application.serverId !== website.serverId
      || backupSet.env?.stagedMetadataPath !== target || !codec.configured) throw fail('website_environment_backup_scope_invalid');
    return { application, target, identity: { websiteId: website.id, resourceId: application.id, kind: 'environment' } };
  }
  function selected(backupSet, include) {
    const target = backupSet.env?.stagedMetadataPath;
    return Boolean(target && include.some(root => within(target, root)));
  }
  async function assertSupported(backupSet, include) {
    if (!selected(backupSet, include)) return;
    const context = await scope(backupSet);
    if (['node', 'python'].includes(context.application.type) && typeof runtimeManager?.restoreEnvironment !== 'function') {
      throw fail('website_environment_runtime_restore_unavailable');
    }
  }
  async function capture(backupSet) {
    const context = await scope(backupSet);
    if (['node', 'python'].includes(context.application.type) && typeof runtimeManager?.captureEnvironment !== 'function') {
      throw fail('website_environment_runtime_backup_unavailable');
    }
    const saved = await applicationEnvironmentRegistry.exportApplicationBackup(context.application.id);
    const runtime = ['node', 'python'].includes(context.application.type) && typeof runtimeManager?.captureEnvironment === 'function'
      ? await runtimeManager.captureEnvironment({ website: backupSet.website, application: context.application }) : null;
    await mkdir(path.dirname(context.target), { recursive: true, mode: 0o700 });
    const temporary = context.target + '.tmp';
    await writeFile(temporary, codec.encode(context.identity, { version: 1, catalog: saved, runtime }), { mode: 0o600 });
    await chmod(temporary, 0o600); await rename(temporary, context.target);
    return { applicationId: context.application.id, captured: true };
  }
  async function restore({ backupSet, include, operationId, rollback = false }) {
    if (!selected(backupSet, include)) return [];
    await assertSupported(backupSet, include);
    const context = await scope(backupSet), metadata = await lstat(context.target);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid() || (metadata.mode & 0o077)) throw fail('website_environment_backup_file_unsafe');
    const saved = codec.decode(context.identity, await readFile(context.target, 'utf8'));
    if (saved.version !== 1 || saved.catalog?.applicationId !== context.application.id) throw fail('website_environment_backup_scope_invalid');
    if (!['node', 'python'].includes(context.application.type)
      && saved.catalog.variables.some(record => !['YUNPANEL_GIT_CREDENTIAL', 'YUNPANEL_GITHUB_WEBHOOK_SECRET'].includes(record.key))) throw fail('website_environment_runtime_restore_unavailable');
    let verifyHealth = null;
    if (['node', 'python'].includes(context.application.type)) {
      if (typeof runtimeManager.assertRestoreSupported === 'function') {
        await runtimeManager.assertRestoreSupported({ application: context.application, savedRuntime: saved.runtime });
      }
      const domains = await domainRegistry?.listDomains();
      const bound = domains?.filter(domain => domain.websiteId === backupSet.website.id && domain.serverId === context.application.serverId && domain.type !== 'alias') ?? [];
      const primary = bound.find(domain => domain.primaryDomain === backupSet.website.name) ?? (bound.length === 1 ? bound[0] : null);
      if (!primary || typeof healthInspector?.inspect !== 'function') throw fail('website_environment_health_scope_unavailable');
      verifyHealth = async () => (await healthInspector.inspect({ primaryDomain: primary.primaryDomain,
        healthPath: (context.application.activeRuntime ?? context.application.runtime)?.healthPath ?? '/', timeoutSeconds: 30 })).satisfied === true;
    }
    const status = await applicationEnvironmentRegistry.restoreApplicationBackup(context.application.id, saved.catalog);
    if (['node', 'python'].includes(context.application.type)) {
      const values = await applicationEnvironmentRegistry.materialize(context.application.id, { expectedRevision: status.savedRevision });
      const result = await runtimeManager.restoreEnvironment({ website: backupSet.website, application: context.application,
        values, environmentRevision: status.savedRevision, savedRuntime: saved.runtime, operationId, rollback, verifyHealth });
      if (result?.verified !== true || result.applicationId !== context.application.id || result.environmentRevision !== status.savedRevision) throw fail('website_environment_runtime_restore_unverified');
      if (result.appliedMatchesSaved === true && context.application.currentReleaseId) await applicationEnvironmentRegistry.markApplied({ applicationId: context.application.id,
        revision: status.savedRevision, releaseId: context.application.currentReleaseId });
    }
    return [{ applicationId: context.application.id, restored: true, savedRevision: status.savedRevision }];
  }
  return Object.freeze({ capture, restore, selected, assertSupported });
}
