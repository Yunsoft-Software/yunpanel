import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLicenseSettingsPath,
  describeLicenseReturnTarget,
  formatLicenseError,
  hasLicenseCapability,
  isLicenseLoaded,
  isPremiumRequired,
  sanitizeLicenseReturnTo,
} from '../src/workspace/license-client.js';
import { navigationItemRequiredCapability } from '../src/workspace/ui/ux-model.js';

const FREE_READY = Object.freeze({
  status: 'ready',
  data: {
    valid: false,
    tier: 'free',
    status: 'free',
    capabilities: {
      singlePanelUserUnlimitedSites: true,
      resellerAccounts: false,
      perSiteIsolatedUsers: false,
      aiOperations: false,
    },
  },
  error: null,
});

const PREMIUM_READY = Object.freeze({
  status: 'ready',
  data: {
    valid: true,
    tier: 'premium',
    status: 'active',
    capabilities: {
      singlePanelUserUnlimitedSites: true,
      resellerAccounts: true,
      perSiteIsolatedUsers: true,
      aiOperations: true,
    },
  },
  error: null,
});

test('isLicenseLoaded, hasLicenseCapability and isPremiumRequired distinguish loading/error/stale from loaded Free and Premium states', () => {
  for (const unknownState of [
    null,
    undefined,
    { status: 'loading', data: null, error: null },
    { status: 'error', data: null, error: new Error('network') },
    { status: 'stale', data: FREE_READY.data, error: new Error('stale') },
    { status: 'ready', data: null, error: null },
    { status: 'ready', data: {}, error: null },
  ]) {
    assert.equal(isLicenseLoaded(unknownState), false);
    assert.equal(hasLicenseCapability(unknownState, 'resellerAccounts'), null);
    assert.equal(isPremiumRequired(unknownState, 'resellerAccounts'), false);
    assert.equal(isPremiumRequired(unknownState, 'perSiteIsolatedUsers'), false);
  }

  assert.equal(isLicenseLoaded(FREE_READY), true);
  assert.equal(hasLicenseCapability(FREE_READY, 'singlePanelUserUnlimitedSites'), true);
  assert.equal(hasLicenseCapability(FREE_READY, 'resellerAccounts'), false);
  assert.equal(hasLicenseCapability(FREE_READY, 'perSiteIsolatedUsers'), false);
  assert.equal(isPremiumRequired(FREE_READY, 'singlePanelUserUnlimitedSites'), false);
  assert.equal(isPremiumRequired(FREE_READY, 'resellerAccounts'), true);
  assert.equal(isPremiumRequired(FREE_READY, 'perSiteIsolatedUsers'), true);

  assert.equal(isLicenseLoaded(PREMIUM_READY), true);
  assert.equal(hasLicenseCapability(PREMIUM_READY, 'resellerAccounts'), true);
  assert.equal(hasLicenseCapability(PREMIUM_READY, 'perSiteIsolatedUsers'), true);
  assert.equal(isPremiumRequired(PREMIUM_READY, 'resellerAccounts'), false);
  assert.equal(isPremiumRequired(PREMIUM_READY, 'perSiteIsolatedUsers'), false);
  assert.equal(hasLicenseCapability(PREMIUM_READY, ''), null);
});

