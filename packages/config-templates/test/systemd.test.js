import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SystemdTemplateError,
  nodeApplicationUser,
  nodeServiceName,
  renderNodeSystemdUnit,
} from '../src/index.js';

const APPLICATION_ID = '9d4a4727-1aba-4d35-95fe-21db67042ce9';

test('renders a hardened direct Node systemd unit without shell execution', () => {
  const user = nodeApplicationUser(APPLICATION_ID);
  const unit = renderNodeSystemdUnit({
    applicationId: APPLICATION_ID,
    user,
    nodePath: '/usr/bin/node',
    runtime: {
      nodeMajor: 24,
      port: 3100,
      startMode: 'node',
      entryFile: 'dist/server.js',
      restartPolicy: 'on-failure',
    },
  });

  assert.match(nodeServiceName(APPLICATION_ID), /^yunpanel-node-[a-f0-9]{16}\.service$/);
  assert.match(unit, new RegExp(`User=${user}`));
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/var\/lib\/yunpanel\/apps\/.+\/current\/dist\/server\.js/);
  assert.match(unit, /EnvironmentFile=\/etc\/yunpanel\/apps\/.+\.env/);
  assert.match(unit, /NoNewPrivileges=true/);
  assert.match(unit, /ProtectSystem=strict/);
  assert.match(unit, /CapabilityBoundingSet=\n/);
  assert.equal(unit.includes('/bin/sh'), false);
  assert.equal(unit.includes('bash'), false);
});

test('renders allowlisted npm start scripts directly through npm', () => {
  const unit = renderNodeSystemdUnit({
    applicationId: APPLICATION_ID,
    user: nodeApplicationUser(APPLICATION_ID),
    nodePath: '/usr/bin/node',
    npmPath: '/usr/bin/npm',
    runtime: {
      nodeMajor: 24,
      port: 4100,
      startMode: 'npm',
      startScript: 'start:prod',
      restartPolicy: 'always',
    },
  });

  assert.match(unit, /ExecStart=\/usr\/bin\/npm run start:prod/);
  assert.match(unit, /Restart=always/);
});

test('rejects mismatched users and executable path injection', () => {
  assert.throws(
    () => renderNodeSystemdUnit({
      applicationId: APPLICATION_ID,
      user: 'root',
      nodePath: '/usr/bin/node',
      runtime: { port: 3000 },
    }),
    (error) => error instanceof SystemdTemplateError && error.code === 'invalid_application_user',
  );

  assert.throws(
    () => renderNodeSystemdUnit({
      applicationId: APPLICATION_ID,
      user: nodeApplicationUser(APPLICATION_ID),
      nodePath: '/tmp/node',
      runtime: { port: 3000 },
    }),
    (error) => error instanceof SystemdTemplateError && error.code === 'invalid_node_path',
  );
});
