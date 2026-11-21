import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NginxTemplateError,
  NginxTrafficTemplateError,
  YUNPANEL_TRAFFIC_CONF_PATH,
  YUNPANEL_TRAFFIC_LOG_FORMAT,
  YUNPANEL_TRAFFIC_LOG_PATH,
  renderNginxTrafficAccountingConfig,
  renderPassengerSiteConfig,
  renderPhpSiteConfig,
  renderProxySiteConfig,
  renderPythonSiteConfig,
  renderRedirectSiteConfig,
  renderStaticSiteConfig,
} from '../src/index.js';

const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';
const SITE_C = '33333333-3333-4333-8333-333333333333';
const TLS = {
  fullchainPath: '/etc/yunpanel/certs/example.test/fullchain.pem',
  privateKeyPath: '/etc/yunpanel/certs/example.test/privkey.pem',
};

test('renderNginxTrafficAccountingConfig: uses $server_name (never $host), exact-string log_enabled map (no {8} regex), excludes non-active domains, and quotes map entries', () => {
  assert.equal(YUNPANEL_TRAFFIC_LOG_PATH, '/var/log/nginx/yunpanel-site-traffic.log');
  assert.equal(YUNPANEL_TRAFFIC_CONF_PATH, '/etc/nginx/conf.d/yunpanel-site-traffic.conf');
  assert.equal(YUNPANEL_TRAFFIC_LOG_FORMAT, 'yunpanel_site_traffic');

  const rendered = renderNginxTrafficAccountingConfig({
    domains: [
      { primaryDomain: 'Beta.Example.Test', aliases: ['www.beta.example.test'], websiteId: SITE_B.toUpperCase(), state: 'active' },
      { primaryDomain: 'alpha.example.test', aliases: ['www.alpha.example.test'], websiteId: SITE_A, state: 'active' },
      { primaryDomain: 'api.alpha.example.test', aliases: [], websiteId: SITE_A, state: 'active' },
      { primaryDomain: 'draft.example.test', aliases: [], websiteId: SITE_C, state: 'draft' },
      { primaryDomain: 'staged.example.test', aliases: [], websiteId: SITE_C, state: 'staged' },
      { primaryDomain: 'suspended.example.test', aliases: [], websiteId: SITE_C, state: 'suspended' },
      { primaryDomain: 'removed.example.test', aliases: [], websiteId: SITE_C, state: 'removed' },
      { primaryDomain: 'unapplied.example.test', aliases: [], websiteId: SITE_C, state: 'active', applied: false },
      { primaryDomain: 'unbound.example.test', aliases: [], websiteId: null, state: 'active' },
    ],
    blockedWebsiteIds: [SITE_B.toUpperCase(), SITE_B],
  });

  assert.equal(rendered.path, YUNPANEL_TRAFFIC_CONF_PATH);
  assert.equal(rendered.trafficLogPath, YUNPANEL_TRAFFIC_LOG_PATH);
  assert.match(rendered.sha256, /^[a-f0-9]{64}$/);
  assert.equal(rendered.trackedHostCount, 5);
  assert.deepEqual(rendered.trackedWebsiteIds, [SITE_A, SITE_B]);
  assert.deepEqual(rendered.blockedWebsiteIds, [SITE_B]);

  assert.ok(rendered.content.includes("log_format yunpanel_site_traffic '$time_iso8601\\t$yunpanel_traffic_site_id\\t$body_bytes_sent';"));
  assert.ok(!rendered.content.includes('$remote_addr'), 'traffic log format must never include client IP (zero-PII)');
  assert.ok(!rendered.content.includes('$request_uri') && !rendered.content.includes('$args'), 'traffic log format must never include query/URI');
  assert.ok(rendered.content.includes('map $server_name $yunpanel_traffic_site_id {'), 'must map $server_name');
  assert.ok(!rendered.content.includes('map $host '), 'must NEVER map untrusted client $host');
  assert.ok(!rendered.content.includes('{8}'), 'must NEVER embed unquoted {8} regex quantifier inside Nginx map');
  assert.ok(rendered.content.includes(`  "alpha.example.test" "${SITE_A}";`));
  assert.ok(rendered.content.includes(`  "api.alpha.example.test" "${SITE_A}";`));
  assert.ok(rendered.content.includes(`  "beta.example.test" "${SITE_B}";`));
  assert.ok(rendered.content.includes(`  "www.alpha.example.test" "${SITE_A}";`));
  assert.ok(rendered.content.includes(`  "www.beta.example.test" "${SITE_B}";`));
  for (const excluded of ['draft.example.test', 'staged.example.test', 'suspended.example.test', 'removed.example.test', 'unapplied.example.test', 'unbound.example.test']) {
    assert.ok(!rendered.content.includes(excluded), `non-active/unbound domain ${excluded} must be excluded`);
  }
  assert.ok(rendered.content.includes('map $yunpanel_traffic_site_id $yunpanel_traffic_log_enabled {\n  default 1;\n  "" 0;\n}'));
  assert.ok(rendered.content.includes(`map $yunpanel_traffic_site_id $yunpanel_traffic_blocked {\n  default 0;\n  "${SITE_B}" 1;\n}`));

  // requireApplied: true also excludes minimal domain entries lacking explicit state: 'active'
  const strict = renderNginxTrafficAccountingConfig({
    domains: [
      { primaryDomain: 'no-state.example.test', websiteId: SITE_A },
      { primaryDomain: 'active.example.test', websiteId: SITE_B, state: 'active' },
    ],
    requireApplied: true,
  });
  assert.equal(strict.trackedHostCount, 1);
  assert.ok(!strict.content.includes('no-state.example.test'));
  assert.ok(strict.content.includes(`"active.example.test" "${SITE_B}";`));
});

