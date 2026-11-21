import assert from 'node:assert/strict';
import { chmodSync, closeSync, existsSync, ftruncateSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLinuxSiteConsumptionAdapter, siteConsumptionInspectorInternals } from '../src/site-consumption-inspector.js';

const SERVER_LOCAL = '11111111-1111-4111-8111-111111111111';
const SERVER_REMOTE = '22222222-2222-4222-8222-222222222222';
const APP_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const APP_EMPTY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const APP_DRAFT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const APP_ESCAPE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const APP_SUB = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SITE_A = '10000000-0000-4000-8000-000000000001';
const SITE_EMPTY = '10000000-0000-4000-8000-000000000002';
const SITE_DRAFT = '10000000-0000-4000-8000-000000000003';
const SITE_ESCAPE = '10000000-0000-4000-8000-000000000004';
const SITE_OVERLAP = '10000000-0000-4000-8000-000000000005';

function makeStaticSite(id, applicationId, overrides = {}) {
  return {
    id,
    serverId: SERVER_LOCAL,
    name: `site-${id.slice(-1)}`,
    runtimeType: 'static',
    applicationId,
    unixUser: siteConsumptionInspectorInternals.canonicalSiteUser(applicationId),
    documentRoot: `/var/www/yunpanel/apps/${applicationId}/current`,
    ...overrides,
  };
}

function assertPidDead(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, `expected valid pid, got ${pid}`);
  assert.throws(() => process.kill(pid, 0), (err) => err?.code === 'ESRCH', `PID ${pid} MUST be dead (ESRCH) before measurement resolves`);
}

