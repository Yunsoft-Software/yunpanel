import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PassengerBootstrapTemplateError,
  renderPassengerBootstrap,
} from '../src/passenger-bootstrap.js';

const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const environmentPath = `/var/lib/yunpanel/data/${applicationId}/passenger/environment.json`;
const appRoot = `/var/lib/yunpanel/apps/${applicationId}/current`;

function input(overrides = {}) {
  return {
    applicationId,
    appEnv: 'production',
    environmentPath,
    appRoot,
    startupPath: `${appRoot}/server.js`,
    ...overrides,
  };
}

test('Passenger bootstrap loads private environment before the real startup file', () => {
  const rendered = renderPassengerBootstrap(input());
  assert.match(rendered, new RegExp(environmentPath.replaceAll('/', '\\/')));
  assert.match(rendered, /process\.env\.NODE_ENV = "production"/);
  assert.match(rendered, /process\.env\.HOST = '127\.0\.0\.1'/);
  assert.match(rendered, new RegExp(`process\\.env\\.YUNPANEL_APPLICATION_ID = "${applicationId}"`));
  assert.match(rendered, /process\.chdir/);
  assert.match(rendered, /pathToFileURL/);
  assert.match(rendered, /server\.js/);
  assert.doesNotMatch(rendered, /process\.env\.PORT\s*=/);
});

test('Passenger bootstrap contains no materialized secret values', () => {
  const rendered = renderPassengerBootstrap(input());
  assert.doesNotMatch(rendered, /DATABASE_PASSWORD/);
  assert.doesNotMatch(rendered, /super-secret-value/);
});

test('Passenger bootstrap rejects environment path drift', () => {
  assert.throws(
    () => renderPassengerBootstrap(input({ environmentPath: '/tmp/environment.json' })),
    (error) => error instanceof PassengerBootstrapTemplateError
      && error.code === 'passenger_bootstrap_environment_path_invalid',
  );
});

test('Passenger bootstrap rejects startup escape', () => {
  assert.throws(
    () => renderPassengerBootstrap(input({ startupPath: `/var/lib/yunpanel/apps/${applicationId}/other.js` })),
    (error) => error instanceof PassengerBootstrapTemplateError
      && error.code === 'passenger_bootstrap_path_invalid',
  );
});

test('Passenger bootstrap rejects unsupported app environments', () => {
  assert.throws(
    () => renderPassengerBootstrap(input({ appEnv: 'staging' })),
    (error) => error instanceof PassengerBootstrapTemplateError
      && error.code === 'passenger_bootstrap_app_env_invalid',
  );
});
