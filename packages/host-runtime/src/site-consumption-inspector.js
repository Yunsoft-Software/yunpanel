import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createApplicationPathContract } from './website-path-contract.js';

const HOSTED_RUNTIMES = new Set(['static', 'node', 'php', 'python']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APP_USER_RE = /^yunapp-[a-f0-9]{12}$/;

function createConcurrencyGate(maxConcurrent = 2, maxQueue = 8) {
  let active = 0;
  const queue = [];
  return {
    acquire(signal) {
      if (signal?.aborted) return Promise.resolve('aborted');
      if (active < maxConcurrent) { active += 1; return Promise.resolve('acquired'); }
      if (queue.length >= maxQueue) return Promise.resolve('busy');
      return new Promise((resolve) => {
        const w = { off: false, ok: () => { signal?.removeEventListener?.('abort', onAbort); resolve('acquired'); } };
        const onAbort = () => { w.off = true; const i = queue.indexOf(w); if (i >= 0) queue.splice(i, 1); resolve('aborted'); };
        signal?.addEventListener?.('abort', onAbort, { once: true });
        queue.push(w);
      });
    },
    release() {
      if (active > 0) active -= 1;
      while (active < maxConcurrent && queue.length > 0) { const w = queue.shift(); if (!w.off) { active += 1; w.ok(); } }
    },
  };
}

const GLOBAL_IO_GATE = createConcurrencyGate(2, 8);
const canonicalSiteUser = (appId) => `yunapp-${createHash('sha256').update(appId.toLowerCase()).digest('hex').slice(0, 12)}`;
const isOverlap = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const failDisk = (reasonCode, reason) => Object.freeze({ ok: false, spaceMb: null, bytes: null, measuredAt: null, reasonCode, reason });
const failDb = (reasonCode, reason) => Object.freeze({ ok: false, databases: null, storageMb: null, measuredAt: null, reasonCode, reason });
const failTraffic = (reasonCode, reason) => Object.freeze({ ok: false, trafficMb: null, measuredAt: null, period: null, scope: null, reasonCode, reason });

function parseManagedPasswdUser(passwdText, user) {
  if (typeof passwdText !== 'string' || !APP_USER_RE.test(user)) return null;
  const matches = passwdText.split('\n').filter((line) => line.startsWith(`${user}:`));
  if (matches.length !== 1) return null;
  const f = matches[0].split(':');
  if (f.length !== 7 || !/^[1-9][0-9]{0,9}$/.test(f[2] ?? '') || !/^[1-9][0-9]{0,9}$/.test(f[3] ?? '')) return null;
  const uid = Number.parseInt(f[2], 10);
  const gid = Number.parseInt(f[3], 10);
  return Number.isSafeInteger(uid) && Number.isSafeInteger(gid) && uid > 0 && gid > 0 ? Object.freeze({ user, uid, gid }) : null;
}

const expectedDocumentRoot = (runtimeType, contract) => (
  runtimeType === 'static' ? path.posix.join(contract.static.publishRoot, 'current')
    : runtimeType === 'php' ? path.posix.join(contract.runtime.currentRelease, 'public') : contract.runtime.currentRelease
);

function safeNormalizedAbsolute(raw) {
  if (typeof raw !== 'string' || !path.posix.isAbsolute(raw)) return null;
  const norm = path.posix.normalize(raw.trim()).replace(/\/+$/, '');
  return norm && norm !== '/' ? norm : null;
}

function resolveCanonicalContract(website, pathContractOptions) {
  if (!HOSTED_RUNTIMES.has(website?.runtimeType) || typeof website?.applicationId !== 'string' || !UUID_RE.test(website.applicationId)) {
    return { error: failDisk('site_root_unverified', 'Bu site için doğrulanmış bir yerel uygulama dosya kökü bulunmuyor.') };
  }
  const contract = createApplicationPathContract(website.applicationId, pathContractOptions);
  const siteUser = canonicalSiteUser(contract.applicationId);
  if (website.unixUser && website.unixUser !== siteUser) {
    return { error: failDisk('site_identity_mismatch', 'Site sistem kullanıcısı doğrulanamadığı için disk kullanımı ölçülemedi.') };
  }
  const containerRoot = website.runtimeType === 'static' ? contract.static.publishRoot : contract.runtime.applicationRoot;
  if (typeof website.documentRoot === 'string' && website.documentRoot.trim() !== '') {
    const expected = expectedDocumentRoot(website.runtimeType, contract);
    const customRoot = Boolean(pathContractOptions?.staticPublishRoot || pathContractOptions?.applicationRoot);
    const defaultExpected = customRoot ? expectedDocumentRoot(website.runtimeType, createApplicationPathContract(website.applicationId)) : expected;
    const docRoot = safeNormalizedAbsolute(website.documentRoot);
    if (!docRoot || (docRoot !== expected && docRoot !== defaultExpected)) {
      return { error: failDisk('site_root_unverified', 'Site belge kökü standart uygulama sözleşmesiyle eşleşmediği için disk kullanımı ölçülemedi.') };
    }
  }
  return { containerRoot, currentPath: path.posix.join(containerRoot, 'current'), siteUser, applicationId: contract.applicationId };
}

function waitProcessGroupGone(pgid) {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const deadline = Date.now() + 2500;
    const probe = () => {
      try { process.kill(-pgid, 'SIGKILL'); } catch (err) { if (err?.code === 'ESRCH' || err?.code === 'EPERM') return resolve(); }
      try { process.kill(-pgid, 0); } catch (err) { if (err?.code === 'ESRCH' || err?.code === 'EPERM') return resolve(); }
      if (Date.now() >= deadline) return resolve();
      setTimeout(probe, 10).unref?.();
    };
    probe();
  });
}

