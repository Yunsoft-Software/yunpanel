import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mountPanelSettingsRoutes } from '../src/panel-settings-http.js';

function createMockApp({ panelSettingsService, userRole = 'owner' }) {
  const app = express();
  app.use(express.json());

  // Mock authentication middleware matching describePanelAccess in panel-access.js
  app.use((req, res, next) => {
    if (userRole === 'unauthenticated') {
      req.auth = null;
    } else if (userRole === 'owner') {
      req.auth = {
        user: { id: 'usr-owner', username: 'admin', role: 'owner' },
        access: { mode: 'management', permissions: ['*'] },
        security: { managementAllowed: true },
      };
    } else if (userRole === 'read_only') {
      req.auth = {
        user: { id: 'usr-ro', username: 'viewer', role: 'read_only' },
        access: { mode: 'read_only', permissions: ['servers.read'] },
        security: { managementAllowed: false },
      };
    }
    next();
  });

  mountPanelSettingsRoutes(app, { panelSettingsService });

  // Error handler
  app.use((err, req, res, next) => {
    res.status(err.status ?? 400).json({ error: { code: err.code ?? 'error', message: err.message } });
  });

  return app;
}

test('Panel Settings HTTP API', async (t) => {
  const mockService = {
    settingsData: {
      panel: { version: '0.3.0', hostname: 'panel.local', executionMode: 'local' },
      websiteDefaults: { defaultRuntime: 'node' },
      dnsSsl: { acmeEmail: null },
    },
    async getSystemSettings() {
      return this.settingsData;
    },
    async updateSystemSettings(patch) {
      if (patch.websiteDefaults) {
        this.settingsData.websiteDefaults = { ...this.settingsData.websiteDefaults, ...patch.websiteDefaults };
      }
      return this.settingsData;
    },
  };

  await t.test('GET /api/panel/settings returns 200 and system settings for owner', async () => {
    const app = createMockApp({ panelSettingsService: mockService, userRole: 'owner' });
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/panel/settings`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.panel.version, '0.3.0');
      assert.equal(body.data.websiteDefaults.defaultRuntime, 'node');
    } finally {
      server.close();
    }
  });

  await t.test('GET /api/panel/settings returns 200 and system settings for read_only', async () => {
    const app = createMockApp({ panelSettingsService: mockService, userRole: 'read_only' });
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/panel/settings`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.panel.version, '0.3.0');
    } finally {
      server.close();
    }
  });

  await t.test('PATCH /api/panel/settings updates settings and returns 200 for owner', async () => {
    const app = createMockApp({ panelSettingsService: mockService, userRole: 'owner' });
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/panel/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ websiteDefaults: { defaultRuntime: 'php' } }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.websiteDefaults.defaultRuntime, 'php');
    } finally {
      server.close();
    }
  });

  await t.test('PATCH /api/panel/settings rejects read_only role with 403', async () => {
    const app = createMockApp({ panelSettingsService: mockService, userRole: 'read_only' });
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/panel/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ websiteDefaults: { defaultRuntime: 'php' } }),
      });
      assert.equal(res.status, 403);
    } finally {
      server.close();
    }
  });

  await t.test('GET /api/panel/settings rejects unauthenticated with 401', async () => {
    const app = createMockApp({ panelSettingsService: mockService, userRole: 'unauthenticated' });
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/panel/settings`);
      assert.equal(res.status, 401);
    } finally {
      server.close();
    }
  });
});