test('renderNginxTrafficAccountingConfig: rejects unsafe paths, invalid UUIDs, invalid hostnames, and conflicting duplicate hosts', () => {
  assert.throws(
    () => renderNginxTrafficAccountingConfig({ trafficLogPath: '/var/log/nginx/a.log; evil' }),
    (err) => err instanceof NginxTrafficTemplateError && err.code === 'invalid_path',
  );
  assert.throws(
    () => renderNginxTrafficAccountingConfig({ trafficLogPath: '/var/log/../etc/passwd' }),
    (err) => err instanceof NginxTrafficTemplateError && err.code === 'invalid_path',
  );
  assert.throws(
    () => renderNginxTrafficAccountingConfig({ trafficLogPath: '/' }),
    (err) => err instanceof NginxTrafficTemplateError && err.code === 'invalid_path',
  );
  assert.throws(
    () => renderNginxTrafficAccountingConfig({ domains: [{ primaryDomain: 'a.test', websiteId: 'not-a-uuid', state: 'active' }] }),
    (err) => err instanceof NginxTrafficTemplateError && err.code === 'invalid_website_id',
  );
  assert.throws(
    () => renderNginxTrafficAccountingConfig({ blockedWebsiteIds: ['not-a-uuid'] }),
    (err) => err instanceof NginxTrafficTemplateError && err.code === 'invalid_blocked_website_id',
  );
  assert.throws(
    () => renderNginxTrafficAccountingConfig({
      domains: [
        { primaryDomain: 'dup.example.test', websiteId: SITE_A, state: 'active' },
        { primaryDomain: 'dup.example.test', websiteId: SITE_B, state: 'active' },
      ],
    }),
    (err) => err instanceof NginxTrafficTemplateError && err.code === 'duplicate_traffic_hostname',
  );
});