function runDuProcess(command, args, { timeoutMs, signal }) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ ok: false, kind: 'aborted' });
    let child;
    try {
      child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { HOME: '/', LANG: 'C.UTF-8', LC_ALL: 'C', PATH: '/usr/bin:/bin' } });
    } catch (error) { return resolve({ ok: false, kind: 'spawn_error', code: error?.code ?? null }); }
    let stdout = '', overflow = false, killedReason = null, settled = false;
    const killGroup = (reason) => {
      if (!killedReason) killedReason = reason;
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    };
    const timer = setTimeout(() => killGroup('timeout'), timeoutMs);
    timer.unref?.();
    const onAbort = () => killGroup('aborted');
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); resolve(result); } };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { if (stdout.length + chunk.length > 64 * 1024) { overflow = true; killGroup('overflow'); } else stdout += chunk; });
    child.stderr.resume();
    child.once('error', (error) => finish({ ok: false, kind: 'spawn_error', code: error?.code ?? null }));
    child.once('close', async (code, termSignal) => {
      if (killedReason && child.pid) await waitProcessGroupGone(child.pid);
      if (killedReason === 'aborted' || signal?.aborted) return finish({ ok: false, kind: 'aborted' });
      if (killedReason === 'timeout') return finish({ ok: false, kind: 'timeout' });
      if (overflow || code !== 0 || termSignal !== null) return finish({ ok: false, kind: 'failed', code });
      finish({ ok: true, stdout });
    });
  });
}

function parseDuKib(stdout) {
  const lines = String(stdout ?? '').trim().split('\n').filter(Boolean);
  const match = lines.length === 1 ? /^(\d+)\s+/.exec(lines[0]) : null;
  const kib = match ? Number.parseInt(match[1], 10) : -1;
  return Number.isSafeInteger(kib) && kib >= 0 ? kib : null;
}

