// PowerDNS authoritative manager: one factory that provisions the local PowerDNS host,
// journals every apply/rollback, keeps an exact rollback snapshot and requires healthy
// DNS sockets before a mutation is reported as done.
//
// Sections, bottom-up:
//   1. files     – private reads and same-directory atomic replacement
//   2. host      – packages, SQLite, managed drop-in, service, API, receipt
//   3. rollback  – managed path guard, rollback snapshot, compensation, restore
//   4. journal   – operation record, serialized mutations, explicit recovery
//   5. readiness – UDP/TCP/recursion evidence on every public result
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, chown, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { promisify } from 'node:util';
import { powerDnsTemplatePolicy, renderManagedPowerDnsConfig } from '@yunpanel/config-templates/powerdns';
import { createPowerDnsSocketHealthInspector } from './powerdns-socket-health-inspector.js';
import {
  apiKeyHashFromConfig,
  assertRestoredState,
  buildReceipt,
  buildRollbackCompensation,
  buildRollbackSnapshot,
  configMatchesSpec,
  decodeSnapshotFile,
  evidenceFromInspection,
  fileIdentity,
  includeDirConfigured,
  JOURNAL_VERSION,
  normalizeIntent,
  OPERATION_ID_PATTERN,
  operationMatches,
  packageStatus,
  persistedOperation,
  persistedRollbackCompensation,
  persistedRollbackSnapshot,
  PowerDnsAuthoritativeManagerError,
  publicOperation,
  publicRollbackSnapshot,
  receiptValue,
  ROLLBACK_CAPABLE_STATUSES,
  safeFailure,
  sameFileSnapshot,
  SNAPSHOT_DIGEST_PATTERN,
} from './powerdns-authoritative-records.js';

export { PowerDnsAuthoritativeManagerError };

const execFileAsync = promisify(execFile);
const DPKG_QUERY = '/usr/bin/dpkg-query';
const APT_GET = '/usr/bin/apt-get';
const SYSTEMCTL = '/usr/bin/systemctl';
const SS = '/usr/bin/ss';
const PDNS_SERVER = '/usr/sbin/pdns_server';
const PDNSUTIL = '/usr/bin/pdnsutil';
const SQLITE3 = '/usr/bin/sqlite3';
const INSTALL = '/usr/bin/install';
const CHOWN = '/usr/bin/chown';
const STAT = '/usr/bin/stat';
const BASE_CONFIG = '/etc/powerdns/pdns.conf';
const STATE_DIRECTORY = '/var/lib/yunpanel/staging/powerdns';
const RECEIPT_PATH = `${STATE_DIRECTORY}/authoritative.json`;
const OPERATION_PATH = `${STATE_DIRECTORY}/authoritative-operation.json`;
const ROLLBACK_SNAPSHOT_PATH = `${STATE_DIRECTORY}/authoritative-rollback.json`;
const ROLLBACK_COMPENSATION_PATH = `${STATE_DIRECTORY}/authoritative-rollback-compensation.json`;
const SCHEMA_PATHS = Object.freeze([
  '/usr/share/pdns-backend-sqlite3/schema/schema.sqlite3.sql',
  '/usr/share/doc/pdns-backend-sqlite3/schema.sqlite3.sql',
  '/usr/share/doc/pdns-backend-sqlite3/schema.sqlite3.sql.gz',
]);
const ADAPTER = 'powerdns-authoritative-gsqlite3';
// A failure with one of these codes happened before any host mutation or was rolled back,
// so the journal closes as failed instead of blocking replay.
const DETERMINISTIC_FAILURE_CODES = new Set([
  'powerdns_recursor_conflict',
  'powerdns_include_dir_required',
  'powerdns_schema_missing',
  'powerdns_hash_failed',
  'powerdns_hash_invalid',
  'powerdns_config_invalid',
  'powerdns_rollback_snapshot_failed',
  'powerdns_rollback_credential_mismatch',
  'powerdns_rollback_snapshot_unsafe',
  'powerdns_rollback_snapshot_invalid',
  'powerdns_rollback_snapshot_unavailable',
  'powerdns_rollback_snapshot_conflict',
]);
const CONFIG_SNAPSHOT_ERRORS = Object.freeze({
  failed: ['powerdns_config_snapshot_failed', 'PowerDNS managed configuration could not be snapshotted before apply'],
  drift: ['powerdns_config_path_drift', 'Managed PowerDNS configuration path must be a regular file when it already exists'],
});
const RECEIPT_SNAPSHOT_ERRORS = Object.freeze({
  failed: ['powerdns_rollback_snapshot_failed', 'PowerDNS authoritative receipt could not be snapshotted before apply'],
  drift: ['powerdns_rollback_snapshot_failed', 'PowerDNS authoritative receipt must be a regular file before apply'],
});

function fail(code, message) {
  throw new PowerDnsAuthoritativeManagerError(code, message);
}

function defaultRun(file, args, options = {}) {
  return execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 10 * 60_000,
    maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
    env: options.env,
  });
}

async function defaultHashPassword(value) {
  return new Promise((resolve, reject) => {
    const child = spawn(PDNSUTIL, ['hash-password'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { if (stdout.length < 4096) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < 4096) stderr += chunk; });
    child.on('error', () => reject(new PowerDnsAuthoritativeManagerError('powerdns_hash_failed', 'PowerDNS API key hash command failed')));
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new PowerDnsAuthoritativeManagerError('powerdns_hash_failed', `PowerDNS API key hash command failed${stderr ? ' with stderr output' : ''}`));
      }
      const result = stdout.trim();
      if (result.length < 20 || result.length > 512 || /[\r\n\u0000]/.test(result)) {
        return reject(new PowerDnsAuthoritativeManagerError('powerdns_hash_invalid', 'PowerDNS API key hash output is invalid'));
      }
      resolve(result);
    });
    child.stdin.end(`${value}\n`);
  });
}

