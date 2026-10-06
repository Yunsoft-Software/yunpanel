import test from 'node:test';
import assert from 'node:assert/strict';
import { requireToolGatewaySession } from '../src/tool-gateway-session-policy.js';

const manager = { user: { role: 'site_manager', websiteIds: ['site-a'] } };
const phpMyAdminGateway = { id: 'phpmyadmin', accessPath: '/api/phpmyadmin-gateway-access' };
const pgAdminGateway = { id: 'pgadmin', accessPath: '/api/pgadmin-gateway-access' };
const elFinderGateway = { id: 'elfinder', accessPath: '/api/elfinder-gateway-access' };
const policy = {
  requireSiteManagement(session) {
    if (!['site_manager', 'reseller', 'customer'].includes(session?.user?.role)) throw new Error('site_management_required');
    return { ...session, access: { mode: 'site_management' }, security: { managementAllowed: true } };
  },
  requireManagement(session) {
    if (session?.user?.role !== 'owner' || session.mfaReady !== true) {
      throw new Error('owner_or_mfa_required');
    }
    return session;
  },
};

test('site manager, reseller, and customer may reach Website-scoped vendor session authorizers only on exact paths', () => {
  const reseller = { user: { role: 'reseller', websiteIds: ['site-a'] } };
  const customer = { user: { role: 'customer', websiteIds: ['site-a'] } };
  for (const session of [manager, reseller, customer]) {
    for (const gateway of [phpMyAdminGateway, pgAdminGateway, elFinderGateway]) {
      const authorized = requireToolGatewaySession(policy, session, gateway);
      assert.equal(authorized.user.role, session.user.role);
      assert.equal(authorized.access.mode, 'site_management');
    }
  }
});

test('other integrated tools and path mismatches retain Owner authorization', () => {
  for (const id of ['ttyd', 'netdata', 'goaccess', 'unknown']) {
    assert.throws(
      () => requireToolGatewaySession(policy, manager, {
        id,
        accessPath: `/api/${id}-gateway-access`,
      }),
      /owner_or_mfa/,
    );
  }
  for (const gateway of [phpMyAdminGateway, pgAdminGateway, elFinderGateway]) {
    assert.throws(
      () => requireToolGatewaySession(policy, manager, {
        ...gateway,
        accessPath: '/api/netdata-gateway-access',
      }),
      /owner_or_mfa/,
    );
  }
});

test('Website-scoped gateway policy still rejects non-management roles and preserves Owner MFA', () => {
  for (const gateway of [phpMyAdminGateway, pgAdminGateway, elFinderGateway]) {
    assert.throws(
      () => requireToolGatewaySession(policy, { user: { role: 'read_only' } }, gateway),
      /owner_or_mfa/,
    );
    assert.throws(() => requireToolGatewaySession(policy, null, gateway), /owner_or_mfa/);
    assert.throws(
      () => requireToolGatewaySession(policy, { user: { role: 'owner' }, mfaReady: false }, gateway),
      /owner_or_mfa/,
    );
    assert.equal(
      requireToolGatewaySession(policy, { user: { role: 'owner' }, mfaReady: true }, gateway).mfaReady,
      true,
    );
  }
});

test('site-management authorization failures cannot fall through to Owner or gateway access', () => {
  const blocked = {
    ...policy,
    requireSiteManagement: () => { throw new Error('site permission expired'); },
  };
  for (const gateway of [phpMyAdminGateway, pgAdminGateway, elFinderGateway]) {
    assert.throws(
      () => requireToolGatewaySession(blocked, manager, gateway),
      /site permission expired/,
    );
  }
});
