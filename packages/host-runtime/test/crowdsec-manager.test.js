import assert from 'node:assert/strict';
import test from 'node:test';
import { createCrowdsecManager, CrowdsecManagerError } from '../src/index.js';

test('inspectCrowdsec returns engine, bouncer, and conflict status', async () => {
  const manager = createCrowdsecManager({
    execFn: async (file, args) => {
      if (args[0] === 'version') {
        return { stdout: 'version: v1.6.0\nCodename: alphatest\n' };
      }
      if (args[0] === 'is-active' && args[1] === 'crowdsec') {
        return { stdout: 'active\n' };
      }
      if (args[0] === 'is-enabled' && args[1] === 'crowdsec') {
        return { stdout: 'enabled\n' };
      }
      if (args[0] === 'is-active' && args[1] === 'crowdsec-firewall-bouncer') {
        return { stdout: 'active\n' };
      }
      if (args[0] === 'is-enabled' && args[1] === 'crowdsec-firewall-bouncer') {
        return { stdout: 'enabled\n' };
      }
      if (args[0] === 'is-active' && args[1] === 'fail2ban') {
        throw new Error('inactive');
      }
      if (args[0] === 'is-enabled' && args[1] === 'fail2ban') {
        throw new Error('disabled');
      }
      throw new Error(`Unexpected: ${file} ${args.join(' ')}`);
    },
  });

  const inspected = await manager.inspectCrowdsec();
  assert.equal(inspected.engine.installed, true);
  assert.equal(inspected.engine.version, '1.6.0');
  assert.equal(inspected.engine.active, true);
  assert.equal(inspected.bouncer.active, true);
  assert.equal(inspected.conflicts.fail2banActive, false);
  assert.equal(inspected.conflicts.duplicateAuthorityDetected, false);
  assert.equal(inspected.healthy, true);
});

test('inspectCrowdsec detects fail2ban conflict (duplicate authority)', async () => {
  const manager = createCrowdsecManager({
    execFn: async (file, args) => {
      if (args[0] === 'version') {
        return { stdout: 'version: v1.6.0\n' };
      }
      if (args[0] === 'is-active' || args[0] === 'is-enabled') {
        return { stdout: 'active\n' };
      }
      return { stdout: '' };
    },
  });

  const inspected = await manager.inspectCrowdsec();
  assert.equal(inspected.conflicts.fail2banActive, true);
  assert.equal(inspected.conflicts.duplicateAuthorityDetected, true);
  assert.equal(inspected.healthy, false);
});

test('listDecisions parses decision array and handles empty or null output', async () => {
  const mockDecisions = [
    {
      id: 42,
      origin: 'cscli',
      scope: 'ip',
      value: '198.51.100.23',
      scenario: 'crowdsecurity/ssh-bf',
      duration: '3h59m',
      type: 'ban',
      simulated: false,
      created_at: '2026-09-20T12:00:00Z',
    },
  ];

  const manager = createCrowdsecManager({
    execFn: async (file, args) => {
      assert.equal(args[0], 'decisions');
      assert.equal(args[1], 'list');
      assert.equal(args[2], '-o');
      assert.equal(args[3], 'json');
      return { stdout: JSON.stringify(mockDecisions) };
    },
  });

  const decisions = await manager.listDecisions();
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].id, 42);
  assert.equal(decisions[0].value, '198.51.100.23');
  assert.equal(decisions[0].reason, 'crowdsecurity/ssh-bf');
  assert.equal(decisions[0].type, 'ban');

  // Test empty output
  const emptyManager = createCrowdsecManager({
    execFn: async () => ({ stdout: 'null\n' }),
  });
  const emptyList = await emptyManager.listDecisions();
  assert.deepEqual(emptyList, []);
});

test('addDecision validates IP and duration and adds decision', async () => {
  const calls = [];
  const manager = createCrowdsecManager({
    execFn: async (file, args) => {
      calls.push(['exec', file, ...args]);
      return { stdout: '' };
    },
  });

  // Valid IPv4
  const res1 = await manager.addDecision({
    ip: '198.51.100.5',
    duration: '24h',
    reason: 'manual-test',
  });
  assert.equal(res1.success, true);
  assert.equal(res1.ip, '198.51.100.5');
  assert.equal(res1.duration, '24h');

  // Valid IPv6
  const res2 = await manager.addDecision({
    ip: '2001:db8::1',
    duration: '4h',
  });
  assert.equal(res2.success, true);

  // Valid CIDR
  const res3 = await manager.addDecision({
    ip: '198.51.100.0/24',
    duration: '1h',
  });
  assert.equal(res3.success, true);

  // Invalid IP
  await assert.rejects(
    () => manager.addDecision({ ip: 'not-an-ip' }),
    (err) => {
      assert.equal(err instanceof CrowdsecManagerError, true);
      assert.equal(err.code, 'invalid_ip');
      return true;
    },
  );

  // Invalid duration
  await assert.rejects(
    () => manager.addDecision({ ip: '198.51.100.5', duration: 'forever' }),
    (err) => {
      assert.equal(err instanceof CrowdsecManagerError, true);
      assert.equal(err.code, 'invalid_duration');
      return true;
    },
  );
});

test('deleteDecision deletes by IP or by ID and rejects missing target', async () => {
  const calls = [];
  const manager = createCrowdsecManager({
    execFn: async (file, args) => {
      calls.push(['exec', file, ...args]);
      return { stdout: '' };
    },
  });

  // Delete by IP
  const delIp = await manager.deleteDecision({ ip: '198.51.100.5' });
  assert.equal(delIp.success, true);
  assert.equal(delIp.target, '198.51.100.5');
  assert.equal(delIp.targetType, 'ip');

  // Delete by ID
  const delId = await manager.deleteDecision({ id: 42 });
  assert.equal(delId.success, true);
  assert.equal(delId.target, 42);
  assert.equal(delId.targetType, 'id');

  // Missing target
  await assert.rejects(
    () => manager.deleteDecision({}),
    (err) => {
      assert.equal(err instanceof CrowdsecManagerError, true);
      assert.equal(err.code, 'missing_target');
      return true;
    },
  );
});

test('getMetrics and listAlerts return parsed responses', async () => {
  const manager = createCrowdsecManager({
    execFn: async (file, args) => {
      if (args[0] === 'metrics') {
        return { stdout: JSON.stringify({ acquisition: { total: 120 } }) };
      }
      if (args[0] === 'alerts') {
        return { stdout: JSON.stringify([{ id: 1, message: 'bruteforce' }]) };
      }
      return { stdout: '' };
    },
  });

  const metrics = await manager.getMetrics();
  assert.equal(metrics.acquisition.total, 120);

  const alerts = await manager.listAlerts({ limit: 10 });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].id, 1);
});
