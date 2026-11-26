// In-memory Ubuntu host for PowerDNS authoritative manager tests: filesystem with owners and
// modes, command runner (dpkg, apt, systemctl, stat, chown, sqlite3, pdns_server), API endpoint
// and DNS socket inspector. Tests drive the real manager against it and inspect what it left.
import { powerDnsTemplatePolicy, renderManagedPowerDnsConfig } from '@yunpanel/config-templates/powerdns';
import {
  createPowerDnsAuthoritativeManager,
  powerDnsAuthoritativeManagerInternals,
} from '../src/powerdns-authoritative-manager.js';

export const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
export const apiKey = 'A'.repeat(43);
export const otherApiKey = 'B'.repeat(43);
export const currentSecondaryDns = Object.freeze(['203.0.113.20']);
export const previousSecondaryDns = Object.freeze(['198.51.100.53']);
export const healthySockets = Object.freeze({ satisfied: true, udp53: true, tcp53: true, recursive: false });
export const paths = Object.freeze({
  config: powerDnsTemplatePolicy.configPath,
  database: powerDnsTemplatePolicy.databasePath,
  receipt: powerDnsAuthoritativeManagerInternals.paths.RECEIPT_PATH,
  journal: powerDnsAuthoritativeManagerInternals.paths.OPERATION_PATH,
  snapshot: powerDnsAuthoritativeManagerInternals.paths.ROLLBACK_SNAPSHOT_PATH,
  compensation: powerDnsAuthoritativeManagerInternals.paths.ROLLBACK_COMPENSATION_PATH,
  baseConfig: powerDnsAuthoritativeManagerInternals.paths.BASE_CONFIG,
  schema: powerDnsAuthoritativeManagerInternals.schemaPaths[0],
});

const USERS = Object.freeze({ root: 0, pdns: 113 });
const NAMES = Object.freeze({ 0: 'root', 113: 'pdns' });

export function intent(overrides = {}) {
  return { serverId, apiKey, apiKeyRevision: 2, secondaryDns: [...currentSecondaryDns], ...overrides };
}

export function fakeHash(value) {
  return `$scrypt$fake-hash-for-${value}`;
}

export function configFor(secondaryDns, key = apiKey) {
  return renderManagedPowerDnsConfig({ apiKeyHash: fakeHash(key), secondaryDns });
}

function fsError(code) {
  return Object.assign(new Error(code), { code });
}

