import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PythonSystemdTemplateError,
  pythonApplicationUser,
  pythonServiceName,
  pythonSocketPath,
  renderPythonSystemdUnit,
} from '../src/index.js';

const VALID_APP_ID = '11111111-1111-4111-8111-111111111111';

test('generates deterministic python service name, user, and socket path', () => {
  const serviceName = pythonServiceName(VALID_APP_ID);
  assert.match(serviceName, /^yunpanel-python-[a-f0-9]{16}\.service$/);

  const user = pythonApplicationUser(VALID_APP_ID);
  assert.match(user, /^yunapp-[a-f0-9]{12}$/);

  const socketPath = pythonSocketPath(VALID_APP_ID);
  assert.equal(socketPath, `/run/yunpanel/python-${VALID_APP_ID}.sock`);
});

test('renders systemd unit for gunicorn WSGI application with unix socket', () => {
  const user = pythonApplicationUser(VALID_APP_ID);
  const unit = renderPythonSystemdUnit({
    applicationId: VALID_APP_ID,
    user,
    runtime: {
      pythonVersion: '3.12',
      appServer: 'gunicorn',
      entryPoint: 'wsgi:application',
      workers: 3,
    },
  });

  assert.match(unit, new RegExp(`Description=YunPanel Python application ${VALID_APP_ID}`));
  assert.match(unit, new RegExp(`User=${user}`));
  assert.match(unit, new RegExp(`Group=${user}`));
  assert.match(unit, new RegExp(`WorkingDirectory=/var/lib/yunpanel/apps/${VALID_APP_ID}/current`));
  assert.match(unit, new RegExp(`EnvironmentFile=-/etc/yunpanel/apps/${VALID_APP_ID}\\.env`));
  assert.match(unit, new RegExp(`Environment="PATH=/var/lib/yunpanel/data/${VALID_APP_ID}/venv/bin:/usr/local/bin:/usr/bin:/bin"`));
  assert.match(unit, new RegExp(`ExecStart=/var/lib/yunpanel/data/${VALID_APP_ID}/venv/bin/gunicorn --workers 3 --bind unix:/run/yunpanel/python-${VALID_APP_ID}\\.sock wsgi:application`));
  assert.match(unit, /Restart=always/);
  assert.match(unit, /PrivateTmp=true/);
  assert.match(unit, /ProtectSystem=strict/);
  assert.match(unit, /UMask=0027/);
});

test('renders systemd unit for uvicorn ASGI application with unix socket', () => {
  const user = pythonApplicationUser(VALID_APP_ID);
  const unit = renderPythonSystemdUnit({
    applicationId: VALID_APP_ID,
    user,
    runtime: {
      pythonVersion: '3.12',
      appServer: 'uvicorn',
      entryPoint: 'main:app',
      workers: 2,
    },
  });

  assert.match(unit, new RegExp(`ExecStart=/var/lib/yunpanel/data/${VALID_APP_ID}/venv/bin/uvicorn --workers 2 --uds /run/yunpanel/python-${VALID_APP_ID}\\.sock main:app`));
});

test('renders systemd unit with TCP port binding when configured', () => {
  const user = pythonApplicationUser(VALID_APP_ID);
  const unit = renderPythonSystemdUnit({
    applicationId: VALID_APP_ID,
    user,
    runtime: {
      pythonVersion: '3.12',
      appServer: 'gunicorn',
      entryPoint: 'app:app',
      workers: 2,
      port: 8000,
    },
  });

  assert.match(unit, /--bind 127\.0\.0\.1:8000 app:app/);
});

test('rejects mismatched user or invalid paths', () => {
  assert.throws(
    () => renderPythonSystemdUnit({
      applicationId: VALID_APP_ID,
      user: 'root',
      runtime: { appServer: 'gunicorn', entryPoint: 'app:app' },
    }),
    (error) => error instanceof PythonSystemdTemplateError && error.code === 'invalid_application_user',
  );

  const user = pythonApplicationUser(VALID_APP_ID);
  assert.throws(
    () => renderPythonSystemdUnit({
      applicationId: VALID_APP_ID,
      user,
      venvPath: '/var/lib/yunpanel/../../../etc',
      runtime: { appServer: 'gunicorn', entryPoint: 'app:app' },
    }),
    (error) => error instanceof PythonSystemdTemplateError && error.code === 'invalid_path',
  );
});
