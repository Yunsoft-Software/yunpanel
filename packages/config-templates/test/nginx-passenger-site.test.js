import assert from 'node:assert/strict';
import test from 'node:test';
import { renderPassengerSiteConfig } from '../src/nginx.js';

const appRoot = '/var/lib/yunpanel/apps/6dcb8908-3f3e-43da-9452-15fd6b51ac76/current';
const user = 'yunapp-0123456789ab';

function target() {
  return {
    appRoot,
    documentRoot: appRoot,
    startupFile: 'server.js',
    nodeBinary: '/usr/bin/node',
    user,
    group: user,
  };
}

test('Passenger site renders Website identity and Node entrypoint in HTTP vhost', () => {
  const config = renderPassengerSiteConfig({
    primaryDomain: 'example.com',
    aliases: ['www.example.com'],
    target: target(),
    nginxSettings: { clientMaxBodySizeMb: 64, headers: [] },
  });

  assert.match(config, /server_name example\.com www\.example\.com;/);
  assert.match(config, /client_max_body_size 64m;/);
  assert.match(config, /passenger_enabled on;/);
  assert.match(config, /passenger_app_type node;/);
  assert.match(config, /passenger_startup_file server\.js;/);
  assert.match(config, new RegExp(`passenger_user ${user};`));
});

test('managed TLS keeps Passenger directives only on serving vhost and redirects HTTP', () => {
  const config = renderPassengerSiteConfig({
    primaryDomain: 'example.com',
    target: target(),
    tls: {
      fullchainPath: '/etc/letsencrypt/live/example.com/fullchain.pem',
      privateKeyPath: '/etc/letsencrypt/live/example.com/privkey.pem',
    },
    httpsRedirect: true,
  });

  const passengerMatches = config.match(/passenger_enabled on;/g) ?? [];
  assert.equal(passengerMatches.length, 1);
  assert.match(config, /return 301 https:\/\/\$host\$request_uri;/);
  assert.match(config, /listen 443 ssl;/);
});