test('createLinuxSiteConsumptionAdapter: active release root du measurement, hard-link dedup, symlink isolation, empty dir, draft dir, and current escape rejection', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-consumption-fs-'));
  try {
    const staticPublishRoot = path.join(tmpDir, 'static-apps');
    const applicationRoot = path.join(tmpDir, 'runtime-apps');
    const dataRoot = path.join(tmpDir, 'data');
    const foreignDir = path.join(tmpDir, 'foreign-tenant');
    mkdirSync(staticPublishRoot, { recursive: true });
    mkdirSync(applicationRoot, { recursive: true });
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(foreignDir, { recursive: true });

    // Foreign tenant has a 2 MiB file that must NEVER be counted via symlink
    writeFileSync(path.join(foreignDir, 'secret-2mb.bin'), Buffer.alloc(2 * 1024 * 1024, 0x42));

    // Site A uses production atomic release layout: current -> releases/rel-001
    const siteAContainer = path.join(staticPublishRoot, APP_A);
    const siteARelease = path.join(siteAContainer, 'releases', 'rel-001');
    mkdirSync(siteARelease, { recursive: true });
    symlinkSync(siteARelease, path.join(siteAContainer, 'current'));
    const realFile = path.join(siteARelease, 'payload.bin');
    writeFileSync(realFile, Buffer.alloc(256 * 1024, 0x41));
    symlinkSync(foreignDir, path.join(siteARelease, 'escape-to-foreign'));

    // Empty site active release: legitimately exists and is empty
    const emptyContainer = path.join(staticPublishRoot, APP_EMPTY);
    const emptyRelease = path.join(emptyContainer, 'releases', 'rel-empty');
    mkdirSync(emptyRelease, { recursive: true });
    symlinkSync(emptyRelease, path.join(emptyContainer, 'current'));

    // Draft site: container exists, but current release does NOT exist yet
    mkdirSync(path.join(staticPublishRoot, APP_DRAFT), { recursive: true });

    // Escaping current symlink: current -> foreignDir (must be rejected fail-closed!)
    const escapeContainer = path.join(staticPublishRoot, APP_ESCAPE);
    mkdirSync(escapeContainer, { recursive: true });
    symlinkSync(foreignDir, path.join(escapeContainer, 'current'));

    const sites = [
      makeStaticSite(SITE_A, APP_A),
      makeStaticSite(SITE_EMPTY, APP_EMPTY),
      makeStaticSite(SITE_DRAFT, APP_DRAFT),
      makeStaticSite(SITE_ESCAPE, APP_ESCAPE),
    ];
    const websiteRegistry = {
      async listWebsites() { return sites; },
      async getWebsite(id) { return sites.find((s) => s.id === id) ?? null; },
    };

    const fixedNow = Date.parse('2026-11-21T16:30:00.000Z');
    const adapter = createLinuxSiteConsumptionAdapter({
      websiteRegistry,
      localServerId: SERVER_LOCAL,
      pathContractOptions: { staticPublishRoot, applicationRoot, dataRoot },
      allowCurrentUserWithoutSetpriv: true,
      getuid: () => 501,
      now: () => fixedNow,
    });

    // 1. Real du measurement on active release without following inner symlink into foreign 2 MiB dir
    const resA1 = await adapter.getDiskUsage(SITE_A);
    assert.equal(resA1.ok, true);
    assert.ok(resA1.bytes >= 256 * 1024, `expected >= 256 KiB, got ${resA1.bytes}`);
    assert.ok(resA1.bytes < 1024 * 1024, `symlink target must NOT be counted, got ${resA1.bytes}`);
    assert.equal(resA1.spaceMb, Number((resA1.bytes / (1024 * 1024)).toFixed(2)));
    assert.equal(resA1.measuredAt, '2026-11-21T16:30:00.000Z');
    assert.equal(resA1.scope, 'active_release_root');
    assert.equal(resA1.inodes, undefined, 'single-call du must not spawn a second inode pass');

    // 2. Hard link to the same 256 KiB file must NOT double bytes (du -s deduplicates hard links)
    linkSync(realFile, path.join(siteARelease, 'payload-hardlink.bin'));
    const resA2 = await adapter.getDiskUsage(SITE_A);
    assert.equal(resA2.ok, true);
    assert.equal(resA2.bytes, resA1.bytes, 'hard link must be deduplicated');

    // 3. Legitimately existing empty active release returns a real non-negative block count (0 on APFS/tmpfs, 4 KiB on ext4) + valid measuredAt
    const resEmpty = await adapter.getDiskUsage(SITE_EMPTY);
    assert.equal(resEmpty.ok, true);
    assert.ok(Number.isSafeInteger(resEmpty.bytes) && resEmpty.bytes >= 0 && resEmpty.bytes <= 16 * 1024, `expected empty dir bytes <= 16 KiB, got ${resEmpty.bytes}`);
    assert.ok(typeof resEmpty.spaceMb === 'number' && resEmpty.spaceMb >= 0 && resEmpty.spaceMb <= 0.02, `expected empty dir spaceMb <= 0.02, got ${resEmpty.spaceMb}`);
    assert.equal(resEmpty.measuredAt, '2026-11-21T16:30:00.000Z');

    // 4. Draft/undeployed site (missing current) fails honestly with null and measuredAt: null
    const resDraft = await adapter.getDiskUsage(SITE_DRAFT);
    assert.equal(resDraft.ok, false);
    assert.equal(resDraft.spaceMb, null);
    assert.equal(resDraft.bytes, null);
    assert.equal(resDraft.measuredAt, null);
    assert.equal(resDraft.reasonCode, 'site_root_not_deployed');

    // 5. Escaping current symlink is rejected fail-closed
    const resEscape = await adapter.getDiskUsage(SITE_ESCAPE);
    assert.equal(resEscape.ok, false);
    assert.equal(resEscape.spaceMb, null);
    assert.equal(resEscape.bytes, null);
    assert.equal(resEscape.measuredAt, null);
    assert.equal(resEscape.reasonCode, 'site_root_invalid');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('createLinuxSiteConsumptionAdapter: identity/contract checks, remote rejection, shared root overlap, and permission errors fail closed', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-consumption-guard-'));
  const lockedSubdir = path.join(tmpDir, 'static-apps', APP_A, 'current', 'locked');
  try {
    const staticPublishRoot = path.join(tmpDir, 'static-apps');
    const siteACurrent = path.join(staticPublishRoot, APP_A, 'current');
    mkdirSync(siteACurrent, { recursive: true });
    writeFileSync(path.join(siteACurrent, 'index.html'), 'hello');

    const siteA = makeStaticSite(SITE_A, APP_A);
    const sharedOverlapSite = makeStaticSite(SITE_OVERLAP, APP_SUB, {
      documentRoot: path.join(staticPublishRoot, APP_A, 'subdomains', 'api'),
    });

    const adapter = createLinuxSiteConsumptionAdapter({
      websiteRegistry: {
        async listWebsites() { return [siteA, sharedOverlapSite]; },
        async getWebsite(id) { return id === SITE_A ? siteA : null; },
      },
      localServerId: SERVER_LOCAL,
      pathContractOptions: { staticPublishRoot },
      allowCurrentUserWithoutSetpriv: true,
      getuid: () => 501,
    });

    const overlap = await adapter.getDiskUsage(SITE_A, siteA);
    assert.equal(overlap.ok, false);
    assert.equal(overlap.spaceMb, null);
    assert.equal(overlap.bytes, null);
    assert.equal(overlap.measuredAt, null);
    assert.equal(overlap.reasonCode, 'shared_root_overlap');

    const remote = await adapter.getDiskUsage(SITE_A, { ...siteA, serverId: SERVER_REMOTE });
    assert.equal(remote.ok, false);
    assert.equal(remote.reasonCode, 'remote_server_unsupported');
    assert.equal(remote.measuredAt, null);

    const badUser = await adapter.getDiskUsage(SITE_A, { ...siteA, unixUser: 'yunapp-000000000000' });
    assert.equal(badUser.ok, false);
    assert.equal(badUser.reasonCode, 'site_identity_mismatch');
    assert.equal(badUser.measuredAt, null);

    const badDocRoot = await adapter.getDiskUsage(SITE_A, { ...siteA, documentRoot: '/var/www/vhosts/custom.test' });
    assert.equal(badDocRoot.ok, false);
    assert.equal(badDocRoot.reasonCode, 'site_root_unverified');
    assert.equal(badDocRoot.measuredAt, null);

    const dockerSite = await adapter.getDiskUsage(SITE_A, { ...siteA, runtimeType: 'docker', applicationId: null });
    assert.equal(dockerSite.ok, false);
    assert.equal(dockerSite.reasonCode, 'site_root_unverified');
    assert.equal(dockerSite.measuredAt, null);

    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      mkdirSync(lockedSubdir, { recursive: true });
      writeFileSync(path.join(lockedSubdir, 'hidden.txt'), 'secret');
      chmodSync(lockedSubdir, 0o000);
      const isolatedAdapter = createLinuxSiteConsumptionAdapter({
        websiteRegistry: { async listWebsites() { return [siteA]; }, async getWebsite() { return siteA; } },
        localServerId: SERVER_LOCAL,
        pathContractOptions: { staticPublishRoot },
        allowCurrentUserWithoutSetpriv: true,
        getuid: () => 501,
      });
      const permRes = await isolatedAdapter.getDiskUsage(SITE_A, siteA);
      assert.equal(permRes.ok, false);
      assert.equal(permRes.spaceMb, null);
      assert.equal(permRes.bytes, null);
      assert.equal(permRes.measuredAt, null);
      assert.equal(permRes.reasonCode, 'disk_measurement_failed');
    }
  } finally {
    try { chmodSync(lockedSubdir, 0o700); } catch {}
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('createLinuxSiteConsumptionAdapter: root setpriv UID/GID + owner check, zero-orphan timeout/abort kill, and concurrency gate', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-consumption-exec-'));
  try {
    const staticPublishRoot = path.join(tmpDir, 'static-apps');
    const siteAContainer = path.join(staticPublishRoot, APP_A);
    const siteARelease = path.join(siteAContainer, 'releases', 'rel-20261121');
    mkdirSync(siteARelease, { recursive: true });
    symlinkSync(siteARelease, path.join(siteAContainer, 'current'));
    writeFileSync(path.join(siteARelease, 'data.bin'), Buffer.alloc(64 * 1024, 0x33));
    const canonicalRelease = realpathSync(siteARelease);

    const siteA = makeStaticSite(SITE_A, APP_A);
    const websiteRegistry = { async listWebsites() { return [siteA]; }, async getWebsite() { return siteA; } };
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : 501;
    const currentGid = typeof process.getgid === 'function' ? process.getgid() : 20;

    // 1. Non-root without explicit opt-in fails closed
    const nonRootDefault = createLinuxSiteConsumptionAdapter({
      websiteRegistry,
      localServerId: SERVER_LOCAL,
      pathContractOptions: { staticPublishRoot },
      getuid: () => currentUid || 501,
    });
    const deniedNonRoot = await nonRootDefault.getDiskUsage(SITE_A, siteA);
    assert.equal(deniedNonRoot.ok, false);
    assert.equal(deniedNonRoot.reasonCode, 'site_user_unavailable');
    assert.equal(deniedNonRoot.measuredAt, null);

    // 2. Root (uid 0) with missing siteUser in /etc/passwd fails closed
    const emptyPasswd = path.join(tmpDir, 'passwd-empty');
    writeFileSync(emptyPasswd, 'root:x:0:0:root:/root:/bin/bash\n');
    const rootMissingUser = createLinuxSiteConsumptionAdapter({
      websiteRegistry,
      localServerId: SERVER_LOCAL,
      pathContractOptions: { staticPublishRoot },
      getuid: () => 0,
      passwdPath: emptyPasswd,
    });
    const missingUserRes = await rootMissingUser.getDiskUsage(SITE_A, siteA);
    assert.equal(missingUserRes.ok, false);
    assert.equal(missingUserRes.reasonCode, 'site_user_unavailable');
    assert.equal(missingUserRes.measuredAt, null);

    // 3. Root (uid 0) with mismatched directory owner UID/GID fails closed (site_root_owner_mismatch)
    const wrongOwnerPasswd = path.join(tmpDir, 'passwd-wrong-owner');
    writeFileSync(wrongOwnerPasswd, `root:x:0:0:root:/root:/bin/bash\n${siteA.unixUser}:x:${currentUid + 777}:${currentGid + 777}::/var/lib/yunpanel/data/${APP_A}:/usr/sbin/nologin\n`);
    const rootMismatchAdapter = createLinuxSiteConsumptionAdapter({
      websiteRegistry,
      localServerId: SERVER_LOCAL,
      pathContractOptions: { staticPublishRoot },
      getuid: () => 0,
      passwdPath: wrongOwnerPasswd,
    });
    const mismatchRes = await rootMismatchAdapter.getDiskUsage(SITE_A, siteA);
    assert.equal(mismatchRes.ok, false);
    assert.equal(mismatchRes.reasonCode, 'site_root_owner_mismatch');
    assert.equal(mismatchRes.measuredAt, null);

    // 4. Root (uid 0) with matching owner UID/GID invokes setpriv --reuid --regid --clear-groups --no-new-privs -- /usr/bin/du -s -x -P -k -- <verifiedContentRoot>
    if (currentUid > 0 && currentGid > 0) {
      const validPasswd = path.join(tmpDir, 'passwd-valid');
      writeFileSync(validPasswd, `root:x:0:0:root:/root:/bin/bash\n${siteA.unixUser}:x:${currentUid}:${currentGid}::/var/lib/yunpanel/data/${APP_A}:/usr/sbin/nologin\n`);
      const argvCapture = path.join(tmpDir, 'captured-setpriv-argv.txt');
      const setprivHarness = path.join(tmpDir, 'setpriv-exec-du.sh');
      writeFileSync(
        setprivHarness,
        `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvCapture}"\nshift 5\nexec "$@"\n`,
        { mode: 0o755 },
      );
      const rootAdapter = createLinuxSiteConsumptionAdapter({
        websiteRegistry,
        localServerId: SERVER_LOCAL,
        pathContractOptions: { staticPublishRoot },
        getuid: () => 0,
        passwdPath: validPasswd,
        setprivPath: setprivHarness,
        allowCurrentUserWithoutSetpriv: true, // Even if true, uid=0 MUST still use setpriv!
      });
      const rootRes = await rootAdapter.getDiskUsage(SITE_A, siteA);
      assert.equal(rootRes.ok, true);
      assert.ok(rootRes.bytes >= 64 * 1024);
      assert.equal(rootRes.scope, 'active_release_root');
      const captured = readFileSync(argvCapture, 'utf8').trim().split('\n');
      assert.deepEqual(captured, [
        `--reuid=${currentUid}`,
        `--regid=${currentGid}`,
        '--clear-groups',
        '--no-new-privs',
        '--',
        '/usr/bin/du',
        '-s',
        '-x',
        '-P',
        '-k',
        '--',
        canonicalRelease,
      ]);
    }

    // 5. Real timeout ZERO-ORPHAN-PID proof (both child and spawned grandchild process-group member MUST be dead before resolve)
    const timeoutPidFile = path.join(tmpDir, 'timeout-pids.txt');
    const slowTimeoutScript = path.join(tmpDir, 'slow-timeout-du.sh');
    writeFileSync(
      slowTimeoutScript,
      `#!/bin/sh\nsleep 30 &\nCHILD_PID=$!\nprintf '%s\\n%s\\n' "$$" "$CHILD_PID" > "${timeoutPidFile}.tmp" && mv "${timeoutPidFile}.tmp" "${timeoutPidFile}"\nwait "$CHILD_PID"\n`,
      { mode: 0o755 },
    );
    const timeoutAdapter = createLinuxSiteConsumptionAdapter({
      websiteRegistry,
      localServerId: SERVER_LOCAL,
      pathContractOptions: { staticPublishRoot },
      allowCurrentUserWithoutSetpriv: true,
      getuid: () => currentUid || 501,
      duPath: slowTimeoutScript,
      maxDurationMs: 400,
      maxConcurrent: 1,
      maxQueue: 1,
    });
    const timeoutRes = await timeoutAdapter.getDiskUsage(SITE_A, siteA);
    assert.equal(timeoutRes.ok, false);
    assert.equal(timeoutRes.reasonCode, 'disk_measurement_timeout');
    assert.equal(timeoutRes.spaceMb, null);
    assert.equal(timeoutRes.bytes, null);
    assert.equal(timeoutRes.measuredAt, null);
    const timeoutPids = readFileSync(timeoutPidFile, 'utf8').trim().split('\n').map((v) => Number.parseInt(v, 10));
    assert.equal(timeoutPids.length, 2);
    for (const pid of timeoutPids) assertPidDead(pid);

    // 6. Real AbortSignal ZERO-ORPHAN-PID proof + concurrency gate saturation (maxConcurrent=1, maxQueue=1)
    const abortPidFile = path.join(tmpDir, 'abort-pids.txt');
    const slowAbortScript = path.join(tmpDir, 'slow-abort-du.sh');
    writeFileSync(
      slowAbortScript,
      `#!/bin/sh\nsleep 30 &\nCHILD_PID=$!\nprintf '%s\\n%s\\n' "$$" "$CHILD_PID" > "${abortPidFile}.tmp" && mv "${abortPidFile}.tmp" "${abortPidFile}"\nwait "$CHILD_PID"\n`,
      { mode: 0o755 },
    );
    const busyAdapter = createLinuxSiteConsumptionAdapter({
      websiteRegistry,
      localServerId: SERVER_LOCAL,
      pathContractOptions: { staticPublishRoot },
      allowCurrentUserWithoutSetpriv: true,
      getuid: () => currentUid || 501,
      duPath: slowAbortScript,
      maxDurationMs: 5000,
      maxConcurrent: 1,
      maxQueue: 1,
    });
    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = busyAdapter.getDiskUsage(SITE_A, siteA, { signal: c1.signal });
    // Wait until p1's spawned process writes both its PID and its grandchild sleep PID
    for (let i = 0; i < 40 && !existsSync(abortPidFile); i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(existsSync(abortPidFile), true, 'p1 child process must have started and written PID file');
    const p2 = busyAdapter.getDiskUsage(SITE_A, siteA, { signal: c2.signal });
    await new Promise((r) => setTimeout(r, 40));

    // 3rd concurrent request exceeds maxConcurrent (1) + maxQueue (1) -> immediate disk_measurement_busy
    const res3 = await busyAdapter.getDiskUsage(SITE_A, siteA);
    assert.equal(res3.ok, false);
    assert.equal(res3.reasonCode, 'disk_measurement_busy');
    assert.equal(res3.measuredAt, null);

    c2.abort();
    c1.abort();
    const [res1, res2] = await Promise.all([p1, p2]);
    assert.equal(res1.ok, false);
    assert.equal(res1.reasonCode, 'disk_measurement_aborted');
    assert.equal(res1.measuredAt, null);
    assert.equal(res2.ok, false);
    assert.equal(res2.reasonCode, 'disk_measurement_aborted');
    assert.equal(res2.measuredAt, null);

    const abortPids = readFileSync(abortPidFile, 'utf8').trim().split('\n').map((v) => Number.parseInt(v, 10));
    assert.equal(abortPids.length, 2);
    for (const pid of abortPids) assertPidDead(pid);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('createLinuxSiteConsumptionAdapter: database count and traffic honesty', async () => {
  const siteA = makeStaticSite(SITE_A, APP_A);
  const bindings = [
    { id: 'b1', serverId: SERVER_LOCAL, websiteId: SITE_A, applicationId: APP_A, databaseName: 'app_one' },
    { id: 'b2', serverId: SERVER_LOCAL, websiteId: SITE_A, applicationId: APP_A, databaseName: 'app_two' },
    { id: 'b3', serverId: SERVER_LOCAL, websiteId: SITE_A, applicationId: APP_EMPTY, databaseName: 'mismatched_app' },
    { id: 'b4', serverId: SERVER_REMOTE, websiteId: SITE_A, applicationId: APP_A, databaseName: 'remote_db' },
  ];

  const adapter = createLinuxSiteConsumptionAdapter({
    databaseBindingRegistry: { async listBindings() { return bindings; } },
    now: () => Date.parse('2026-11-21T16:40:00.000Z'),
  });

  const dbRes = await adapter.getDatabaseUsage(SITE_A, siteA);
  assert.equal(dbRes.ok, true);
  assert.equal(dbRes.databases, 2);
  assert.equal(dbRes.storageMb, null);
  assert.equal(dbRes.measuredAt, '2026-11-21T16:40:00.000Z');
  assert.equal(dbRes.scope, 'canonical_active_bindings');

  const trafficDefault = await adapter.getTrafficUsage(SITE_A, siteA);
  assert.equal(trafficDefault.ok, false);
  assert.equal(trafficDefault.trafficMb, null);
  assert.equal(trafficDefault.measuredAt, null);
  assert.equal(trafficDefault.reasonCode, 'traffic_source_unavailable');
  assert.match(trafficDefault.reason, /Nginx erişim günlüğü kapalı/);

  const failingAdapter = createLinuxSiteConsumptionAdapter({
    databaseBindingRegistry: { async listBindings() { throw new Error('disk offline'); } },
    trafficInspector: async () => ({
      trafficMb: 412.5,
      period: '2026-11',
      scope: 'vhost_monthly_counter',
      measuredAt: '2026-11-21T16:41:00.000Z',
    }),
  });
  const dbFail = await failingAdapter.getDatabaseUsage(SITE_A, siteA);
  assert.equal(dbFail.ok, false);
  assert.equal(dbFail.databases, null);
  assert.equal(dbFail.measuredAt, null);
  assert.equal(dbFail.reasonCode, 'database_inventory_unavailable');

  const trafficCustom = await failingAdapter.getTrafficUsage(SITE_A, siteA);
  assert.equal(trafficCustom.ok, true);
  assert.equal(trafficCustom.trafficMb, 412.5);
  assert.equal(trafficCustom.period, '2026-11');
  assert.equal(trafficCustom.scope, 'vhost_monthly_counter');
  assert.equal(trafficCustom.measuredAt, '2026-11-21T16:41:00.000Z');
});

test('site-consumption-inspector: getDiskQuotaBytes measures logical apparent bytes + per-path hard links (sparse/hardlink safe) and fails closed on shared roots', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-quota-bytes-'));
  try {
    const staticPublishRoot = path.join(tmpDir, 'static-sites');
    const relA = path.join(staticPublishRoot, APP_A, 'releases', 'rel-1');
    mkdirSync(relA, { recursive: true });
    symlinkSync(relA, path.join(staticPublishRoot, APP_A, 'current'));

    // 1. Sparse file (4 MiB logical size, 0 allocated data blocks!)
    const sparsePath = path.join(relA, 'sparse.bin');
    const fd = openSync(sparsePath, 'w');
    ftruncateSync(fd, 4 * 1024 * 1024);
    closeSync(fd);

    // 2. Hard-linked pair (2 x 256 KiB = 512 KiB logical per-path!)
    const hardA = path.join(relA, 'hard-a.bin');
    const hardB = path.join(relA, 'hard-b.bin');
    writeFileSync(hardA, Buffer.alloc(256 * 1024, 0x41));
    linkSync(hardA, hardB);

    // 3. Symlink to large external file MUST NOT be followed!
    const externalBig = path.join(tmpDir, 'external-10mb.bin');
    writeFileSync(externalBig, Buffer.alloc(10 * 1024 * 1024, 0x42));
    symlinkSync(externalBig, path.join(relA, 'ext-link.bin'));

    const siteA = { id: SITE_A, serverId: SERVER_LOCAL, runtimeType: 'static', applicationId: APP_A };
    const adapter = createLinuxSiteConsumptionAdapter({
      websiteRegistry: { async getWebsite(id) { return id === SITE_A ? siteA : null; }, async listWebsites() { return [siteA]; } },
      domainRegistry: { async listDomains() { return []; } },
      localServerId: SERVER_LOCAL,
      pathContractOptions: { staticPublishRoot },
      allowCurrentUserWithoutSetpriv: true,
    });

    const quotaRes = await adapter.getDiskQuotaBytes(SITE_A, siteA);
    assert.equal(quotaRes.ok, true);
    assert.equal(quotaRes.scope, 'active_release_root_apparent_bytes');
    // Must count 4 MiB sparse + 2 x 256 KiB hardlinks = 4.5 MiB (and NOT the 10 MiB external symlink!)
    const expectedMin = (4 * 1024 * 1024) + (2 * 256 * 1024);
    assert.ok(quotaRes.bytes >= expectedMin, `expected >= ${expectedMin} apparent bytes, got ${quotaRes.bytes}`);
    assert.ok(quotaRes.bytes < expectedMin + (256 * 1024), `symlink must not be followed, got ${quotaRes.bytes}`);

    // Shared/nested root MUST fail closed with shared_root_overlap
    const siteOverlap = {
      id: SITE_OVERLAP,
      serverId: SERVER_LOCAL,
      runtimeType: 'static',
      applicationId: APP_SUB,
      documentRoot: path.join(relA, 'nested'),
    };
    const overlapAdapter = createLinuxSiteConsumptionAdapter({
      websiteRegistry: { async getWebsite(id) { return id === SITE_A ? siteA : siteOverlap; }, async listWebsites() { return [siteA, siteOverlap]; } },
      domainRegistry: { async listDomains() { return []; } },
      localServerId: SERVER_LOCAL,
      pathContractOptions: { staticPublishRoot },
      allowCurrentUserWithoutSetpriv: true,
    });
    const overlapRes = await overlapAdapter.getDiskQuotaBytes(SITE_A, siteA);
    assert.equal(overlapRes.ok, false);
    assert.equal(overlapRes.reasonCode, 'shared_root_overlap');
    assert.equal(overlapRes.bytes, null);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
