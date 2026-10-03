import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import {
  createFirewallService,
  FirewallServiceError,
  computeFirewallImpact,
  parseAllowedPortsFromRuleset,
} from '../src/firewall-service.js';
import {
  mountFirewallRoutes,
  FirewallHttpError,
} from '../src/firewall-http.js';
import {
  createNftablesManager,
  NftablesManagerError,
  MANAGED_FIREWALL_TABLE,
  MANAGED_FIREWALL_FAMILY,
} from '@yunpanel/host-runtime';

const MOCK_LIVE_RULESET = `
table ip filter {
  chain INPUT {
    type filter hook input priority filter; policy accept;
  }
  chain FORWARD {
    type filter hook forward priority filter; policy drop;
    oifname "docker0" ct state related,established counter accept
    oifname "docker0" counter jump DOCKER
    iifname "docker0" oifname != "docker0" counter accept
    iifname "docker0" oifname "docker0" counter accept
  }
}
table ip nat {
  chain POSTROUTING {
    type nat hook postrouting priority srcnat; policy accept;
    oifname != "docker0" ip saddr 172.17.0.0/16 counter masquerade
  }
}
table inet yunpanel {
  set crowdsec-blacklists {
    type ipv4_addr
    flags interval
    elements = { 198.51.100.10, 203.0.113.50 }
  }
  set crowdsec6-blacklists {
    type ipv6_addr
    flags interval
    elements = { 2001:db8::1 }
  }
  chain input {
    type filter hook input priority 0; policy drop;
    ip saddr @crowdsec-blacklists drop
    ip6 saddr @crowdsec6-blacklists drop
    ct state established,related accept
    iif "lo" accept
    tcp dport 22 accept
    tcp dport { 80, 443 } accept
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
    ct state established,related accept
    iifname "docker0" accept
    oifname "docker0" accept
    iifname "br-*" accept
    oifname "br-*" accept
  }
}
`;

const VALID_CANDIDATE_RULESET = `
table inet yunpanel {
  set crowdsec-blacklists {
    type ipv4_addr
    flags interval
  }
  set crowdsec6-blacklists {
    type ipv6_addr
    flags interval
  }
  chain input {
    type filter hook input priority 0; policy drop;
    ip saddr @crowdsec-blacklists drop
    ip6 saddr @crowdsec6-blacklists drop
    ct state established,related accept
    iif "lo" accept
    tcp dport { 22, 2222 } accept
    tcp dport { 80, 443 } accept
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
    ct state established,related accept
    iifname "docker0" accept
    oifname "docker0" accept
    iifname "br-*" accept
    oifname "br-*" accept
  }
}
`;

function createMockAuditStore() {
  const events = [];
  return {
    record: (event) => {
      const rec = { id: events.length + 1, ...event, createdAt: Date.now() };
      events.push(rec);
      return rec;
    },
    getEvents: () => [...events],
    clear: () => { events.length = 0; },
  };
}

