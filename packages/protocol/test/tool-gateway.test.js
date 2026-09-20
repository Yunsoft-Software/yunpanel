import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INTEGRATED_TOOL_GATEWAYS,
  integratedToolGateway,
  integratedToolGatewayInternals,
  isManagementToolGatewayAccessPath,
  managementToolGatewayForAccessPath,
} from '../src/tool-gateway.js';

test('integrated tool gateway descriptors keep unique audience, prefix, access path and Unix socket', () => {
  const values = Object.values(INTEGRATED_TOOL_GATEWAYS);
  assert.equal(values.length, 4);
  assert.deepEqual(values.map((value) => value.id), ['phpmyadmin', 'elfinder', 'ttyd', 'netdata']);
  for (const field of ['audience', 'publicPrefix', 'accessPath']) {
    assert.equal(new Set(values.map((value) => value[field])).size, values.length, field);
  }
  assert.deepEqual(integratedToolGateway('phpmyadmin'), {
    id: 'phpmyadmin',
    audience: 'phpmyadmin',
    publicPrefix: '/tools/phpmyadmin',
    accessPath: '/api/phpmyadmin-gateway-access',
    accessMode: 'owner',
    socketPath: '/run/yunpanel/phpmyadmin-http.sock',
    socketRoot: null,
    loopbackPort: null,
  });
  assert.deepEqual(integratedToolGateway('elfinder'), {
    id: 'elfinder',
    audience: 'elfinder',
    publicPrefix: '/tools/elfinder',
    accessPath: '/api/elfinder-gateway-access',
    accessMode: 'owner',
    socketPath: '/run/yunpanel/elfinder-http.sock',
    socketRoot: null,
    loopbackPort: null,
  });
  assert.deepEqual(integratedToolGateway('ttyd'), {
    id: 'ttyd',
    audience: 'terminal',
    publicPrefix: '/tools/ttyd',
    accessPath: '/api/ttyd-gateway-access',
    accessMode: 'session',
    socketPath: null,
    socketRoot: '/run/yunpanel/ttyd',
    loopbackPort: null,
  });
  assert.deepEqual(integratedToolGateway('netdata'), {
    id: 'netdata',
    audience: 'netdata',
    publicPrefix: '/tools/netdata',
    accessPath: '/api/netdata-gateway-access',
    accessMode: 'owner',
    socketPath: null,
    socketRoot: null,
    loopbackPort: 19999,
  });
});

test('management access path lookup never broad-matches tool prefixes', () => {
  assert.equal(isManagementToolGatewayAccessPath('/api/phpmyadmin-gateway-access'), true);
  assert.equal(isManagementToolGatewayAccessPath('/api/elfinder-gateway-access'), true);
  assert.equal(isManagementToolGatewayAccessPath('/api/ttyd-gateway-access'), true);
  assert.equal(isManagementToolGatewayAccessPath('/api/netdata-gateway-access'), true);
  assert.equal(isManagementToolGatewayAccessPath('/api/phpmyadmin-gateway-access/extra'), false);
  assert.equal(isManagementToolGatewayAccessPath('/api/elfinder-gateway-access?x=1'), false);
  assert.equal(isManagementToolGatewayAccessPath('/tools/elfinder/'), false);
  assert.equal(managementToolGatewayForAccessPath('/api/elfinder-gateway-access')?.id, 'elfinder');
  assert.equal(managementToolGatewayForAccessPath('/api/netdata-gateway-access')?.id, 'netdata');
  assert.equal(managementToolGatewayForAccessPath('/api/unknown'), null);
});

test('descriptor validation rejects expanded or unsafe gateway shapes', () => {
  const descriptor = integratedToolGatewayInternals.descriptor;
  for (const invalid of [
    {},
    { id: 'x', audience: 'x', publicPrefix: '/tools/x/', accessPath: '/api/x', accessMode: 'owner', socketPath: '/run/x.sock' },
    { id: 'x', audience: 'x', publicPrefix: '../x', accessPath: '/api/x', accessMode: 'owner', socketPath: '/run/x.sock' },
    { id: 'x', audience: 'x', publicPrefix: '/tools/x', accessPath: '/api/x?bad=1', accessMode: 'owner', socketPath: '/run/x.sock' },
    { id: 'x', audience: 'x', publicPrefix: '/tools/x', accessPath: '/api/x', accessMode: 'bogus', socketPath: '/run/x.sock' },
    { id: 'x', audience: 'x', publicPrefix: '/tools/x', accessPath: '/api/x', accessMode: 'owner', socketPath: '/tmp/x' },
    { id: 'x', audience: 'x', publicPrefix: '/tools/x', accessPath: '/api/x', accessMode: 'owner', socketPath: '/run/x.sock', socketRoot: '/run/x' },
    { id: 'x', audience: 'x', publicPrefix: '/tools/x', accessPath: '/api/x', accessMode: 'owner', socketPath: '/run/x.sock', loopbackPort: 19999 },
    { id: 'x', audience: 'x', publicPrefix: '/tools/x', accessPath: '/api/x', accessMode: 'owner', loopbackPort: 80 },
    { id: 'x', audience: 'x', publicPrefix: '/tools/x', accessPath: '/api/x', accessMode: 'owner', loopbackPort: 70000 },
    { id: 'x', audience: 'x', publicPrefix: '/tools/x', accessPath: '/api/x', accessMode: 'owner', loopbackPort: '19999' },
    { id: 'x', audience: 'x', publicPrefix: '/tools/x', accessPath: '/api/x', accessMode: 'owner' },
  ]) assert.throws(() => descriptor(invalid), /descriptor is invalid/);
  assert.throws(() => integratedToolGateway('pgadmin'), /Unknown integrated tool gateway/);
});
