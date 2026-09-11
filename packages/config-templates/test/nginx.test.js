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
  assert.equal(config.includes('listen 443 ssl;'), false);
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

test('renders canonical external DNS and IPv6 reverse proxy targets', () => {
  const dns = renderProxySiteConfig({
    primaryDomain: 'edge.example.com',
    upstreamHost: 'ORIGIN.Example.NET.',
    upstreamPort: 8443,
    websocket: false,
  });
  assert.match(dns, /proxy_pass http:\/\/origin\.example\.net:8443;/);
  assert.equal(dns.includes('proxy_set_header Upgrade'), false);

  const ipv6 = renderProxySiteConfig({
    primaryDomain: 'ipv6.example.com',
    upstreamHost: '2001:0db8:0:0:0:0:0:1',
    upstreamPort: 8080,
  });
  assert.match(ipv6, /proxy_pass http:\/\/\[2001:db8::1\]:8080;/);
});

test('renders managed HTTPS with HTTP ACME challenge and redirect', () => {
  const config = renderProxySiteConfig({
    primaryDomain: 'secure.example.com',
    aliases: ['www.secure.example.com'],
    upstreamPort: 3100,
    tls: {
      fullchainPath: '/etc/letsencrypt/live/secure.example.com/fullchain.pem',
      privateKeyPath: '/etc/letsencrypt/live/secure.example.com/privkey.pem',
    },
  });

  assert.match(config, /listen 80;/);
  assert.match(config, /\.well-known\/acme-challenge/);
  assert.match(config, /return 301 https:\/\/\$host\$request_uri;/);
  assert.match(config, /listen 443 ssl;/);
  assert.match(config, /ssl_certificate \/etc\/letsencrypt\/live\/secure\.example\.com\/fullchain\.pem;/);
  assert.match(config, /ssl_certificate_key \/etc\/letsencrypt\/live\/secure\.example\.com\/privkey\.pem;/);
  assert.match(config, /proxy_pass http:\/\/127\.0\.0\.1:3100;/);
});

test('serves HTTP alongside HTTPS when HTTPS redirect is disabled', () => {
  const config = renderProxySiteConfig({
    primaryDomain: 'secure.example.com',
    aliases: ['www.secure.example.com'],
    upstreamPort: 3100,
    httpsRedirect: false,
    tls: {
      fullchainPath: '/etc/letsencrypt/live/secure.example.com/fullchain.pem',
      privateKeyPath: '/etc/letsencrypt/live/secure.example.com/privkey.pem',
    },
  });
  assert.equal(config.includes('return 301'), false);
  assert.equal(config.match(/proxy_pass http:\/\/127\.0\.0\.1:3100;/g)?.length, 2);
  assert.match(config, /listen 80;/);
  assert.match(config, /listen 443 ssl;/);
});

test('redirects aliases to the canonical primary hostname on HTTP and HTTPS', () => {
  const config = renderStaticSiteConfig({
    primaryDomain: 'example.com',
    aliases: ['www.example.com', 'example.net'],
    root: '/var/www/yunpanel/apps/example/current',
    canonicalRedirect: true,
    tls: {
      fullchainPath: '/etc/letsencrypt/live/example.com/fullchain.pem',
      privateKeyPath: '/etc/letsencrypt/live/example.com/privkey.pem',
    },
  });
  assert.match(config, /server_name example\.com;/);
  assert.match(config, /server_name www\.example\.com example\.net;/);
  assert.equal(config.match(/return 301 https:\/\/example\.com\$request_uri;/g)?.length, 3);
  assert.equal(config.match(/\.well-known\/acme-challenge/g)?.length, 2);
  assert.equal(config.match(/root \/var\/www\/yunpanel\/apps\/example\/current;/g)?.length, 1);
});

test('canonical HTTP aliases stay on HTTP until a certificate is attached', () => {
  const config = renderProxySiteConfig({
    primaryDomain: 'api.example.com',
    aliases: ['old.example.com'],
    upstreamPort: 3100,
    canonicalRedirect: true,
    httpsRedirect: true,
  });
  assert.match(config, /return 301 http:\/\/api\.example\.com\$request_uri;/);
  assert.equal(config.includes('listen 443 ssl;'), false);
});

test('rejects non-boolean redirect policy values', () => {
  assert.throws(
    () => renderProxySiteConfig({ primaryDomain: 'api.example.com', upstreamPort: 3100, canonicalRedirect: 'yes' }),
    (error) => error instanceof NginxTemplateError && error.code === 'invalid_redirect_policy',
  );
});

test('rejects config injection through domain, path, upstream and TLS inputs', () => {
  assert.throws(
    () => renderStaticSiteConfig({ primaryDomain: 'example.com; include /etc/shadow', root: '/var/www/site' }),
    (error) => error?.code === 'invalid_domain_length',
  );

  assert.throws(
    () => renderStaticSiteConfig({ primaryDomain: 'example.com', root: '/var/www/site; include /etc/shadow' }),
    (error) => error instanceof NginxTemplateError && error.code === 'invalid_path',
  );

  assert.throws(
    () => renderProxySiteConfig({ primaryDomain: 'api.example.com', upstreamHost: 'https://10.0.0.5/evil', upstreamPort: 3000 }),
    (error) => error instanceof NginxTemplateError && error.code === 'invalid_upstream_host',
  );

  assert.throws(
    () => renderProxySiteConfig({ primaryDomain: 'api.example.com', upstreamPort: 80 }),
    (error) => error instanceof NginxTemplateError && error.code === 'invalid_upstream_port',
  );

  assert.throws(
    () => renderProxySiteConfig({
      primaryDomain: 'api.example.com',
      upstreamPort: 3000,
      tls: {
        fullchainPath: '/etc/letsencrypt/live/api.example.com/fullchain.pem; include /etc/shadow',
        privateKeyPath: '/etc/letsencrypt/live/api.example.com/privkey.pem',
      },
    }),
    (error) => error instanceof NginxTemplateError && error.code === 'invalid_path',
  );
});
