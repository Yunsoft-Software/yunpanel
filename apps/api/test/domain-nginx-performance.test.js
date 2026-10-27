import test from 'node:test';
import assert from 'node:assert/strict';
import { domainNginxSettingsForTarget } from '../src/domain-nginx-settings.js';

test('PHP and Passenger projections keep gzip, and PHP keeps its static browser cache', () => {
  const domain = { nginxSettings: { clientMaxBodySizeMb: null, headers: [], gzip: true, staticAssetCacheSeconds: 86_400 } };
  assert.equal(domainNginxSettingsForTarget(domain, 'passenger').gzip, true);
  assert.equal(Object.hasOwn(domainNginxSettingsForTarget(domain, 'passenger'), 'staticAssetCacheSeconds'), false);
  const php = domainNginxSettingsForTarget(domain, 'php');
  assert.equal(php.gzip, true);
  assert.equal(php.staticAssetCacheSeconds, 86_400);
  const legacy = domainNginxSettingsForTarget({ nginxSettings: { clientMaxBodySizeMb: null, headers: [] } }, 'php');
  assert.deepEqual(legacy, { clientMaxBodySizeMb: null, headers: [] });
});
