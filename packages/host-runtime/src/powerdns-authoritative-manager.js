import { execFile, spawn } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { promisify } from 'node:util';
import { powerDnsTemplatePolicy, renderManagedPowerDnsConfig } from '@yunpanel/config-templates/powerdns';

const execFileAsync = promisify(execFile);
const DPKG_QUERY = '/usr/bin/dpkg-query';
const APT_GET = '/usr/bin/apt-get';
const SYSTEMCTL = '/usr/bin/systemctl';
const PDNS_SERVER = '/usr/sbin/pdns_server';
const PDNSUTIL = '/usr/bin/pdnsutil';
const SQLITE3 = '/usr/bin/sqlite3';
const INSTALL = '/usr/bin/install';
const CHOWN = '/usr/bin/chown';
const STAT = '/usr/bin/stat';
const BASE_CONFIG = '/etc/powerdns/pdns.conf';
const RECEIPT_PATH = '/var/lib/yunpanel/staging/powerdns/authoritative.json';
const SCHEMA_PATHS = Object.freeze([
  '/usr/share/doc/pdns-backend-sqlite3/schema.sqlite3.sql',
  '/usr/share/doc/pdns-backend-sqlite3/schema.sqlite3.sql.gz',
]);
const API_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PowerDnsAuthoritativeManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PowerDnsAuthoritativeManagerError';
    this.code = code;
  }
}

function normalizeIntent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['serverId', 'apiKey', 'apiKeyRevision', 'secondaryDns'].includes(key))
    || typeof value.serverId !== 'string' || !UUID_PATTERN.test(value.serverId)
    || typeof value.apiKey !== 'string' || !API_KEY_PATTERN.test(value.apiKey)
    || !Number.isSafeInteger(value.apiKeyRevision) || value.apiKeyRevision < 1
    || !Array.isArray(value.secondaryDns)) {
    throw new PowerDnsAuthoritativeManagerError('powerdns_intent_invalid', 'PowerDNS authoritative intent is invalid');
  }
  let content;
  try { content = renderManagedPowerDnsConfig({ apiKeyHash: 'placeholder-hash-value-00000000000000000000', secondaryDns: value.secondaryDns }); }
  catch { throw new PowerDnsAuthoritativeManagerError('powerdns_intent_invalid', 'PowerDNS authoritative secondary DNS settings are invalid'); }
  void content;
  return Object.freeze({
    serverId: value.serverId.toLowerCase(),
    apiKey: value.apiKey,
    apiKeyRevision: value.apiKeyRevision,
    secondaryDns: Object.freeze([...value.secondaryDns].sort()),
  });
}

function packageStatus(output) {
  const [status = '', version = ''] = String(output ?? '').trim().split('\t');
  return Object.freeze({ installed: status === 'install ok installed', version: status === 'install ok installed' && version ? version : null });
}

function includeDirConfigured(content) {
  return String(content ?? '').split(/\r?\n/).some((line) => /^\s*include-dir\s*=\s*\/etc\/powerdns\/pdns\.d\s*$/.test(line));
}

function apiKeyHashFromConfig(content) {
  const match = String(content ?? '').match(/^api-key=([^\r\n]+)$/m);
  if (!match || match[1].length < 20 || match[1].length > 512 || /[\u0000-\u001f\u007f]/.test(match[1])) return null;
  return match[1];
}

function fileIdentity(output) {
  const [owner, group, mode] = String(output ?? '').trim().split(':');
  return Object.freeze({ owner, group, mode });
}

