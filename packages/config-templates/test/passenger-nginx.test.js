import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PassengerNginxTemplateError,
  renderPassengerNodeDirectives,
} from '../src/passenger-nginx.js';

const user = 'yunapp-0123456789ab';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const appRoot = `/var/lib/yunpanel/apps/${applicationId}/current`;
const environmentInclude = `/etc/yunpanel/passenger-env/${applicationId}.conf`;

test('Passenger Node directives pin runtime, Website identity and managed env include explicitly', () => {
  const config = renderPassengerNodeDirectives({
    appRoot,
    documentRoot: `${appRoot}/public`,
    startupFile: 'server.js',
    nodeBinary: '/opt/yunpanel/node-runtimes/24/bin/node',
    user,
    environmentInclude,
  });

  assert.match(config, /passenger_enabled on;/);
  assert.match(config, new RegExp(`passenger_app_root ${appRoot.replaceAll('/', '\\/')};`));
  assert.match(config, /passenger_app_type node;/);
  assert.match(config, /passenger_startup_file server\.js;/);
  assert.match(config, /passenger_nodejs \/opt\/yunpanel\/node-runtimes\/24\/bin\/node;/);
  assert.match(config, new RegExp(`passenger_user ${user};`));
  assert.match(config, new RegExp(`passenger_group ${user};`));
  assert.match(config, /passenger_app_env production;/);
  assert.match(config, new RegExp(`include ${environmentInclude.replaceAll('/', '\\/')};`));
});

test('Passenger template rejects environment includes outside the managed root', () => {
  for (const invalid of [
    `/tmp/${applicationId}.conf`,
    '/etc/yunpanel/passenger-env/custom.conf',
    `/etc/yunpanel/passenger-env/${applicationId}.conf/extra`,
  ]) {
    assert.throws(
      () => renderPassengerNodeDirectives({
        appRoot,
        documentRoot: appRoot,
        startupFile: 'server.js',
        user,
        environmentInclude: invalid,
      }),
      (error) => error instanceof PassengerNginxTemplateError
        && error.code === 'passenger_environment_include_invalid',
    );
  }
});

test('Passenger template rejects document roots escaping the active release', () => {
  assert.throws(
    () => renderPassengerNodeDirectives({
      appRoot,
      documentRoot: '/var/www/other-site/public',
      startupFile: 'server.js',
      user,
    }),
    (error) => error instanceof PassengerNginxTemplateError
      && error.code === 'passenger_document_root_invalid',
  );
});

test('Passenger template rejects arbitrary Unix users and startup traversal', () => {
  assert.throws(
    () => renderPassengerNodeDirectives({
      appRoot,
      documentRoot: appRoot,
      startupFile: '../../etc/passwd',
      user,
    }),
    (error) => error instanceof PassengerNginxTemplateError
      && error.code === 'passenger_startup_file_invalid',
  );

  assert.throws(
    () => renderPassengerNodeDirectives({
      appRoot,
      documentRoot: appRoot,
      startupFile: 'server.js',
      user: 'root',
    }),
    (error) => error instanceof PassengerNginxTemplateError
      && error.code === 'passenger_identity_invalid',
  );
});

test('Passenger template rejects raw directive-like values', () => {
  assert.throws(
    () => renderPassengerNodeDirectives({
      appRoot,
      documentRoot: appRoot,
      startupFile: 'server.js; passenger_user root',
      user,
    }),
    (error) => error instanceof PassengerNginxTemplateError,
  );
});
