import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostingForm, editHostingForm, reloadHostingForm } from '../src/workspace/domain-hosting-form.js';
import { hostingSettingsChanges } from '../src/workspace/domain-hosting-model.js';

const record = (targetType, overrides = {}) => ({ id: 'domain-a', websiteId: 'website-a', serverId: 'local-a', parentDomainId: null,
  primaryDomain: 'example.com', aliases: [], desiredRevision: 3, appliedRevision: 3, targetType,
  target: targetType === 'proxy' ? { host: '127.0.0.1', port: 3000, websocket: true } : { root: '/srv/website-a/public' },
  nginxSettings: targetType === 'proxy'
    ? { clientMaxBodySizeMb: null, proxyTimeoutSeconds: null, websocket: true, headers: [] }
    : { clientMaxBodySizeMb: null, spaFallback: false, staticAssetCacheSeconds: 604800, headers: [] },
  httpsMode: 'managed', httpsRedirect: false, canonicalRedirect: false, certificateId: 'cert-a', state: 'active', ...overrides });
const rules = [{ source: '/eski', target: 'https://example.com/yeni', status: 301, match: 'exact' }];

for (const targetType of ['static', 'proxy']) {
  test(`${targetType}: a redirect draft survives a reload of a newer record and submits as a canonical change`, () => {
    const clean = createHostingForm(record(targetType));
    const form = editHostingForm(clean, 'nginxSettings', { ...clean.values.nginxSettings, redirectRules: rules });
    const incoming = record(targetType, { desiredRevision: 4, nginxSettings: { ...record(targetType).nginxSettings, clientMaxBodySizeMb: 20 } });
    const next = reloadHostingForm(form, incoming, form.base);
    assert.deepEqual(next.values.nginxSettings.redirectRules, rules);
    assert.equal(next.values.nginxSettings.clientMaxBodySizeMb, 20);
    assert.deepEqual(hostingSettingsChanges(next.base, next.values).nginxSettings.redirectRules, rules);
  });
}

test('an unsafe redirect draft is refused before review', () => {
  const clean = createHostingForm(record('static'));
  const form = editHostingForm(clean, 'nginxSettings', { ...clean.values.nginxSettings,
    redirectRules: [{ source: '/x;', target: '/y', status: 301, match: 'exact' }] });
  assert.throws(() => hostingSettingsChanges(form.base, form.values), { code: 'hosting_draft_invalid' });
});
