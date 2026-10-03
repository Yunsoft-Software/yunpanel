import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchFirewallStatus,
  fetchFirewallPorts,
  addFirewallPortRule,
  removeFirewallPortRule,
  fetchServiceProfiles,
  updateServiceProfiles,
  scanFirewallPort,
  fetchCrowdsecBans,
  addCrowdsecBan,
  removeCrowdsecBan,
} from '../src/workspace/firewall-client.js';
import { setSession } from '../src/session-client.js';

const ok = (data) => new Response(JSON.stringify({ data }), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

test('Firewall client handles all endpoints and parameters', async (t) => {
  setSession({ csrfToken: 'csrf-firewall-test' });
  t.after(() => setSession(null));

  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return ok({ success: true });
  });

  // 1. fetchFirewallStatus
  await fetchFirewallStatus();
  assert.equal(calls[0].url, '/api/firewall/status');
  assert.equal(calls[0].options.method, 'GET');

  // Server-scoped status
  await fetchFirewallStatus({ serverId: 'srv-01' });
  assert.equal(calls[1].url, '/api/servers/srv-01/firewall/status');

  // 2. fetchFirewallPorts
  await fetchFirewallPorts();
  assert.equal(calls[2].url, '/api/firewall/ports');

  // 3. addFirewallPortRule
  await addFirewallPortRule({
    port: 8080,
    protocol: 'tcp',
    source: '192.168.1.0/24',
  });
  assert.equal(calls[3].url, '/api/firewall/ports');
  assert.equal(calls[3].options.method, 'POST');
  const addBody = JSON.parse(calls[3].options.body);
  assert.equal(addBody.port, 8080);
  assert.equal(addBody.protocol, 'tcp');
  assert.equal(addBody.source, '192.168.1.0/24');

  // 4. removeFirewallPortRule
  await removeFirewallPortRule({ port: 8080, protocol: 'tcp' });
  assert.ok(calls[4].url.startsWith('/api/firewall/ports/8080'));
  assert.equal(calls[4].options.method, 'DELETE');

  // 5. fetchServiceProfiles & updateServiceProfiles
  await fetchServiceProfiles();
  assert.equal(calls[5].url, '/api/firewall/service-profiles');

  await updateServiceProfiles({ profiles: { localMail: true } });
  assert.equal(calls[6].url, '/api/firewall/service-profiles');
  assert.equal(calls[6].options.method, 'PUT');
  const profBody = JSON.parse(calls[6].options.body);
  assert.equal(profBody.profiles.localMail, true);

  // 6. scanFirewallPort
  await scanFirewallPort({ host: '127.0.0.1', port: 22 });
  assert.equal(calls[7].url, '/api/firewall/scan');
  assert.equal(calls[7].options.method, 'POST');
  const scanBody = JSON.parse(calls[7].options.body);
  assert.equal(scanBody.host, '127.0.0.1');
  assert.equal(scanBody.port, 22);

  // 7. CrowdSec bans
  await fetchCrowdsecBans();
  assert.equal(calls[8].url, '/api/firewall/bans');

  await addCrowdsecBan({ ip: '198.51.100.20', duration: '24h', reason: 'Abuse' });
  assert.equal(calls[9].url, '/api/firewall/bans');
  assert.equal(calls[9].options.method, 'POST');
  const banBody = JSON.parse(calls[9].options.body);
  assert.equal(banBody.ip, '198.51.100.20');
  assert.equal(banBody.duration, '24h');

  await removeCrowdsecBan({ id: 5 });
  assert.equal(calls[10].url, '/api/firewall/bans/5');
  assert.equal(calls[10].options.method, 'DELETE');

  await removeCrowdsecBan({ ip: '198.51.100.20' });
  assert.equal(calls[11].url, '/api/firewall/unban');
  assert.equal(calls[11].options.method, 'POST');
});
