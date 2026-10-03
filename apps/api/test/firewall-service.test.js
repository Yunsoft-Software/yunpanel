import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFirewallService,
  FirewallServiceError,
  SERVICE_PROFILES,
  MAIL_PORTS,
  DNS_PORTS,
  WEB_PORTS,
  DEFAULT_PROFILES,
  parseAllowedPortsFromRuleset,
  parseAllowedRulesFromRuleset,
  parseListeningSockets,
  isTargetAuthorized,
} from '../src/firewall-service.js';
import {
  createNftablesManager,
  NftablesManagerError,
  MANAGED_FIREWALL_TABLE,
} from '@yunpanel/host-runtime';

const MOCK_LIVE_RULESET = `
table inet yunpanel {
  set crowdsec-blacklists {
    type ipv4_addr
    flags interval
    elements = { 198.51.100.10 }
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

function createMockCrowdsecManager() {
  const decisions = [
    {
      id: 1,
      ip: '198.51.100.10',
      duration: '4h',
      reason: 'ssh brute-force',
      type: 'ban',
      origin: 'crowdsec',
      scope: 'Ip',
      value: '198.51.100.10',
      simulated: false,
      expiresAt: new Date(Date.now() + 14400000).toISOString(),
    },
  ];

  return {
    inspectCrowdsec: async () => ({
      engineInstalled: true,
      engineVersion: '1.6.0',
      healthy: true,
      bouncerHealthy: true,
      engineService: { active: true, enabled: true },
      bouncerService: { active: true, enabled: true },
      fail2banService: { active: false, enabled: false },
      duplicateAuthorityDetected: false,
      status: 'healthy',
      issues: [],
      activeBansCount: decisions.length,
    }),
    listDecisions: async () => [...decisions],
    addDecision: async ({ ip, duration = '4h', reason = 'manual', type = 'ban' }) => {
      const id = decisions.length + 1;
      const dec = {
        id,
        ip: ip.trim(),
        duration,
        reason,
        type,
        origin: 'yunpanel',
        scope: 'Ip',
        value: ip.trim(),
        simulated: false,
        expiresAt: new Date(Date.now() + 14400000).toISOString(),
      };
      decisions.push(dec);
      return { success: true, ...dec };
    },
    deleteDecision: async ({ ip = null, id = null }) => {
      const idx = decisions.findIndex((d) => (id && d.id === Number(id)) || (ip && d.ip === ip.trim()));
      if (idx === -1) {
        throw new Error('decision not found');
      }
      const removed = decisions.splice(idx, 1)[0];
      return { success: true, removedId: removed.id };
    },
  };
}

function createTestHarness({
  initialRuleset = MOCK_LIVE_RULESET,
  mockSockets = null,
} = {}) {
  let liveRuleset = initialRuleset;
  const auditStore = createMockAuditStore();
  const crowdsecManager = createMockCrowdsecManager();

  const nftablesManager = createNftablesManager({
    configPath: '/etc/nftables.conf',
    execFn: async (file, args) => {
      if (args[0] === 'list' && args[1] === 'ruleset') {
        return { stdout: liveRuleset };
      }
      if (args[0] === '-c' && args[1] === '-f') {
        return { stdout: '' };
      }
      if (args[0] === '-f') {
        return { stdout: '' };
      }
      if (args[0] === 'is-active' || (args[0] === 'systemctl' && args[1] === 'is-active')) {
        return { stdout: 'active\n' };
      }
      if (args[0] === 'is-enabled' || (args[0] === 'systemctl' && args[1] === 'is-enabled')) {
        return { stdout: 'enabled\n' };
      }
      return { stdout: '' };
    },
    statFn: async () => ({ isFile: () => true }),
    readFileFn: async () => liveRuleset,
    writeFileFn: async (path, content) => {
      liveRuleset = content;
    },
    chmodFn: async () => {},
    renameFn: async () => {},
    rmFn: async () => {},
  });

  const defaultSockets = [
    { protocol: 'tcp', family: 'IPv4', port: 22, listenAddress: '0.0.0.0', process: 'sshd', isListening: true, isLoopback: false },
    { protocol: 'tcp', family: 'IPv6', port: 22, listenAddress: '::', process: 'sshd', isListening: true, isLoopback: false },
    { protocol: 'tcp', family: 'IPv4', port: 3306, listenAddress: '127.0.0.1', process: 'mysqld', isListening: true, isLoopback: true },
    { protocol: 'tcp', family: 'IPv4', port: 8080, listenAddress: '0.0.0.0', process: 'node', isListening: true, isLoopback: false },
  ];

  const firewallService = createFirewallService({
    nftablesManager,
    crowdsecManager,
    auditStore,
    localServerId: 'srv-local-01',
    allowedTestTargets: ['157.180.11.28', 'staging.test.internal'],
    inspectSocketsFn: async () => mockSockets ?? defaultSockets,
    connectFn: async ({ host, port }) => {
      if (port === 9999) throw new Error('Connection refused');
      return true;
    },
  });

  return { firewallService, auditStore, crowdsecManager, nftablesManager };
}

test('PROD-05 Firewall Service Suite', async (suite) => {

  await suite.test('parseListeningSockets parses ss output correctly', () => {
    const ssSample = `
