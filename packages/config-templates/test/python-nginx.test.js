import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NginxTemplateError,
  renderPythonSiteConfig,
} from '../src/index.js';

test('renders python reverse proxy site config using unix domain socket', () => {
  const config = renderPythonSiteConfig({
    primaryDomain: 'pyapp.example.com',
    aliases: ['www.pyapp.example.com'],
    socketPath: '/run/yunpanel/python-11111111-1111-4111-8111-111111111111.sock',
  });

  assert.match(config, /server_name pyapp\.example\.com www\.pyapp\.example\.com;/);
  assert.match(config, /proxy_pass http:\/\/unix:\/run\/yunpanel\/python-11111111-1111-4111-8111-111111111111\.sock;/);
  assert.match(config, /proxy_set_header Upgrade \$http_upgrade;/);
  assert.match(config, /proxy_set_header Connection "upgrade";/);
  assert.match(config, /proxy_set_header Host \$host;/);
  assert.match(config, /proxy_set_header X-Real-IP \$remote_addr;/);
  assert.match(config, /proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/);
  assert.match(config, /proxy_set_header X-Forwarded-Proto \$scheme;/);
});

test('renders python reverse proxy site config using TCP port', () => {
  const config = renderPythonSiteConfig({
    primaryDomain: 'fastapi.example.com',
    upstreamPort: 8000,
  });

  assert.match(config, /proxy_pass http:\/\/127\.0\.0\.1:8000;/);
});

test('renders python site with TLS, ACME challenge, and bounded nginx settings', () => {
  const config = renderPythonSiteConfig({
    primaryDomain: 'securepy.example.com',
    socketPath: '/run/yunpanel/python-22222222-2222-4222-8222-222222222222.sock',
    tls: {
      fullchainPath: '/etc/yunpanel/acme/live/securepy.example.com/fullchain.pem',
      privateKeyPath: '/etc/yunpanel/acme/live/securepy.example.com/privkey.pem',
    },
    canonicalRedirect: true,
    httpsRedirect: true,
    nginxSettings: {
      clientMaxBodySizeMb: 50,
      proxyTimeoutSeconds: 180,
      websocket: true,
      headers: [
        { name: 'X-Frame-Options', value: 'DENY', always: true },
      ],
    },
  });

  assert.match(config, /listen 443 ssl;/);
  assert.match(config, /client_max_body_size 50m;/);
  assert.match(config, /proxy_connect_timeout 180s;/);
  assert.match(config, /proxy_send_timeout 180s;/);
  assert.match(config, /proxy_read_timeout 180s;/);
  assert.match(config, /add_header X-Frame-Options "DENY" always;/);
  assert.match(config, /ssl_certificate \/etc\/yunpanel\/acme\/live\/securepy\.example\.com\/fullchain\.pem;/);
});

test('rejects invalid socket path or missing upstream target', () => {
  assert.throws(
    () => renderPythonSiteConfig({
      primaryDomain: 'invalid.example.com',
    }),
    (error) => error instanceof NginxTemplateError && error.code === 'invalid_upstream',
  );

  assert.throws(
    () => renderPythonSiteConfig({
      primaryDomain: 'invalid.example.com',
      socketPath: '/tmp/arbitrary.sock',
    }),
    (error) => error instanceof NginxTemplateError && error.code === 'invalid_python_socket',
  );
});
