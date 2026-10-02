import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createNftablesManager,
  NftablesManagerError,
  createFirewallStatusInspector,
  inspectFirewallStatus,
  FirewallStatusInspectorError,
  firewallStatusInspectorInternals,
  nftablesManagerInternals,
} from '../src/index.js';

const MOCK_LIVE_RULESET = `table inet yunpanel {
  set crowdsec-blacklists {
    type ipv4_addr
    flags interval
    elements = { 198.51.100.1 }
  }
  chain input {
    type filter hook input priority 0; policy drop;
    tcp dport 22 accept
    tcp dport 80 accept
    tcp dport 443 accept
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
    iifname "docker0" accept
    oifname "docker0" accept
    iifname "br-*" accept
    oifname "br-*" accept
  }
}
`;

test('AC-1: Firewall status serviceEnabled is derived strictly from verified systemd evidence, never request option', async () => {
  // Test case A: Request says enableService: true, but systemd is-enabled reports disabled.
  // The result MUST report serviceEnabled: false.
  const managerA = createNftablesManager({
    configPath: '/etc/nftables.conf',
    execFn: async (file, args) => {
      if (args[0] === 'list' && args[1] === 'ruleset') {
        return { stdout: MOCK_LIVE_RULESET };
      }
      if (args[0] === 'is-active') {
        return { stdout: 'inactive\n' };
      }
      if (args[0] === 'is-enabled') {
        return { stdout: 'disabled\n' };
      }
      return { stdout: '' };
    },
    statFn: async () => {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
    writeFileFn: async () => {},
    rmFn: async () => {},
  });

  const resultA = await managerA.applyRuleset({
    allowedSshPort: 22,
    enableService: true,
    persist: false, // Don't trigger enable call, test status derivation
  });

  assert.equal(resultA.success, true);
  assert.equal(resultA.serviceEnabled, false, 'serviceEnabled must be false because systemd reported disabled');
  assert.equal(resultA.serviceActive, false);
  assert.equal(resultA.systemdEvidence.unitFileState, 'disabled');

  // Test case B: Request says enableService: false, but systemd is-enabled reports enabled.
  // The result MUST report serviceEnabled: true based on real evidence.
  const managerB = createNftablesManager({
    configPath: '/etc/nftables.conf',
    execFn: async (file, args) => {
      if (args[0] === 'list' && args[1] === 'ruleset') {
        return { stdout: MOCK_LIVE_RULESET };
      }
      if (args[0] === 'is-active') {
        return { stdout: args[1] === 'nftables' ? 'active\n' : 'inactive\n' };
      }
      if (args[0] === 'is-enabled') {
        return { stdout: args[1] === 'nftables' ? 'enabled\n' : 'disabled\n' };
      }
      return { stdout: '' };
    },
    statFn: async () => {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
    writeFileFn: async () => {},
    rmFn: async () => {},
    chmodFn: async () => {},
    renameFn: async () => {},
  });

  const resultB = await managerB.applyRuleset({
    allowedSshPort: 22,
    enableService: false,
  });

  assert.equal(resultB.success, true);
  assert.equal(resultB.serviceEnabled, true, 'serviceEnabled must be true because systemd reported enabled');
  assert.equal(resultB.serviceActive, true);
  assert.equal(resultB.systemdEvidence.unitFileState, 'enabled');
  assert.equal(resultB.systemdEvidence.verified, true);
});

test('AC-2: UFW read error is reported as unknown/error, never assumed inactive', async () => {
  const inspector = createFirewallStatusInspector({
    ufwPath: '/usr/sbin/ufw',
    statFn: async () => ({ isFile: () => true }),
    execFn: async (file, args) => {
      if (file === '/usr/sbin/ufw' && args[0] === 'status') {
        const err = new Error('Permission denied reading /etc/ufw/ufw.conf');
        err.stderr = 'Permission denied';
        throw err;
      }
      if (args[0] === 'is-active' || args[0] === 'is-enabled') {
        return { stdout: 'inactive\n' };
      }
      if (args[0] === 'list' && args[1] === 'ruleset') {
        return { stdout: MOCK_LIVE_RULESET };
      }
      return { stdout: '' };
    },
  });

  const conflicts = await inspector.inspectConflictingFirewalls();
  assert.equal(conflicts.ufw.installed, true);
  assert.equal(conflicts.ufw.status, 'error');
  assert.equal(conflicts.ufw.statusActive, 'unknown', 'UFW statusActive must be unknown on read error, NOT false');
  assert.equal(conflicts.conflictStatus, 'unknown', 'Conflict status must be unknown when UFW cannot be verified');
  assert.ok(conflicts.ufw.error);

  const status = await inspector.inspectStatus();
  assert.equal(status.conflictingFirewalls.conflictStatus, 'unknown');
  assert.equal(status.status, 'unknown');
  assert.equal(status.healthy, false);
});

test('AC-2: firewalld read error is reported as unknown/error, never assumed inactive', async () => {
  const inspector = createFirewallStatusInspector({
    execFn: async (file, args) => {
      if (args[1] === 'firewalld') {
        const err = new Error('D-Bus connection error to systemd');
        throw err;
      }
      if (args[0] === 'is-active' && args[1] === 'nftables') {
        return { stdout: 'active\n' };
      }
      if (args[0] === 'is-enabled' && args[1] === 'nftables') {
        return { stdout: 'enabled\n' };
      }
      if (args[0] === 'list' && args[1] === 'ruleset') {
        return { stdout: MOCK_LIVE_RULESET };
      }
      return { stdout: '' };
    },
    statFn: async () => {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
    readFileFn: async () => MOCK_LIVE_RULESET,
  });

  const conflicts = await inspector.inspectConflictingFirewalls();
  assert.equal(conflicts.firewalld.status, 'error');
  assert.equal(conflicts.firewalld.active, 'unknown', 'firewalld active must be unknown on check error, NOT false');
  assert.equal(conflicts.conflictStatus, 'unknown');
  assert.ok(conflicts.firewalld.error);
});

test('AC-2: ruleset read or parse error is reported as unknown/error, never assumed empty or inactive', async () => {
  // Test parseRulesetMetadata directly
  const metaError = nftablesManagerInternals.parseRulesetMetadata(null, 'Ruleset read failed: I/O error');
  assert.equal(metaError.status, 'error');
  assert.equal(metaError.loaded, 'unknown');
  assert.ok(metaError.error);

  // Test inspectLiveApply with failing execFn
  const inspector = createFirewallStatusInspector({
    execFn: async (file, args) => {
      if (args[0] === 'list' && args[1] === 'ruleset') {
        const err = new Error('nft command failed');
        err.stderr = 'nft: command not found or kernel module missing';
        throw err;
      }
      return { stdout: '' };
    },
  });

  const liveApply = await inspector.inspectLiveApply();
  assert.equal(liveApply.status, 'error');
  assert.equal(liveApply.applied, false);
  assert.ok(liveApply.error);

  const overall = await inspector.inspectStatus();
  assert.equal(overall.status, 'error', 'Overall status must be error when live ruleset cannot be read');
  assert.equal(overall.healthy, false);
});

test('AC-3: liveApply, persistentFile, bootLoading, and crowdsecBouncer are reported independently with drift detection', async () => {
  const inspector = createFirewallStatusInspector({
    configPath: '/etc/nftables.conf',
    execFn: async (file, args) => {
      if (args[0] === 'list' && args[1] === 'ruleset') {
        return { stdout: MOCK_LIVE_RULESET };
      }
      if (args[0] === 'is-active' && args[1] === 'nftables') {
        return { stdout: 'active\n' };
      }
      if (args[0] === 'is-enabled' && args[1] === 'nftables') {
        return { stdout: 'enabled\n' };
      }
      if (args[0] === 'is-active' && args[1] === 'crowdsec-firewall-bouncer') {
        return { stdout: 'active\n' };
      }
      if (args[0] === 'is-enabled' && args[1] === 'crowdsec-firewall-bouncer') {
        return { stdout: 'enabled\n' };
      }
      if (args[0] === '-c') {
        return { stdout: '' }; // valid syntax
      }
      return { stdout: '' };
    },
    statFn: async (target) => {
      if (target === '/etc/nftables.conf') {
        return { mode: 0o755, size: 500 };
      }
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
    readFileFn: async (target) => {
      if (target === '/etc/nftables.conf') {
        // Different content in config file than live ruleset -> drift!
        return 'table inet yunpanel { chain input { type filter hook input priority 0; policy accept; } }\n';
      }
      throw new Error('Not found');
    },
  });

  const status = await inspector.inspectStatus();

  // 1. liveApply is independently reported
  assert.equal(status.liveApply.applied, true);
  assert.equal(status.liveApply.status, 'applied');
  assert.equal(status.liveApply.hasYunpanelTable, true);
  assert.equal(status.liveApply.hasCrowdsecSets, true);
  assert.ok(status.liveApply.rulesetSha256);

  // 2. persistentFile is independently reported and detects drift
  assert.equal(status.persistentFile.exists, true);
  assert.equal(status.persistentFile.valid, true);
  assert.equal(status.persistentFile.matchesLive, false, 'Persistent file must report drift when sha256 differs from live');
  assert.equal(status.persistentFile.status, 'persisted');

  // 3. bootLoading is independently reported
  assert.equal(status.bootLoading.enabled, true);
  assert.equal(status.bootLoading.active, true);
  assert.equal(status.bootLoading.status, 'active');
  assert.equal(status.bootLoading.verified, true);

  // 4. crowdsecBouncer is independently reported
  assert.equal(status.crowdsecBouncer.installed, true);
  assert.equal(status.crowdsecBouncer.healthy, true);
  assert.equal(status.crowdsecBouncer.status, 'healthy');
  assert.equal(status.crowdsecBouncer.hasLiveSets, true);

  // Overall status reflects degradation due to drift
  assert.equal(status.status, 'degraded');
  assert.equal(status.healthy, false);
});

test('AC-3: crowdsecBouncer reports bouncer_inactive when unit is installed but stopped', async () => {
  const inspector = createFirewallStatusInspector({
    execFn: async (file, args) => {
      if (args[0] === 'list' && args[1] === 'ruleset') {
        return { stdout: MOCK_LIVE_RULESET };
      }
      if (args[0] === 'is-active' && args[1] === 'nftables') {
        return { stdout: 'active\n' };
      }
      if (args[0] === 'is-enabled' && args[1] === 'nftables') {
        return { stdout: 'enabled\n' };
      }
      if (args[0] === 'is-active' && args[1] === 'crowdsec-firewall-bouncer') {
        return { stdout: 'inactive\n' };
      }
      if (args[0] === 'is-enabled' && args[1] === 'crowdsec-firewall-bouncer') {
        return { stdout: 'enabled\n' };
      }
      return { stdout: '' };
    },
    statFn: async () => {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
    readFileFn: async () => '',
  });

  const bouncerHealth = await inspector.inspectCrowdsecBouncerHealth();
  assert.equal(bouncerHealth.installed, true);
  assert.equal(bouncerHealth.active, false);
  assert.equal(bouncerHealth.healthy, false);
  assert.equal(bouncerHealth.status, 'bouncer_inactive');
});

test('AC-4: applyRuleset stops fail-closed if required ruleset snapshot fails', async () => {
  const manager = createNftablesManager({
    execFn: async (file, args) => {
      if (args[0] === 'list' && args[1] === 'ruleset') {
        const err = new Error('Failed to dump ruleset from kernel');
        err.stderr = 'netlink error: Operation not permitted';
        throw err;
      }
      return { stdout: '' };
    },
    statFn: async () => {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
    writeFileFn: async () => {},
  });

  await assert.rejects(
    () => manager.applyRuleset({ allowedSshPort: 22 }),
    (err) => {
      assert.equal(err instanceof NftablesManagerError, true);
      assert.equal(err.code, 'ruleset_snapshot_failed');
      assert.match(err.message, /Failed to snapshot/);
      return true;
    },
  );
});

test('AC-4: applyRuleset does not swallow failed systemctl enable or start operations', async () => {
  // Test enable failure
  const managerEnableFail = createNftablesManager({
    execFn: async (file, args) => {
      if (args[0] === 'list' && args[1] === 'ruleset') {
        return { stdout: MOCK_LIVE_RULESET };
      }
      if (args[0] === 'enable' && args[1] === 'nftables') {
        const err = new Error('systemctl enable failed');
        err.stderr = 'Failed to enable unit: Unit /etc/systemd/system/nftables.service is masked.';
        throw err;
      }
      return { stdout: '' };
    },
    statFn: async () => {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
    writeFileFn: async () => {},
    rmFn: async () => {},
    chmodFn: async () => {},
    renameFn: async () => {},
  });

  await assert.rejects(
    () => managerEnableFail.applyRuleset({
      allowedSshPort: 22,
      enableService: true,
      persist: true,
    }),
    (err) => {
      assert.equal(err instanceof NftablesManagerError, true);
      assert.equal(err.code, 'service_operation_failed');
      assert.match(err.message, /Failed to enable nftables/);
      return true;
    },
  );

  // Test start failure
  const managerStartFail = createNftablesManager({
    execFn: async (file, args) => {
      if (args[0] === 'list' && args[1] === 'ruleset') {
        return { stdout: MOCK_LIVE_RULESET };
      }
      if (args[0] === 'enable' && args[1] === 'nftables') {
        return { stdout: '' };
      }
      if (args[0] === 'start' && args[1] === 'nftables') {
        const err = new Error('systemctl start failed');
        err.stderr = 'Job for nftables.service failed because the control process exited with error code.';
        throw err;
      }
      return { stdout: '' };
    },
    statFn: async () => {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
    writeFileFn: async () => {},
    rmFn: async () => {},
    chmodFn: async () => {},
    renameFn: async () => {},
  });

  await assert.rejects(
    () => managerStartFail.applyRuleset({
      allowedSshPort: 22,
      enableService: true,
      persist: true,
    }),
    (err) => {
      assert.equal(err instanceof NftablesManagerError, true);
      assert.equal(err.code, 'service_operation_failed');
      assert.match(err.message, /Failed to start nftables/);
      return true;
    },
  );
});

test('AC-4: applyRuleset stops fail-closed if required service verification fails', async () => {
  const manager = createNftablesManager({
    execFn: async (file, args) => {
      if (args[0] === 'list' && args[1] === 'ruleset') {
        return { stdout: MOCK_LIVE_RULESET };
      }
      if (args[0] === 'enable' || args[0] === 'start') {
        return { stdout: '' };
      }
      if (args[0] === 'is-enabled' && args[1] === 'nftables') {
        return { stdout: 'disabled\n' };
      }
      if (args[0] === 'is-active' && args[1] === 'nftables') {
        return { stdout: 'inactive\n' };
      }
      return { stdout: '' };
    },
    statFn: async () => {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
    writeFileFn: async () => {},
    rmFn: async () => {},
    chmodFn: async () => {},
    renameFn: async () => {},
  });

  await assert.rejects(
    () => manager.applyRuleset({
      allowedSshPort: 22,
      enableService: true,
      persist: true,
      requireServiceVerification: true,
    }),
    (err) => {
      assert.equal(err instanceof NftablesManagerError, true);
      assert.equal(err.code, 'service_verification_failed');
      return true;
    },
  );
});

test('AC-4: applyRuleset stops fail-closed if conflicting firewall status is unknown and not overridden', async () => {
  const manager = createNftablesManager({
    ufwPath: '/usr/sbin/ufw',
    statFn: async () => ({ isFile: () => true }),
    execFn: async (file, args) => {
      if (file === '/usr/sbin/ufw' && args[0] === 'status') {
        throw new Error('EACCES: permission denied to ufw');
      }
      if (args[0] === 'list' && args[1] === 'ruleset') {
        return { stdout: MOCK_LIVE_RULESET };
      }
      return { stdout: '' };
    },
    writeFileFn: async () => {},
    rmFn: async () => {},
    chmodFn: async () => {},
    renameFn: async () => {},
  });

  await assert.rejects(
    () => manager.applyRuleset({ allowedSshPort: 22 }),
    (err) => {
      assert.equal(err instanceof NftablesManagerError, true);
      assert.equal(err.code, 'conflicting_firewall_unknown');
      return true;
    },
  );
});

test('AC-5: inspectNftables and inspectFirewallStatus full contract verification', async () => {
  const manager = createNftablesManager({
    configPath: '/etc/nftables.conf',
    execFn: async (file, args) => {
      if (args[0] === '--version') return { stdout: 'nftables v1.0.9\n' };
      if (args[0] === 'is-active' && args[1] === 'nftables') return { stdout: 'active\n' };
      if (args[0] === 'is-enabled' && args[1] === 'nftables') return { stdout: 'enabled\n' };
      if (args[0] === 'is-active' && args[1] === 'crowdsec-firewall-bouncer') return { stdout: 'active\n' };
      if (args[0] === 'is-enabled' && args[1] === 'crowdsec-firewall-bouncer') return { stdout: 'enabled\n' };
      if (args[0] === 'list' && args[1] === 'ruleset') return { stdout: MOCK_LIVE_RULESET };
      if (args[0] === '-c') return { stdout: '' };
      return { stdout: '' };
    },
    statFn: async (target) => {
      if (target === '/etc/nftables.conf') return { mode: 0o755, size: 500 };
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
    readFileFn: async () => MOCK_LIVE_RULESET,
  });

  const inspected = await manager.inspectNftables();
  assert.equal(inspected.satisfied, true);
  assert.equal(inspected.serviceStatus.active, true);
  assert.equal(inspected.serviceStatus.enabled, true);
  assert.equal(inspected.serviceStatus.verified, true);
  assert.equal(inspected.conflictingFirewalls.conflictDetected, false);
  assert.equal(inspected.ruleset.hasYunpanelTable, true);
  assert.ok(inspected.firewallStatus);
  assert.equal(inspected.firewallStatus.healthy, true);
  assert.equal(inspected.firewallStatus.status, 'active');

  const directStatus = await inspectFirewallStatus({
    configPath: '/etc/nftables.conf',
    execFn: async (file, args) => {
      if (args[0] === 'is-active' && args[1] === 'nftables') return { stdout: 'active\n' };
      if (args[0] === 'is-enabled' && args[1] === 'nftables') return { stdout: 'enabled\n' };
      if (args[0] === 'is-active' && args[1] === 'crowdsec-firewall-bouncer') return { stdout: 'active\n' };
      if (args[0] === 'is-enabled' && args[1] === 'crowdsec-firewall-bouncer') return { stdout: 'enabled\n' };
      if (args[0] === 'list' && args[1] === 'ruleset') return { stdout: MOCK_LIVE_RULESET };
      if (args[0] === '-c') return { stdout: '' };
      return { stdout: '' };
    },
    statFn: async (target) => {
      if (target === '/etc/nftables.conf') return { mode: 0o755, size: 500 };
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
    readFileFn: async () => MOCK_LIVE_RULESET,
  });

  assert.equal(directStatus.healthy, true);
  assert.equal(directStatus.serviceEnabled, true);
  assert.equal(directStatus.serviceActive, true);
  assert.equal(directStatus.liveApply.applied, true);
  assert.equal(directStatus.persistentFile.status, 'persisted');
  assert.equal(directStatus.bootLoading.status, 'active');
  assert.equal(directStatus.crowdsecBouncer.healthy, true);
});