Netid State  Recv-Q Send-Q Local Address:Port  Peer Address:PortProcess
tcp   LISTEN 0      128          0.0.0.0:22        0.0.0.0:*    users:(("sshd",pid=123,fd=3))
tcp   LISTEN 0      511          0.0.0.0:80        0.0.0.0:*    users:(("nginx",pid=456,fd=6))
tcp   LISTEN 0      511             [::]:443          [::]:*    users:(("nginx",pid=456,fd=7))
tcp   LISTEN 0      128        127.0.0.1:3306       0.0.0.0:*    users:(("mariadbd",pid=789,fd=10))
udp   UNCONN 0      0            0.0.0.0:53        0.0.0.0:*    users:(("named",pid=999,fd=512))
`;
    const parsed = parseListeningSockets(ssSample);
    assert.equal(parsed.length, 5);

    const ssh = parsed.find((s) => s.port === 22);
    assert.equal(ssh.protocol, 'tcp');
    assert.equal(ssh.family, 'IPv4');
    assert.equal(ssh.listenAddress, '0.0.0.0');
    assert.equal(ssh.process, 'sshd');
    assert.equal(ssh.isLoopback, false);

    const mysql = parsed.find((s) => s.port === 3306);
    assert.equal(mysql.isLoopback, true);
    assert.equal(mysql.process, 'mariadbd');

    const dns = parsed.find((s) => s.port === 53);
    assert.equal(dns.protocol, 'udp');
    assert.equal(dns.process, 'named');
  });

  await suite.test('isTargetAuthorized enforces strictly allowed targets and rejects .44', () => {
    assert.equal(isTargetAuthorized('127.0.0.1'), true);
    assert.equal(isTargetAuthorized('localhost'), true);
    assert.equal(isTargetAuthorized('::1'), true);
    assert.equal(isTargetAuthorized('157.180.11.28'), true);
    assert.equal(isTargetAuthorized('server.cryptoraichu.website'), true);
    assert.equal(isTargetAuthorized('custom-target.internal', ['custom-target.internal']), true);

    // Strictly forbidden .44 host
    assert.equal(isTargetAuthorized('192.168.1.44'), false);
    assert.equal(isTargetAuthorized('plesk.remote.44'), false);
    assert.equal(isTargetAuthorized('10.0.0.44'), false);
    // Arbitrary unauthorized hosts
    assert.equal(isTargetAuthorized('8.8.8.8'), false);
    assert.equal(isTargetAuthorized('evil-host.com'), false);
  });

  await suite.test('listPorts provides distinct listening, firewall allowed, and reachability statuses', async () => {
    const { firewallService } = createTestHarness();
    const result = await firewallService.listPorts();

    assert.ok(Array.isArray(result.ports));
    assert.equal(result.providerFirewallStatus, undefined);
    assert.equal(result.summary.providerFirewallStatus, 'unknown');
    assert.ok(result.summary.providerFirewallNote.includes('Cloud/sağlayıcı güvenlik duvarı'));

    // Check port 22: listening on 0.0.0.0 & allowed in firewall -> reachable
    const p22 = result.ports.find((p) => p.port === 22 && p.protocol === 'tcp');
    assert.ok(p22);
    assert.equal(p22.isListening, true);
    assert.equal(p22.isFirewallAllowed, true);
    assert.equal(p22.policy, 'allow');
    assert.equal(p22.serviceProfile, 'system');
    assert.equal(p22.reachability.status, 'reachable');
    assert.equal(p22.reachability.isExternallyReachable, true);
    assert.equal(p22.reachability.providerFirewallStatus, 'unknown');

    // Check port 3306: listening on 127.0.0.1 & NOT allowed in firewall -> internal_only
    const p3306 = result.ports.find((p) => p.port === 3306);
    assert.ok(p3306);
    assert.equal(p3306.isListening, true);
    assert.equal(p3306.isFirewallAllowed, false);
    assert.equal(p3306.policy, 'drop');
    assert.equal(p3306.reachability.status, 'internal_only');
    assert.equal(p3306.reachability.isExternallyReachable, false);

    // Check port 8080: listening on 0.0.0.0 & NOT allowed in firewall -> blocked_by_firewall
    const p8080 = result.ports.find((p) => p.port === 8080);
    assert.ok(p8080);
    assert.equal(p8080.isListening, true);
    assert.equal(p8080.isFirewallAllowed, false);
    assert.equal(p8080.reachability.status, 'blocked_by_firewall');
    assert.equal(p8080.reachability.isExternallyReachable, false);

    // Check port 80: allowed in firewall & NOT listening -> not_listening
    const p80 = result.ports.find((p) => p.port === 80);
    assert.ok(p80);
    assert.equal(p80.isListening, false);
    assert.equal(p80.isFirewallAllowed, true);
    assert.equal(p80.reachability.status, 'not_listening');
    assert.equal(p80.reachability.isExternallyReachable, false);

    // Summary counts must not conflate listening vs allowed vs reachable
    assert.ok(result.summary.totalListeningPorts >= 3);
    assert.ok(result.summary.totalFirewallAllowedPorts >= 2);
    assert.ok(result.summary.totalExternallyReachablePorts >= 1);
  });

  await suite.test('Service profiles: blocks opening mail ports when localMail profile is inactive', async () => {
    const { firewallService, auditStore } = createTestHarness();

    // localMail is inactive by default
    const profiles = firewallService.getServiceProfiles();
    assert.equal(profiles.localMail, false);

    for (const mailPort of [25, 143, 465, 587, 993]) {
      await assert.rejects(
        () => firewallService.addPortRule({ port: mailPort, protocol: 'tcp' }),
        (err) => {
          assert.equal(err instanceof FirewallServiceError, true);
          assert.equal(err.code, 'service_profile_inactive');
          return true;
        },
      );
    }

    const auditEvents = auditStore.getEvents();
    const rejectedAudit = auditEvents.find((e) => e.code === 'service_profile_inactive');
    assert.ok(rejectedAudit);
  });

  await suite.test('Service profiles: blocks opening DNS port 53 when authoritativeDns profile is inactive', async () => {
    const { firewallService } = createTestHarness();

    // authoritativeDns is inactive by default
    const profiles = firewallService.getServiceProfiles();
    assert.equal(profiles.authoritativeDns, false);

    await assert.rejects(
      () => firewallService.addPortRule({ port: 53, protocol: 'tcp' }),
      (err) => {
        assert.equal(err instanceof FirewallServiceError, true);
        assert.equal(err.code, 'service_profile_inactive');
        return true;
      },
    );
    await assert.rejects(
      () => firewallService.addPortRule({ port: 53, protocol: 'udp' }),
      (err) => {
        assert.equal(err instanceof FirewallServiceError, true);
        assert.equal(err.code, 'service_profile_inactive');
        return true;
      },
    );
  });

  await suite.test('previewMutation and applyMutation reject candidate ruleset with mail/dns ports if profiles inactive', async () => {
    const { firewallService } = createTestHarness();

    const rulesetWithMail = `