export function createFakeHost({ clock = '2026-09-16T12:00:00.000Z' } = {}) {
  const files = new Map();
  const directories = new Set();
  const host = {
    files,
    calls: [],
    writes: [],
    restarts: [],
    hashes: 0,
    socketChecks: 0,
    socketResults: [],
    clock: Date.parse(clock),
    packagesInstalled: true,
    recursorInstalled: false,
    running: false,
    rejectConfig: false,
    failActivations: 0,
    inactiveChecks: 0,
    databaseAsSymlink: false,
    lstatErrors: new Set(),
    apiUnhealthyFor: () => false,
    onRun: null,
    onRename: null,
  };

  function put(target, content, { uid = 0, gid = 0, mode = 0o600, type = 'file' } = {}) {
    files.set(target, { content: Buffer.from(content), uid, gid, mode, type });
  }

  function isDirectory(target) {
    return directories.has(target) || [...files.keys()].some((file) => file.startsWith(`${target}/`));
  }

  const fs = {
    async lstatFn(target) {
      if (host.lstatErrors.has(target)) throw fsError('EACCES');
      const entry = files.get(target);
      if (entry) {
        return {
          isFile: () => entry.type === 'file',
          isSymbolicLink: () => entry.type === 'symlink',
          isDirectory: () => entry.type === 'directory',
          uid: entry.uid,
          gid: entry.gid,
          mode: (entry.type === 'directory' ? 0o040000 : 0o100000) | entry.mode,
        };
      }
      if (isDirectory(target)) {
        return { isFile: () => false, isSymbolicLink: () => false, isDirectory: () => true, uid: 0, gid: 0, mode: 0o040755 };
      }
      throw fsError('ENOENT');
    },
    async readFileFn(target, encoding) {
      const entry = files.get(target);
      if (!entry) throw fsError('ENOENT');
      if (entry.type === 'directory') throw fsError('EISDIR');
      const content = Buffer.from(entry.content);
      return encoding ? content.toString(encoding) : content;
    },
    async writeFileFn(target, content, options = {}) {
      host.writes.push(target);
      const buffer = Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content, options.encoding ?? 'utf8');
      files.set(target, { content: buffer, uid: 0, gid: 0, mode: options.mode ?? 0o644, type: 'file' });
    },
    async renameFn(from, to) {
      const entry = files.get(from);
      if (!entry) throw fsError('ENOENT');
      files.set(to, entry);
      files.delete(from);
      await host.onRename?.(from, to);
    },
    async rmFn(target, { force = false } = {}) {
      if (!files.delete(target) && !force) throw fsError('ENOENT');
    },
    async chmodFn(target, mode) {
      const entry = files.get(target);
      if (entry) entry.mode = mode & 0o777;
      else if (!isDirectory(target)) throw fsError('ENOENT');
    },
    async chownFn(target, uid, gid) {
      const entry = files.get(target);
      if (!entry) throw fsError('ENOENT');
      Object.assign(entry, { uid, gid });
    },
    async mkdirFn(target) { directories.add(target); },
    async readdirFn(target) {
      return [...files.keys()].filter((file) => file.startsWith(`${target}/`)).map((file) => file.slice(target.length + 1));
    },
  };

  function configText() {
    return files.get(paths.config)?.content.toString('utf8') ?? '';
  }

  async function run(file, args) {
    host.calls.push([file, [...args]]);
    await host.onRun?.(file, args);
    const target = args.at(-1);
    if (file === '/usr/bin/dpkg-query') {
      if (target === 'pdns-recursor') return { stdout: host.recursorInstalled ? 'install ok installed\t1' : 'deinstall ok config-files\t' };
      if (!host.packagesInstalled) throw new Error('package is not installed');
      return { stdout: 'install ok installed\t4.8.3-1ubuntu1' };
    }
    if (file === '/usr/bin/apt-get' && args[0] === 'install') host.packagesInstalled = true;
    if (file === '/usr/bin/sqlite3') put(args[0], 'sqlite', { mode: 0o644, type: host.databaseAsSymlink ? 'symlink' : 'file' });
    if (file === '/usr/bin/chown') {
      const [user, group] = args[0].split(':');
      const entry = files.get(target);
      if (!entry) throw fsError('ENOENT');
      Object.assign(entry, { uid: USERS[user], gid: USERS[group] });
    }
    if (file === '/usr/sbin/pdns_server' && host.rejectConfig) throw new Error('config check failed');
    if (file === '/usr/bin/stat') {
      const entry = files.get(target);
      if (!entry) throw fsError('ENOENT');
      return { stdout: `${NAMES[entry.uid]}:${NAMES[entry.gid]}:${entry.mode.toString(8)}\n` };
    }
    if (file === '/usr/bin/systemctl') {
      if (args[0] === 'enable' || args[0] === 'restart') {
        if (host.failActivations > 0) {
          host.failActivations -= 1;
          throw new Error('systemctl result is ambiguous');
        }
        host.running = true;
        if (args[0] === 'restart') host.restarts.push(configText());
      }
      if (args[0] === 'is-active') {
        if (host.inactiveChecks > 0) {
          host.inactiveChecks -= 1;
          throw new Error('inactive');
        }
        if (!host.running) throw new Error('inactive');
      }
      if (args[0] === 'show') return { stdout: 'ActiveState=inactive\nSubState=dead\nLoadState=not-found\nMainPID=0\n' };
    }
    return { stdout: '' };
  }

  async function fetchFn(_url, { headers }) {
    const config = configText();
    const healthy = host.running && config.includes(`api-key=${fakeHash(headers['X-API-Key'])}\n`)
      && !host.apiUnhealthyFor(config);
    return { ok: healthy, status: healthy ? 200 : 401, async json() { return { id: 'localhost' }; } };
  }

  const socketInspector = {
    async inspect() {
      host.socketChecks += 1;
      return host.socketResults.length ? host.socketResults.shift() : healthySockets;
    },
  };

  let nextId = 0;
  host.manager = (overrides = {}) => createPowerDnsAuthoritativeManager({
    run,
    fetchFn,
    async hashPassword(value) { host.hashes += 1; return fakeHash(value); },
    socketInspector,
    now: () => host.clock,
    idFactory: () => `operation-${++nextId}`,
    ...fs,
    ...overrides,
  });
  host.fs = fs;
  host.put = put;
  host.text = (target) => files.get(target)?.content.toString('utf8') ?? null;
  host.bytes = (target) => (files.has(target) ? Buffer.from(files.get(target).content) : null);
  host.meta = (target) => {
    const entry = files.get(target);
    return entry ? { uid: entry.uid, gid: entry.gid, mode: entry.mode } : null;
  };
  host.journal = () => JSON.parse(host.text(paths.journal));
  host.editJournal = (update) => {
    const entry = files.get(paths.journal);
    entry.content = Buffer.from(JSON.stringify({ ...host.journal(), ...update }));
  };
  host.commands = (file, first) => host.calls.filter(([name, args]) => name === file && (first === undefined || args[0] === first));
  host.configWrites = () => host.writes.filter((target) => target.startsWith(`${paths.config}.`)).length;

  put(paths.baseConfig, 'include-dir=/etc/powerdns/pdns.d\n', { mode: 0o644 });
  put(paths.schema, 'CREATE TABLE domains (id INTEGER PRIMARY KEY);\n', { mode: 0o644 });
  return host;
}

// Applies the previous secondary DNS set, then the current one, so the second operation owns an
// available rollback snapshot of the first. Returns the second operation's public record.
export async function hostWithRollbackSnapshot(options) {
  const host = createFakeHost(options);
  const manager = host.manager();
  await manager.apply(intent({ secondaryDns: [...previousSecondaryDns] }));
  host.clock += 60_000;
  await manager.apply(intent());
  return { host, manager, operation: await manager.operation() };
}

export function rollbackRequest(operation, overrides = {}) {
  return {
    operationId: operation.id,
    expectedUpdatedAt: operation.updatedAt,
    snapshotDigest: operation.rollback.snapshotDigest,
    ...overrides,
  };
}
