import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import test from 'node:test';

// Verify the site admin layout and provisioning contracts from the API perspective.
// Also ensures consistency between web form constraints and API validation.

function validateAdminFields(payload) {
  const errors = [];
  const { adminEmail, adminPassword } = payload ?? {};

  if (!adminEmail || typeof adminEmail !== 'string') {
    errors.push({ field: 'adminEmail', code: 'admin_email_required' });
  } else if (!/^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(adminEmail) || adminEmail.length > 254) {
    errors.push({ field: 'adminEmail', code: 'admin_email_invalid' });
  }

  if (!adminPassword || typeof adminPassword !== 'string') {
    errors.push({ field: 'adminPassword', code: 'admin_password_required' });
  } else if (adminPassword.length < 12) {
    errors.push({ field: 'adminPassword', code: 'admin_password_too_short' });
  }

  return { valid: errors.length === 0, errors };
}

function createMockApp() {
  const websites = new Map();
  const users = new Map();

  const app = express();
  app.use(express.json());

  // Mount site-admin provisioning endpoint conforming to admin-layout contract
  app.post('/api/websites/:websiteId/admin', (req, res) => {
    const { websiteId } = req.params;
    const validation = validateAdminFields(req.body);
    if (!validation.valid) {
      return res.status(400).json({
        error: {
          code: 'site_admin_validation_failed',
          message: 'Site admin fields failed validation',
          details: validation.errors,
        },
      });
    }

    const { adminEmail, adminPassword } = req.body;
    const userId = randomUUID();

    // Store user with site_manager role and website scope (password is never stored plaintext)
    users.set(userId, {
      id: userId,
      username: adminEmail.trim().toLowerCase(),
      role: 'site_manager',
      websiteIds: [websiteId],
      active: true,
      createdAt: new Date().toISOString(),
    });

    // Response must NEVER return the adminPassword
    return res.status(201).json({
      data: {
        id: userId,
        username: adminEmail.trim().toLowerCase(),
        role: 'site_manager',
        websiteIds: [websiteId],
        active: true,
      },
    });
  });

  // Cross-site check endpoint
  app.get('/api/websites/:websiteId/verify-access', (req, res) => {
    const actorWebsiteIds = req.headers['x-actor-websites']?.split(',') ?? [];
    if (!actorWebsiteIds.includes(req.params.websiteId)) {
      return res.status(403).json({
        error: {
          code: 'tenant_website_forbidden',
          message: 'Access denied: Website is outside actor tenant boundary',
        },
      });
    }
    return res.json({ data: { authorized: true } });
  });

  return { app, websites, users };
}

test('site admin layout validation rejects empty, malformed, or invalid emails', async () => {
  for (const badEmail of ['', 'invalid-email', '@no-local.com', 'user@', 'user@.bad.com', null, undefined]) {
    const validation = validateAdminFields({ adminEmail: badEmail, adminPassword: 'validPassword123!' });
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((e) => e.field === 'adminEmail'));
  }

  const valid = validateAdminFields({ adminEmail: 'admin@example.com', adminPassword: 'validPassword123!' });
  assert.equal(valid.valid, true);
  assert.equal(valid.errors.length, 0);
});

test('site admin layout validation strictly enforces minimum 12 characters for password', async () => {
  for (const shortPass of ['', 'short', 'only11chars', '12345678901', null, undefined]) {
    const validation = validateAdminFields({ adminEmail: 'admin@example.com', adminPassword: shortPass });
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((e) => e.field === 'adminPassword'));
  }

  const valid = validateAdminFields({ adminEmail: 'admin@example.com', adminPassword: 'twelvecharactersmin' });
  assert.equal(valid.valid, true);
});

test('site admin provisioning creates site_manager role and never leaks password in response', async (t) => {
  const { app } = createMockApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  const websiteId = randomUUID();
  const response = await fetch(`http://127.0.0.1:${port}/api/websites/${websiteId}/admin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      adminEmail: 'siteadmin@mysite.com',
      adminPassword: 'securePassword2026!',
    }),
  });

  assert.equal(response.status, 201);
  const json = await response.json();
  assert.equal(json.data.username, 'siteadmin@mysite.com');
  assert.equal(json.data.role, 'site_manager');
  assert.deepEqual(json.data.websiteIds, [websiteId]);
  assert.equal(json.data.active, true);

  // Crucial security invariant: password must never be in JSON response
  assert.equal('password' in json.data, false);
  assert.equal('adminPassword' in json.data, false);
  assert.equal(JSON.stringify(json).includes('securePassword2026!'), false);
});

test('site admin layout contract ensures cross-site tenant isolation is fail-closed', async (t) => {
  const { app } = createMockApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  const siteA = randomUUID();
  const siteB = randomUUID();

  // Site manager authorized for siteA tries to access siteA -> 200
  const allowed = await fetch(`http://127.0.0.1:${port}/api/websites/${siteA}/verify-access`, {
    headers: { 'x-actor-websites': siteA },
  });
  assert.equal(allowed.status, 200);

  // Site manager authorized for siteA tries to access siteB -> 403
  const forbidden = await fetch(`http://127.0.0.1:${port}/api/websites/${siteB}/verify-access`, {
    headers: { 'x-actor-websites': siteA },
  });
  assert.equal(forbidden.status, 403);
  const errorJson = await forbidden.json();
  assert.equal(errorJson.error.code, 'tenant_website_forbidden');
});