export function createLinuxSiteConsumptionAdapter({
  websiteRegistry = null, domainRegistry = null, databaseBindingRegistry = null, localServerId = null,
  pathContractOptions = {}, trafficInspector = null, maxDurationMs = 3000, maxConcurrent = null, maxQueue = null,
  allowCurrentUserWithoutSetpriv = false, verifyOwnerUid = true,
  getuid = () => (typeof process.getuid === 'function' ? process.getuid() : -1),
  setprivPath = '/usr/bin/setpriv', duPath = '/usr/bin/du', passwdPath = '/etc/passwd', now = () => Date.now(),
} = {}) {
  const timeoutMs = Number.isFinite(maxDurationMs) && maxDurationMs > 0 ? maxDurationMs : 3000;
  const gate = (Number.isSafeInteger(maxConcurrent) && maxConcurrent > 0) || (Number.isSafeInteger(maxQueue) && maxQueue >= 0)
    ? createConcurrencyGate(maxConcurrent ?? 2, maxQueue ?? 8)
    : GLOBAL_IO_GATE;

  async function hasSharedRootOverlap(website, roots, applicationId) {
    const overlapsAny = (candidate) => Boolean(candidate) && roots.some((root) => isOverlap(root, candidate));
    const others = typeof websiteRegistry?.listWebsites === 'function' ? await websiteRegistry.listWebsites() : [];
    for (const other of Array.isArray(others) ? others : []) {
      if (!other || other.id === website.id || (localServerId && other.serverId && other.serverId !== localServerId)) continue;
      if (typeof other.applicationId === 'string' && other.applicationId.toLowerCase() === applicationId) return true;
      if (overlapsAny(resolveCanonicalContract(other, pathContractOptions).containerRoot) || overlapsAny(safeNormalizedAbsolute(other.documentRoot))) return true;
    }
    const domains = typeof domainRegistry?.listDomains === 'function' ? await domainRegistry.listDomains() : [];
    for (const d of Array.isArray(domains) ? domains : []) {
      if (!d || d.websiteId === website.id || (localServerId && d.serverId && d.serverId !== localServerId)) continue;
      if (overlapsAny(safeNormalizedAbsolute(d.documentRoot ?? d.target?.root))) return true;
    }
    return false;
  }

  async function getDiskUsage(websiteId, providedWebsite = null, { signal = null } = {}) {
    let website = providedWebsite;
    if (!website && typeof websiteRegistry?.getWebsite === 'function') {
      try { website = await websiteRegistry.getWebsite(websiteId); } catch { return failDisk('disk_measurement_failed', 'Site kaydı okunamadığı için disk kullanımı ölçülemedi.'); }
    }
    if (!website) return failDisk('website_not_found', 'Site kaydı bulunamadığı için disk kullanımı ölçülemedi.');
    if (localServerId && website.serverId && website.serverId !== localServerId) {
      return failDisk('remote_server_unsupported', 'Uzak sunucudaki sitelerin disk kullanımı bu sunucudan doğrudan ölçülemez.');
    }

    const resolved = resolveCanonicalContract(website, pathContractOptions);
    if (resolved.error) return resolved.error;
    const { containerRoot, currentPath, siteUser, applicationId } = resolved;

    let containerReal, verifiedContentRoot;
    try {
      const containerStat = await lstat(containerRoot);
      if (containerStat.isSymbolicLink() || !containerStat.isDirectory()) return failDisk('site_root_invalid', 'Site uygulama konteyneri geçerli bir dizin değil.');
      containerReal = (await realpath(containerRoot)).replace(/\/+$/, '');
      verifiedContentRoot = (await realpath(currentPath)).replace(/\/+$/, '');
    } catch (error) {
      return error?.code === 'ENOENT'
        ? failDisk('site_root_not_deployed', 'Site dosya kökü henüz sunucuda oluşturulmadığı için disk kullanımı ölçülemedi.')
        : failDisk('disk_measurement_failed', 'Site dosya kökü doğrulanamadığı için disk kullanımı ölçülemedi.');
    }

    const releaseSegment = verifiedContentRoot.startsWith(`${containerReal}/releases/`) ? verifiedContentRoot.slice(containerReal.length + '/releases/'.length) : null;
    const isDirectRelease = Boolean(releaseSegment && !releaseSegment.includes('/') && releaseSegment !== '.' && releaseSegment !== '..');
    if (verifiedContentRoot !== `${containerReal}/current` && !isDirectRelease) {
      return failDisk('site_root_invalid', 'Site aktif sürüm kökü uygulama dizini sınırlarının dışında olduğu için disk kullanımı ölçülemedi.');
    }

    let contentStat;
    try { contentStat = await lstat(verifiedContentRoot); } catch { return failDisk('disk_measurement_failed', 'Site aktif sürüm kökü okunamadığı için disk kullanımı ölçülemedi.'); }
    if (contentStat.isSymbolicLink() || !contentStat.isDirectory()) {
      return failDisk('site_root_invalid', 'Site aktif sürüm kökü geçerli bir dizin olmadığı için disk kullanımı ölçülemedi.');
    }

    const uid = getuid();
    let account = null;
    if (uid === 0 || verifyOwnerUid) {
      try { account = parseManagedPasswdUser(await readFile(passwdPath, 'utf8'), siteUser); } catch { account = null; }
      if (uid === 0 && !account) return failDisk('site_user_unavailable', 'Site sistem kullanıcısı bulunamadığı için disk kullanımı ölçülemedi.');
      if (account && (contentStat.uid !== account.uid || contentStat.gid !== account.gid)) {
        return failDisk('site_root_owner_mismatch', 'Site dosya kökünün sistem sahibi beklenen site kullanıcısıyla eşleşmediği için disk kullanımı ölçülemedi.');
      }
    }

    try {
      if (await hasSharedRootOverlap(website, [containerRoot, containerReal, verifiedContentRoot], applicationId)) {
        return failDisk('shared_root_overlap', 'Bu site başka bir siteyle aynı veya iç içe dosya kökünü paylaştığı için tekil disk kullanımı ayrıştırılamadı.');
      }
    } catch { return failDisk('disk_measurement_failed', 'Site dizin izolasyonu doğrulanamadığı için disk kullanımı ölçülemedi.'); }

    let command = duPath, args = ['-s', '-x', '-P', '-k', '--', verifiedContentRoot];
    if (uid === 0) {
      command = setprivPath;
      args = [`--reuid=${account.uid}`, `--regid=${account.gid}`, '--clear-groups', '--no-new-privs', '--', duPath, '-s', '-x', '-P', '-k', '--', verifiedContentRoot];
    } else if (!allowCurrentUserWithoutSetpriv) {
      return failDisk('site_user_unavailable', 'Site kullanıcısı izolasyonu olmadan disk ölçümü çalıştırılamaz.');
    }

    const slot = await gate.acquire(signal);
    if (slot === 'busy') return failDisk('disk_measurement_busy', 'Sunucuda yoğun disk ölçümü sürdüğü için istek geçici olarak ertelendi.');
    if (slot === 'aborted') return failDisk('disk_measurement_aborted', 'Disk ölçümü iptal edildi.');

    try {
      const result = await runDuProcess(command, args, { timeoutMs, signal });
      if (!result.ok) {
        if (result.kind === 'aborted') return failDisk('disk_measurement_aborted', 'Disk ölçümü iptal edildi.');
        if (result.kind === 'timeout') return failDisk('disk_measurement_timeout', 'Site disk ölçümü zaman sınırını aştığı için tamamlanamadı.');
        if (uid === 0 && result.kind === 'spawn_error' && result.code === 'ENOENT') return failDisk('site_user_unavailable', 'Site yetki düşürme aracı bulunamadığı için disk kullanımı ölçülemedi.');
        return failDisk('disk_measurement_failed', 'Site disk kullanımı ölçülemedi.');
      }
      const kib = parseDuKib(result.stdout);
      if (kib === null) return failDisk('disk_measurement_failed', 'Disk ölçüm çıktısı doğrulanamadığı için değer gösterilmiyor.');
      return Object.freeze({ ok: true, bytes: kib * 1024, spaceMb: Number((kib / 1024).toFixed(2)), measuredAt: new Date(now()).toISOString(), scope: 'active_release_root' });
    } finally { gate.release(); }
  }

  async function getDatabaseUsage(websiteId, providedWebsite = null) {
    if (!databaseBindingRegistry || (typeof databaseBindingRegistry.listBindings !== 'function' && typeof databaseBindingRegistry.listDatabaseBindings !== 'function')) {
      return failDb('database_inventory_unavailable', 'Veritabanı bağlantı envanteri okunamadığı için sayı doğrulanamadı.');
    }
    let website = providedWebsite;
    if (!website && typeof websiteRegistry?.getWebsite === 'function') { try { website = await websiteRegistry.getWebsite(websiteId); } catch { website = null; } }
    try {
      const bindings = typeof databaseBindingRegistry.listBindings === 'function'
        ? await databaseBindingRegistry.listBindings({ serverId: website?.serverId ?? null, websiteId })
        : await databaseBindingRegistry.listDatabaseBindings();
      if (!Array.isArray(bindings)) return failDb('database_inventory_unavailable', 'Veritabanı bağlantı envanteri okunamadığı için sayı doğrulanamadı.');
      const count = bindings.filter((b) => b && b.websiteId === websiteId && (!website?.serverId || b.serverId === website.serverId) && (!website?.applicationId || b.applicationId === website.applicationId)).length;
      return Object.freeze({ ok: true, databases: count, storageMb: null, measuredAt: new Date(now()).toISOString(), scope: 'canonical_active_bindings' });
    } catch { return failDb('database_inventory_unavailable', 'Veritabanı bağlantı envanteri okunamadığı için sayı doğrulanamadı.'); }
  }

  async function getTrafficUsage(websiteId, website = null) {
    if (trafficInspector) {
      try {
        const fn = typeof trafficInspector === 'function' ? trafficInspector : trafficInspector.getTrafficUsage ?? trafficInspector.inspectWebsite;
        const res = typeof fn === 'function' ? await fn(websiteId, website) : null;
        const ts = res?.measuredAt != null ? (typeof res.measuredAt === 'number' ? res.measuredAt : Date.parse(res.measuredAt)) : Number.NaN;
        if (res && typeof res.trafficMb === 'number' && Number.isFinite(res.trafficMb) && res.trafficMb >= 0 && typeof res.period === 'string' && res.period.trim() && typeof res.scope === 'string' && res.scope.trim() && Number.isFinite(ts) && ts > 0) {
          return Object.freeze({ ok: true, trafficMb: res.trafficMb, period: res.period.trim(), scope: res.scope.trim(), measuredAt: new Date(ts).toISOString() });
        }
        if (res?.ok === false) return failTraffic(res.reasonCode || 'traffic_source_unavailable', res.reason || 'Aylık trafik verisi okunamadı.');
      } catch { return failTraffic('traffic_source_unavailable', 'Aylık trafik verisi okunamadı.'); }
    }
    return failTraffic('traffic_source_unavailable', 'Site bazında kalıcı aylık trafik sayacı bulunmuyor; statik dosya isteklerinde Nginx erişim günlüğü kapalı olduğu için eksik trafik verisi gösterilmiyor.');
  }

  return Object.freeze({ getDiskUsage, getDatabaseUsage, getTrafficUsage });
}

export const siteConsumptionInspectorInternals = Object.freeze({
  hostedRuntimes: Object.freeze([...HOSTED_RUNTIMES]),
  canonicalSiteUser,
  parseManagedPasswdUser,
  parseDuKib,
  createConcurrencyGate,
});
