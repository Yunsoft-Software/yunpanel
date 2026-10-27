import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostingForm, editHostingForm, reloadHostingForm } from '../src/workspace/domain-hosting-form.js';
import { hostingSettingsChanges } from '../src/workspace/domain-hosting-model.js';

const record = (targetType, overrides = {}) => ({ id: 'domain-a', websiteId: 'website-a', serverId: 'local-a', parentDomainId: null,
  primaryDomain: 'example.com', aliases: [], desiredRevision: 3, appliedRevision: 3, targetType,
  target: targetType === 'proxy' ? { host: '127.0.0.1', port: 3000, websocket: true }
    : { root: '/srv/website-a/public', socketPath: '/run/php/yunpanel-yunapp-123456abcdef.sock' },
  nginxSettings: targetType === 'proxy'
    ? { clientMaxBodySizeMb: null, proxyTimeoutSeconds: null, websocket: true, headers: [] }
    : { clientMaxBodySizeMb: null, headers: [] },
  httpsMode: 'managed', httpsRedirect: false, canonicalRedirect: false, certificateId: 'cert-a', state: 'active', ...overrides });

for (const [targetType, draft] of [['proxy', { gzip: true }], ['php', { gzip: true, staticAssetCacheSeconds: 86_400 }]]) {
  test(`${targetType}: performance draft survives a reload of a newer record and submits canonically`, () => {
    const clean = createHostingForm(record(targetType));
    const form = editHostingForm(clean, 'nginxSettings', { ...clean.values.nginxSettings, ...draft });
    const incoming = record(targetType, { desiredRevision: 4, nginxSettings: { ...record(targetType).nginxSettings, clientMaxBodySizeMb: 20 } });
    const next = reloadHostingForm(form, incoming, form.base);
    for (const [key, value] of Object.entries(draft)) assert.equal(next.values.nginxSettings[key], value);
    assert.equal(next.values.nginxSettings.clientMaxBodySizeMb, 20);
    const changes = hostingSettingsChanges(next.base, next.values).nginxSettings;
    for (const [key, value] of Object.entries(draft)) assert.equal(changes[key], value);
  });
}

test('a protected directory draft survives a reload of a newer record', () => {
  const clean = createHostingForm(record('proxy'));
  const form = editHostingForm(clean, 'nginxSettings', { ...clean.values.nginxSettings, protectedPaths: [{ path: '/admin/', key: '0123456789abcdef' }] });
  const next = reloadHostingForm(form, record('proxy', { desiredRevision: 4 }), form.base);
  assert.deepEqual(next.values.nginxSettings.protectedPaths, [{ path: '/admin/', key: '0123456789abcdef' }]);
});
