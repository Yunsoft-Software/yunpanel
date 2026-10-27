import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperationEnvelope, OPERATIONS } from '@yunpanel/protocol';
import { renderPhpSiteConfig } from '@yunpanel/config-templates';
import { domainNginxSettingsForTarget } from '../src/domain-nginx-settings.js';

const redirectRules = [
  { source: '/eski', target: 'https://yeni.example.com/', status: 301, match: 'exact' },
  { source: '/blog/', target: '/haberler/', status: 302, match: 'prefix' },
];

test('PHP and Passenger projections keep stored redirect rules instead of silently dropping them', () => {
  const domain = { nginxSettings: { clientMaxBodySizeMb: null, headers: [], redirectRules } };
  for (const targetType of ['php', 'passenger']) {
    assert.deepEqual(domainNginxSettingsForTarget(domain, targetType).redirectRules, redirectRules);
  }
  assert.equal(Object.hasOwn(domainNginxSettingsForTarget({ nginxSettings: { clientMaxBodySizeMb: null, headers: [] } }, 'php'), 'redirectRules'), false);
});

test('a domain stage job carries redirect rules through protocol validation into the rendered PHP site', () => {
  const settings = domainNginxSettingsForTarget({ nginxSettings: { clientMaxBodySizeMb: null, headers: [], redirectRules } }, 'php');
  const target = { root: '/var/lib/yunpanel/apps/owned/current', socketPath: '/run/php/yunpanel-yunapp-123456abcdef.sock' };
  const envelope = createOperationEnvelope({ id: 'valid-job-php-redirect-1', operation: OPERATIONS.DOMAIN_STAGE,
    payload: { primaryDomain: 'owned.example.com', aliases: [], targetType: 'php', target,
      nginxSettings: settings, httpsRedirect: false, canonicalRedirect: false, domainRevision: 2 } });
  const config = renderPhpSiteConfig({ primaryDomain: 'owned.example.com', ...target, httpsRedirect: false,
    canonicalRedirect: false, nginxSettings: envelope.payload.nginxSettings });
  assert.match(config, /location = \/eski \{\n    return 301 https:\/\/yeni\.example\.com\/\$is_args\$args;/);
  assert.match(config, /rewrite \^\/blog\/\(\.\*\)\$ \/haberler\/\$1 redirect;/);
});
