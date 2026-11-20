import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { register } from 'node:module';
import test from 'node:test';
import { getDockerConsoleTargets } from '../src/workspace/docker-compose-client.js';
import { setSession } from '../src/session-client.js';
import {
  createTerminalWebSocket,
  normalizeTerminalCapability,
  parseTerminalMessage,
  terminalCapabilityRequestBody,
  terminalClientInternals,
  terminalContextCwd,
  terminalContextUser,
} from '../src/workspace/terminal-client.js';

register('./jsx-loader.js', import.meta.url);

const { dockerProjectsPageInternals } = await import('../src/workspace/DockerProjectsPage.jsx');

const CONTAINER_ID = 'a'.repeat(64);
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const SERVER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';

function validDockerTarget(overrides = {}) {
  return {
    scope: 'docker_container',
    serverId: SERVER_ID,
    dockerProjectId: PROJECT_ID,
    projectName: 'shop_stack',
    serviceName: 'web',
    containerId: CONTAINER_ID,
    containerName: 'shop_stack-web-1',
    user: '65534:65534',
    uid: 65534,
    gid: 65534,
    cwd: '/',
    shell: '/bin/sh',
    ...overrides,
  };
}

function validDockerCapability(targetOverrides = {}) {
  return {
    capability: 'b'.repeat(43),
    expiresAt: Date.now() + 60_000,
    protocol: 'yunpanel-terminal-v1',
    target: validDockerTarget(targetOverrides),
  };
}

test('terminal-client validates non-root docker_container capabilities and ready messages fail-closed', () => {
  const cap = validDockerCapability({ user: '101:101', uid: 101, gid: 101, shell: '/bin/bash', cwd: '/app' });
  const normalized = normalizeTerminalCapability(cap);
  assert.deepEqual(normalized.target, cap.target);
  assert.equal(
    terminalClientInternals.targetIdentity(normalized.target),
    `docker_container:${SERVER_ID}:${PROJECT_ID}:${CONTAINER_ID}:101:101:/app:/bin/bash`,
  );

  const ready = parseTerminalMessage(JSON.stringify({
    type: 'ready',
    sessionId: SESSION_ID,
    target: cap.target,
  }));
  assert.equal(ready.target.user, '101:101');

  const sockets = [];
  class FakeWebSocket {
    constructor(url, protocols) { sockets.push({ url, protocols }); }
  }
  createTerminalWebSocket(cap, {
    WebSocketClass: FakeWebSocket,
    locationLike: { href: 'https://panel.example.test/docker/project-1' },
  });
  assert.deepEqual(sockets, [{
    url: 'wss://panel.example.test/api/terminal',
    protocols: ['yunpanel-terminal-v1', `yunpanel-terminal-capability.${'b'.repeat(43)}`],
  }]);

  // Fail-closed rejections: root uid/gid, root user, mismatch, short containerId, bad cwd/shell, extra key
  const badTargets = [
    validDockerTarget({ uid: 0, gid: 65534, user: '0:65534' }),
    validDockerTarget({ uid: 65534, gid: 0, user: '65534:0' }),
    validDockerTarget({ uid: 0, gid: 0, user: 'root' }),
    validDockerTarget({ user: 'root' }),
    validDockerTarget({ uid: 1000, gid: 1000, user: '1000:1001' }),
    validDockerTarget({ containerId: 'a'.repeat(12) }),
    validDockerTarget({ containerId: 'A'.repeat(64) }),
    validDockerTarget({ cwd: 'relative/path' }),
    validDockerTarget({ shell: '/bin/zsh' }),
    validDockerTarget({ shell: '/bin/sh -c id' }),
    validDockerTarget({ privileged: true }),
    (() => {
      const { shell: _omitted, ...rest } = validDockerTarget();
      return rest;
    })(),
  ];

  for (const badTarget of badTargets) {
    assert.equal(terminalClientInternals.targetIdentity(badTarget), null);
    assert.throws(() => normalizeTerminalCapability({ ...validDockerCapability(), target: badTarget }));
    assert.throws(() => parseTerminalMessage(JSON.stringify({
      type: 'ready',
      sessionId: SESSION_ID,
      target: badTarget,
    })));
  }
});

