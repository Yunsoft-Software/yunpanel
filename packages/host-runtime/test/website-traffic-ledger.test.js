import assert from 'node:assert/strict';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createLinuxSiteConsumptionAdapter,
  createNginxManager,
  createWebsiteTrafficEnforcer,
  createWebsiteTrafficLedger,
  discoverAppliedTrafficVhosts,
  inspectNativeDiskQuotaSupport,
  WebsiteTrafficEnforcerError,
} from '../src/index.js';

const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';
const SITE_IDLE = '33333333-3333-4333-8333-333333333333';

test('website-traffic-ledger: incremental reads, partial lines, restart persistence (0 replay), delayed-USR1 .1 flush drain, copytruncate gap honesty, and UTC month rollover', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-traffic-ledger-'));
  try {
    const ledgerPath = path.join(tmpDir, 'ledger.json');
    const logPath = path.join(tmpDir, 'yunpanel-site-traffic.log');
    let clock = Date.parse('2026-11-21T18:00:00.000Z');
    const meteredSet = new Set([SITE_A, SITE_B, SITE_IDLE]);

    // 1. Write 2 complete lines + malformed/panel lines + 1 half-written trailing line
    writeFileSync(
      logPath,
      [
        `2026-11-21T17:50:00Z\t${SITE_A}\t1048576`,
        `2026-11-21T17:55:00+00:00\t${SITE_A}\t524288`,
        '2026-11-21T17:56:00Z\t\t999999',
        'corrupted-line-without-tabs',
        `2026-11-21T17:59:00Z\t${SITE_B}\t204`,
      ].join('\n'),
    );

    const ledger1 = createWebsiteTrafficLedger({
      filePath: ledgerPath,
      logPath,
      maxRetainedMonths: 3,
      now: () => clock,
      isMeteredWebsite: (id) => meteredSet.has(id),
    });

    const sync1 = await ledger1.sync();
    assert.equal(sync1.ok, true);
    assert.equal(sync1.linesParsed, 2);
    assert.equal(statSync(ledgerPath).mode & 0o777, 0o600);

    const a1 = await ledger1.getWebsiteTraffic(SITE_A, { month: '2026-11', sync: false });
    assert.equal(a1.ok, true);
    assert.equal(a1.bytes, 1572864);
    assert.equal(a1.trafficMb, 1.5);
    assert.equal(a1.requests, 2);
    assert.equal(a1.period, '2026-11');
    assert.equal(a1.scope, 'nginx_outbound_body_bytes');
    assert.equal(a1.completeness, 'complete');
    assert.equal(a1.rotationGapCount, 0);
    assert.equal(a1.measuredAt, '2026-11-21T18:00:00.000Z');

    const idle1 = await ledger1.getWebsiteTraffic(SITE_IDLE, { month: '2026-11', sync: false });
    assert.equal(idle1.ok, true);
    assert.equal(idle1.bytes, 0);
    assert.equal(idle1.completeness, 'complete');
    assert.equal(idle1.rotationGapCount, 0);
    assert.equal(idle1.meterStartedAt, '2026-11-21T18:00:00.000Z');

    // Unmeasured past & future months MUST NEVER fabricate 0 or fresh measuredAt!
    for (const unmeasuredMonth of ['2025-01', '2027-01']) {
      const idleOther = await ledger1.getWebsiteTraffic(SITE_IDLE, { month: unmeasuredMonth, sync: false });
      assert.equal(idleOther.ok, false);
      assert.equal(idleOther.bytes, null);
      assert.equal(idleOther.trafficMb, null);
      assert.equal(idleOther.measuredAt, null);
      assert.equal(idleOther.reasonCode, 'traffic_source_unavailable');

      const emptyTotals = await ledger1.getMonthlyTotalsForWebsites([], { month: unmeasuredMonth, sync: false });
      assert.equal(emptyTotals.ok, false);
      assert.equal(emptyTotals.bytes, null);
      assert.equal(emptyTotals.trafficMb, null);
      assert.equal(emptyTotals.measuredAt, null);
    }

    // 2. Restart simulation: brand-new ledger reads persisted state -> ZERO replay!
    clock = Date.parse('2026-11-21T18:05:00.000Z');
    const ledger2 = createWebsiteTrafficLedger({
      filePath: ledgerPath,
      logPath,
      maxRetainedMonths: 3,
      now: () => clock,
      isMeteredWebsite: (id) => meteredSet.has(id),
    });
    const sync2 = await ledger2.sync();
    assert.equal(sync2.linesParsed, 0);
    assert.equal((await ledger2.getWebsiteTraffic(SITE_A, { month: '2026-11', sync: false })).bytes, 1572864);

    // 3. Complete partial trailing line for SITE_B ("204" + "8\n" -> 2048 bytes)
    appendFileSync(logPath, '8\n');
    const sync3 = await ledger2.sync();
    assert.equal(sync3.linesParsed, 1);
    assert.equal((await ledger2.getWebsiteTraffic(SITE_B, { month: '2026-11', sync: false })).bytes, 2048);

    // 4. Rename rotation -> .1 + DELAYED USR1 worker flush appended to .1 AFTER initial rotation sync!
    appendFileSync(logPath, `2026-11-21T18:09:00Z\t${SITE_A}\t4096\n`);
    renameSync(logPath, `${logPath}.1`);
    writeFileSync(logPath, `2026-11-21T18:10:00Z\t${SITE_A}\t8192\n`);
    clock = Date.parse('2026-11-21T18:11:00.000Z');

    const sync4 = await ledger2.sync();
    assert.equal(sync4.ok, true);
    assert.equal(sync4.linesParsed, 2);
    assert.equal((await ledger2.getWebsiteTraffic(SITE_A, { month: '2026-11', sync: false })).bytes, 1572864 + 4096 + 8192);
    assert.equal((await ledger2.getWebsiteTraffic(SITE_A, { month: '2026-11', sync: false })).completeness, 'complete');

    // Delayed Nginx worker flushes another line to .1 before USR1 reopen completes!
    appendFileSync(`${logPath}.1`, `2026-11-21T18:11:05Z\t${SITE_A}\t16384\n`);
    const sync4Delayed = await ledger2.sync();
    assert.equal(sync4Delayed.ok, true);
    assert.equal(sync4Delayed.linesParsed, 1, 'delayed USR1 flush appended to .1 must be drained cleanly');
    assert.equal((await ledger2.getWebsiteTraffic(SITE_A, { month: '2026-11', sync: false })).bytes, 1572864 + 4096 + 8192 + 16384);
    assert.equal((await ledger2.getWebsiteTraffic(SITE_A, { month: '2026-11', sync: false })).completeness, 'complete');

    // Repeat sync produces ZERO double-counting from .1
    assert.equal((await ledger2.sync()).linesParsed, 0);

    // 5. Real copytruncate rotation WITH .1 backup: drains unread tail between prev.offset and truncate with ZERO loss!
    appendFileSync(logPath, `2026-11-21T18:12:00Z\t${SITE_A}\t512\n`);
    await ledger2.sync();
    appendFileSync(logPath, `2026-11-21T18:13:00Z\t${SITE_B}\t256\n`); // unread tail before copytruncate!
    copyFileSync(logPath, `${logPath}.1`);
    truncateSync(logPath, 0);
    writeFileSync(logPath, `2026-11-21T18:15:00Z\t${SITE_B}\t1024\n`);
    const sync5 = await ledger2.sync();
    assert.equal(sync5.linesParsed, 2, 'copytruncate with intact .1 must recover unread tail + new line');
    assert.equal((await ledger2.getWebsiteTraffic(SITE_B, { month: '2026-11', sync: false })).bytes, 2048 + 256 + 1024);
    assert.equal((await ledger2.getWebsiteTraffic(SITE_B, { month: '2026-11', sync: false })).completeness, 'complete');

    // 5b. Unbacked in-place shrink (missing .1) MUST honestly flag partial_rotation_gap!
    appendFileSync(logPath, `2026-11-21T18:16:00Z\t${SITE_B}\t512\n`);
    await ledger2.sync();
    rmSync(`${logPath}.1`, { force: true });
    truncateSync(logPath, 0);
    writeFileSync(logPath, `2026-11-21T18:17:00Z\t${SITE_B}\t128\n`);
    await ledger2.sync();
    const bAfterUnbackedShrink = await ledger2.getWebsiteTraffic(SITE_B, { month: '2026-11', sync: false });
    assert.equal(bAfterUnbackedShrink.bytes, 2048 + 256 + 1024 + 512 + 128);
    assert.equal(bAfterUnbackedShrink.completeness, 'partial_rotation_gap');
    assert.equal(bAfterUnbackedShrink.rotationGapCount, 1);

    // 6. copytruncate overwrite PAST previous offset (without matching .1) -> increments rotationGapCount!
    truncateSync(logPath, 0);
    writeFileSync(
      logPath,
      [
        `2026-11-21T18:20:00Z\t${SITE_B}\t1000`,
        `2026-11-21T18:21:00Z\t${SITE_B}\t2000`,
        `2026-11-21T18:22:00Z\t${SITE_B}\t3000`,
      ].join('\n') + '\n',
    );
    clock = Date.parse('2026-11-21T18:23:00.000Z');
    assert.equal((await ledger2.sync()).linesParsed, 3);
    const bAfterGap = await ledger2.getWebsiteTraffic(SITE_B, { month: '2026-11', sync: false });
    assert.equal(bAfterGap.bytes, 2048 + 256 + 1024 + 512 + 128 + 6000);
    assert.equal(bAfterGap.completeness, 'partial_rotation_gap');
    assert.equal(bAfterGap.rotationGapCount, 2);
    assert.equal((await ledger2.snapshot()).collector.lastRotationGapAt, '2026-11-21T18:23:00.000Z');

    // 7. Missing rotated .1 during rename rotation (rotated past .1 / deleted before sync) -> increments rotationGapCount!
    rmSync(logPath, { force: true });
    rmSync(`${logPath}.1`, { force: true });
    writeFileSync(logPath, `2026-11-21T18:25:00Z\t${SITE_A}\t256\n`);
    clock = Date.parse('2026-11-21T18:26:00.000Z');
    await ledger2.sync();
    const aAfterMissingRot = await ledger2.getWebsiteTraffic(SITE_A, { month: '2026-11', sync: false });
    assert.equal(aAfterMissingRot.completeness, 'partial_rotation_gap');
    assert.equal(aAfterMissingRot.rotationGapCount, 3);

    // 8. UTC month rollover + timezone offset crossing midnight + retention pruning
    appendFileSync(
      logPath,
      [
        `2026-12-01T01:00:00+03:00\t${SITE_A}\t1000`, // UTC = 2026-11
        `2026-12-01T00:05:00Z\t${SITE_A}\t524288`,    // UTC = 2026-12 (clean month, 0 gaps!)
        `2026-08-15T12:00:00Z\t${SITE_A}\t100`,
        `2026-09-15T12:00:00Z\t${SITE_A}\t200`,
        `2026-10-15T12:00:00Z\t${SITE_A}\t300`,
      ].join('\n') + '\n',
    );
    clock = Date.parse('2026-12-01T00:10:00.000Z');
    await ledger2.sync();

    const aNov = await ledger2.getWebsiteTraffic(SITE_A, { month: '2026-11', sync: false });
    const aDec = await ledger2.getWebsiteTraffic(SITE_A, { month: '2026-12', sync: false });
    assert.equal(aNov.bytes, 1572864 + 4096 + 8192 + 16384 + 512 + 256 + 1000);
    assert.equal(aNov.completeness, 'partial_rotation_gap');
    assert.equal(aDec.bytes, 524288);
    assert.equal(aDec.trafficMb, 0.5);
    assert.equal(aDec.completeness, 'complete');
    assert.equal(aDec.rotationGapCount, 0);

    const snap = await ledger2.snapshot();
    assert.deepEqual(Object.keys(snap.sites[SITE_A].months).sort(), ['2026-10', '2026-11', '2026-12']);

    // 9. Customer aggregation + SiteConsumptionInspector plug-in carries completeness & rotationGapCount
    const totals = await ledger2.getMonthlyTotalsForWebsites([SITE_A, SITE_B], { month: '2026-11', sync: false });
    assert.equal(totals.ok, true);
    assert.equal(totals.bytes, aNov.bytes + bAfterGap.bytes);
    assert.equal(totals.completeness, 'partial_rotation_gap');
    assert.equal(totals.rotationGapCount, 3);

    const adapter = createLinuxSiteConsumptionAdapter({ trafficInspector: ledger2 });
    const viaAdapter = await adapter.getTrafficUsage(SITE_A);
    assert.equal(viaAdapter.ok, true);
    assert.equal(viaAdapter.bytes, 524288);
    assert.equal(viaAdapter.period, '2026-12');
    assert.equal(viaAdapter.completeness, 'complete');
    assert.equal(viaAdapter.rotationGapCount, 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('website-traffic-ledger: symlink rejection, missing log honesty, and unreadable log fail closed', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-traffic-safety-'));
  const lockedLog = path.join(tmpDir, 'locked.log');
  try {
    const ledgerPath = path.join(tmpDir, 'ledger.json');
    const missingLog = path.join(tmpDir, 'does-not-exist.log');

    const missingLedger = createWebsiteTrafficLedger({
      filePath: ledgerPath,
      logPath: missingLog,
      isMeteredWebsite: () => true,
      now: () => Date.parse('2026-11-21T18:30:00.000Z'),
    });
    const missingRes = await missingLedger.getWebsiteTraffic(SITE_A, { month: '2026-11' });
    assert.equal(missingRes.ok, false);
    assert.equal(missingRes.trafficMb, null);
    assert.equal(missingRes.bytes, null);
    assert.equal(missingRes.measuredAt, null);
    assert.equal(missingRes.reasonCode, 'traffic_log_missing');

    const realTarget = path.join(tmpDir, 'real-target.log');
    writeFileSync(realTarget, `2026-11-21T18:30:00Z\t${SITE_A}\t99999\n`);
    const symlinkLog = path.join(tmpDir, 'symlink.log');
    symlinkSync(realTarget, symlinkLog);

    const symlinkLedger = createWebsiteTrafficLedger({ logPath: symlinkLog, isMeteredWebsite: () => true });
    const symRes = await symlinkLedger.getWebsiteTraffic(SITE_A, { month: '2026-11' });
    assert.equal(symRes.ok, false);
    assert.equal(symRes.trafficMb, null);
    assert.equal(symRes.measuredAt, null);
    assert.equal(symRes.reasonCode, 'traffic_log_unsafe');

    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      writeFileSync(lockedLog, `2026-11-21T18:30:00Z\t${SITE_A}\t99999\n`);
      chmodSync(lockedLog, 0o000);
      const lockedLedger = createWebsiteTrafficLedger({ logPath: lockedLog, isMeteredWebsite: () => true });
      const lockedRes = await lockedLedger.getWebsiteTraffic(SITE_A, { month: '2026-11' });
      assert.equal(lockedRes.ok, false);
      assert.equal(lockedRes.trafficMb, null);
      assert.equal(lockedRes.measuredAt, null);
      assert.equal(lockedRes.reasonCode, 'traffic_log_unreadable');
    }
  } finally {
    try { chmodSync(lockedLog, 0o600); } catch {}
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('website-traffic-enforcer & nginx-manager: shared withConfigLock serialization, active-only + sitesDir filtering, baked trafficWebsiteId, zero-reload no-op, and rollback', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-traffic-enforcer-'));
  try {
    const confPath = path.join(tmpDir, 'conf.d', 'yunpanel-site-traffic.conf');
    const logPath = path.join(tmpDir, 'log', 'yunpanel-site-traffic.log');
    const sitesDir = path.join(tmpDir, 'sites-enabled');
    const stagingDir = path.join(tmpDir, 'staging');
    mkdirSync(sitesDir, { recursive: true });
    writeFileSync(path.join(sitesDir, 'yunpanel-alpha.example.test.conf'), '# active vhost\n');

    const passScript = path.join(tmpDir, 'pass.sh');
    const failScript = path.join(tmpDir, 'fail.sh');
    const callLog = path.join(tmpDir, 'calls.log');
    writeFileSync(passScript, `#!/bin/sh\necho "$0 $*" >> "${callLog}"\nexit 0\n`, { mode: 0o755 });
    writeFileSync(failScript, `#!/bin/sh\necho "$0 $*" >> "${callLog}"\nexit 1\n`, { mode: 0o755 });

    // Shared lock serialization test between nginxManager.activateDomain and enforcer.reconcile
    const events = [];
    const lockedMgr = createNginxManager({
      stagingDir,
      sitesDir,
      trafficLogPath: logPath,
      enableTrafficLimitGuard: true,
      execFn: async (_cmd, args) => {
        events.push(`mgr-start:${args[0]}`);
        await new Promise((r) => setTimeout(r, 40));
        events.push(`mgr-end:${args[0]}`);
        return { stdout: '', stderr: '' };
      },
    });

    const staged = await lockedMgr.stageDomain({
      primaryDomain: 'metered.example.test',
      websiteId: SITE_B,
      targetType: 'proxy',
      target: { upstreamPort: 3000 },
    });
    const stagedContent = readFileSync(path.join(stagingDir, staged.configName), 'utf8');
    assert.ok(stagedContent.includes(`access_log ${logPath} yunpanel_site_traffic if=$yunpanel_traffic_log_enabled;`));
    assert.ok(stagedContent.includes(`if ($yunpanel_traffic_site_id = "${SITE_B}") {`));

    const enforcer = createWebsiteTrafficEnforcer({
      configPath: confPath,
      trafficLogPath: logPath,
      sitesDir,
      nginxManager: lockedMgr,
      execFn: async (_cmd, args) => {
        events.push(`enf-start:${args[0]}`);
        await new Promise((r) => setTimeout(r, 20));
        events.push(`enf-end:${args[0]}`);
        return { stdout: '', stderr: '' };
      },
    });

    const [actRes, recRes] = await Promise.all([
      lockedMgr.activateDomain({ primaryDomain: 'metered.example.test', checksum: staged.checksum }),
      enforcer.reconcile({
        domains: [
          { primaryDomain: 'alpha.example.test', aliases: ['www.alpha.example.test'], websiteId: SITE_A, state: 'active' },
          { primaryDomain: 'metered.example.test', websiteId: SITE_B, state: 'active' },
          { primaryDomain: 'draft.example.test', websiteId: SITE_IDLE, state: 'draft' },
          { primaryDomain: 'ghost-not-on-disk.example.test', websiteId: SITE_IDLE, state: 'active' },
        ],
        blockedWebsiteIds: [],
      }),
    ]);
    assert.equal(actRes.active, true);
    assert.equal(recRes.changed, true);
    assert.equal(recRes.reloaded, true);

    // Verify strict serialization: all mgr-* events finished BEFORE enf-* began!
    const lastMgrIdx = events.findLastIndex((e) => e.startsWith('mgr-'));
    const firstEnfIdx = events.findIndex((e) => e.startsWith('enf-'));
    assert.ok(lastMgrIdx >= 0 && firstEnfIdx > lastMgrIdx, `expected strict lock serialization, got ${JSON.stringify(events)}`);

    const writtenConf = readFileSync(confPath, 'utf8');
    assert.ok(writtenConf.includes('map $server_name $yunpanel_traffic_site_id {'));
    assert.ok(writtenConf.includes(`"alpha.example.test" "${SITE_A}";`));
    assert.ok(writtenConf.includes(`"metered.example.test" "${SITE_B}";`));
    assert.ok(!writtenConf.includes('draft.example.test'), 'draft domain must be excluded');
    assert.ok(!writtenConf.includes('ghost-not-on-disk.example.test'), 'domain without active vhost file in sitesDir must be excluded');

    // Identical reconcile is a strict ZERO-reload SHA-256 no-op
    const eventsBeforeNoop = events.length;
    const noopRes = await enforcer.reconcile({
      domains: [
        { primaryDomain: 'alpha.example.test', aliases: ['www.alpha.example.test'], websiteId: SITE_A, state: 'active' },
        { primaryDomain: 'metered.example.test', websiteId: SITE_B, state: 'active' },
      ],
      blockedWebsiteIds: [],
    });
    assert.equal(noopRes.changed, false);
    assert.equal(noopRes.reloaded, false);
    assert.equal(events.length, eventsBeforeNoop, 'no-op reconcile must perform zero nginx -t / reload calls');

    // Failed nginx -t restores previous valid config byte-for-byte
    const failingEnforcer = createWebsiteTrafficEnforcer({
      configPath: confPath,
      trafficLogPath: logPath,
      sitesDir,
      nginxPath: failScript,
      systemctlPath: passScript,
    });
    await assert.rejects(
      () => failingEnforcer.reconcile({
        domains: [{ primaryDomain: 'alpha.example.test', websiteId: SITE_A, state: 'active' }],
        blockedWebsiteIds: [SITE_A],
      }),
      (err) => err instanceof WebsiteTrafficEnforcerError && err.code === 'nginx_traffic_config_validation_failed',
    );
    assert.equal(readFileSync(confPath, 'utf8'), writtenConf, 'previous valid config MUST be restored on nginx -t failure');

    // Reload fallback: systemctl fails -> falls back to nginx -s reload
    const fallbackEnforcer = createWebsiteTrafficEnforcer({
      configPath: confPath,
      trafficLogPath: logPath,
      sitesDir,
      nginxPath: passScript,
      systemctlPath: failScript,
    });
    const fallbackRes = await fallbackEnforcer.reconcile({
      domains: [{ primaryDomain: 'alpha.example.test', websiteId: SITE_A, state: 'active' }],
      blockedWebsiteIds: [SITE_A],
    });
    assert.equal(fallbackRes.changed, true);
    assert.equal(fallbackRes.reloaded, true);
    assert.ok(readFileSync(confPath, 'utf8').includes(`"${SITE_A}" 1;`));
    assert.ok(readFileSync(callLog, 'utf8').includes('-s reload'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('inspectNativeDiskQuotaSupport: parses /proc/mounts read-only for longest mount point and prjquota/usrquota/grpquota', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-disk-quota-cap-'));
  try {
    const mountsNoQuota = path.join(tmpDir, 'mounts-no-quota');
    writeFileSync(
      mountsNoQuota,
      [
        '/dev/sda1 / ext4 rw,relatime,errors=remount-ro 0 0',
        '/dev/sdb1 /var/www ext4 rw,relatime 0 0',
      ].join('\n') + '\n',
    );
    const resNoQuota = await inspectNativeDiskQuotaSupport({
      targetPath: '/var/www/yunpanel/apps',
      procMountsPath: mountsNoQuota,
    });
    assert.equal(resNoQuota.nativeHardQuotaSupported, false);
    assert.equal(resNoQuota.mountPoint, '/var/www');
    assert.equal(resNoQuota.fsType, 'ext4');
    assert.equal(resNoQuota.enforcementMode, 'managed_write_guard');
    assert.equal(resNoQuota.reasonCode, 'mount_missing_quota_option');

    const mountsWithPrjQuota = path.join(tmpDir, 'mounts-prjquota');
    writeFileSync(
      mountsWithPrjQuota,
      [
        '/dev/sda1 / ext4 rw,relatime 0 0',
        '/dev/sdb1 /var/www/yunpanel/apps ext4 rw,relatime,prjquota 0 0',
      ].join('\n') + '\n',
    );
    const resWithQuota = await inspectNativeDiskQuotaSupport({
      targetPath: '/var/www/yunpanel/apps/11111111-1111-4111-8111-111111111111',
      procMountsPath: mountsWithPrjQuota,
    });
    assert.equal(resWithQuota.nativeHardQuotaSupported, true);
    assert.equal(resWithQuota.mountPoint, '/var/www/yunpanel/apps');
    assert.equal(resWithQuota.fsType, 'ext4');
    assert.ok(resWithQuota.mountOptions.includes('prjquota'));
    assert.equal(resWithQuota.enforcementMode, 'native_quota_available');
    assert.equal(resWithQuota.reasonCode, 'native_quota_mount_option_present');

    const mountsDisabled = path.join(tmpDir, 'mounts-noquota');
    writeFileSync(mountsDisabled, '/dev/sda1 / xfs rw,relatime,prjquota,noquota 0 0\n');
    const resDisabled = await inspectNativeDiskQuotaSupport({
      targetPath: '/var/www/yunpanel/apps',
      procMountsPath: mountsDisabled,
    });
    assert.equal(resDisabled.nativeHardQuotaSupported, false);
    assert.equal(resDisabled.enforcementMode, 'managed_write_guard');

    const resMissing = await inspectNativeDiskQuotaSupport({
      targetPath: '/var/www/yunpanel/apps',
      procMountsPath: path.join(tmpDir, 'nonexistent-mounts'),
    });
    assert.equal(resMissing.nativeHardQuotaSupported, false);
    assert.equal(resMissing.mountPoint, null);
    assert.equal(resMissing.enforcementMode, 'managed_write_guard');
    assert.equal(resMissing.reasonCode, 'proc_mounts_unavailable');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('discoverAppliedTrafficVhosts & website-traffic-ledger: zero-touch non-retroactive metering for pre-upgrade active managed vhosts, zero PII persisted, and clean upgrade transition', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-legacy-traffic-'));
  try {
    const sitesDir = path.join(tmpDir, 'sites-enabled');
    const logDir = path.join(tmpDir, 'logs');
    const ledgerPath = path.join(tmpDir, 'ledger.json');
    const dedicatedLogPath = path.join(logDir, 'yunpanel-site-traffic.log');
    const legacyLogPath = path.join(logDir, 'legacy.example.test.access.log');
    mkdirSync(sitesDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });

    // Pre-upgrade applied managed vhost (never modified on disk!) + manual/panel vhosts (ignored!)
    const legacyVhostPath = path.join(sitesDir, 'yunpanel-legacy.example.test.conf');
    const legacyVhostContent = [
      'server {',
      '  listen 443 ssl;',
      '  server_name legacy.example.test www.legacy.example.test;',
      `  access_log ${legacyLogPath};`,
      '  location ~* \\.(?:css|js)$ { access_log off; }',
      '}',
    ].join('\n') + '\n';
    writeFileSync(legacyVhostPath, legacyVhostContent);
    writeFileSync(path.join(sitesDir, 'manual-other.conf'), `server { server_name manual.test; access_log ${path.join(logDir, 'manual.access.log')}; }\n`);
    writeFileSync(path.join(sitesDir, 'yunpanel-draft.example.test.conf'), `server { server_name draft.example.test; access_log ${path.join(logDir, 'draft.example.test.access.log')}; }\n`);

    // Pre-upgrade historical lines in legacy access log (MUST NOT be counted retroactively!)
    writeFileSync(
      legacyLogPath,
      '203.0.113.10 - - [21/Nov/2026:10:00:00 +0300] "GET /secret?token=abc123 HTTP/1.1" 200 999999 "-" "Mozilla/5.0"\n',
    );

    const domains = [
      { primaryDomain: 'legacy.example.test', websiteId: SITE_A, state: 'active' },
      { primaryDomain: 'draft.example.test', websiteId: SITE_B, state: 'draft' },
    ];

    const discovered1 = await discoverAppliedTrafficVhosts({ domains, sitesDir, allowedLogDir: logDir });
    assert.equal(discovered1.legacySources.length, 1);
    assert.equal(discovered1.legacySources[0].websiteId, SITE_A);
    assert.equal(discovered1.legacySources[0].logPath, legacyLogPath);
    assert.equal(discovered1.dedicatedWebsiteIds.length, 0);

    let clock = Date.parse('2026-11-21T20:00:00.000Z');
    const ledger = createWebsiteTrafficLedger({
      filePath: ledgerPath,
      logPath: dedicatedLogPath, // intentionally missing yet!
      now: () => clock,
      resolveLegacySources: async () => (await discoverAppliedTrafficVhosts({ domains, sitesDir, allowedLogDir: logDir })).legacySources,
    });

    // First sync initializes at EOF -> ZERO retroactive bytes counted, records exact meterStartedAt!
    const initSync = await ledger.sync();
    assert.equal(initSync.ok, true);
    assert.equal(initSync.linesParsed, 0);

    const initialRes = await ledger.getWebsiteTraffic(SITE_A, { month: '2026-11', sync: false });
    assert.equal(initialRes.ok, true);
    assert.equal(initialRes.bytes, 0);
    assert.equal(initialRes.meterStartedAt, '2026-11-21T20:00:00.000Z');
    assert.equal(initialRes.accountingMode, 'legacy_applied_access_log');
    assert.equal(initialRes.includesStaticAssets, false);
    assert.equal(initialRes.scope, 'nginx_legacy_applied_access_log');

    // If legacy log becomes a symlink while bucket is still empty -> MUST fail closed (NO fake 0 / fresh measuredAt)!
    const symlinkTarget = path.join(tmpDir, 'evil-target.log');
    writeFileSync(symlinkTarget, '203.0.113.99 - - [21/Nov/2026:23:01:00 +0300] "GET / HTTP/1.1" 200 50000 "-" "curl"\n');
    const savedLegacyPath = path.join(tmpDir, 'saved-legacy.log');
    renameSync(legacyLogPath, savedLegacyPath);
    symlinkSync(symlinkTarget, legacyLogPath);
    clock = Date.parse('2026-11-21T20:02:00.000Z');
    await ledger.sync();
    const afterSymlink = await ledger.getWebsiteTraffic(SITE_A, { month: '2026-11', sync: false });
    assert.equal(afterSymlink.ok, false);
    assert.equal(afterSymlink.bytes, null);
    assert.equal(afterSymlink.trafficMb, null);
    assert.equal(afterSymlink.measuredAt, null);
    assert.equal(afterSymlink.reasonCode, 'traffic_log_unsafe');

    // Restore original regular legacy log -> recovers cleanly without losing meterStartedAt!
    rmSync(legacyLogPath, { force: true });
    renameSync(savedLegacyPath, legacyLogPath);
    clock = Date.parse('2026-11-21T20:03:00.000Z');
    await ledger.sync();
    const afterRestore = await ledger.getWebsiteTraffic(SITE_A, { month: '2026-11', sync: false });
    assert.equal(afterRestore.ok, true);
    assert.equal(afterRestore.bytes, 0);
    assert.equal(afterRestore.meterStartedAt, '2026-11-21T20:00:00.000Z');

    // New live request arrives on pre-upgrade vhost -> counted cleanly without storing PII!
    clock = Date.parse('2026-11-21T20:05:00.000Z');
    appendFileSync(
      legacyLogPath,
      '198.51.100.42 - alice [21/Nov/2026:23:04:00 +0300] "GET /private?email=a@b.test HTTP/2.0" 200 12345 "https://ref.test/" "curl/8.5"\n',
    );
    await ledger.sync();
    const afterReq = await ledger.getWebsiteTraffic(SITE_A, { month: '2026-11', sync: false });
    assert.equal(afterReq.ok, true);
    assert.equal(afterReq.bytes, 12345);
    assert.equal(afterReq.requests, 1);
    assert.equal(afterReq.meterStartedAt, '2026-11-21T20:00:00.000Z');
    assert.equal(afterReq.accountingMode, 'legacy_applied_access_log');
    assert.equal(afterReq.includesStaticAssets, false);

    // Verify ZERO PII in persisted ledger file & vhost file untouched byte-for-byte!
    const ledgerDisk = readFileSync(ledgerPath, 'utf8');
    assert.ok(!ledgerDisk.includes('198.51.100.42'));
    assert.ok(!ledgerDisk.includes('203.0.113.10'));
    assert.ok(!ledgerDisk.includes('email=a@b.test'));
    assert.ok(!ledgerDisk.includes('token=abc123'));
    assert.equal(readFileSync(legacyVhostPath, 'utf8'), legacyVhostContent);

    // Explicit vhost upgrade to dedicated yunpanel_site_traffic -> one final drain of legacy + clean transition with ZERO double-counting!
    appendFileSync(
      legacyLogPath,
      '198.51.100.43 - - [21/Nov/2026:23:06:00 +0300] "GET /last-legacy HTTP/2.0" 200 1000 "-" "curl/8.5"\n',
    );
    writeFileSync(
      legacyVhostPath,
      [
        'server {',
        '  listen 443 ssl;',
        '  server_name legacy.example.test www.legacy.example.test;',
        `  access_log ${legacyLogPath};`,
        `  access_log ${dedicatedLogPath} yunpanel_site_traffic if=$yunpanel_traffic_log_enabled;`,
        '}',
      ].join('\n') + '\n',
    );
    writeFileSync(dedicatedLogPath, `2026-11-21T20:07:00Z\t${SITE_A}\t4096\n`);
    clock = Date.parse('2026-11-21T20:08:00.000Z');
    await ledger.sync();

    const afterUpgrade = await ledger.getWebsiteTraffic(SITE_A, { month: '2026-11', sync: false });
    assert.equal(afterUpgrade.ok, true);
    assert.equal(afterUpgrade.bytes, 12345 + 1000 + 4096);
    assert.equal(afterUpgrade.accountingMode, 'dedicated_traffic_log');
    assert.equal(afterUpgrade.includesStaticAssets, true);
    assert.equal(afterUpgrade.scope, 'nginx_outbound_body_bytes');
    assert.equal(afterUpgrade.meterStartedAt, '2026-11-21T20:00:00.000Z');

    // Subsequent writes to legacy access log after upgrade MUST NOT be double-counted!
    appendFileSync(
      legacyLogPath,
      '198.51.100.44 - - [21/Nov/2026:23:09:00 +0300] "GET /post-upgrade HTTP/2.0" 200 5000 "-" "curl/8.5"\n',
    );
    await ledger.sync();
    assert.equal((await ledger.getWebsiteTraffic(SITE_A, { month: '2026-11', sync: false })).bytes, 12345 + 1000 + 4096);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