function createMockHarness({
  initialRuleset = MOCK_LIVE_RULESET,
  failApply = false,
  failSyntax = false,
  failSnapshot = false,
  connectionFails = false,
} = {}) {
  let liveRuleset = initialRuleset;
  let nftablesServiceActive = true;
  let nftablesServiceEnabled = true;
  let applyFailRemaining = failApply ? 1 : 0;
  const writtenFiles = new Map();
  const execCommands = [];
  const auditStore = createMockAuditStore();

  const nftablesManager = createNftablesManager({
    configPath: '/etc/nftables.conf',
    execFn: async (file, args) => {
      execCommands.push([file, ...args]);

      if (args[0] === 'list' && args[1] === 'ruleset') {
        if (failSnapshot) {
          const err = new Error('ruleset read failed');
          err.stderr = 'Kernel nftables subsystem unavailable';
          throw err;
        }
        return { stdout: liveRuleset };
      }

      if (args[0] === '-c' && args[1] === '-f') {
        if (failSyntax) {
          const err = new Error('syntax error');
          err.stderr = 'Error: syntax error, unexpected newline in rule';
          throw err;
        }
        return { stdout: '' };
      }

      if (args[0] === '-f') {
        if (applyFailRemaining > 0) {
          applyFailRemaining -= 1;
          const err = new Error('apply failed');
          err.stderr = 'Kernel error processing ruleset';
          throw err;
        }
        const tempPath = args[1];
        if (writtenFiles.has(tempPath)) {
          const content = writtenFiles.get(tempPath);
          if (content.includes('table inet yunpanel {')) {
            liveRuleset = content;
          } else if (content.includes('delete table inet yunpanel')) {
            liveRuleset = liveRuleset.replace(/table inet yunpanel\s*\{[\s\S]*?\n\}/, '').trim();
          } else {
            liveRuleset = content;
          }
        }
        return { stdout: '' };
      }

      // Systemctl control
      if (args[0] === 'stop' && args[1] === 'nftables') {
        nftablesServiceActive = false;
        return { stdout: '' };
      }
      if (args[0] === 'start' && args[1] === 'nftables') {
        nftablesServiceActive = true;
        return { stdout: '' };
      }
      if (args[0] === 'disable' && args[1] === 'nftables') {
        nftablesServiceEnabled = false;
        return { stdout: '' };
      }
      if (args[0] === 'enable' && args[1] === 'nftables') {
        nftablesServiceEnabled = true;
        return { stdout: '' };
      }

      if (args[0] === 'is-active') {
        if (args[1] === 'ufw' || args[1] === 'firewalld') {
          return { stdout: 'inactive\n' };
        }
        if (args[1] === 'nftables') {
          return { stdout: nftablesServiceActive ? 'active\n' : 'inactive\n' };
        }
        return { stdout: 'active\n' };
      }

      if (args[0] === 'is-enabled') {
        if (args[1] === 'ufw' || args[1] === 'firewalld') {
          return { stdout: 'disabled\n' };
        }
        if (args[1] === 'nftables') {
          return { stdout: nftablesServiceEnabled ? 'enabled\n' : 'disabled\n' };
        }
        return { stdout: 'enabled\n' };
      }

      if (args[0] === '--version') {
        return { stdout: 'nftables v1.0.6 (Lester Gooch #2)\n' };
      }

      if (args[0] === 'status' && file.includes('ufw')) {
        return { stdout: 'Status: inactive\n' };
      }

      return { stdout: '' };
    },
    statFn: async () => {},
    readFileFn: async (path) => {
      if (writtenFiles.has(path)) return writtenFiles.get(path);
      return liveRuleset;
    },
    writeFileFn: async (target, content) => {
      writtenFiles.set(target, content);
    },
    chmodFn: async () => {},
    renameFn: async (src, dst) => {
      writtenFiles.set(dst, writtenFiles.get(src));
      writtenFiles.delete(src);
    },
    rmFn: async (target) => {
      writtenFiles.delete(target);
    },
  });

  let simulatedNow = 1_700_000_000_000;
  const timerCallbacks = new Map();
  let nextTimerId = 1;

  const timerFn = {
    setTimeout: (fn, ms) => {
      const id = nextTimerId++;
      timerCallbacks.set(id, { fn, expiresAt: simulatedNow + ms });
      return id;
    },
    clearTimeout: (id) => {
      timerCallbacks.delete(id);
    },
  };

  const advanceTime = async (ms) => {
    simulatedNow += ms;
    for (const [id, entry] of [...timerCallbacks.entries()]) {
      if (simulatedNow >= entry.expiresAt) {
        timerCallbacks.delete(id);
        await entry.fn();
      }
    }
  };

  const connectFn = async ({ host, port, timeoutMs }) => {
    if (connectionFails) {
      throw new Error(`ECONNREFUSED ${host}:${port}`);
    }
    return { connected: true };
  };

  const firewallService = createFirewallService({
    nftablesManager,
    auditStore,
    localServerId: 'srv-local-01',
    now: () => simulatedNow,
    connectFn,
    timerFn,
    execFn: async (file, args) => {
      if (args[0] === 'stop' && args[1] === 'nftables') nftablesServiceActive = false;
      if (args[0] === 'disable' && args[1] === 'nftables') nftablesServiceEnabled = false;
      return { stdout: '' };
    },
  });

  return {
    nftablesManager,
    firewallService,
    auditStore,
    writtenFiles,
    execCommands,
    advanceTime,
    getLiveRuleset: () => liveRuleset,
    setLiveRuleset: (r) => { liveRuleset = r; },
    getNow: () => simulatedNow,
    setServiceState: ({ active, enabled }) => {
      if (active !== undefined) nftablesServiceActive = active;
      if (enabled !== undefined) nftablesServiceEnabled = enabled;
    },
  };
}

