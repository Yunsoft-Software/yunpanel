import { register } from 'node:module';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';

register('./jsx-loader.js', import.meta.url);

const {
  default: NginxSettingsFields,
  NGINX_HEADER_PRESETS,
  STATIC_CACHE_PRESETS,
  applyNginxHeaderPreset,
} = await import('../src/workspace/NginxSettingsFields.jsx');

const {
  JAMSTACK_FRAMEWORK_PRESETS,
  buildNginxSubPathLocationBlock,
  NginxSubPathProxyBuilder,
} = await import('../src/workspace/DomainHostingPanel.jsx');

const readSrc = (relPath) => readFile(new URL(`../src/${relPath}`, import.meta.url), 'utf8');

test('applyNginxHeaderPreset merges CORS, Security, and Immutable Cache headers with deduplication and 12-header boundary', () => {
  // 1. CORS preset
  const corsHeaders = applyNginxHeaderPreset([], 'cors');
  assert.equal(corsHeaders.length, 3);
  assert.deepEqual(
    corsHeaders.map((h) => [h.name, h.value, h.always]),
    [
      ['Access-Control-Allow-Origin', '*', true],
      ['Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS', true],
      ['Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With', true],
    ],
  );

  // 2. Deduplication (case-insensitive)
  const dedupedCors = applyNginxHeaderPreset(
    [{ name: 'access-control-allow-origin', value: 'https://app.example.com', always: false }],
    'cors',
  );
  assert.equal(dedupedCors.length, 3);
  assert.equal(dedupedCors[0].value, 'https://app.example.com');

  // 3. Security preset merged on top of CORS
  const withSecurity = applyNginxHeaderPreset(corsHeaders, 'security');
  assert.equal(withSecurity.length, 7);
  assert.ok(withSecurity.some((h) => h.name === 'X-Frame-Options' && h.value === 'SAMEORIGIN'));
  assert.ok(withSecurity.some((h) => h.name === 'X-Content-Type-Options' && h.value === 'nosniff'));
  assert.ok(withSecurity.some((h) => h.name === 'Referrer-Policy' && h.value === 'strict-origin-when-cross-origin'));
  assert.ok(withSecurity.some((h) => h.name === 'Permissions-Policy' && h.value === 'camera=(), microphone=(), geolocation=()'));

  // 4. Immutable cache preset
  const withImmutable = applyNginxHeaderPreset(withSecurity, 'immutable_cache');
  assert.equal(withImmutable.length, 8);
  assert.ok(
    withImmutable.some(
      (h) => h.name === 'Cache-Control' && h.value === 'public, max-age=31536000, immutable',
    ),
  );

  // 5. No-cache preset respects existing Cache-Control header deduplication
  const noCacheFresh = applyNginxHeaderPreset([], 'no_cache');
  assert.equal(noCacheFresh.length, 1);
  assert.equal(noCacheFresh[0].name, 'Cache-Control');
  assert.equal(noCacheFresh[0].value, 'no-store, no-cache, must-revalidate');

  // 6. 12-header boundary enforcement
  const tenExisting = Array.from({ length: 10 }, (_, idx) => ({
    name: `X-Custom-${idx + 1}`,
    value: `val-${idx + 1}`,
    always: true,
  }));
  const bounded = applyNginxHeaderPreset(tenExisting, 'security');
  assert.equal(bounded.length, 12, 'Must never exceed 12 response headers');
  assert.equal(bounded[10].name, 'X-Frame-Options');
  assert.equal(bounded[11].name, 'X-Content-Type-Options');
  assert.ok(NGINX_HEADER_PRESETS.cors.length === 3);
  assert.ok(STATIC_CACHE_PRESETS.length === 4);
});

test('NginxSettingsFields renders all existing controls alongside JAMstack header and static cache preset buttons', () => {
  const staticMarkup = renderToStaticMarkup(
    createElement(NginxSettingsFields, {
      targetType: 'static',
      domainNames: ['example.com', 'www.example.com'],
      disabled: false,
      onChange() {},
      settings: {
        documentRoot: 'dist',
        preferredDomain: 'example.com',
        clientMaxBodySizeMb: 64,
        staticAssetCacheSeconds: 86400,
        indexFiles: ['index.html'],
        spaFallback: true,
        errorPages: { 404: '/404.html' },
        headers: [{ name: 'X-Custom', value: '1', always: true }],
      },
    }),
  );

  // Existing controls preserved
  for (const label of [
    'Web sunucusu ayarları',
    'Document root',
    'Tercih edilen alan adı',
    'En büyük yükleme boyutu (MB)',
    'Statik dosya önbelleği (saniye)',
    'Başlangıç dosyaları',
    'Bulunamayan sayfalarda index.html kullan',
    'Özel hata sayfaları',
    'Özel yanıt başlıkları',
    'Yanıt başlığı ekle',
  ]) {
    assert.ok(staticMarkup.includes(label), `Expected NginxSettingsFields static markup to include "${label}"`);
  }

  // New static cache quick-fill buttons
  for (const label of [
    '1 Saat (3600s)',
    '1 Gün (86400s)',
    '30 Gün (2592000s)',
    '1 Yıl (31536000s)',
  ]) {
    assert.ok(staticMarkup.includes(label), `Expected static cache preset button "${label}"`);
  }

  // New JAMstack & security header preset buttons
  for (const label of [
    'CORS Başlıkları Ekle',
    'Güvenlik Başlıkları (HSTS/XSS) Ekle',
    'Immutable Cache Başlığı Ekle',
  ]) {
    assert.ok(staticMarkup.includes(label), `Expected header preset button "${label}"`);
  }

  // Proxy target renders proxy timeout and websocket controls
  const proxyMarkup = renderToStaticMarkup(
    createElement(NginxSettingsFields, {
      targetType: 'proxy',
      domainNames: ['api.example.com'],
      disabled: false,
      onChange() {},
      settings: {
        clientMaxBodySizeMb: 32,
        proxyTimeoutSeconds: 120,
        websocket: true,
        headers: [],
      },
    }),
  );
  assert.ok(proxyMarkup.includes('Uygulama yanıt süresi (saniye)'));
  assert.ok(proxyMarkup.includes('WebSocket bağlantılarına izin ver'));
  assert.ok(proxyMarkup.includes('CORS Başlıkları Ekle'));
});