test('sanitizeLicenseReturnTo accepts only allowlisted internal routes and non-secret query parameters', () => {
  assert.equal(sanitizeLicenseReturnTo('/resellers'), '/resellers');
  assert.equal(sanitizeLicenseReturnTo('/resellers?action=create'), '/resellers?action=create');
  assert.equal(sanitizeLicenseReturnTo('/customers'), '/customers');
  assert.equal(sanitizeLicenseReturnTo('/customers?action=create'), '/customers?action=create');
  assert.equal(sanitizeLicenseReturnTo('/users'), '/users');
  assert.equal(sanitizeLicenseReturnTo('/users?action=create'), '/users?action=create');
  assert.equal(sanitizeLicenseReturnTo('/settings/users'), '/settings/users');
  assert.equal(sanitizeLicenseReturnTo('/websites/new'), '/websites/new');
  assert.equal(sanitizeLicenseReturnTo('/websites/new?customer=cust_123-abc'), '/websites/new?customer=cust_123-abc');
  assert.equal(sanitizeLicenseReturnTo('/websites/new?parent=dom-1&mode=subdomain'), '/websites/new?parent=dom-1&mode=subdomain');
  assert.equal(sanitizeLicenseReturnTo('/websites'), '/websites');
  assert.equal(sanitizeLicenseReturnTo('/settings'), '/settings');
  assert.equal(sanitizeLicenseReturnTo('/settings?section=dns'), '/settings?section=dns');

  for (const rejected of [
    null,
    undefined,
    '',
    'resellers',
    '//evil.example.com/resellers',
    '///evil.example.com',
    'https://evil.example.com/resellers',
    'http://127.0.0.1/resellers',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '/resellers\\@evil.example',
    '/resellers\r\nLocation: https://evil.example',
    '/resellers#fragment',
    '/resellers/../settings',
    '/admin',
    '/api/panel/license',
    '/resellers?action=delete',
    '/websites/new?action=create',
    '/settings?section=license',
    '/resellers?password=secret',
    '/resellers?pass=secret',
    '/resellers?secret=1',
    '/resellers?token=abc',
    '/resellers?key=abc',
    '/resellers?username=owner',
    '/customers?user=alice',
    '/customers?email=a@b.test',
    '/customers?action=create&password=leak',
    '/websites/new?customer=../escape',
    '/resellers?action=create&action=create',
    '/resellers?unknown=1',
  ]) {
    assert.equal(sanitizeLicenseReturnTo(rejected), null, `Expected rejection for ${String(rejected)}`);
  }
});

test('buildLicenseSettingsPath and describeLicenseReturnTarget encode safe paths and drop unsafe parameters', () => {
  const resellerPath = buildLicenseSettingsPath({ returnTo: '/resellers?action=create', feature: 'reseller' });
  assert.equal(resellerPath, '/settings?section=license&returnTo=%2Fresellers%3Faction%3Dcreate&feature=reseller');

  const safeOnly = buildLicenseSettingsPath({ returnTo: '//evil.example/steal', feature: 'unknown_feature' });
  assert.equal(safeOnly, '/settings?section=license');

  const polluted = buildLicenseSettingsPath({ returnTo: '/customers?action=create&password=leaked', feature: 'customer' });
  assert.equal(polluted, '/settings?section=license&feature=customer');
  assert.equal(polluted.includes('password'), false);
  assert.equal(polluted.includes('leaked'), false);

  assert.equal(describeLicenseReturnTarget('/resellers?action=create', 'reseller')?.buttonLabel, 'Bayi eklemeye dön');
  assert.equal(describeLicenseReturnTarget('/customers?action=create', 'customer')?.buttonLabel, 'Müşteri eklemeye dön');
  assert.equal(describeLicenseReturnTarget('/users', 'site_user')?.buttonLabel, 'Kullanıcılara dön');
  assert.equal(describeLicenseReturnTarget('/websites/new', 'site_owner')?.buttonLabel, 'Yeni site oluşturmaya dön');
  assert.equal(describeLicenseReturnTarget('/websites')?.buttonLabel, 'Önceki işe dön');
  assert.equal(describeLicenseReturnTarget('https://evil.example'), null);

  assert.match(formatLicenseError({ code: 'premium_license_required' }), /YunPanel Premium/);
});

test('navigationItemRequiredCapability marks only Owner reseller/customer routes and preserves Free Owner tools', () => {
  assert.equal(navigationItemRequiredCapability('/customers', true), 'perSiteIsolatedUsers');
  assert.equal(navigationItemRequiredCapability('/resellers', true), 'resellerAccounts');
  assert.equal(navigationItemRequiredCapability('/customers', false), null);
  assert.equal(navigationItemRequiredCapability('/resellers', false), null);
  for (const freeRoute of ['/websites', '/mail', '/files', '/databases', '/statistics', '/tools-settings']) {
    assert.equal(navigationItemRequiredCapability(freeRoute, true), null);
  }
});