function createTestHttpApp({ firewallService, role = 'owner' } = {}) {
  const app = express();
  app.use(express.json());

  // Mock authentication matching YunPanel's describePanelAccess
  app.use((req, res, next) => {
    if (role === 'unauthenticated') {
      req.auth = null;
    } else if (role === 'owner') {
      req.auth = {
        user: { id: 'usr-owner-1', username: 'admin', role: 'owner' },
        access: { mode: 'management', permissions: ['*'] },
        security: { managementAllowed: true },
      };
    } else if (role === 'read_only') {
      req.auth = {
        user: { id: 'usr-ro-1', username: 'auditor', role: 'read_only' },
        access: { mode: 'read_only', permissions: ['servers.read'] },
        security: { managementAllowed: false },
      };
    } else if (role === 'site_manager') {
      req.auth = {
        user: { id: 'usr-sm-1', username: 'siteowner', role: 'site_manager' },
        access: { mode: 'site_management', permissions: ['sites.manage'] },
        security: { managementAllowed: true },
      };
    }
    next();
  });

  mountFirewallRoutes(app, {
    firewallService,
    localServerId: 'srv-local-01',
  });

  // Error handler
  app.use((err, req, res, next) => {
    if (err instanceof FirewallServiceError || err instanceof FirewallHttpError || err instanceof NftablesManagerError) {
      return res.status(err.status ?? 400).json({
        error: { code: err.code ?? 'firewall_error', message: err.message },
      });
    }
    return res.status(500).json({ error: { code: 'internal_error', message: err.message } });
  });

  return app;
}