test('getDockerConsoleTargets requests encoded console-targets endpoint and validates projectId', async (t) => {
  setSession({ csrfToken: 'csrf-console' });
  t.after(() => setSession(null));

  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({
      data: {
        version: 1,
        projectId: 'project/one',
        projectName: 'shop_stack',
        runtimeStatus: 'running',
        targets: [{
          containerId: CONTAINER_ID,
          containerName: 'shop_stack-web-1',
          serviceName: 'web',
          running: true,
          eligible: true,
          user: '65534:65534',
          forcedNonRoot: true,
          cwd: '/',
          reasonCode: null,
          reason: null,
        }],
      },
    }), { status: 200 });
  });

  const controller = new AbortController();
  const res = await getDockerConsoleTargets('project/one', { signal: controller.signal });
  assert.equal(res.targets.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/panel/docker/projects/project%2Fone/console-targets');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.signal, controller.signal);

  assert.throws(() => getDockerConsoleTargets(''), /dockerProjectId is required/);
  assert.equal(calls.length, 1);
});

test('TerminalPanel supports exact 3-field docker_container issueBody and resets connection on target change', async () => {
  assert.deepEqual(
    terminalCapabilityRequestBody({
      scope: 'docker_container',
      dockerProjectId: PROJECT_ID,
      containerId: CONTAINER_ID,
      user: '65534:65534',
      cwd: '/',
    }),
    {
      scope: 'docker_container',
      dockerProjectId: PROJECT_ID,
      containerId: CONTAINER_ID,
    },
  );
  assert.equal(terminalCapabilityRequestBody({ scope: 'docker_container', dockerProjectId: PROJECT_ID }), null);
  assert.equal(terminalCapabilityRequestBody({ scope: 'docker_container', containerId: CONTAINER_ID }), null);
  assert.deepEqual(terminalCapabilityRequestBody({ scope: 'server', serverId: SERVER_ID }), { scope: 'server', serverId: SERVER_ID });
  assert.deepEqual(terminalCapabilityRequestBody({ scope: 'site', websiteId: 'site-1' }), { scope: 'site', websiteId: 'site-1' });
  assert.equal(terminalContextUser({ scope: 'docker_container', user: '65534:65534' }), '65534:65534');
  assert.equal(terminalContextCwd({ scope: 'docker_container', cwd: '/app' }), '/app');

  const source = await readFile(new URL('../src/workspace/TerminalPanel.jsx', import.meta.url), 'utf8');
  assert.match(source, /terminalCapabilityRequestBody/);
  assert.match(source, /active\.close\(1000, 'target_changed'\)/);
  assert.match(source, /setStatus\('idle'\)/);
  assert.match(source, /setContext\(null\)/);
  assert.match(source, /setError\(null\)/);
  assert.doesNotMatch(source, /Site kullanıcısı \(izole\)/);
});

test('DockerProjectsPage wires Owner-only container console via LazyTerminalPanel with zero Cockpit or host fallback', async () => {
  const targets = [
    {
      containerId: CONTAINER_ID,
      containerName: 'shop_stack-web-1',
      serviceName: 'web',
      running: true,
      eligible: true,
      user: '65534:65534',
      forcedNonRoot: true,
      cwd: '/',
      reasonCode: null,
      reason: null,
    },
  ];
  assert.equal(
    dockerProjectsPageInternals.findConsoleTarget(targets, { id: CONTAINER_ID.slice(0, 12), name: 'other' })?.containerId,
    CONTAINER_ID,
  );
  assert.equal(
    dockerProjectsPageInternals.findConsoleTarget(targets, { id: CONTAINER_ID, name: 'shop_stack-web-1' })?.user,
    '65534:65534',
  );

  const source = await readFile(new URL('../src/workspace/DockerProjectsPage.jsx', import.meta.url), 'utf8');
  assert.match(source, /getDockerConsoleTargets/);
  assert.match(source, /import LazyTerminalPanel from '\.\/LazyTerminalPanel\.jsx';/);
  assert.match(source, /useWorkspace/);
  assert.match(source, /scope: 'docker_container'/);
  assert.match(source, /Konsolu aç/);
  assert.match(source, /Konsolu kapat/);
  assert.match(source, /title="Konteyner konsolu"/);

  // Preserve existing panels untouched
  assert.match(source, /<StoragePanel project=\{project\} backup=\{storageBackup\.data\} \/><DockerVolumesPanel project=\{project\} onChanged=\{refresh\} \/>/);
  assert.match(source, /<DockerLifecyclePanel project=\{project\} onChanged=\{detail\.refresh\} \/>/);

  // Strictly no Cockpit fallback, host terminal fallback, or root exec option
  assert.doesNotMatch(source, /cockpit/i);
  assert.doesNotMatch(source, /scope:\s*['"]server['"]/);
  assert.doesNotMatch(source, /root exec|exec as root|run as root/i);
});
