import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { nodeServiceName } from '@yunpanel/config-templates';
import { createNodeStatusInspector } from '../src/node-status-inspector.js';

const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const releaseId = '216e4db8-468b-4e2f-a021-3ab31e0f4123';
const spec = () => ({ applicationId, releaseId, runtime: { port: 3100, healthPath: '/health' } });
async function root(t, target = `releases/${releaseId}`) {
  const appRoot = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-node-status-'));
  await mkdir(path.join(appRoot, applicationId));
  if (target !== null) await symlink(target, path.join(appRoot, applicationId, 'current'));
  t.after(() => rm(appRoot, { recursive: true, force: true }));
  return appRoot;
}

test('moved inspector uses real release symlinks and loopback HTTP with bounded systemctl arguments', async t => {
  const appRoot = await root(t); const requests = []; const commands = [];
  const server = http.createServer((request, response) => {
    requests.push({ path: request.url, host: request.headers.host, method: request.method });
    response.writeHead(204); response.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const input = spec(); input.runtime.port = server.address().port;
  const inspector = createNodeStatusInspector({ appRoot, systemctlPaths: ['/usr/bin/systemctl'], run: async (file, args, options) => {
    commands.push({ file, args, options });
    return { stdout: args[0] === '--version' ? 'systemd 255' : 'LoadState=loaded\nActiveState=active\nSubState=running\nNRestarts=2\nMainPID=1234\n' };
  } });
  const result = await inspector.inspectNodeStatus(input);
  assert.equal(result.healthy, true); assert.equal(result.inspectionError, false);
  assert.equal(result.serviceName, nodeServiceName(applicationId));
  assert.deepEqual(requests, [{ path: '/health', host: 'localhost', method: 'GET' }]);
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[1].args, ['show', result.serviceName, '--property=LoadState', '--property=ActiveState', '--property=SubState', '--property=NRestarts', '--property=MainPID', '--no-pager']);
  assert.equal(commands[1].options.maxBuffer, 64 * 1024);
  assert.equal(commands[1].options.timeout, 5000);
});

for (const target of [null, '/tmp/unmanaged-release', '../../another-site/current']) {
  test(`rejects missing or unmanaged current link (${target}) before running systemctl`, async t => {
    let calls = 0; const appRoot = await root(t, target);
    const inspector = createNodeStatusInspector({ appRoot, run: async () => { calls++; } });
    await assert.rejects(inspector.inspectNodeStatus(spec()), { code: 'node_status_current_missing' });
    assert.equal(calls, 0);
  });
}

test('shared input validation runs before filesystem or host access', async () => {
  let calls = 0;
  const inspector = createNodeStatusInspector({ readlinkFn: async () => { calls++; }, run: async () => { calls++; } });
  for (const input of [{ ...spec(), applicationId: '../other' }, { ...spec(), releaseId: 'invalid' }, { ...spec(), runtime: { port: 22 } }, { ...spec(), runtime: { port: 3100, healthPath: '//external.example' } }]) {
    await assert.rejects(inspector.inspectNodeStatus(input), { code: 'invalid_node_status' });
  }
  assert.equal(calls, 0);
});

test('missing systemctl remains a distinct dependency failure', async t => {
  const appRoot = await root(t);
  const inspector = createNodeStatusInspector({ appRoot, systemctlPaths: [], run: async () => { assert.fail('must not execute'); } });
  await assert.rejects(inspector.inspectNodeStatus(spec()), { code: 'systemd_not_available' });
});

test('a systemctl inspection error does not copy raw error details into its result', async t => {
  const appRoot = await root(t);
  const inspector = createNodeStatusInspector({ appRoot, run: async (_file, args) => {
    if (args[0] === '--version') return { stdout: 'systemd 255' };
    throw Object.assign(new Error('PRIVATE_PATH'), { stderr: 'PRIVATE_KEY', stdout: 'LoadState=loaded\nActiveState=inactive\nSubState=dead\nEnvironment=PRIVATE_TOKEN\n' });
  } });
  const result = await inspector.inspectNodeStatus(spec());
  assert.equal(result.inspectionError, true); assert.equal(result.healthy, false);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});
