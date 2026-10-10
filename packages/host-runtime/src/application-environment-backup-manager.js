import { constants } from 'node:fs';
import { chmod, lstat, open, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { assertUuid } from '@yunpanel/shared';
import { nodeServiceName, pythonServiceName, renderNodeEnvironmentFile, renderPythonEnvironmentFile } from '@yunpanel/config-templates';
import { passengerEnvironmentManagerInternals } from './passenger-environment-manager.js';
import { websitePassengerEnvironmentInternals } from './website-passenger-environment-manager.js';

const execute = promisify(execFile);
const fail = code => Object.assign(new Error('Uygulamanın çalışan ortam değişkenleri doğrulanamadı'), { code });
const equal = (left, right) => JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort());

// Private contents are returned only to the encrypted Website backup adapter.
// This manager never runs site code as root or selects a path from an archive.
export function createApplicationEnvironmentBackupManager({
  applicationRoot = '/var/lib/yunpanel/apps', environmentRoot = '/etc/yunpanel/apps',
  passengerRoot = '/etc/yunpanel/passenger-env', ownerUid = 0, ownerGid = 0,
  run = (file, args) => execute(file, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024,
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', HOME: '/root' } }),
} = {}) {
  function context(application) {
    const id = assertUuid(application?.id, 'applicationId');
    if (!['node', 'python'].includes(application.type)) throw fail('application_environment_runtime_unsupported');
    const passenger = application.type === 'node' && application.runtimeAdapter === 'passenger';
    const runtime = application.activeRuntime ?? application.runtime;
    if (!runtime || !application.currentReleaseId) throw fail('application_environment_runtime_unavailable');
    return { id, passenger, runtime, root: passenger ? passengerRoot : environmentRoot,
      target: path.join(passenger ? passengerRoot : environmentRoot, `${id}.${passenger ? 'conf' : 'env'}`) };
  }
  async function managedParent(root) {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== ownerUid || info.gid !== ownerGid
      || (info.mode & 0o022) || await realpath(root) !== root) throw fail('application_environment_parent_unsafe');
  }
  async function fileState(c) {
    await managedParent(c.root);
    let handle;
    try {
      handle = await open(c.target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.uid !== ownerUid || info.gid !== ownerGid || (info.mode & 0o777) !== 0o600 || info.size > 1024 * 1024) throw fail('application_environment_file_unsafe');
      return await handle.readFile('utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (String(error?.code).startsWith('application_environment_')) throw error;
      throw fail('application_environment_file_unavailable');
    } finally { await handle?.close(); }
  }
  async function release(c, application) {
    const expected = `releases/${assertUuid(application.currentReleaseId, 'releaseId')}`;
    const current = path.join(applicationRoot, c.id, 'current');
    if (await readlink(current) !== expected || await realpath(current) !== path.join(applicationRoot, c.id, expected)) throw fail('application_environment_release_drift');
  }
  function decoded(c, application, content) {
    if (typeof content !== 'string' || content.includes('\0') || content.length > 1024 * 1024) throw fail('application_environment_snapshot_invalid');
    if (!c.passenger) {
      const parsed = passengerEnvironmentManagerInternals.parseManagedEnvironment(content);
      const custom = { ...parsed };
      if (application.type === 'node') for (const key of ['NODE_ENV', 'HOST', 'PORT', 'YUNPANEL_APPLICATION_ID']) delete custom[key];
      else for (const key of ['PYTHONUNBUFFERED', 'PORT', 'YUNPANEL_APPLICATION_ID']) delete custom[key];
      const render = application.type === 'node' ? renderNodeEnvironmentFile : renderPythonEnvironmentFile;
      if (render({ applicationId: c.id, runtime: c.runtime, environment: custom }) !== content) throw fail('application_environment_snapshot_invalid');
      return custom;
    }
    const values = {};
    const lines = content.split('\n');
    let revision = null;
    if (lines[0].startsWith('#')) {
      const match = lines.shift().match(/^# YunPanel Passenger environment ([a-f0-9-]{36}) revision (\d+)$/);
      if (!match || match[1] !== c.id || !Number.isSafeInteger(Number(match[2]))) throw fail('application_environment_snapshot_invalid');
      revision = Number(match[2]);
    }
    if (lines.pop() !== '') throw fail('application_environment_snapshot_invalid');
    for (const line of lines) {
      const match = line.match(/^passenger_env_var ([A-Z_][A-Z0-9_]{0,127}) "((?:[^"\\]|\\["\\$])*)";$/);
      if (!match || Object.hasOwn(values, match[1])) throw fail('application_environment_snapshot_invalid');
      values[match[1]] = match[2].replace(/\\(["\\$])/g, '$1');
    }
    if (revision !== null) {
      const normalized = websitePassengerEnvironmentInternals.normalizeSpec({ applicationId: c.id, environmentRevision: revision, values });
      if (normalized.content !== content) throw fail('application_environment_snapshot_invalid');
    } else {
      if (values.YUNPANEL_APPLICATION_ID !== c.id || values.HOST !== '127.0.0.1'
        || values.PORT !== String(c.runtime.port) || passengerEnvironmentManagerInternals.renderPassengerEnvironmentInclude(values) !== content) throw fail('application_environment_snapshot_invalid');
      for (const key of ['HOST', 'PORT', 'YUNPANEL_APPLICATION_ID']) delete values[key];
      websitePassengerEnvironmentInternals.normalizedValues(values);
    }
    return values;
  }
  async function command(file, args) {
    try { return await run(file, args); }
    catch { throw fail('application_environment_restart_failed'); }
  }
  async function restart(c, application) {
    if (c.passenger) {
      await command('/usr/sbin/nginx', ['-t']);
      await command('/usr/bin/systemctl', ['reload', 'nginx']);
      // Passenger uses a prefix: the trailing slash confines it to this UUID.
      await command('/usr/bin/passenger-config', ['restart-app', path.join(applicationRoot, c.id) + '/', '--ignore-app-not-running']);
    } else {
      const service = application.type === 'python' ? pythonServiceName(c.id) : nodeServiceName(c.id);
      await command('/usr/bin/systemctl', ['restart', service]);
      const result = await command('/usr/bin/systemctl', ['show', service, '--property=LoadState,ActiveState,MainPID', '--no-pager']);
      const properties = Object.fromEntries(String(result.stdout).trim().split('\n').map(line => line.split('=')));
      if (properties.LoadState !== 'loaded' || properties.ActiveState !== 'active' || !/^[1-9]\d*$/.test(properties.MainPID ?? '')) throw fail('application_environment_restart_unverified');
    }
  }
  async function replace(c, content) {
    await managedParent(c.root);
    const temporary = c.target + `.${process.pid}.restore.tmp`;
    try {
      await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, c.target);
    } finally { await rm(temporary, { force: true }); }
  }
  async function captureEnvironment({ application }) {
    const c = context(application);
    await release(c, application);
    const content = await fileState(c);
    decoded(c, application, content);
    return { version: 1, applicationId: c.id, type: application.type, runtimeAdapter: application.runtimeAdapter ?? null,
      runtime: structuredClone(c.runtime), releaseId: application.currentReleaseId, content };
  }
  async function assertRestoreSupported({ application, savedRuntime }) {
    const c = context(application);
    if (!savedRuntime || savedRuntime.version !== 1 || savedRuntime.applicationId !== c.id
      || savedRuntime.type !== application.type || savedRuntime.runtimeAdapter !== (application.runtimeAdapter ?? null)
      || JSON.stringify(savedRuntime.runtime) !== JSON.stringify(c.runtime)) throw fail('application_environment_runtime_drift');
    decoded(c, application, savedRuntime.content);
    await release(c, application);
    await fileState(c);
  }
  async function restoreEnvironment({ application, values, savedRuntime, environmentRevision, verifyHealth }) {
    await assertRestoreSupported({ application, savedRuntime });
    if (typeof verifyHealth !== 'function') throw fail('application_environment_health_unavailable');
    const c = context(application), before = await fileState(c);
    try {
      await replace(c, savedRuntime.content);
      await restart(c, application);
      if (await fileState(c) !== savedRuntime.content || await verifyHealth() !== true) throw fail('application_environment_restore_unverified');
    } catch (error) {
      try {
        if (before === null) await rm(c.target, { force: true });
        else await replace(c, before);
        await restart(c, application);
        if (await fileState(c) !== before || await verifyHealth() !== true) throw fail('application_environment_rollback_unverified');
      } catch { throw fail('application_environment_rollback_failed'); }
      throw error;
    }
    return { applicationId: c.id, environmentRevision, verified: true,
      appliedMatchesSaved: equal(decoded(c, application, savedRuntime.content), values) };
  }
  return Object.freeze({ captureEnvironment, restoreEnvironment, assertRestoreSupported });
}
