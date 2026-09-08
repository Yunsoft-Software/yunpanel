import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NginxTemplateError,
  nginxConfigFileName,
  renderProxySiteConfig,
  renderStaticSiteConfig,
} from '../src/index.js';

test('renders a static SPA server block with normalized domains', () => {
  const config = renderStaticSiteConfig({
    primaryDomain: 'Example.COM',
    aliases: ['www.example.com'],
    root: '/var/lib/yunpanel/apps/example/current',
  });

  assert.match(config, /server_name example\.com www\.example\.com;/);
  assert.match(config, /root \/var\/lib\/yunpanel\/apps\/example\/current;/);
  assert.match(config, /try_files \$uri \$uri\/ \/index\.html;/);
  assert.match(config, /\.well-known\/acme-challenge/);
  assert.equal(nginxConfigFileName('Example.COM.'), 'example.com.conf');
});

test('renders loopback Node proxy settings with websocket support', () => {
  const config = renderProxySiteConfig({
    primaryDomain: 'api.example.com',
    upstreamPort: 3008,
  });

  assert.match(config, /proxy_pass http:\/\/127\.0\.0\.1:3008;/);
  assert.match(config, /proxy_set_header Upgrade \$http_upgrade;/);
  assert.match(config, /proxy_set_header Connection "upgrade";/);
});

test('rejects config injection through domain, path and upstream inputs', () => {
  assert.throws(
    () => renderStaticSiteConfig({ primaryDomain: 'example.com; include /etc/shadow', root: '/var/www/site' }),
    /Domain labels/,
  );

  assert.throws(
    () => renderStaticSiteConfig({ primaryDomain: 'example.com', root: '/var/www/site; include /etc/shadow' }),
    (error) => error instanceof NginxTemplateError && error.code === 'invalid_path',
  );

  assert.throws(
    () => renderProxySiteConfig({ primaryDomain: 'api.example.com', upstreamHost: '10.0.0.5', upstreamPort: 3000 }),
    (error) => error instanceof NginxTemplateError && error.code === 'invalid_upstream_host',
  );

  assert.throws(
    () => renderProxySiteConfig({ primaryDomain: 'api.example.com', upstreamPort: 80 }),
    (error) => error instanceof NginxTemplateError && error.code === 'invalid_upstream_port',
  );
});
