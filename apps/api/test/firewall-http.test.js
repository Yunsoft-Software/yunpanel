import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  createFirewallService,
  FirewallServiceError,
} from '../src/firewall-service.js';
import {
  mountFirewallRoutes,
  FirewallHttpError,
} from '../src/firewall-http.js';
import {
  createNftablesManager,
  NftablesManagerError,
  CrowdsecManagerError,
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

function createTestHarness({ initialRuleset = MOCK_LIVE_RULESET } = {}) {
  let liveRuleset = initialRuleset;
  const auditStore = createMockAuditStore();
  const crowdsecManager = createMockCrowdsecManager();

  const nftablesManager = createNftablesManager({
    configPath: '/etc/nftables.conf',
    execFn: async (file, args) => {
      if (args[0] === 'list' && args[1] === 'ruleset') return { stdout: liveRuleset };
      if (args[0] === '-c' && args[1] === '-f') return { stdout: '' };
      if (args[0] === '-f') return { stdout: '' };
      if (args[0] === 'is-active') {
        if (args[1] === 'ufw' || args[1] === 'firewalld') return { stdout: 'inactive\n' };
        if (args[1] === 'nftables') return { stdout: 'active\n' };
        return { stdout: 'active\n' };
      }
      if (args[0] === 'is-enabled') {
        if (args[1] === 'ufw' || args[1] === 'firewalld') return { stdout: 'disabled\n' };
        if (args[1] === 'nftables') return { stdout: 'enabled\n' };
        return { stdout: 'enabled\n' };
      }
      if (args[0] === '--version') {
        return { stdout: 'nftables v1.0.6 (Lester Gooch #2)\n' };
      }
      if (args[0] === 'status' && (file.includes('ufw') || args.includes('ufw'))) {
        return { stdout: 'Status: inactive\n' };
      }
      return { stdout: '' };
    },
    statFn: async () => ({ isFile: () => true }),
    readFileFn: async () => liveRuleset,
    writeFileFn: async (path, content) => { liveRuleset = content; },
    chmodFn: async () => {},
    renameFn: async () => {},
    rmFn: async () => {},
  });

  const sockets = [
    { protocol: 'tcp', family: 'IPv4', port: 22, listenAddress: '0.0.0.0', process: 'sshd', isListening: true, isLoopback: false },
    { protocol: 'tcp', family: 'IPv6', port: 22, listenAddress: '::', process: 'sshd', isListening: true, isLoopback: false },
    { protocol: 'tcp', family: 'IPv4', port: 80, listenAddress: '0.0.0.0', process: 'nginx', isListening: true, isLoopback: false },
    { protocol: 'tcp', family: 'IPv4', port: 443, listenAddress: '0.0.0.0', process: 'nginx', isListening: true, isLoopback: false },
    { protocol: 'tcp', family: 'IPv4', port: 3306, listenAddress: '127.0.0.1', process: 'mysqld', isListening: true, isLoopback: true },
    { protocol: 'tcp', family: 'IPv4', port: 8080, listenAddress: '0.0.0.0', process: 'node', isListening: true, isLoopback: false },
  ];

  const firewallService = createFirewallService({
    nftablesManager,
    crowdsecManager,
    auditStore,
    localServerId: 'srv-local-01',
    inspectSocketsFn: async () => sockets,
    connectFn: async ({ host, port }) => {
      if (port === 9999) throw new Error('connection refused');
      return { connected: true };
    },
  });

  return {
    firewallService,
    auditStore,
    crowdsecManager,
    nftablesManager,
  };
}

function createHttpApp({ firewallService, role = 'owner' } = {}) {
  const app = express();
  app.use(express.json());

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

  app.use((err, req, res, next) => {
    if (
      err instanceof FirewallServiceError
      || err instanceof FirewallHttpError
      || err instanceof NftablesManagerError
      || err instanceof CrowdsecManagerError
    ) {
      const status = err.status ?? (
        ['invalid_ip', 'invalid_duration', 'missing_identifier', 'missing_port', 'missing_ip', 'invalid_port', 'invalid_protocol', 'invalid_cidr', 'service_profile_inactive', 'lockout_risk_detected'].includes(err.code)
          ? 400
          : (err.code === 'unauthorized_test_target' ? 403 : (err.code === 'snapshot_not_found' || err.code === 'decision_not_found' ? 404 : 400))
      );
      return res.status(status).json({
        error: { code: err.code ?? 'firewall_error', message: err.message, ...(err.details ? { details: err.details } : {}) },
      });
    }
    return res.status(500).json({ error: { code: 'internal_error', message: err.message } });
  });

  return app;
}

test('PROD-05 Firewall HTTP API Suite', async (suite) => {
  await suite.test('GET /api/firewall/ports: returns ports with distinct listening, allowed and reachability statuses', async () => {
    const { firewallService } = createTestHarness();
    const app = createHttpApp({ firewallService, role: 'owner' });
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/firewall/ports`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.data);
      assert.ok(Array.isArray(body.data.ports));
      assert.ok(body.data.summary);
      assert.ok(body.data.serviceProfiles);
      assert.equal(body.data.providerFirewall.status, 'unknown');
      assert.ok(body.data.providerFirewall.advisory.includes('Cloud/sağlayıcı güvenlik duvarı durumu bilinmiyor'));

      const ports = body.data.ports;
      // SSH 22
      const sshPort = ports.find((p) => p.port === 22 && p.protocol === 'tcp');
      assert.ok(sshPort);
      assert.equal(sshPort.isListening, true);
      assert.equal(sshPort.isFirewallAllowed, true);
      assert.equal(sshPort.isExternallyReachable, true);
      assert.equal(sshPort.process, 'sshd');

      // MySQL 3306 (loopback listening, firewall not allowed)
      const mysqlPort = ports.find((p) => p.port === 3306);
      assert.ok(mysqlPort);
      assert.equal(mysqlPort.isListening, true);
      assert.equal(mysqlPort.isFirewallAllowed, false);
      assert.equal(mysqlPort.isExternallyReachable, false);

      // Node 8080 (listening on 0.0.0.0, firewall not allowed)
      const nodePort = ports.find((p) => p.port === 8080);
      assert.ok(nodePort);
      assert.equal(nodePort.isListening, true);
      assert.equal(nodePort.isFirewallAllowed, false);
      assert.equal(nodePort.isExternallyReachable, false);
    } finally {
      server.close();
    }
  });

  await suite.test('GET /api/servers/:serverId/firewall/ports: server-scoped route works identically', async () => {
    const { firewallService } = createTestHarness();
    const app = createHttpApp({ firewallService, role: 'owner' });
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/servers/srv-local-01/firewall/ports`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.data.ports);
      assert.equal(body.data.serverId, 'srv-local-01');
    } finally {
      server.close();
    }
  });

  await suite.test('RBAC: Authentication and Authorization on /api/firewall/ports', async () => {
    const { firewallService } = createTestHarness();

    // 1. Unauthenticated -> 401
    {
      const app = createHttpApp({ firewallService, role: 'unauthenticated' });
      const server = app.listen(0);
      const port = server.address().port;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/firewall/ports`);
        assert.equal(res.status, 401);
      } finally {
        server.close();
      }
    }

    // 2. Site manager -> 403
    {
      const app = createHttpApp({ firewallService, role: 'site_manager' });
      const server = app.listen(0);
      const port = server.address().port;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/firewall/ports`);
        assert.equal(res.status, 403);
      } finally {
        server.close();
      }
    }

    // 3. Read only -> 200
    {
      const app = createHttpApp({ firewallService, role: 'read_only' });
      const server = app.listen(0);
      const port = server.address().port;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/firewall/ports`);
        assert.equal(res.status, 200);
      } finally {
        server.close();
      }
    }
  });

  await suite.test('POST /api/firewall/ports: Blocks mail & DNS ports when inactive, allows valid ports', async () => {
    const { firewallService } = createTestHarness();
    const app = createHttpApp({ firewallService, role: 'owner' });
    const server = app.listen(0);
    const port = server.address().port;

    try {
      // 1. Block mail port 25 when localMail is false
      const mailRes = await fetch(`http://127.0.0.1:${port}/api/firewall/ports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: 25, protocol: 'tcp' }),
      });
      assert.equal(mailRes.status, 400);
      const mailBody = await mailRes.json();
      assert.equal(mailBody.error.code, 'service_profile_inactive');
      assert.ok(mailBody.error.message.toLowerCase().includes('mail'));

      // 2. Block DNS port 53 when authoritativeDns is false
      const dnsRes = await fetch(`http://127.0.0.1:${port}/api/firewall/ports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: 53, protocol: 'udp' }),
      });
      assert.equal(dnsRes.status, 400);
      const dnsBody = await dnsRes.json();
      assert.equal(dnsBody.error.code, 'service_profile_inactive');
      assert.ok(dnsBody.error.message.toLowerCase().includes('dns'));

      // 3. Validation errors: missing port, invalid port
      const invalidRes1 = await fetch(`http://127.0.0.1:${port}/api/firewall/ports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocol: 'tcp' }),
      });
      assert.equal(invalidRes1.status, 400);

      const invalidRes2 = await fetch(`http://127.0.0.1:${port}/api/firewall/ports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: 99999 }),
      });
      assert.equal(invalidRes2.status, 400);

      // 4. Add allowed custom port 8080
      const addRes = await fetch(`http://127.0.0.1:${port}/api/firewall/ports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: 8080, protocol: 'tcp', comment: 'Node API test' }),
      });
      assert.equal(addRes.status, 200);
      const addBody = await addRes.json();
      const p8080 = addBody.data.ports.find((p) => p.port === 8080);
      assert.ok(p8080);
      assert.equal(p8080.isFirewallAllowed, true);
      assert.equal(p8080.isExternallyReachable, true);
    } finally {
      server.close();
    }
  });

  await suite.test('DELETE /api/firewall/ports/:port: Prevents SSH lockout, allows custom port deletion', async () => {
    const { firewallService } = createTestHarness();
    const app = createHttpApp({ firewallService, role: 'owner' });
    const server = app.listen(0);
    const port = server.address().port;

    try {
      // 1. Attempt to delete SSH port 22 -> 400 lockout_risk_detected
      const delSshRes = await fetch(`http://127.0.0.1:${port}/api/firewall/ports/22`, {
        method: 'DELETE',
      });
      assert.equal(delSshRes.status, 400);
      const delSshBody = await delSshRes.json();
      assert.equal(delSshBody.error.code, 'lockout_risk_detected');

      // 2. Add port 8080 then delete it
      await fetch(`http://127.0.0.1:${port}/api/firewall/ports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: 8080, protocol: 'tcp' }),
      });

      const delRes = await fetch(`http://127.0.0.1:${port}/api/firewall/ports/8080?protocol=tcp`, {
        method: 'DELETE',
      });
      assert.equal(delRes.status, 200);
      const delBody = await delRes.json();
      const p8080 = delBody.data.ports.find((p) => p.port === 8080);
      assert.ok(p8080);
      assert.equal(p8080.isFirewallAllowed, false);
    } finally {
      server.close();
    }
  });

  await suite.test('Service profiles lifecycle via HTTP: GET and PUT /api/firewall/service-profiles', async () => {
    const { firewallService } = createTestHarness();
    const app = createHttpApp({ firewallService, role: 'owner' });
    const server = app.listen(0);
    const port = server.address().port;

    try {
      // 1. GET service profiles
      const getRes = await fetch(`http://127.0.0.1:${port}/api/firewall/service-profiles`);
      assert.equal(getRes.status, 200);
      const getBody = await getRes.json();
      assert.equal(getBody.data.serviceProfiles.localMail, false);
      assert.equal(getBody.data.serviceProfiles.authoritativeDns, false);

      // 2. PUT update service profiles to enable localMail
      const putRes = await fetch(`http://127.0.0.1:${port}/api/firewall/service-profiles`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localMail: true, authoritativeDns: true }),
      });
      assert.equal(putRes.status, 200);
      const putBody = await putRes.json();
      assert.equal(putBody.data.serviceProfiles.localMail, true);
      assert.equal(putBody.data.serviceProfiles.authoritativeDns, true);

      // 3. Now opening mail port 25 is permitted
      const mailRes = await fetch(`http://127.0.0.1:${port}/api/firewall/ports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: 25, protocol: 'tcp' }),
      });
      assert.equal(mailRes.status, 200);

      // 4. Disabling localMail closes mail ports and purges custom rules
      const disableRes = await fetch(`http://127.0.0.1:${port}/api/firewall/service-profiles`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localMail: false }),
      });
      assert.equal(disableRes.status, 200);

      // Verify port 25 is closed
      const portsRes = await fetch(`http://127.0.0.1:${port}/api/firewall/ports`);
      const portsBody = await portsRes.json();
      const p25 = portsBody.data.ports.find((p) => p.port === 25);
      assert.ok(!p25 || !p25.isFirewallAllowed);
    } finally {
      server.close();
    }
  });

  await suite.test('POST /api/firewall/scan: Enforces authorized test targets and strictly rejects .44', async () => {
    const { firewallService } = createTestHarness();
    const app = createHttpApp({ firewallService, role: 'owner' });
    const server = app.listen(0);
    const port = server.address().port;

    try {
      // 1. Rejects target containing .44
      const dot44Res = await fetch(`http://127.0.0.1:${port}/api/firewall/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: '10.0.0.44', port: 22 }),
      });
      assert.equal(dot44Res.status, 403);
      const dot44Body = await dot44Res.json();
      assert.equal(dot44Body.error.code, 'unauthorized_test_target');

      // 2. Rejects random unauthorized external host
      const extRes = await fetch(`http://127.0.0.1:${port}/api/firewall/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: '1.2.3.4', port: 22 }),
      });
      assert.equal(extRes.status, 403);

      // 3. Allows authorized target 127.0.0.1
      const localRes = await fetch(`http://127.0.0.1:${port}/api/firewall/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: '127.0.0.1', port: 22 }),
      });
      assert.equal(localRes.status, 200);
      const localBody = await localRes.json();
      assert.equal(localBody.data.target, '127.0.0.1');
      assert.equal(localBody.data.reachable, true);

      // 4. Allows authorized staging IP 157.180.11.28
      const stagingRes = await fetch(`http://127.0.0.1:${port}/api/firewall/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: '157.180.11.28', port: 80 }),
      });
      assert.equal(stagingRes.status, 200);
    } finally {
      server.close();
    }
  });

  await suite.test('CrowdSec integration: ban, unban, list decisions via HTTP', async () => {
    const { firewallService } = createTestHarness();
    const app = createHttpApp({ firewallService, role: 'owner' });
    const server = app.listen(0);
    const port = server.address().port;

    try {
      // 1. GET bans
      const listRes = await fetch(`http://127.0.0.1:${port}/api/firewall/bans`);
      assert.equal(listRes.status, 200);
      const listBody = await listRes.json();
      assert.equal(listBody.data.length, 1);
      assert.equal(listBody.data[0].ip, '198.51.100.10');

      // 2. Add ban
      const addRes = await fetch(`http://127.0.0.1:${port}/api/firewall/bans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: '203.0.113.99', duration: '24h', reason: 'Abuse detected' }),
      });
      assert.equal(addRes.status, 200);
      const addBody = await addRes.json();
      assert.equal(addBody.data.ip, '203.0.113.99');

      // 3. Unban via POST /api/firewall/unban
      const unbanRes = await fetch(`http://127.0.0.1:${port}/api/firewall/unban`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: '203.0.113.99' }),
      });
      assert.equal(unbanRes.status, 200);

      // Verify removed
      const afterRes = await fetch(`http://127.0.0.1:${port}/api/firewall/bans`);
      const afterBody = await afterRes.json();
      assert.equal(afterBody.data.length, 1);
      assert.equal(afterBody.data[0].ip, '198.51.100.10');

      // 4. Delete ban via DELETE /api/firewall/bans/:id
      const delRes = await fetch(`http://127.0.0.1:${port}/api/firewall/bans/1`, {
        method: 'DELETE',
      });
      assert.equal(delRes.status, 200);

      const emptyRes = await fetch(`http://127.0.0.1:${port}/api/firewall/bans`);
      const emptyBody = await emptyRes.json();
      assert.equal(emptyBody.data.length, 0);
    } finally {
      server.close();
    }
  });

  await suite.test('GET /api/firewall/status: includes serviceProfiles, providerFirewall and portsSummary', async () => {
    const { firewallService } = createTestHarness();
    const app = createHttpApp({ firewallService, role: 'owner' });
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/firewall/status`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.data.serviceProfiles);
      assert.equal(body.data.serviceProfiles.localMail, false);
      assert.equal(body.data.serviceProfiles.authoritativeDns, false);
      assert.equal(body.data.providerFirewall.status, 'unknown');
      assert.ok(body.data.portsSummary);
      assert.ok(body.data.portsSummary.listeningCount >= 0);
    } finally {
      server.close();
    }
  });
});
