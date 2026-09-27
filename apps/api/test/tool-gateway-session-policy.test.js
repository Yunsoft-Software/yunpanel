import test from 'node:test';
import assert from 'node:assert/strict';
import { requireToolGatewaySession } from '../src/tool-gateway-session-policy.js';

const manager = { user: { role: 'site_manager', websiteIds: ['site-a'] } };
const gateway = { id: 'phpmyadmin', accessPath: '/api/phpmyadmin-gateway-access' };
const policy = {
  requireSiteManagement(session) {
    if (session?.user?.role !== 'site_manager') throw new Error('site_management_required');
    return { ...session, access: { mode: 'site_management' }, security: { managementAllowed: true } };
  },
  requireManagement(session) {
    if (session?.user?.role !== 'owner' || session.mfaReady !== true) {
      throw new Error('owner_or_mfa_required');
    }
    return session;
  },
};

test('site manager may reach phpMyAdmin only through the session-authorized gateway path', () => {
  const authorized = requireToolGatewaySession(policy, manager, gateway);
  assert.equal(authorized.user.role, 'site_manager');
  assert.equal(authorized.access.mode, 'site_management');
});

test('other integrated tools retain Owner authorization', () => {
  for (const id of ['ttyd', 'elfinder', 'netdata', 'goaccess', 'unknown']) {
    assert.throws(
      () => requireToolGatewaySession(policy, manager, {
        id,
        accessPath: `/api/${id}-gateway-access`,
      }),
      /owner_or_mfa/,
    );
  }
  assert.throws(
    () => requireToolGatewaySession(policy, manager, {
      ...gateway,
      accessPath: '/api/netdata-gateway-access',
    }),
    /owner_or_mfa/,
  );
});

test('phpMyAdmin policy still rejects non-management roles and preserves Owner MFA', () => {
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
});

test('site-management authorization failures cannot fall through to Owner or gateway access', () => {
  const blocked = {
    ...policy,
    requireSiteManagement: () => { throw new Error('site permission expired'); },
  };
  assert.throws(
    () => requireToolGatewaySession(blocked, manager, gateway),
    /site permission expired/,
  );
});