test('DomainHostingPanel sub-path reverse proxy builder generates valid Nginx location block and links to /docker', () => {
  const blockWithWs = buildNginxSubPathLocationBlock({
    path: '/api',
    innerPort: '3000',
    outerPort: '127.0.0.1:13000',
    websocket: true,
  });
  assert.match(blockWithWs, /location \/api \{/);
  assert.match(blockWithWs, /proxy_pass http:\/\/127\.0\.0\.1:13000;/);
  assert.match(blockWithWs, /proxy_http_version 1\.1;/);
  assert.match(blockWithWs, /proxy_set_header Upgrade \$http_upgrade;/);
  assert.match(blockWithWs, /proxy_set_header Connection "upgrade";/);

  const blockWithoutWs = buildNginxSubPathLocationBlock({
    path: 'graphql',
    innerPort: '4000',
    outerPort: '14000',
    websocket: false,
  });
  assert.match(blockWithoutWs, /location \/graphql \{/);
  assert.match(blockWithoutWs, /proxy_pass http:\/\/127\.0\.0\.1:14000;/);
  assert.doesNotMatch(blockWithoutWs, /Upgrade \$http_upgrade/);

  assert.ok(JAMSTACK_FRAMEWORK_PRESETS.length >= 7);
  for (const fw of ['Next.js', 'Astro', 'Vite', 'Nuxt', 'Remix', 'Node.js', 'Python']) {
    assert.ok(
      JAMSTACK_FRAMEWORK_PRESETS.some((item) => item.label === fw),
      `Framework preset "${fw}" must be defined`,
    );
  }

  const builderHtml = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(NginxSubPathProxyBuilder, {
        domain: {
          id: 'dom-1',
          primaryDomain: 'jamstack.example.com',
          target: { upstreamPort: 13000 },
        },
      }),
    ),
  );

  assert.ok(builderHtml.includes('Nginx Reverse Proxy &amp; Alt Yol (Location) Kuralları'));
  assert.ok(builderHtml.includes('URL Yolu'));
  assert.ok(builderHtml.includes('Inner / Konteyner Portu'));
  assert.ok(builderHtml.includes('Outer / Yerel Host Portu'));
  assert.ok(builderHtml.includes('WebSocket (Upgrade)'));
  assert.ok(builderHtml.includes('Docker Stack Bağla'));
  assert.ok(builderHtml.includes('href="/docker"'));
  assert.ok(builderHtml.includes('proxy_pass http://127.0.0.1:13000;'));
});

test('SiteDetailPage surfaces "Web Sunucusu & Nginx" (hosting) and "Alan Adları & Yönlendirme" (domains) in overview tool cards', async () => {
  const siteDetailSource = await readSrc('workspace/SiteDetailPage.jsx');

  assert.match(
    siteDetailSource,
    /\['hosting',\s*'Web Sunucusu & Nginx',\s*'settings'\]/,
    'SiteDetailPage shortcuts must include Web Sunucusu & Nginx',
  );
  assert.match(
    siteDetailSource,
    /\['domains',\s*'Alan Adları & Yönlendirme',\s*'globe'\]/,
    'SiteDetailPage shortcuts must include Alan Adları & Yönlendirme',
  );
  assert.match(
    siteDetailSource,
    /hosting:\s*'Nginx, CORS, önbellek ve proxy kuralları'/,
  );
  assert.match(
    siteDetailSource,
    /domains:\s*'Alt alan adları, alias ve yayına alma'/,
  );
  assert.match(
    siteDetailSource,
    /\['Alan Adı, Güvenlik ve E-posta',\s*\['hosting',\s*'domains',\s*'ssl',\s*'dns',\s*'mail'\]\]/,
  );
});