table inet yunpanel {
  chain input {
    type filter hook input priority 0; policy drop;
    tcp dport { 22, 25 } accept
  }
}
`;
    await assert.rejects(
      () => firewallService.previewMutation({ candidateRuleset: rulesetWithMail }),
      (err) => {
        assert.equal(err.code, 'service_profile_inactive');
        assert.equal(err.details.profile, 'localMail');
        return true;
      },
    );

    const rulesetWithDns = `
table inet yunpanel {
  chain input {
    type filter hook input priority 0; policy drop;
    tcp dport 22 accept
    udp dport 53 accept
  }
}
`;
    await assert.rejects(
      () => firewallService.previewMutation({ candidateRuleset: rulesetWithDns }),
      (err) => {
        assert.equal(err.code, 'service_profile_inactive');
        assert.equal(err.details.profile, 'authoritativeDns');
        return true;
      },
    );
  });

  await suite.test('Enabling localMail and authoritativeDns profiles allows opening corresponding ports', async () => {
    const { firewallService } = createTestHarness();

    // Enable localMail
    await firewallService.updateServiceProfiles({ profiles: { localMail: true }, skipApply: true });
    assert.equal(firewallService.getServiceProfiles().localMail, true);

    // Now adding mail port succeeds
    const resMail = await firewallService.addPortRule({ port: 25, protocol: 'tcp', skipApply: true });
    const p25 = resMail.ports.find((p) => p.port === 25);
    assert.ok(p25);
    assert.equal(p25.serviceProfile, 'mail');

    // Enable authoritativeDns
    await firewallService.updateServiceProfiles({ profiles: { authoritativeDns: true }, skipApply: true });
    assert.equal(firewallService.getServiceProfiles().authoritativeDns, true);

    const resDns = await firewallService.addPortRule({ port: 53, protocol: 'udp', skipApply: true });
    const p53 = resDns.ports.find((p) => p.port === 53);
    assert.ok(p53);
    assert.equal(p53.serviceProfile, 'dns');
  });

  await suite.test('Disabling service profiles closes corresponding ports and cleans custom rules', async () => {
    const { firewallService } = createTestHarness();

    await firewallService.updateServiceProfiles({ profiles: { localMail: true, authoritativeDns: true }, skipApply: true });
    await firewallService.addPortRule({ port: 25, protocol: 'tcp', skipApply: true });
    await firewallService.addPortRule({ port: 53, protocol: 'udp', skipApply: true });

    // Disabling localMail purges mail port
    await firewallService.updateServiceProfiles({ profiles: { localMail: false }, skipApply: true });
    assert.equal(firewallService.getServiceProfiles().localMail, false);

    // Attempting to add mail port is blocked again
    await assert.rejects(
      () => firewallService.addPortRule({ port: 25, protocol: 'tcp' }),
      (err) => err.code === 'service_profile_inactive',
    );
  });

  await suite.test('scanPortReachability permits authorized targets and rejects unauthorized targets including .44', async () => {
    const { firewallService } = createTestHarness();

    // Authorized target scan succeeds
    const localScan = await firewallService.scanPortReachability({ host: '127.0.0.1', port: 22 });
    assert.equal(localScan.reachable, true);
    assert.equal(localScan.providerFirewallStatus, 'unknown');

    const stagingScan = await firewallService.scanPortReachability({ host: '157.180.11.28', port: 443 });
    assert.equal(stagingScan.reachable, true);

    // .44 host rejected fail-closed
    await assert.rejects(
      () => firewallService.scanPortReachability({ host: '192.168.1.44', port: 22 }),
      (err) => {
        assert.equal(err.code, 'unauthorized_test_target');
        assert.equal(err.status, 403);
        return true;
      },
    );

    // Arbitrary external host rejected
    await assert.rejects(
      () => firewallService.scanPortReachability({ host: 'unauthorized-external-scan.org', port: 80 }),
      (err) => {
        assert.equal(err.code, 'unauthorized_test_target');
        assert.equal(err.status, 403);
        return true;
      },
    );
  });

  await suite.test('addPortRule and removePortRule manage custom ports with SSH lockout protection', async () => {
    const { firewallService, auditStore } = createTestHarness();

    // Add custom port rule
    const resAdd = await firewallService.addPortRule({
      port: 8443,
      protocol: 'tcp',
      source: '192.168.1.0/24',
      policy: 'allow',
      serviceProfile: 'custom',
      skipApply: true,
    });
    const p8443 = resAdd.ports.find((p) => p.port === 8443);
    assert.ok(p8443);
    assert.equal(p8443.source, '192.168.1.0/24');

    // Attempting to remove SSH port 22 is blocked to prevent lockout
    await assert.rejects(
      () => firewallService.removePortRule({ port: 22, protocol: 'tcp' }),
      (err) => {
        assert.equal(err.code, 'lockout_risk_detected');
        assert.equal(err.status, 400);
        return true;
      },
    );

    // Removing custom port succeeds
    const resRemove = await firewallService.removePortRule({ port: 8443, protocol: 'tcp', skipApply: true });
    const p8443After = resRemove.ports.find((p) => p.port === 8443 && p.isFirewallAllowed);
    assert.equal(p8443After, undefined);
  });

  await suite.test('CrowdSec ban, unban and listDecisions work from the same security context', async () => {
    const { firewallService, auditStore } = createTestHarness();

    // 1. List bans
    const bans = await firewallService.listBans();
    assert.ok(Array.isArray(bans));
    assert.equal(bans.length, 1);
    assert.equal(bans[0].ip, '198.51.100.10');

    // 2. Add ban
    const newBan = await firewallService.addBan({
      ip: '203.0.113.88',
      duration: '8h',
      reason: 'Automated brute force attack',
    });
    assert.equal(newBan.success, true);
    assert.equal(newBan.ip, '203.0.113.88');

    const bansAfter = await firewallService.listBans();
    assert.equal(bansAfter.length, 2);

    // 3. Remove ban
    const removed = await firewallService.removeBan({ ip: '203.0.113.88' });
    assert.equal(removed.success, true);

    const bansFinal = await firewallService.listBans();
    assert.equal(bansFinal.length, 1);

    // Verify audit logs
    const events = auditStore.getEvents();
    assert.ok(events.some((e) => e.code === 'crowdsec_ban_added'));
    assert.ok(events.some((e) => e.code === 'crowdsec_ban_removed'));
  });

  await suite.test('getStatus reports serviceProfiles, providerFirewall and portsSummary', async () => {
    const { firewallService } = createTestHarness();
    const status = await firewallService.getStatus();

    assert.equal(status.status, 'active');
    assert.ok(status.serviceProfiles);
    assert.equal(status.serviceProfiles.system, true);
    assert.equal(status.serviceProfiles.localMail, false);
    assert.equal(status.serviceProfiles.authoritativeDns, false);

    assert.ok(status.providerFirewall);
    assert.equal(status.providerFirewall.status, 'unknown');

    assert.ok(status.portsSummary);
    assert.equal(status.portsSummary.providerFirewallStatus, 'unknown');
  });

});