test('nginx templates: defaults unchanged; trafficLogPath meters all server blocks & static assets; enableTrafficLimitGuard pins baked trafficWebsiteId with ACME exemption', () => {
  const staticDefault = renderStaticSiteConfig({
    primaryDomain: 'alpha.example.test',
    aliases: ['www.alpha.example.test'],
    root: '/var/www/yunpanel/apps/11111111-1111-4111-8111-111111111111/current',
    tls: TLS,
    canonicalRedirect: true,
    acmeOnlyHostnames: ['mail.alpha.example.test'],
  });
  assert.ok(!staticDefault.includes('yunpanel_site_traffic'));
  assert.ok(!staticDefault.includes('$yunpanel_traffic_blocked'));
  assert.ok(staticDefault.includes('    access_log off;'));

  const staticMetered = renderStaticSiteConfig({
    primaryDomain: 'alpha.example.test',
    aliases: ['www.alpha.example.test'],
    root: '/var/www/yunpanel/apps/11111111-1111-4111-8111-111111111111/current',
    tls: TLS,
    canonicalRedirect: true,
    acmeOnlyHostnames: ['mail.alpha.example.test'],
    trafficLogPath: YUNPANEL_TRAFFIC_LOG_PATH,
    enableTrafficLimitGuard: true,
    trafficWebsiteId: SITE_A,
  });

  const trafficLogDirective = `access_log ${YUNPANEL_TRAFFIC_LOG_PATH} ${YUNPANEL_TRAFFIC_LOG_FORMAT} if=$yunpanel_traffic_log_enabled;`;
  const trafficMatches = staticMetered.split(trafficLogDirective).length - 1;
  assert.equal(trafficMatches, 6, `expected 5 server-level + 1 static-asset traffic log directives, got ${trafficMatches}`);
  assert.ok(!staticMetered.includes('    access_log off;'), 'static asset location must switch from access_log off to traffic log');

  // 429 guard pins baked canonical Website ID on the 4 main/alias blocks, NOT on ACME-only block
  const pinnedGuard = `  set $yp_block_traffic 0;\n  if ($yunpanel_traffic_site_id = "${SITE_A}") {\n    set $yp_block_traffic $yunpanel_traffic_blocked;\n  }`;
  assert.equal(staticMetered.split(pinnedGuard).length - 1, 4);
  assert.equal(staticMetered.split('return 429;').length - 1, 4);
  assert.ok(staticMetered.includes('if ($uri ~ "^/\\.well-known/acme-challenge/") {\n    set $yp_block_traffic 0;\n  }'));
  const acmeOnlyBlock = staticMetered.slice(staticMetered.indexOf('server_name mail.alpha.example.test;'));
  assert.ok(!acmeOnlyBlock.includes('return 429;'), 'ACME challenge-only block must not include traffic limit guard');

  // PHP static asset cache block switches access_log off -> trafficLogPath while hidden dotfiles deny stays access_log off
  const phpMetered = renderPhpSiteConfig({
    primaryDomain: 'php.example.test',
    root: '/var/lib/yunpanel/apps/11111111-1111-4111-8111-111111111111/current/public',
    socketPath: '/run/php/yunpanel-yunapp-123456789abc.sock',
    nginxSettings: { staticAssetCacheSeconds: 604800 },
    trafficLogPath: YUNPANEL_TRAFFIC_LOG_PATH,
    enableTrafficLimitGuard: true,
    trafficWebsiteId: SITE_A,
  });
  assert.ok(phpMetered.includes(`    ${trafficLogDirective}`));
  assert.ok(phpMetered.includes(pinnedGuard));
  assert.ok(phpMetered.includes('location ~ /\\.(?!well-known/) {\n    deny all;\n    access_log off;'));

  // Proxy, Passenger, Python, Redirect all accept trafficLogPath + enableTrafficLimitGuard + trafficWebsiteId
  const proxyMetered = renderProxySiteConfig({
    primaryDomain: 'proxy.example.test',
    upstreamPort: 3000,
    trafficLogPath: YUNPANEL_TRAFFIC_LOG_PATH,
    enableTrafficLimitGuard: true,
    trafficWebsiteId: SITE_A,
  });
  assert.ok(proxyMetered.includes(trafficLogDirective));
  assert.ok(proxyMetered.includes(pinnedGuard));

  const passengerMetered = renderPassengerSiteConfig({
    primaryDomain: 'node.example.test',
    target: {
      appRoot: '/var/lib/yunpanel/apps/11111111-1111-4111-8111-111111111111/current',
      documentRoot: '/var/lib/yunpanel/apps/11111111-1111-4111-8111-111111111111/current/public',
      startupFile: 'server.js',
      nodeBinary: '/usr/bin/node',
      user: 'yunapp-123456789abc',
      group: 'yunapp-123456789abc',
      appEnv: 'production',
    },
    trafficLogPath: YUNPANEL_TRAFFIC_LOG_PATH,
    enableTrafficLimitGuard: true,
    trafficWebsiteId: SITE_A,
  });
  assert.ok(passengerMetered.includes(trafficLogDirective));
  assert.ok(passengerMetered.includes(pinnedGuard));

  const pythonMetered = renderPythonSiteConfig({
    primaryDomain: 'py.example.test',
    upstreamPort: 8000,
    trafficLogPath: YUNPANEL_TRAFFIC_LOG_PATH,
    enableTrafficLimitGuard: true,
    trafficWebsiteId: SITE_A,
  });
  assert.ok(pythonMetered.includes(trafficLogDirective));
  assert.ok(pythonMetered.includes(pinnedGuard));

  const redirectMetered = renderRedirectSiteConfig({
    primaryDomain: 'redir.example.test',
    target: { url: 'https://target.example.test', status: 301, preservePath: true },
    trafficLogPath: YUNPANEL_TRAFFIC_LOG_PATH,
    enableTrafficLimitGuard: true,
    trafficWebsiteId: SITE_A,
  });
  assert.ok(redirectMetered.includes(trafficLogDirective));
  assert.ok(redirectMetered.includes(pinnedGuard));

  // Reject invalid trafficLogPath & invalid trafficWebsiteId
  assert.throws(
    () => renderProxySiteConfig({ primaryDomain: 'bad.example.test', upstreamPort: 3000, trafficLogPath: '/var/log/a.log; bad' }),
    (err) => err instanceof NginxTemplateError && err.code === 'invalid_path',
  );
  assert.throws(
    () => renderProxySiteConfig({ primaryDomain: 'bad.example.test', upstreamPort: 3000, enableTrafficLimitGuard: true, trafficWebsiteId: 'bad-id' }),
    (err) => err instanceof NginxTemplateError && err.code === 'invalid_traffic_website_id',
  );
});