function receiptValue(value, spec, configContent) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1 || value.serverId !== spec.serverId || value.apiKeyRevision !== spec.apiKeyRevision
    || JSON.stringify(value.secondaryDns) !== JSON.stringify(spec.secondaryDns)
    || value.configLength !== Buffer.byteLength(configContent, 'utf8')
    || typeof value.appliedAt !== 'string' || !Number.isFinite(Date.parse(value.appliedAt))) {
    throw new PowerDnsAuthoritativeManagerError('powerdns_receipt_invalid', 'PowerDNS authoritative receipt is invalid');
  }
  return Object.freeze({ ...value, secondaryDns: Object.freeze([...value.secondaryDns]) });
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
      if (code !== 0) return reject(new PowerDnsAuthoritativeManagerError('powerdns_hash_failed', `PowerDNS API key hash command failed${stderr ? ' with stderr output' : ''}`));
      const result = stdout.trim();
      if (result.length < 20 || result.length > 512 || /[\r\n\u0000]/.test(result)) {
        return reject(new PowerDnsAuthoritativeManagerError('powerdns_hash_invalid', 'PowerDNS API key hash output is invalid'));
      }
      resolve(result);
    });
    child.stdin.end(`${value}\n`);
  });
}

export function createPowerDnsAuthoritativeManager({
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 10 * 60_000,
    maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
    env: options.env,
  }),
  fetchFn = globalThis.fetch,
  hashPassword = defaultHashPassword,
  chmodFn = chmod,
  lstatFn = lstat,
  mkdirFn = mkdir,
  readFileFn = readFile,
  renameFn = rename,
  writeFileFn = writeFile,
  now = () => Date.now(),
} = {}) {
  if (typeof run !== 'function' || typeof fetchFn !== 'function' || typeof hashPassword !== 'function'
    || typeof chmodFn !== 'function' || typeof lstatFn !== 'function' || typeof mkdirFn !== 'function'
    || typeof readFileFn !== 'function' || typeof renameFn !== 'function' || typeof writeFileFn !== 'function'
    || typeof now !== 'function') {
    throw new PowerDnsAuthoritativeManagerError('powerdns_dependencies_invalid', 'PowerDNS authoritative dependencies are unavailable');
  }

  async function readOptional(target, encoding = 'utf8') {
    try { return await readFileFn(target, encoding); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new PowerDnsAuthoritativeManagerError('powerdns_file_unavailable', 'PowerDNS managed file could not be read');
    }
  }

  async function inspectPackage(packageName) {
    try { return packageStatus((await run(DPKG_QUERY, ['-W', '-f=${Status}\t${Version}', packageName], { timeout: 10_000 })).stdout); }
    catch { return Object.freeze({ installed: false, version: null }); }
  }

  async function ensurePackages() {
    const recursor = await inspectPackage('pdns-recursor');
    if (recursor.installed) {
      throw new PowerDnsAuthoritativeManagerError('powerdns_recursor_conflict', 'pdns-recursor is installed; YunPanel authoritative DNS refuses to share ownership with a recursive resolver');
    }
    const before = await Promise.all(powerDnsTemplatePolicy.packages.map(inspectPackage));
    if (before.every((entry) => entry.installed)) return before;
    try {
      await run(APT_GET, ['update'], { env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive', LC_ALL: 'C' } });
      await run(APT_GET, ['install', '--yes', '--no-install-recommends', ...powerDnsTemplatePolicy.packages], {
        env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive', LC_ALL: 'C' },
      });
    } catch {
      throw new PowerDnsAuthoritativeManagerError('powerdns_package_install_failed', 'PowerDNS authoritative packages could not be installed');
    }
    const after = await Promise.all(powerDnsTemplatePolicy.packages.map(inspectPackage));
    if (!after.every((entry) => entry.installed)) {
      throw new PowerDnsAuthoritativeManagerError('powerdns_package_install_unverified', 'PowerDNS authoritative package installation could not be verified');
    }
    return after;
  }

  async function assertIncludeDirectory() {
    const base = await readOptional(BASE_CONFIG);
    if (base === null || !includeDirConfigured(base)) {
      throw new PowerDnsAuthoritativeManagerError('powerdns_include_dir_required', 'Vendor pdns.conf must include /etc/powerdns/pdns.d before YunPanel can manage a safe drop-in');
    }
  }

  async function findSchema() {
    for (const candidate of SCHEMA_PATHS) {
      try {
        const info = await lstatFn(candidate);
        if (info?.isFile?.() && !info.isSymbolicLink?.()) return candidate;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw new PowerDnsAuthoritativeManagerError('powerdns_schema_inspection_failed', 'PowerDNS SQLite schema could not be inspected');
      }
    }
    throw new PowerDnsAuthoritativeManagerError('powerdns_schema_missing', 'PowerDNS SQLite schema file is missing');
  }

  async function ensureDatabase() {
    await run(INSTALL, ['-d', '-o', 'pdns', '-g', 'pdns', '-m', '0750', path.posix.dirname(powerDnsTemplatePolicy.databasePath)], { timeout: 10_000 });
    let exists = true;
    try { await lstatFn(powerDnsTemplatePolicy.databasePath); }
    catch (error) {
      if (error?.code === 'ENOENT') exists = false;
      else throw new PowerDnsAuthoritativeManagerError('powerdns_database_inspection_failed', 'PowerDNS SQLite database could not be inspected');
    }
    if (!exists) {
      const schemaPath = await findSchema();
      let schema = await readFileFn(schemaPath);
      if (schemaPath.endsWith('.gz')) schema = gunzipSync(schema);
      try { await run(SQLITE3, [powerDnsTemplatePolicy.databasePath, schema.toString('utf8')], { timeout: 60_000, maxBuffer: 512 * 1024 }); }
      catch { throw new PowerDnsAuthoritativeManagerError('powerdns_database_init_failed', 'PowerDNS SQLite schema initialization failed'); }
    }
    try {
      await run(CHOWN, ['pdns:pdns', powerDnsTemplatePolicy.databasePath], { timeout: 10_000 });
      await chmodFn(powerDnsTemplatePolicy.databasePath, 0o640);
    } catch {
      throw new PowerDnsAuthoritativeManagerError('powerdns_database_permission_failed', 'PowerDNS SQLite database permissions could not be enforced');
    }
  }

  async function atomicConfig(content) {
    await mkdirFn(powerDnsTemplatePolicy.includeDirectory, { recursive: true, mode: 0o750 });
    const temporary = `${powerDnsTemplatePolicy.configPath}.${process.pid}.tmp`;
    try {
      await writeFileFn(temporary, content, { encoding: 'utf8', mode: 0o640 });
      await run(CHOWN, ['root:pdns', temporary], { timeout: 10_000 });
      await renameFn(temporary, powerDnsTemplatePolicy.configPath);
      await chmodFn(powerDnsTemplatePolicy.configPath, 0o640);
    } finally {
      try { await writeFileFn(temporary, '', { flag: 'a' }); } catch { /* ignored */ }
      try { await run('/usr/bin/rm', ['-f', temporary], { timeout: 5_000 }); } catch { /* ignored */ }
    }
  }

  async function configCheck() {
    try { await run(PDNS_SERVER, ['--config=check'], { timeout: 30_000, maxBuffer: 512 * 1024 }); }
    catch { throw new PowerDnsAuthoritativeManagerError('powerdns_config_invalid', 'PowerDNS rejected the managed configuration'); }
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
      const output = (await run(STAT, ['-c', '%U:%G:%a', target], { timeout: 10_000 })).stdout;
      const identity = fileIdentity(output);
      return Object.freeze({ ...identity, satisfied: identity.owner === expected.owner && identity.group === expected.group && identity.mode === expected.mode });
    } catch {
      return Object.freeze({ owner: null, group: null, mode: null, satisfied: false });
    }
  }

  async function inspect(rawIntent) {
    const spec = normalizeIntent(rawIntent);
    const packages = await Promise.all(powerDnsTemplatePolicy.packages.map(inspectPackage));
    const recursor = await inspectPackage('pdns-recursor');
    if (recursor.installed) return Object.freeze({ satisfied: false, reason: 'powerdns_recursor_conflict', packages, recursorInstalled: true });
    if (!packages.every((entry) => entry.installed)) return Object.freeze({ satisfied: false, reason: 'powerdns_packages_missing', packages, recursorInstalled: false });
    const base = await readOptional(BASE_CONFIG);
    if (base === null || !includeDirConfigured(base)) return Object.freeze({ satisfied: false, reason: 'powerdns_include_dir_missing', packages, recursorInstalled: false });
    const config = await readOptional(powerDnsTemplatePolicy.configPath);
    if (config === null) return Object.freeze({ satisfied: false, reason: 'powerdns_config_missing', packages, recursorInstalled: false });
    const currentHash = apiKeyHashFromConfig(config);
    if (!currentHash) throw new PowerDnsAuthoritativeManagerError('powerdns_config_drift', 'Managed PowerDNS API key hash is missing or invalid');
    const expectedConfig = renderManagedPowerDnsConfig({ apiKeyHash: currentHash, secondaryDns: spec.secondaryDns });
    if (config !== expectedConfig) throw new PowerDnsAuthoritativeManagerError('powerdns_config_drift', 'Managed PowerDNS configuration drifted');
    const [configIdentity, databaseIdentity, active, health] = await Promise.all([
      inspectPath(powerDnsTemplatePolicy.configPath, { owner: 'root', group: 'pdns', mode: '640' }),
      inspectPath(powerDnsTemplatePolicy.databasePath, { owner: 'pdns', group: 'pdns', mode: '640' }),
      serviceActive(),
      apiHealth(spec.apiKey),
    ]);
    if (!configIdentity.satisfied) return Object.freeze({ satisfied: false, reason: 'powerdns_config_permissions_invalid', packages, configIdentity, databaseIdentity, active, api: health });
    if (!databaseIdentity.satisfied) return Object.freeze({ satisfied: false, reason: 'powerdns_database_permissions_invalid', packages, configIdentity, databaseIdentity, active, api: health });
    if (!active) return Object.freeze({ satisfied: false, reason: 'powerdns_service_inactive', packages, configIdentity, databaseIdentity, active, api: health });
    if (!health.healthy) return Object.freeze({ satisfied: false, reason: 'powerdns_api_unhealthy', packages, configIdentity, databaseIdentity, active, api: health });
    const receiptRaw = await readOptional(RECEIPT_PATH);
    if (receiptRaw === null) return Object.freeze({ satisfied: false, reason: 'powerdns_receipt_missing', packages, configIdentity, databaseIdentity, active, api: health });
    let receipt;
    try { receipt = receiptValue(JSON.parse(receiptRaw), spec, config); }
    catch (error) { if (error instanceof PowerDnsAuthoritativeManagerError) throw error; throw new PowerDnsAuthoritativeManagerError('powerdns_receipt_invalid', 'PowerDNS authoritative receipt is invalid'); }
    return Object.freeze({
      satisfied: true,
      adapter: 'powerdns-authoritative-gsqlite3',
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

  async function persistReceipt(spec, config) {
    const directory = path.posix.dirname(RECEIPT_PATH);
    await mkdirFn(directory, { recursive: true, mode: 0o700 });
    const receipt = {
      version: 1,
      serverId: spec.serverId,
      apiKeyRevision: spec.apiKeyRevision,
      secondaryDns: [...spec.secondaryDns],
      configLength: Buffer.byteLength(config, 'utf8'),
      appliedAt: new Date(now()).toISOString(),
    };
    const temporary = `${RECEIPT_PATH}.${process.pid}.tmp`;
    await writeFileFn(temporary, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8', mode: 0o600 });
    await renameFn(temporary, RECEIPT_PATH);
    await chmodFn(RECEIPT_PATH, 0o600);
    return receiptValue(receipt, spec, config);
  }

  async function activate(configChanged) {
    await configCheck();
    try {
      await run(SYSTEMCTL, ['enable', '--now', powerDnsTemplatePolicy.serviceUnit], { timeout: 60_000 });
      if (configChanged) await run(SYSTEMCTL, ['restart', powerDnsTemplatePolicy.serviceUnit], { timeout: 60_000 });
    } catch {
      throw new PowerDnsAuthoritativeManagerError('powerdns_service_activation_failed', 'PowerDNS authoritative service could not be activated');
    }
  }

  async function apply(rawIntent) {
    const spec = normalizeIntent(rawIntent);
    await ensurePackages();
    await assertIncludeDirectory();
    await ensureDatabase();

    let currentConfig = await readOptional(powerDnsTemplatePolicy.configPath);
    let currentHash = currentConfig ? apiKeyHashFromConfig(currentConfig) : null;
    let desiredConfig = currentHash ? renderManagedPowerDnsConfig({ apiKeyHash: currentHash, secondaryDns: spec.secondaryDns }) : null;
    let configChanged = currentConfig === null || currentHash === null || currentConfig !== desiredConfig;

    if (configChanged) {
      currentHash = await hashPassword(spec.apiKey);
      desiredConfig = renderManagedPowerDnsConfig({ apiKeyHash: currentHash, secondaryDns: spec.secondaryDns });
      await atomicConfig(desiredConfig);
      currentConfig = desiredConfig;
    }

    await activate(configChanged);
    let health = await apiHealth(spec.apiKey);
    if (!health.healthy && !configChanged) {
      const rotatedHash = await hashPassword(spec.apiKey);
      desiredConfig = renderManagedPowerDnsConfig({ apiKeyHash: rotatedHash, secondaryDns: spec.secondaryDns });
      await atomicConfig(desiredConfig);
      await activate(true);
      currentConfig = desiredConfig;
      health = await apiHealth(spec.apiKey);
    }
    if (!health.healthy) throw new PowerDnsAuthoritativeManagerError('powerdns_api_unhealthy', 'PowerDNS API did not become healthy with the managed API key');
    await persistReceipt(spec, currentConfig);
    const verified = await inspect(spec);
    if (!verified.satisfied) throw new PowerDnsAuthoritativeManagerError('powerdns_apply_unverified', `PowerDNS authoritative apply could not be verified (${verified.reason})`);
    return verified;
  }

  async function activateRestored(rawIntent) {
    const spec = normalizeIntent(rawIntent);
    await assertIncludeDirectory();
    const config = await readOptional(powerDnsTemplatePolicy.configPath);
    if (config === null) {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_config_missing',
        'Restored PowerDNS managed configuration is missing',
      );
    }
    const restoredHash = apiKeyHashFromConfig(config);
    if (!restoredHash || renderManagedPowerDnsConfig({
      apiKeyHash: restoredHash,
      secondaryDns: spec.secondaryDns,
    }) !== config) {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_config_invalid',
        'Restored PowerDNS managed configuration does not match rollback intent',
      );
    }
    const receiptRaw = await readOptional(RECEIPT_PATH);
    if (receiptRaw === null) {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_receipt_missing',
        'Restored PowerDNS authoritative receipt is missing',
      );
    }
    try { receiptValue(JSON.parse(receiptRaw), spec, config); }
    catch {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_receipt_invalid',
        'Restored PowerDNS authoritative receipt does not match rollback intent',
      );
    }

    await activate(true);
    const health = await apiHealth(spec.apiKey);
    if (!health.healthy) {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_api_unhealthy',
        'PowerDNS API did not become healthy after rollback activation',
      );
    }
    const verified = await inspect(spec);
    if (!verified.satisfied) {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_unverified',
        `PowerDNS rollback activation could not be verified (${verified.reason})`,
      );
    }
    return verified;
  }

  return Object.freeze({ inspect, apply, activateRestored });
}

export const powerDnsAuthoritativeManagerInternals = Object.freeze({
  normalizeIntent,
  packageStatus,
  includeDirConfigured,
  apiKeyHashFromConfig,
  fileIdentity,
  receiptValue,
  defaultHashPassword,
  paths: Object.freeze({ BASE_CONFIG, RECEIPT_PATH, ...powerDnsTemplatePolicy }),
});