test('PROD-04 Acceptance Criteria Suite: Safe Firewall Mutation & Connection Verification', async (suite) => {

  // ==========================================================================
  // Criterion 1 & 2: Preview, Syntax Check, and Impact Analysis
  // ==========================================================================
  await suite.test('AC-1 & AC-2: Preview provides syntax check, impact analysis and records audit log', async () => {
    const { firewallService, auditStore } = createMockHarness();

    const preview = await firewallService.previewMutation({
      candidateRuleset: VALID_CANDIDATE_RULESET,
      allowedSshPorts: [22, 2222],
      actorId: 'usr-admin-1',
    });

    assert.equal(preview.valid, true);
    assert.equal(preview.syntaxValid, true);
    assert.equal(preview.impact.action, 'update');
    assert.deepEqual(preview.impact.ports.ssh.proposed, [22, 2222]);
    assert.deepEqual(preview.impact.ports.ssh.added, [2222]);
    assert.equal(preview.impact.lockoutRisk, false);
    assert.equal(preview.impact.dockerCoexistence.dockerProtected, true);
    assert.equal(preview.impact.dockerCoexistence.bridgeInterfacesAllowed, true);
    assert.equal(preview.impact.crowdsec.setsPreserved, true);
    assert.equal(preview.impact.crowdsec.activeBansRetainedCount, 3);

    // Audit log check
    const auditEvents = auditStore.getEvents();
    const previewEvent = auditEvents.find((e) => e.action === 'firewall.preview');
    assert.ok(previewEvent);
    assert.equal(previewEvent.outcome, 'succeeded');
    assert.equal(previewEvent.actorId, 'usr-admin-1');
  });

  await suite.test('AC-2: Preview rejects candidate with syntax error and fails closed with candidate_syntax_error', async () => {
    const { firewallService, auditStore } = createMockHarness({ failSyntax: true });

    // Candidate has CrowdSec and Docker definitions so it passes coexistence checks and triggers syntax check
    const syntaxBrokenCandidate = VALID_CANDIDATE_RULESET.replace(
      'tcp dport { 22, 2222 } accept',
      'tcp dport { 22, 2222 } accept\n    syntax error broken rule',
    );

    await assert.rejects(
      () => firewallService.previewMutation({
        candidateRuleset: syntaxBrokenCandidate,
        allowedSshPorts: [22],
        actorId: 'usr-admin-1',
      }),
      (err) => {
        assert.equal(err instanceof FirewallServiceError, true);
        assert.equal(err.code, 'candidate_syntax_error');
        return true;
      },
    );

    const auditEvents = auditStore.getEvents();
    const failedPreview = auditEvents.find((e) => e.action === 'firewall.preview' && e.outcome === 'failed');
    assert.ok(failedPreview);
    assert.equal(failedPreview.code, 'candidate_syntax_error');
  });

  await suite.test('AC-2: Preview detects lockout risk when candidate closes SSH port', async () => {
    const { firewallService } = createMockHarness();

    const rulesetWithoutSsh = `
table inet yunpanel {
  set crowdsec-blacklists { type ipv4_addr; flags interval; }
  set crowdsec6-blacklists { type ipv6_addr; flags interval; }
  chain input {
    type filter hook input priority 0; policy drop;
    ip saddr @crowdsec-blacklists drop
    ip6 saddr @crowdsec6-blacklists drop
    tcp dport 80 accept
  }
}
`;

    await assert.rejects(
      () => firewallService.previewMutation({
        candidateRuleset: rulesetWithoutSsh,
        allowedSshPorts: [22],
      }),
      (err) => {
        assert.equal(err.code, 'ssh_lockout_risk');
        return true;
      },
    );
  });

  await suite.test('AC-2: Preview rejects candidates violating Docker coexistence (global flush or missing bridge forward)', async () => {
    const { firewallService } = createMockHarness();

    // 1. Candidate with global flush ruleset
    const rulesetWithFlush = `flush ruleset\ntable inet yunpanel { chain input { type filter hook input priority 0; tcp dport 22 accept } }`;
    await assert.rejects(
      () => firewallService.previewMutation({ candidateRuleset: rulesetWithFlush, allowedSshPorts: [22] }),
      (err) => err.code === 'global_flush_prohibited',
    );

    // 2. Candidate deleting Docker tables
    const rulesetDeletingDocker = `table inet yunpanel {}\ndelete table ip filter\n`;
    await assert.rejects(
      () => firewallService.previewMutation({ candidateRuleset: rulesetDeletingDocker, allowedSshPorts: [22] }),
      (err) => err.code === 'docker_table_interference',
    );
  });

  await suite.test('AC-2: Preview rejects candidates violating CrowdSec coexistence (deleting sets or drop rules)', async () => {
    const { firewallService } = createMockHarness();

    const rulesetWithoutCrowdsec = `
table inet yunpanel {
  chain input {
    type filter hook input priority 0; policy drop;
    tcp dport 22 accept
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

    await assert.rejects(
      () => firewallService.previewMutation({ candidateRuleset: rulesetWithoutCrowdsec, allowedSshPorts: [22] }),
      (err) => err.code === 'crowdsec_integration_missing',
    );
  });

  // ==========================================================================
  // Criterion 3: Snapshot Creation & Deterministic Same-Host Rollback
  // ==========================================================================
  await suite.test('AC-3: Automatically takes snapshot before mutation and lists it in snapshots history', async () => {
    const { firewallService } = createMockHarness();

    const beforeSnapshots = firewallService.listSnapshots();
    assert.equal(beforeSnapshots.length, 0);

    const snapshot = await firewallService.createSnapshot({ trigger: 'manual_backup', label: 'Initial test snapshot' });
    assert.ok(snapshot.snapshotId);
    assert.equal(snapshot.trigger, 'manual_backup');
    assert.ok(snapshot.rulesetSha256);
    assert.deepEqual(snapshot.sshPorts, [22]);

    const snapshots = firewallService.listSnapshots();
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].snapshotId, snapshot.snapshotId);
  });

  await suite.test('AC-3: Aborts fail-closed with ruleset_snapshot_failed if snapshot capture fails', async () => {
    const { firewallService } = createMockHarness({ failSnapshot: true });

    await assert.rejects(
      () => firewallService.applyMutation({ candidateRuleset: VALID_CANDIDATE_RULESET, allowedSshPorts: [22] }),
      (err) => {
        assert.equal(err.code, 'ruleset_snapshot_failed');
        assert.equal(err.status, 500);
        return true;
      },
    );
  });

  await suite.test('AC-3: Applies deterministic same-host rollback immediately if kernel apply fails', async () => {
    const { firewallService, auditStore } = createMockHarness({ failApply: true });

    await assert.rejects(
      () => firewallService.applyMutation({
        candidateRuleset: VALID_CANDIDATE_RULESET,
        allowedSshPorts: [22],
        actorId: 'usr-admin-1',
      }),
      (err) => {
        assert.equal(err.code, 'apply_failed');
        return true;
      },
    );

    const auditEvents = auditStore.getEvents();
    const applyFailed = auditEvents.find((e) => e.action === 'firewall.apply' && e.outcome === 'failed');
    const rollbackSuccess = auditEvents.find((e) => e.action === 'firewall.rollback' && e.outcome === 'succeeded');
    assert.ok(applyFailed);
    assert.ok(rollbackSuccess);
    assert.equal(rollbackSuccess.code, 'rollback_after_apply_failure');
  });

  // ==========================================================================
  // Criterion 4: Timed Confirmation Mechanism & New Connection Verification
  // ==========================================================================
  await suite.test('AC-4: Mutation enters pending_confirmation and sets up countdown window', async () => {
    const { firewallService, auditStore } = createMockHarness();

    const result = await firewallService.applyMutation({
      candidateRuleset: VALID_CANDIDATE_RULESET,
      allowedSshPorts: [22, 2222],
      timeoutSeconds: 30,
      actorId: 'usr-admin-1',
    });

    assert.equal(result.status, 'pending_confirmation');
    assert.ok(result.pendingId);
    assert.ok(result.confirmationToken);
    assert.equal(result.timeoutSeconds, 30);
    assert.equal(result.requiresNewConnectionVerification, true);

    const auditEvents = auditStore.getEvents();
    const applyAccepted = auditEvents.find((e) => e.action === 'firewall.apply' && e.outcome === 'accepted');
    assert.ok(applyAccepted);
    assert.equal(applyAccepted.code, 'awaiting_timed_confirmation');
  });

  await suite.test('AC-4: Automatically rolls back when timed confirmation countdown expires', async () => {
    const { firewallService, auditStore, advanceTime, getLiveRuleset } = createMockHarness();

    const applyResult = await firewallService.applyMutation({
      candidateRuleset: VALID_CANDIDATE_RULESET,
      allowedSshPorts: [22, 2222],
      timeoutSeconds: 30,
      actorId: 'usr-admin-1',
    });

    assert.equal(applyResult.status, 'pending_confirmation');

    // Advance simulated time past the 30-second window
    await advanceTime(35_000);

    // Verify auto-rollback executed
    const auditEvents = auditStore.getEvents();
    const rollbackEvent = auditEvents.find((e) => e.action === 'firewall.rollback' && e.code === 'timed_confirmation_expired');
    assert.ok(rollbackEvent, 'Expected auto-rollback audit event');
    assert.equal(rollbackEvent.outcome, 'succeeded');

    // Attempting to confirm expired mutation should be rejected
    await assert.rejects(
      () => firewallService.confirmMutation({
        pendingId: applyResult.pendingId,
        confirmationToken: applyResult.confirmationToken,
      }),
      (err) => {
        assert.equal(err.code, 'pending_confirmation_not_found');
        return true;
      },
    );
  });

  await suite.test('AC-4: Existing SSH connection open is explicitly NOT accepted as proof of reachability', async () => {
    const { firewallService, auditStore } = createMockHarness();

    const applyResult = await firewallService.applyMutation({
      candidateRuleset: VALID_CANDIDATE_RULESET,
      allowedSshPorts: [22, 2222],
      timeoutSeconds: 60,
      actorId: 'usr-admin-1',
    });

    // Client attempts to pass evidence that only existing connection stayed open
    await assert.rejects(
      () => firewallService.confirmMutation({
        pendingId: applyResult.pendingId,
        confirmationToken: applyResult.confirmationToken,
        clientEvidence: { existingConnectionOnly: true },
        actorId: 'usr-admin-1',
      }),
      (err) => {
        assert.equal(err.code, 'existing_connection_insufficient');
        assert.match(err.message, /Existing.*connection.*cannot serve as verification evidence/i);
        return true;
      },
    );

    const auditEvents = auditStore.getEvents();
    const failedVerify = auditEvents.find((e) => e.action === 'firewall.verify_connection' && e.outcome === 'failed');
    assert.ok(failedVerify);
    assert.equal(failedVerify.code, 'existing_connection_insufficient');
  });

  await suite.test('AC-4: Successfully verifies new connection and confirms mutation, persisting config', async () => {
    const { firewallService, auditStore, writtenFiles } = createMockHarness();

    const applyResult = await firewallService.applyMutation({
      candidateRuleset: VALID_CANDIDATE_RULESET,
      allowedSshPorts: [22, 2222],
      timeoutSeconds: 60,
      actorId: 'usr-admin-1',
    });

    // 1. Verify new connection handshake
    const verifyResult = await firewallService.verifyNewConnection({
      pendingId: applyResult.pendingId,
      port: 2222,
      actorId: 'usr-admin-1',
    });
    assert.equal(verifyResult.verified, true);
    assert.equal(verifyResult.newConnectionEstablished, true);

    // 2. Confirm mutation
    const confirmResult = await firewallService.confirmMutation({
      pendingId: applyResult.pendingId,
      confirmationToken: applyResult.confirmationToken,
      actorId: 'usr-admin-1',
    });

    assert.equal(confirmResult.status, 'confirmed');
    assert.equal(confirmResult.connectionVerified, true);
    assert.equal(confirmResult.bootPersistence.enabled, true);

    // Verified configuration was persisted to /etc/nftables.conf
    const persisted = writtenFiles.get('/etc/nftables.conf');
    assert.ok(persisted);
    assert.match(persisted, /table inet yunpanel/);

    const auditEvents = auditStore.getEvents();
    const confirmAudit = auditEvents.find((e) => e.action === 'firewall.confirm');
    assert.ok(confirmAudit);
    assert.equal(confirmAudit.outcome, 'succeeded');
    assert.equal(confirmAudit.code, 'mutation_confirmed');
  });

  await suite.test('AC-4: Explicit rollbackMutation cancels timer and restores previous configuration', async () => {
    const { firewallService, auditStore, advanceTime } = createMockHarness();

    const applyResult = await firewallService.applyMutation({
      candidateRuleset: VALID_CANDIDATE_RULESET,
      allowedSshPorts: [22, 2222],
      timeoutSeconds: 60,
      actorId: 'usr-admin-1',
    });

    const rollbackResult = await firewallService.rollbackMutation({
      pendingId: applyResult.pendingId,
      reason: 'admin_rejected',
      actorId: 'usr-admin-1',
    });

    assert.equal(rollbackResult.status, 'rolled_back');
    assert.equal(rollbackResult.reason, 'admin_rejected');

    // Advance time to verify old timer is disarmed and does not double-fire
    await advanceTime(100_000);

    const rollbackEvents = auditStore.getEvents().filter((e) => e.action === 'firewall.rollback');
    assert.equal(rollbackEvents.length, 1);
  });

  // ==========================================================================
  // Criterion 5: Kernel Rules, Boot Persistence, and CrowdSec Reporting
  // ==========================================================================
  await suite.test('AC-5: getStatus explicitly reports kernel rules, boot persistence, and CrowdSec interaction', async () => {
    const { firewallService } = createMockHarness();

    const status = await firewallService.getStatus();
    assert.equal(status.status, 'active');

    // Kernel rules report
    assert.equal(status.kernelRules.status, 'applied');
    assert.equal(status.kernelRules.hasYunpanelTable, true);
    assert.deepEqual(status.kernelRules.allowedSshPorts, [22]);

    // Boot persistence report
    assert.equal(status.bootPersistence.service, 'nftables');
    assert.equal(status.bootPersistence.enabled, true);
    assert.equal(status.bootPersistence.active, true);
    assert.equal(status.bootPersistence.configPath, '/etc/nftables.conf');

    // CrowdSec report
    assert.equal(status.crowdsec.status, 'healthy');
    assert.equal(status.crowdsec.bouncerActive, true);
    assert.equal(status.crowdsec.hasCrowdsecSets, true);
    assert.equal(status.crowdsec.earlyDropActive, true);
    assert.equal(status.crowdsec.bannedIpsCount, 3);
    assert.deepEqual(status.crowdsec.ipv4Bans, ['198.51.100.10', '203.0.113.50']);
    assert.deepEqual(status.crowdsec.ipv6Bans, ['2001:db8::1']);

    // Docker protection report
    assert.equal(status.docker.tablesProtected, true);
    assert.equal(status.docker.bridgeInterfacesAllowed, true);
  });

  await suite.test('AC-5: disableFirewall safely removes yunpanel table without global flush, disables boot persistence and preserves Docker', async () => {
    const { firewallService, auditStore, execCommands, setServiceState } = createMockHarness();

    const result = await firewallService.disableFirewall({ actorId: 'usr-admin-1' });

    assert.equal(result.status, 'inactive');
    assert.equal(result.kernelRules.hasYunpanelTable, false);
    assert.equal(result.docker.tablesProtected, true);

    // Verify global flush ruleset was NEVER called
    const hadFlush = execCommands.some(([, ...args]) => args.join(' ').includes('flush ruleset'));
    assert.equal(hadFlush, false);

    const auditEvents = auditStore.getEvents();
    const disableAudit = auditEvents.find((e) => e.action === 'firewall.disable');
    assert.ok(disableAudit);
    assert.equal(disableAudit.outcome, 'succeeded');
  });

  await suite.test('AC-5: enableFirewall renders managed ruleset, preserves CrowdSec, and enables boot persistence', async () => {
    const { firewallService, auditStore, writtenFiles } = createMockHarness();

    const result = await firewallService.enableFirewall({
      allowedSshPorts: [22],
      actorId: 'usr-admin-1',
    });

    assert.equal(result.status, 'active');
    assert.equal(result.kernelRules.hasYunpanelTable, true);
    assert.equal(result.bootPersistence.enabled, true);

    const persisted = writtenFiles.get('/etc/nftables.conf');
    assert.ok(persisted);
    assert.equal(persisted.includes('flush ruleset'), false);

    const auditEvents = auditStore.getEvents();
    const enableAudit = auditEvents.find((e) => e.action === 'firewall.enable');
    assert.ok(enableAudit);
    assert.equal(enableAudit.outcome, 'succeeded');
  });

  // ==========================================================================
  // Criterion 6: Complete Audit Logging for All Operations
  // ==========================================================================
  await suite.test('AC-6: Audit logs are recorded for preview, apply, verify, confirm, rollback, enable and disable', async () => {
    const { firewallService, auditStore } = createMockHarness();

    await firewallService.previewMutation({ candidateRuleset: VALID_CANDIDATE_RULESET, allowedSshPorts: [22], actorId: 'actor-1' });
    const apply = await firewallService.applyMutation({ candidateRuleset: VALID_CANDIDATE_RULESET, allowedSshPorts: [22], actorId: 'actor-1' });
    await firewallService.verifyNewConnection({ pendingId: apply.pendingId, actorId: 'actor-1' });
    await firewallService.confirmMutation({ pendingId: apply.pendingId, confirmationToken: apply.confirmationToken, actorId: 'actor-1' });
    await firewallService.rollbackMutation({ actorId: 'actor-1', reason: 'revert_test' });
    await firewallService.disableFirewall({ actorId: 'actor-1' });
    await firewallService.enableFirewall({ allowedSshPorts: [22], actorId: 'actor-1' });

    const events = auditStore.getEvents();
    const actions = events.map((e) => e.action);

    assert.ok(actions.includes('firewall.preview'));
    assert.ok(actions.includes('firewall.apply'));
    assert.ok(actions.includes('firewall.verify_connection'));
    assert.ok(actions.includes('firewall.confirm'));
    assert.ok(actions.includes('firewall.rollback'));
    assert.ok(actions.includes('firewall.disable'));
    assert.ok(actions.includes('firewall.enable'));

    for (const event of events) {
      assert.equal(event.resourceType, 'firewall');
      assert.ok(['succeeded', 'accepted'].includes(event.outcome));
    }
  });

  // ==========================================================================
  // HTTP Layer & Authorization / RBAC Tests
  // ==========================================================================
  await suite.test('HTTP API: Full lifecycle and RBAC enforcement over HTTP', async (t) => {
    const harness = createMockHarness();

    // 1. Owner role has full access
    await t.test('Owner can access GET /api/firewall/status and POST /api/firewall/preview', async () => {
      const app = createTestHttpApp({ firewallService: harness.firewallService, role: 'owner' });
      const server = app.listen(0);
      const port = server.address().port;

      try {
        const statusRes = await fetch(`http://127.0.0.1:${port}/api/firewall/status`);
        assert.equal(statusRes.status, 200);
        const statusBody = await statusRes.json();
        assert.equal(statusBody.data.status, 'active');
        assert.equal(statusBody.data.kernelRules.hasYunpanelTable, true);

        const previewRes = await fetch(`http://127.0.0.1:${port}/api/firewall/preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            candidateRuleset: VALID_CANDIDATE_RULESET,
            allowedSshPorts: [22, 2222],
          }),
        });
        assert.equal(previewRes.status, 200);
        const previewBody = await previewRes.json();
        assert.equal(previewBody.data.valid, true);
        assert.deepEqual(previewBody.data.impact.ports.ssh.proposed, [22, 2222]);
      } finally {
        server.close();
      }
    });

    // 2. Owner lifecycle: apply -> verify -> confirm
    await t.test('Owner full lifecycle via HTTP: apply -> verify -> confirm', async () => {
      const app = createTestHttpApp({ firewallService: harness.firewallService, role: 'owner' });
      const server = app.listen(0);
      const port = server.address().port;

      try {
        // Apply
        const applyRes = await fetch(`http://127.0.0.1:${port}/api/firewall/apply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            candidateRuleset: VALID_CANDIDATE_RULESET,
            allowedSshPorts: [22, 2222],
            timeoutSeconds: 60,
          }),
        });
        assert.equal(applyRes.status, 200);
        const applyBody = await applyRes.json();
        const { pendingId, confirmationToken } = applyBody.data;
        assert.ok(pendingId);
        assert.ok(confirmationToken);

        // Verify connection
        const verifyRes = await fetch(`http://127.0.0.1:${port}/api/firewall/verify-connection`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pendingId, port: 2222 }),
        });
        assert.equal(verifyRes.status, 200);

        // Confirm
        const confirmRes = await fetch(`http://127.0.0.1:${port}/api/firewall/confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pendingId, confirmationToken }),
        });
        assert.equal(confirmRes.status, 200);
        const confirmBody = await confirmRes.json();
        assert.equal(confirmBody.data.status, 'confirmed');
      } finally {
        server.close();
      }
    });

    // 3. Server-scoped routes: /api/servers/:serverId/firewall/*
    await t.test('Server-scoped routes work identically', async () => {
      const app = createTestHttpApp({ firewallService: harness.firewallService, role: 'owner' });
      const server = app.listen(0);
      const port = server.address().port;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/servers/srv-local-01/firewall/status`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.data.serverId, 'srv-local-01');
      } finally {
        server.close();
      }
    });

    // 4. Read-only role: allowed on GET, forbidden on POST
    await t.test('Read-only role can read status but is denied on mutations', async () => {
      const app = createTestHttpApp({ firewallService: harness.firewallService, role: 'read_only' });
      const server = app.listen(0);
      const port = server.address().port;

      try {
        const statusRes = await fetch(`http://127.0.0.1:${port}/api/firewall/status`);
        assert.equal(statusRes.status, 200);

        const previewRes = await fetch(`http://127.0.0.1:${port}/api/firewall/preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ candidateRuleset: VALID_CANDIDATE_RULESET }),
        });
        assert.equal(previewRes.status, 403);
      } finally {
        server.close();
      }
    });

    // 5. Site-scoped role (site_manager) is denied 403 on firewall
    await t.test('Site-scoped role is denied 403 on firewall', async () => {
      const app = createTestHttpApp({ firewallService: harness.firewallService, role: 'site_manager' });
      const server = app.listen(0);
      const port = server.address().port;

      try {
        const statusRes = await fetch(`http://127.0.0.1:${port}/api/firewall/status`);
        assert.equal(statusRes.status, 403);
      } finally {
        server.close();
      }
    });

    // 6. Unauthenticated request is denied 401
    await t.test('Unauthenticated request is denied 401', async () => {
      const app = createTestHttpApp({ firewallService: harness.firewallService, role: 'unauthenticated' });
      const server = app.listen(0);
      const port = server.address().port;

      try {
        const statusRes = await fetch(`http://127.0.0.1:${port}/api/firewall/status`);
        assert.equal(statusRes.status, 401);
      } finally {
        server.close();
      }
    });
  });
});