function isRegularFile(info) {
  return Boolean(info?.isFile?.()) && !info?.isSymbolicLink?.();
}

function privateJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function createPowerDnsAuthoritativeManager({
  run = defaultRun,
  fetchFn = globalThis.fetch,
  hashPassword = defaultHashPassword,
  socketInspector = createPowerDnsSocketHealthInspector(),
  operationPath = OPERATION_PATH,
  rollbackSnapshotPath = ROLLBACK_SNAPSHOT_PATH,
  rollbackCompensationPath = ROLLBACK_COMPENSATION_PATH,
  now = () => Date.now(),
  idFactory = randomUUID,
  chmodFn = chmod,
  chownFn = chown,
  lstatFn = lstat,
  mkdirFn = mkdir,
  readdirFn = readdir,
  readFileFn = readFile,
  renameFn = rename,
  rmFn = rm,
  writeFileFn = writeFile,
} = {}) {
  const functions = [run, fetchFn, hashPassword, now, idFactory, chmodFn, chownFn, lstatFn, mkdirFn, readdirFn,
    readFileFn, renameFn, rmFn, writeFileFn];
  if (functions.some((value) => typeof value !== 'function')
    || typeof socketInspector?.inspect !== 'function'
    || [operationPath, rollbackSnapshotPath, rollbackCompensationPath].some((value) => typeof value !== 'string' || !value)) {
    fail('powerdns_dependencies_invalid', 'PowerDNS authoritative dependencies are unavailable');
  }

  // ---- 1. files ----

  async function readOptional(target) {
    try { return await readFileFn(target, 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      fail('powerdns_file_unavailable', 'PowerDNS managed file could not be read');
    }
  }

  // Writes a same-directory temporary file with final owner and mode, then renames it into place.
  async function replaceFile(target, content, { mode, directoryMode = null, enforceDirectoryMode = false, setOwner = null }) {
    if (directoryMode !== null) {
      const directory = path.dirname(target);
      await mkdirFn(directory, { recursive: true, mode: directoryMode });
      if (enforceDirectoryMode) await chmodFn(directory, directoryMode);
    }
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      await writeFileFn(temporary, content, Buffer.isBuffer(content) ? { mode } : { encoding: 'utf8', mode });
      if (setOwner) await setOwner(temporary);
      await chmodFn(temporary, mode);
      await renameFn(temporary, target);
    } finally {
      try { await rmFn(temporary, { force: true }); } catch { /* already renamed */ }
    }
  }

  // Root-only JSON state (journal, rollback snapshot, compensation): 0600 file in a 0700 directory.
  function writePrivateJson(target, value) {
    return replaceFile(target, privateJson(value), { mode: 0o600, directoryMode: 0o700, enforceDirectoryMode: true });
  }

  async function readPrivateJson(target, parse, { unavailable, unsafe, invalid }) {
    let info;
    try { info = await lstatFn(target); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      fail(...unavailable);
    }
    if (!isRegularFile(info) || info.uid !== 0 || (info.mode & 0o777) !== 0o600) fail(...unsafe);
    try { return parse(JSON.parse(await readFileFn(target, 'utf8'))); }
    catch (error) {
      if (error instanceof PowerDnsAuthoritativeManagerError) throw error;
      fail(...invalid);
    }
  }

  async function fileSnapshot(target, errors) {
    let info;
    try { info = await lstatFn(target); }
    catch (error) {
      if (error?.code === 'ENOENT') return Object.freeze({ exists: false });
      fail(...errors.failed);
    }
    if (!isRegularFile(info)) fail(...errors.drift);
    try {
      const content = await readFileFn(target);
      return Object.freeze({ exists: true, content, uid: info.uid, gid: info.gid, mode: info.mode & 0o777 });
    } catch {
      fail(...errors.failed);
    }
  }

  async function managedFiles() {
    return Object.freeze({
      config: await fileSnapshot(powerDnsTemplatePolicy.configPath, CONFIG_SNAPSHOT_ERRORS),
      receipt: await fileSnapshot(RECEIPT_PATH, RECEIPT_SNAPSHOT_ERRORS),
    });
  }

  function sameManagedFiles(left, right) {
    return sameFileSnapshot(left.config, right.config) && sameFileSnapshot(left.receipt, right.receipt);
  }

  async function restoreFile(target, snapshot) {
    if (!snapshot.exists) {
      await rmFn(target, { force: true });
      return;
    }
    if (!Number.isInteger(snapshot.uid) || !Number.isInteger(snapshot.gid) || !Number.isInteger(snapshot.mode)) {
      fail('powerdns_config_snapshot_invalid', 'PowerDNS managed configuration snapshot metadata is invalid');
    }
    await replaceFile(target, snapshot.content, {
      mode: snapshot.mode,
      setOwner: (temporary) => chownFn(temporary, snapshot.uid, snapshot.gid),
    });
  }

  async function restoreManagedFiles(files) {
    await restoreFile(powerDnsTemplatePolicy.configPath, files.config);
    await restoreFile(RECEIPT_PATH, files.receipt);
  }

  // ---- 2. host ----

  async function inspectPackage(packageName) {
    try { return packageStatus((await run(DPKG_QUERY, ['-W', '-f=${Status}\t${Version}', packageName], { timeout: 10_000 })).stdout); }
    catch { return Object.freeze({ installed: false, version: null }); }
  }

  async function ensurePackages() {
    if ((await inspectPackage('pdns-recursor')).installed) {
      fail('powerdns_recursor_conflict', 'pdns-recursor is installed; YunPanel authoritative DNS refuses to share ownership with a recursive resolver');
    }
    const before = await Promise.all(powerDnsTemplatePolicy.packages.map(inspectPackage));
    if (before.every((entry) => entry.installed)) return;
    const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive', LC_ALL: 'C' };
    try {
      await run(APT_GET, ['update'], { env });
      await run(APT_GET, ['install', '--yes', '--no-install-recommends', ...powerDnsTemplatePolicy.packages], { env });
    } catch {
      fail('powerdns_package_install_failed', 'PowerDNS authoritative packages could not be installed');
    }
    const after = await Promise.all(powerDnsTemplatePolicy.packages.map(inspectPackage));
    if (!after.every((entry) => entry.installed)) {
      fail('powerdns_package_install_unverified', 'PowerDNS authoritative package installation could not be verified');
    }
  }

  async function assertIncludeDirectory() {
    const base = await readOptional(BASE_CONFIG);
    if (base === null || !includeDirConfigured(base)) {
      fail('powerdns_include_dir_required', 'Vendor pdns.conf must include /etc/powerdns/pdns.d before YunPanel can manage a safe drop-in');
    }
  }

  async function findSchema() {
    for (const candidate of SCHEMA_PATHS) {
      try {
        if (isRegularFile(await lstatFn(candidate))) return candidate;
      } catch (error) {
        if (error?.code !== 'ENOENT') fail('powerdns_schema_inspection_failed', 'PowerDNS SQLite schema could not be inspected');
      }
    }
    fail('powerdns_schema_missing', 'PowerDNS SQLite schema file is missing');
  }

  async function ensureDatabase() {
    const { databasePath } = powerDnsTemplatePolicy;
    await run(INSTALL, ['-d', '-o', 'pdns', '-g', 'pdns', '-m', '0750', path.posix.dirname(databasePath)], { timeout: 10_000 });
    let exists = true;
    try { await lstatFn(databasePath); }
    catch (error) {
      if (error?.code !== 'ENOENT') fail('powerdns_database_inspection_failed', 'PowerDNS SQLite database could not be inspected');
      exists = false;
    }
    if (!exists) {
      const schemaPath = await findSchema();
      let schema = await readFileFn(schemaPath);
      if (schemaPath.endsWith('.gz')) schema = gunzipSync(schema);
      try { await run(SQLITE3, [databasePath, schema.toString('utf8')], { timeout: 60_000, maxBuffer: 512 * 1024 }); }
      catch { fail('powerdns_database_init_failed', 'PowerDNS SQLite schema initialization failed'); }
    }
    try {
      await run(CHOWN, ['pdns:pdns', databasePath], { timeout: 10_000 });
      await chmodFn(databasePath, 0o640);
    } catch {
      fail('powerdns_database_permission_failed', 'PowerDNS SQLite database permissions could not be enforced');
    }
  }

  async function writeManagedConfig(content) {
    await mkdirFn(powerDnsTemplatePolicy.includeDirectory, { recursive: true, mode: 0o750 });
    await replaceFile(powerDnsTemplatePolicy.configPath, content, {
      mode: 0o640,
      setOwner: (temporary) => run(CHOWN, ['root:pdns', temporary], { timeout: 10_000 }),
    });
  }

  async function writeReceipt(spec, config) {
    const receipt = buildReceipt(spec, config, new Date(now()).toISOString());
    await replaceFile(RECEIPT_PATH, `${JSON.stringify(receipt)}\n`, { mode: 0o600, directoryMode: 0o700 });
  }

  async function activate(configChanged) {
    try { await run(PDNS_SERVER, ['--config=check'], { timeout: 30_000, maxBuffer: 512 * 1024 }); }
    catch { fail('powerdns_config_invalid', 'PowerDNS rejected the managed configuration'); }
    try {
      await run(SYSTEMCTL, ['enable', '--now', powerDnsTemplatePolicy.serviceUnit], { timeout: 60_000 });
      if (configChanged) await run(SYSTEMCTL, ['restart', powerDnsTemplatePolicy.serviceUnit], { timeout: 60_000 });
    } catch {
      fail('powerdns_service_activation_failed', 'PowerDNS authoritative service could not be activated');
    }
  }

  async function serviceActive() {
    try { await run(SYSTEMCTL, ['is-active', '--quiet', powerDnsTemplatePolicy.serviceUnit], { timeout: 10_000 }); return true; }
    catch { return false; }
  }

  async function apiHealth(rawApiKey) {
    let response;
    try {
      response = await fetchFn(`http://${powerDnsTemplatePolicy.apiAddress}:${powerDnsTemplatePolicy.apiPort}/api/v1/servers/localhost`, {
        method: 'GET',
        headers: { 'X-API-Key': rawApiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      return Object.freeze({ healthy: false, status: null });
    }
    if (!response?.ok) return Object.freeze({ healthy: false, status: response?.status ?? null });
    try {
      const payload = await response.json();
      return Object.freeze({ healthy: Boolean(payload && typeof payload === 'object'), status: response.status });
    } catch {
      return Object.freeze({ healthy: false, status: response.status });
    }
  }

  async function inspectPath(target, expected) {
    try {
      const identity = fileIdentity((await run(STAT, ['-c', '%U:%G:%a', target], { timeout: 10_000 })).stdout);
      return Object.freeze({
        ...identity,
        satisfied: identity.owner === expected.owner && identity.group === expected.group && identity.mode === expected.mode,
      });
    } catch {
      return Object.freeze({ owner: null, group: null, mode: null, satisfied: false });
    }
  }

  async function inspectHost(spec) {
    const packages = await Promise.all(powerDnsTemplatePolicy.packages.map(inspectPackage));
    const notReady = (reason, evidence = {}) => Object.freeze({ satisfied: false, reason, packages, ...evidence });
    if ((await inspectPackage('pdns-recursor')).installed) return notReady('powerdns_recursor_conflict', { recursorInstalled: true });
    if (!packages.every((entry) => entry.installed)) return notReady('powerdns_packages_missing', { recursorInstalled: false });
    const base = await readOptional(BASE_CONFIG);
    if (base === null || !includeDirConfigured(base)) return notReady('powerdns_include_dir_missing', { recursorInstalled: false });
    const config = await readOptional(powerDnsTemplatePolicy.configPath);
    if (config === null) return notReady('powerdns_config_missing', { recursorInstalled: false });
    if (!apiKeyHashFromConfig(config)) return notReady('powerdns_config_invalid', { recursorInstalled: false });
    if (!configMatchesSpec(config, spec)) return notReady('powerdns_config_drift', { recursorInstalled: false });
    const [configIdentity, databaseIdentity, active, api] = await Promise.all([
      inspectPath(powerDnsTemplatePolicy.configPath, { owner: 'root', group: 'pdns', mode: '640' }),
      inspectPath(powerDnsTemplatePolicy.databasePath, { owner: 'pdns', group: 'pdns', mode: '640' }),
      serviceActive(),
      apiHealth(spec.apiKey),
    ]);
    const evidence = { configIdentity, databaseIdentity, active, api };
    if (!configIdentity.satisfied) return notReady('powerdns_config_permissions_invalid', evidence);
    if (!databaseIdentity.satisfied) return notReady('powerdns_database_permissions_invalid', evidence);
    if (!active) return notReady('powerdns_service_inactive', evidence);
    if (!api.healthy) return notReady('powerdns_api_unhealthy', evidence);
    const receiptRaw = await readOptional(RECEIPT_PATH);
    if (receiptRaw === null) return notReady('powerdns_receipt_missing', evidence);
    let receipt;
    try { receipt = receiptValue(JSON.parse(receiptRaw), spec, config); }
    catch { return notReady('powerdns_receipt_invalid', evidence); }
    return Object.freeze({
      satisfied: true,
      adapter: ADAPTER,
      serverId: spec.serverId,
      apiKeyRevision: spec.apiKeyRevision,
      secondaryDns: spec.secondaryDns,
      packages,
      configPath: powerDnsTemplatePolicy.configPath,
      databasePath: powerDnsTemplatePolicy.databasePath,
      api: Object.freeze({ address: powerDnsTemplatePolicy.apiAddress, port: powerDnsTemplatePolicy.apiPort, public: false }),
      authoritative: true,
      recursive: false,
      receipt,
    });
  }

  async function rotatedConfig(spec) {
    return renderManagedPowerDnsConfig({ apiKeyHash: await hashPassword(spec.apiKey), secondaryDns: spec.secondaryDns });
  }

  // Converges packages, database, drop-in, service and API key; idempotent when nothing drifted.
  async function applyHost(spec) {
    await ensurePackages();
    await assertIncludeDirectory();
    await ensureDatabase();

    let config = await readOptional(powerDnsTemplatePolicy.configPath);
    const configChanged = config === null || !configMatchesSpec(config, spec);
    if (configChanged) {
      config = await rotatedConfig(spec);
      await writeManagedConfig(config);
    }
    await activate(configChanged);
    let health = await apiHealth(spec.apiKey);
    if (!health.healthy && !configChanged) {
      // The drop-in matches but carries another key hash: rotate to the requested key once.
      config = await rotatedConfig(spec);
      await writeManagedConfig(config);
      await activate(true);
      health = await apiHealth(spec.apiKey);
    }
    if (!health.healthy) fail('powerdns_api_unhealthy', 'PowerDNS API did not become healthy with the managed API key');
    await writeReceipt(spec, config);
    const verified = await inspectHost(spec);
    if (!verified.satisfied) fail('powerdns_apply_unverified', `PowerDNS authoritative apply could not be verified (${verified.reason})`);
    return verified;
  }

  // Activates already-restored files without rewriting them.
  async function activateRestored(spec) {
    await assertIncludeDirectory();
    const config = await readOptional(powerDnsTemplatePolicy.configPath);
    const receiptRaw = await readOptional(RECEIPT_PATH);
    assertRestoredState(spec, config, receiptRaw);
    await activate(true);
    if (!(await apiHealth(spec.apiKey)).healthy) {
      fail('powerdns_rollback_api_unhealthy', 'PowerDNS API did not become healthy after rollback activation');
    }
    const verified = await inspectHost(spec);
    if (!verified.satisfied) fail('powerdns_rollback_unverified', `PowerDNS rollback activation could not be verified (${verified.reason})`);
    return verified;
  }

  async function isUnconfigured() {
    const { apiPort, databasePath, includeDirectory, serviceUnit } = powerDnsTemplatePolicy;
    for (const directory of [includeDirectory, path.posix.dirname(databasePath), STATE_DIRECTORY]) {
      try {
        const info = await lstatFn(directory);
        if (!info.isDirectory() || (await readdirFn(directory)).length !== 0) return false;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    const settings = ((await readOptional(BASE_CONFIG)) ?? '').split(/\r?\n/).map((line) => line.trim());
    if (settings.some((line) => (/^(?:launch|api|webserver)\s*\+?=/.test(line)
      && !/^(?:launch\s*=\s*|(?:api|webserver)\s*=\s*no)$/.test(line))
      || (/^include-dir\s*\+?=/.test(line) && !includeDirConfigured(line)))) return false;

    const unit = await run(SYSTEMCTL, ['show', '--property=ActiveState,SubState,LoadState,MainPID', serviceUnit], { timeout: 5_000 });
    const state = new Set(String(unit.stdout).trim().split('\n'));
    if ((!state.has('LoadState=loaded') && !state.has('LoadState=not-found'))
      || !state.has('ActiveState=inactive') || !state.has('SubState=dead') || !state.has('MainPID=0')) return false;
    const listeners = await run(SS, ['-H', '-lntup', `sport = :53 or sport = :${apiPort}`], { timeout: 5_000 });
    return String(listeners.stdout).trim().split('\n').every((line) => {
      if (line === '') return true;
      const [protocol, listenState, , , local, peer, owner, ...rest] = line.trim().split(/\s+/);
      return rest.length === 0 && ((protocol === 'tcp' && listenState === 'LISTEN')
        || (protocol === 'udp' && listenState === 'UNCONN'))
        && /^127\.0\.0\.(?:53|54)(?:%lo)?:53$/.test(local)
        && /^(?:0\.0\.0\.0|\*):\*$/.test(peer)
        && /^users:\(\("systemd-resolve",pid=[1-9]\d*,fd=\d+\)\)$/.test(owner);
    });
  }

  // ---- 3. rollback ----

  async function assertManagedPaths() {
    for (const [target, code, message] of [
      [powerDnsTemplatePolicy.configPath, ...CONFIG_SNAPSHOT_ERRORS.drift],
      [powerDnsTemplatePolicy.databasePath, 'powerdns_database_path_drift',
        'Managed PowerDNS SQLite database path must be a regular file when it already exists'],
    ]) {
      let info;
      try { info = await lstatFn(target); }
      catch (error) {
        if (error?.code === 'ENOENT') continue;
        fail('powerdns_managed_path_inspection_failed', 'PowerDNS managed filesystem state could not be inspected');
      }
      if (!isRegularFile(info)) fail(code, message);
    }
  }

  async function inspectManaged(spec) {
    await assertManagedPaths();
    return inspectHost(spec);
  }

  function readRollbackSnapshot() {
    return readPrivateJson(rollbackSnapshotPath, persistedRollbackSnapshot, {
      unavailable: ['powerdns_rollback_snapshot_unavailable', 'PowerDNS rollback snapshot could not be inspected'],
      unsafe: ['powerdns_rollback_snapshot_unsafe', 'PowerDNS rollback snapshot must be a root-owned private regular file'],
      invalid: ['powerdns_rollback_snapshot_invalid', 'PowerDNS rollback snapshot content is invalid'],
    });
  }

  function readRollbackCompensation() {
    return readPrivateJson(rollbackCompensationPath, persistedRollbackCompensation, {
      unavailable: ['powerdns_rollback_compensation_unavailable', 'PowerDNS rollback compensation snapshot could not be inspected'],
      unsafe: ['powerdns_rollback_compensation_unsafe', 'PowerDNS rollback compensation snapshot must be a root-owned private regular file'],
      invalid: ['powerdns_rollback_compensation_invalid', 'PowerDNS rollback compensation snapshot content is invalid'],
    });
  }

  async function persistValidated(target, value, normalize, code, message) {
    const normalized = normalize(value);
    try { await writePrivateJson(target, normalized); }
    catch { fail(code, message); }
    return normalized;
  }

  // The first attempt of an operation captures the pre-apply state; retries keep that original capture.
  async function prepareRollbackSnapshot(spec, operationId, configBefore) {
    const existing = await readRollbackSnapshot();
    if (existing?.operationId === operationId) {
      if (existing.serverId !== spec.serverId || existing.credentialRevision !== spec.apiKeyRevision) {
        fail('powerdns_rollback_snapshot_conflict', 'PowerDNS rollback snapshot belongs to a different operation intent');
      }
      return;
    }
    const snapshot = buildRollbackSnapshot({
      operationId,
      spec,
      configSnapshot: configBefore,
      receiptSnapshot: await fileSnapshot(RECEIPT_PATH, RECEIPT_SNAPSHOT_ERRORS),
      createdAt: new Date(now()).toISOString(),
    });
    await persistValidated(rollbackSnapshotPath, snapshot, persistedRollbackSnapshot,
      'powerdns_rollback_snapshot_failed', 'PowerDNS rollback snapshot could not be persisted before apply');
  }

  async function rollbackStatus(operation) {
    const snapshot = await readRollbackSnapshot();
    if (!snapshot || snapshot.operationId !== operation.id
      || snapshot.serverId !== operation.serverId || snapshot.credentialRevision !== operation.apiKeyRevision) {
      return Object.freeze({ available: false, reason: 'powerdns_rollback_snapshot_mismatch' });
    }
    return publicRollbackSnapshot(snapshot);
  }

  async function restoreRejectedConfig(configBefore) {
    try { await restoreFile(powerDnsTemplatePolicy.configPath, configBefore); }
    catch (error) {
      if (error?.code === 'powerdns_config_snapshot_invalid') throw error;
      fail('powerdns_config_rollback_failed',
        'PowerDNS rejected the candidate configuration and the previous managed configuration could not be restored');
    }
  }

  async function applyManaged(spec, operationId) {
    await assertManagedPaths();
    const configBefore = await fileSnapshot(powerDnsTemplatePolicy.configPath, CONFIG_SNAPSHOT_ERRORS);
    await prepareRollbackSnapshot(spec, operationId, configBefore);
    let result;
    try { result = await applyHost(spec); }
    catch (error) {
      if (error?.code === 'powerdns_config_invalid') await restoreRejectedConfig(configBefore);
      throw error;
    }
    await assertManagedPaths();
    return result;
  }

  // Before overwriting current files, record them (once per rollback request) so a failed
  // rollback can put them back. Only a verified current state may be captured.
  async function prepareCompensation(spec, snapshot, previous, current) {
    const existing = await readRollbackCompensation();
    if (existing?.operationId === snapshot.operationId && existing.serverId === spec.serverId
      && existing.credentialRevision === spec.apiKeyRevision && existing.rollbackSnapshotDigest === snapshot.snapshotDigest) {
      return existing;
    }
    if (sameManagedFiles(current, previous)) return null;
    let inspected;
    try { inspected = await inspectHost(spec); }
    catch { fail('powerdns_rollback_current_state_unverified', 'Current PowerDNS state could not be verified before rollback'); }
    if (inspected?.satisfied !== true) {
      fail('powerdns_rollback_current_state_unverified', 'Current PowerDNS state is not safe to replace with the rollback snapshot');
    }
    if (!sameManagedFiles(current, await managedFiles())) {
      fail('powerdns_rollback_current_state_changed', 'Current PowerDNS files changed during rollback preflight');
    }
    const compensation = buildRollbackCompensation({
      operationId: snapshot.operationId,
      spec,
      snapshotDigest: snapshot.snapshotDigest,
      configSnapshot: current.config,
      receiptSnapshot: current.receipt,
      createdAt: new Date(now()).toISOString(),
    });
    return persistValidated(rollbackCompensationPath, compensation, persistedRollbackCompensation,
      'powerdns_rollback_compensation_persist_failed', 'PowerDNS rollback compensation snapshot could not be persisted before mutation');
  }

  async function compensate(spec, compensating) {
    try {
      await restoreManagedFiles(compensating);
      const compensated = await activateRestored(spec);
      if (compensated?.satisfied !== true) throw new Error('compensation unverified');
      await verifiedSockets('PowerDNS rollback compensation restored unhealthy DNS socket or recursion policy evidence');
    } catch {
      fail('powerdns_rollback_compensation_failed', 'PowerDNS rollback failed and the current authoritative state could not be recovered');
    }
  }

  // Restores the exact pre-apply config and receipt; resumable after a crash at any step.
  async function restoreSnapshot(spec, snapshot) {
    await assertManagedPaths();
    const previousSpec = normalizeIntent({ ...spec, secondaryDns: snapshot.previousSecondaryDns });
    const previous = Object.freeze({ config: decodeSnapshotFile(snapshot.config), receipt: decodeSnapshotFile(snapshot.receipt) });
    const compensation = await prepareCompensation(spec, snapshot, previous, await managedFiles());
    const compensating = compensation
      ? Object.freeze({ config: decodeSnapshotFile(compensation.config), receipt: decodeSnapshotFile(compensation.receipt) })
      : null;
    const live = await managedFiles();
    const configIsPrevious = sameFileSnapshot(live.config, previous.config);
    const receiptIsPrevious = sameFileSnapshot(live.receipt, previous.receipt);
    const configIsCurrent = compensating ? sameFileSnapshot(live.config, compensating.config) : false;
    const receiptIsCurrent = compensating ? sameFileSnapshot(live.receipt, compensating.receipt) : false;
    if ((!configIsPrevious && !configIsCurrent) || (!receiptIsPrevious && !receiptIsCurrent)) {
      fail('powerdns_rollback_current_state_changed', 'PowerDNS files no longer match the exact rollback or compensation snapshots');
    }

    const alreadyRestored = configIsPrevious && receiptIsPrevious;
    try {
      if (!configIsPrevious) await restoreFile(powerDnsTemplatePolicy.configPath, previous.config);
      if (!receiptIsPrevious) await restoreFile(RECEIPT_PATH, previous.receipt);
      let verified = null;
      if (alreadyRestored) {
        try { verified = await inspectHost(previousSpec); } catch { /* activation performs the authoritative check */ }
      }
      if (verified?.satisfied !== true) verified = await activateRestored(previousSpec);
      const sockets = await verifiedSockets('PowerDNS rollback completed with unhealthy DNS socket or recursion policy evidence');
      return Object.freeze({
        ...verified,
        sockets,
        rollback: Object.freeze({ operationId: snapshot.operationId, snapshotDigest: snapshot.snapshotDigest, alreadyRestored }),
      });
    } catch (error) {
      if (compensating) await compensate(spec, compensating);
      throw error;
    }
  }

  // ---- 4. journal ----

  let mutationChain = Promise.resolve();

  function serializeMutation(task) {
    const execution = mutationChain.then(task, task);
    mutationChain = execution.catch(() => {});
    return execution;
  }

  async function readOperation() {
    try { return persistedOperation(JSON.parse(await readFileFn(operationPath, 'utf8'))); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error instanceof PowerDnsAuthoritativeManagerError) throw error;
      fail('powerdns_operation_state_invalid', 'PowerDNS authoritative operation journal is invalid');
    }
  }

  async function persistOperation(operation) {
    const normalized = persistedOperation(operation);
    await writePrivateJson(operationPath, normalized);
    return normalized;
  }

  function updateOperation(operation, update) {
    const updatedAt = new Date(Math.max(now(), Date.parse(operation.updatedAt) + 1)).toISOString();
    return persistOperation({ ...operation, ...update, version: JOURNAL_VERSION, updatedAt });
  }

  function succeed(operation, spec, inspected) {
    return updateOperation(operation, { status: 'succeeded', result: evidenceFromInspection(spec, inspected), lastError: null });
  }

  function createOperation(spec) {
    const createdAt = new Date(now()).toISOString();
    return persistOperation({
      version: JOURNAL_VERSION,
      id: idFactory(),
      serverId: spec.serverId,
      apiKeyRevision: spec.apiKeyRevision,
      secondaryDns: spec.secondaryDns,
      status: 'applying',
      result: null,
      lastError: null,
      createdAt,
      updatedAt: createdAt,
    });
  }

  async function inspectForRecovery(spec, message) {
    try { return await inspectManaged(spec); }
    catch { fail('powerdns_recovery_inspection_unavailable', message); }
  }

  async function recoveryTarget(rawIntent, { operationId, expectedUpdatedAt } = {}) {
    const spec = normalizeIntent(rawIntent);
    if (typeof operationId !== 'string' || !operationId || typeof expectedUpdatedAt !== 'string' || !expectedUpdatedAt) {
      fail('powerdns_recovery_request_invalid', 'PowerDNS recovery requires an exact operation identity and journal revision');
    }
    const existing = await readOperation();
    if (!existing || existing.status !== 'applying') {
      fail('powerdns_recovery_not_required', 'PowerDNS authoritative operation does not require recovery');
    }
    if (existing.id !== operationId || existing.updatedAt !== expectedUpdatedAt) {
      fail('powerdns_recovery_stale', 'PowerDNS recovery request does not match the current operation journal');
    }
    if (!operationMatches(existing, spec)) {
      fail('powerdns_operation_conflict', 'Interrupted PowerDNS apply intent changed and cannot be recovered with current credentials or settings');
    }
    return Object.freeze({ operation: existing, spec });
  }

  // An interrupted apply closes only from inspected evidence; the mutation is never replayed automatically.
  async function recoverInterrupted(operation, spec) {
    const inspected = await inspectForRecovery(spec,
      'Interrupted PowerDNS apply cannot be replayed because current host state could not be inspected');
    if (inspected?.satisfied !== true) {
      fail('powerdns_recovery_pending',
        'Interrupted PowerDNS apply was inspected but is not proven complete; automatic mutation replay is blocked');
    }
    await succeed(operation, spec, inspected);
    return inspected;
  }

  async function executeApply(operation, spec) {
    let applied;
    try { applied = await applyManaged(spec, operation.id); }
    catch (error) {
      let after = null;
      let inspectionAvailable = true;
      try { after = await inspectManaged(spec); }
      catch { inspectionAvailable = false; }
      if (after?.satisfied === true) {
        await succeed(operation, spec, after);
        return after;
      }
      const failure = safeFailure(error);
      if (DETERMINISTIC_FAILURE_CODES.has(failure.code)) {
        await updateOperation(operation, { status: 'failed', result: null, lastError: failure });
        throw error;
      }
      await updateOperation(operation, { status: 'applying', result: null, lastError: failure });
      if (!inspectionAvailable) {
        fail('powerdns_recovery_inspection_unavailable',
          'PowerDNS apply failed and current host state cannot be inspected; operation remains applying and automatic replay is blocked');
      }
      fail('powerdns_apply_outcome_uncertain',
        'PowerDNS apply failed without a proven post-condition; operation remains applying and automatic replay is blocked');
    }
    await succeed(operation, spec, applied);
    return applied;
  }

  async function applyOnce(rawIntent) {
    const spec = normalizeIntent(rawIntent);
    const existing = await readOperation();
    if (existing?.status === 'rolling_back') {
      fail('powerdns_rollback_recovery_pending',
        'Interrupted PowerDNS rollback must be explicitly resolved before applying authoritative intent');
    }
    if (existing?.status === 'rollback_failed' && existing.lastError?.code === 'powerdns_rollback_compensation_failed') {
      fail('powerdns_rollback_recovery_pending',
        'PowerDNS rollback compensation failed; explicit recovery is required before another apply');
    }
    if (existing?.status === 'applying') {
      if (!operationMatches(existing, spec)) {
        fail('powerdns_operation_conflict',
          'A different interrupted PowerDNS apply must be resolved before changing authoritative DNS intent');
      }
      return recoverInterrupted(existing, spec);
    }
    const before = await inspectManaged(spec);
    if (before?.satisfied === true) return before;
    return executeApply(await createOperation(spec), spec);
  }

  async function resolveOnce(rawIntent, recovery) {
    const { operation, spec } = await recoveryTarget(rawIntent, recovery);
    return recoverInterrupted(operation, spec);
  }

  async function retryOnce(rawIntent, recovery) {
    const { operation: existing, spec } = await recoveryTarget(rawIntent, recovery);
    const before = await inspectForRecovery(spec,
      'Interrupted PowerDNS apply cannot be retried because current host state could not be inspected');
    if (before?.satisfied === true) {
      await succeed(existing, spec, before);
      return before;
    }
    const operation = await updateOperation(existing, {
      status: 'applying',
      result: null,
      lastError: Object.freeze({
        code: 'powerdns_explicit_retry_started',
        message: 'Operator-authorized PowerDNS retry started after current-state inspection',
      }),
    });
    return executeApply(operation, spec);
  }

  function rollbackRequest(recovery) {
    const fields = ['operationId', 'expectedUpdatedAt', 'snapshotDigest'];
    if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)
      || Object.keys(recovery).length !== fields.length || Object.keys(recovery).some((field) => !fields.includes(field))
      || typeof recovery.operationId !== 'string' || !OPERATION_ID_PATTERN.test(recovery.operationId)
      || typeof recovery.expectedUpdatedAt !== 'string' || !recovery.expectedUpdatedAt
      || typeof recovery.snapshotDigest !== 'string' || !SNAPSHOT_DIGEST_PATTERN.test(recovery.snapshotDigest)) {
      fail('powerdns_rollback_request_invalid', 'PowerDNS rollback requires exact operation, journal revision and snapshot digest');
    }
    return recovery;
  }

  async function rollbackOnce(rawIntent, rawRecovery = {}) {
    const recovery = rollbackRequest(rawRecovery);
    const spec = normalizeIntent(rawIntent);
    const existing = await readOperation();
    if (!existing || !ROLLBACK_CAPABLE_STATUSES.includes(existing.status)) {
      fail('powerdns_rollback_not_available', 'PowerDNS operation is not in a rollback-capable state');
    }
    if (existing.id !== recovery.operationId || existing.updatedAt !== recovery.expectedUpdatedAt) {
      fail('powerdns_rollback_stale', 'PowerDNS rollback request does not match the current operation journal');
    }
    if (!operationMatches(existing, spec)) {
      fail('powerdns_operation_conflict', 'PowerDNS rollback intent changed after the selected apply operation');
    }
    const snapshot = await readRollbackSnapshot();
    if (!snapshot?.available || snapshot.operationId !== existing.id || snapshot.serverId !== existing.serverId
      || snapshot.credentialRevision !== existing.apiKeyRevision || snapshot.snapshotDigest !== recovery.snapshotDigest) {
      fail('powerdns_rollback_snapshot_stale', 'PowerDNS rollback snapshot is unavailable or no longer matches the request');
    }
    const previousSpec = normalizeIntent({ ...spec, secondaryDns: snapshot.previousSecondaryDns });
    if (existing.status === 'rolled_back') {
      const inspected = await inspectManaged(previousSpec);
      if (inspected?.satisfied !== true) {
        fail('powerdns_rollback_recovery_unverified', 'Completed PowerDNS rollback no longer matches current host state');
      }
      return inspected;
    }

    const rollingBack = existing.status === 'rolling_back'
      ? existing
      : await updateOperation(existing, {
        status: 'rolling_back',
        result: existing.result,
        lastError: Object.freeze({
          code: 'powerdns_explicit_rollback_started',
          message: 'Operator-authorized PowerDNS rollback started from an exact snapshot',
        }),
      });
    try {
      const restored = await restoreSnapshot(spec, snapshot);
      await updateOperation(rollingBack, {
        status: 'rolled_back',
        result: evidenceFromInspection(previousSpec, restored),
        lastError: null,
      });
      return restored;
    } catch (error) {
      await updateOperation(rollingBack, { status: 'rollback_failed', result: rollingBack.result, lastError: safeFailure(error) });
      throw error;
    }
  }

  // ---- 5. readiness ----

  async function socketEvidence() {
    const sockets = await socketInspector.inspect();
    if (!sockets || typeof sockets !== 'object') {
      fail('powerdns_socket_health_invalid', 'PowerDNS socket health inspector returned invalid evidence');
    }
    return sockets;
  }

  async function verifiedSockets(message) {
    const sockets = await socketEvidence();
    if (sockets.satisfied !== true) fail(sockets.reason ?? 'powerdns_socket_unhealthy', message);
    return sockets;
  }

  async function withVerifiedSockets(result, message) {
    if (result.sockets?.satisfied === true) return result;
    return Object.freeze({ ...result, sockets: await verifiedSockets(message) });
  }

  async function inspect(rawIntent) {
    const base = await inspectManaged(normalizeIntent(rawIntent));
    if (!base?.satisfied) return base;
    const sockets = await socketEvidence();
    if (!sockets.satisfied) {
      return Object.freeze({ ...base, satisfied: false, reason: sockets.reason ?? 'powerdns_socket_unhealthy', sockets });
    }
    return Object.freeze({ ...base, sockets });
  }

  async function apply(rawIntent) {
    const result = await serializeMutation(() => applyOnce(rawIntent));
    return withVerifiedSockets(result, 'PowerDNS service started but DNS socket or recursion policy verification failed');
  }

  async function resolve(rawIntent, recovery) {
    const result = await serializeMutation(() => resolveOnce(rawIntent, recovery));
    return withVerifiedSockets(result, 'PowerDNS recovery found unhealthy DNS socket or recursion policy evidence');
  }

  async function retry(rawIntent, recovery) {
    const result = await serializeMutation(() => retryOnce(rawIntent, recovery));
    return withVerifiedSockets(result, 'PowerDNS retry completed with unhealthy DNS socket or recursion policy evidence');
  }

  async function rollback(rawIntent, recovery) {
    const result = await serializeMutation(() => rollbackOnce(rawIntent, recovery));
    return withVerifiedSockets(result, 'PowerDNS rollback completed with unhealthy DNS socket or recursion policy evidence');
  }

  async function operation() {
    const current = await readOperation();
    return current ? publicOperation(current, await rollbackStatus(current)) : null;
  }

  return Object.freeze({ inspect, apply, operation, resolve, retry, rollback, isUnconfigured });
}

export const powerDnsAuthoritativeManagerInternals = Object.freeze({
  normalizeIntent,
  packageStatus,
  includeDirConfigured,
  apiKeyHashFromConfig,
  assertRestoredState,
  defaultHashPassword,
  paths: Object.freeze({
    BASE_CONFIG,
    RECEIPT_PATH,
    OPERATION_PATH,
    ROLLBACK_SNAPSHOT_PATH,
    ROLLBACK_COMPENSATION_PATH,
    ...powerDnsTemplatePolicy,
  }),
  schemaPaths: SCHEMA_PATHS,
});
