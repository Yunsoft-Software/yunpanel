import test from 'node:test';
import assert from 'node:assert/strict';
import { domainNginxSettingsForTarget } from '../src/domain-nginx-settings.js';
import { createOperationEnvelope, OPERATIONS } from '@yunpanel/protocol';
import { createNginxManager } from '@yunpanel/host-runtime';
import { createDomainRegistry } from '../src/domain-registry.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('PHP Website target projection retains file settings through the real protocol and Nginx renderer', () => {
  const domain = { nginxSettings: { clientMaxBodySizeMb: 16, spaFallback: false,
    indexFiles: ['home.html', 'index.html'], errorPages: { 404: '/errors/404.html' }, headers: [] } };
  const settings = domainNginxSettingsForTarget(domain, 'php');
  assert.equal(Object.hasOwn(settings, 'spaFallback'), false);
  assert.deepEqual(settings.indexFiles, domain.nginxSettings.indexFiles);
  const envelope = createOperationEnvelope({ id: 'valid-job-php-1', operation: OPERATIONS.DOMAIN_STAGE,
    payload: { primaryDomain: 'owned.example.com', aliases: [], targetType: 'php',
      target: { root: '/var/lib/yunpanel/apps/owned/current', socketPath: '/run/php/yunpanel-yunapp-123456abcdef.sock' },
      nginxSettings: settings, httpsRedirect: false, canonicalRedirect: false, domainRevision: 2 } });
  const preview = createNginxManager().previewDomain(envelope.payload);
  assert.match(preview.config, /index home\.html index\.html;/);
  assert.match(preview.config, /error_page 404 \/errors\/404\.html;/);
  assert.match(preview.config, /fastcgi_intercept_errors on;/);
});

test('legacy PHP/Passenger snapshots retain their shape and Passenger cannot acquire static file directives', () => {
  const domain = { nginxSettings: { clientMaxBodySizeMb: 16, headers: [], indexFiles: ['home.html'], errorPages: { 404: '/error.html' } } };
  assert.deepEqual(domainNginxSettingsForTarget(domain, 'passenger'), { clientMaxBodySizeMb: 16, headers: [] });
  assert.deepEqual(domainNginxSettingsForTarget({ nginxSettings: { clientMaxBodySizeMb: 16, headers: [] } }, 'php'), { clientMaxBodySizeMb: 16, headers: [] });
});

test('persisted file settings survive a cold registry reload without exposing mutable stored arrays or maps', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yp-file-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { filePath: path.join(directory, 'domains.json'), serverExists: async () => true };
  const registry = createDomainRegistry(options);
  const created = await registry.createDomain({ serverId: 'local', primaryDomain: 'owned.example.com', targetType: 'static',
    target: { root: '/var/lib/yunpanel/apps/owned/current', spaFallback: false },
    nginxSettings: { indexFiles: ['home.html'], errorPages: { 404: '/errors/404.html' } } });
  const cold = createDomainRegistry(options), loaded = await cold.getDomain(created.id);
  loaded.nginxSettings.indexFiles.push('other.html'); loaded.nginxSettings.errorPages[404] = '/changed.html';
  const fresh = await cold.getDomain(created.id);
  assert.deepEqual(fresh.nginxSettings.indexFiles, ['home.html']);
  assert.deepEqual(fresh.nginxSettings.errorPages, { 404: '/errors/404.html' });
  const changes = { nginxSettings: { indexFiles: null, errorPages: null } };
  const preview = await cold.previewDomainUpdate({ domainId: created.id, changes });
  const saved = await cold.updateDomain({ domainId: created.id, changes, previewDigest: preview.previewDigest });
  assert.equal(saved.domain.nginxSettings.indexFiles, null);
  assert.equal(saved.domain.nginxSettings.errorPages, null);
  assert.equal(createNginxManager().previewDomain({ primaryDomain: fresh.primaryDomain, aliases: [], targetType: 'static',
    target: fresh.target, nginxSettings: saved.domain.nginxSettings }).config,
  createNginxManager().previewDomain({ primaryDomain: fresh.primaryDomain, aliases: [], targetType: 'static',
    target: fresh.target, nginxSettings: { spaFallback: false } }).config);
});
