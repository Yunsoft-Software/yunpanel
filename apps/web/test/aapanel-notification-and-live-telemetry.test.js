import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { localRuntimeInternals } from '../../api/src/local-runtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = path.resolve(__dirname, '../src/workspace');

let jsxLoaderRegistered = false;
async function loadWorkspaceModules() {
  try {
    const drawerMod = await import('../src/workspace/NotificationCenterDrawer.jsx');
    const contextMod = await import('../src/workspace/WorkspaceContext.jsx');
    return { ...drawerMod, ...contextMod };
  } catch {
    if (!jsxLoaderRegistered) {
      const viteUrl = import.meta.resolve('vite');
      const loaderCode = `
        import fs from 'node:fs/promises';
        import { fileURLToPath } from 'node:url';
        import { transformWithOxc } from ${JSON.stringify(viteUrl)};
        export async function load(url, context, nextLoad) {
          if (url.endsWith('.css')) {
            return { format: 'module', shortCircuit: true, source: 'export default {};' };
          }
          if (url.endsWith('.jsx')) {
            const filePath = fileURLToPath(url);
            const source = await fs.readFile(filePath, 'utf8');
            const result = await transformWithOxc(source, filePath, { lang: 'jsx' });
            return { format: 'module', shortCircuit: true, source: result.code };
          }
          return nextLoad(url, context);
        }
      `;
      register(`data:text/javascript;base64,${Buffer.from(loaderCode).toString('base64')}`, import.meta.url);
      jsxLoaderRegistered = true;
    }
    const drawerMod = await import('../src/workspace/NotificationCenterDrawer.jsx');
    const contextMod = await import('../src/workspace/WorkspaceContext.jsx');
    return { ...drawerMod, ...contextMod };
  }
}

test('local-runtime sets DEFAULT_SNAPSHOT_INTERVAL_MS to 5_000 for 5-second live server telemetry', () => {
  assert.equal(localRuntimeInternals.defaultSnapshotIntervalMs, 5_000);
  const runtimeSource = fs.readFileSync(path.resolve(__dirname, '../../api/src/local-runtime.js'), 'utf8');
  assert.match(runtimeSource, /const DEFAULT_SNAPSHOT_INTERVAL_MS = 5_000;/);
});

test('WorkspaceLayout removes confusing /websites sidebar badge, renders Uygulama Marketi, and mounts NotificationCenterDrawer with route-stable alert count', () => {
  const layoutSource = fs.readFileSync(path.resolve(workspaceDir, 'WorkspaceLayout.jsx'), 'utf8');
  assert.equal(layoutSource.includes("to === '/websites' && sites !== null"), false);
  assert.match(layoutSource, /NotificationCenterDrawer/);
  assert.match(layoutSource, /aria-label="Bildirim ve Görev Merkezi"/);
  assert.match(layoutSource, /<span className="ws-toolbar-label">İşlemler<\/span>/);
  assert.match(layoutSource, /<span>Uygulama Marketi<\/span>/);
  assert.doesNotMatch(layoutSource, /Uygulama Marketi \(1-Click\)|1-Click Market/);
  assert.match(layoutSource, /const alertCount = computeWorkspaceAlerts\(\{ domains, websites, certificates, servers \}\)\.length;/);
});

test('DashboardPage and WebsitesPage expose live telemetry interval selector and root/subdomain breakdown', () => {
  const dashboardSource = fs.readFileSync(path.resolve(workspaceDir, 'DashboardPage.jsx'), 'utf8');
  assert.match(dashboardSource, /title="Performans" description="Canlı sunucu kaynak kullanımı"/);
  assert.match(dashboardSource, /aria-label="Yenileme aralığı"/);
  assert.match(dashboardSource, /Şimdi ölç/);

  const websitesSource = fs.readFileSync(path.resolve(workspaceDir, 'WebsitesPage.jsx'), 'utf8');
  assert.match(websitesSource, /ana alan adı · \$\{subdomainsCount\} alt alan adı/);
});

test('computeWorkspaceAlerts synthesizes real SSL, server resource, failed job, and suspended domain alerts', async () => {
  const { computeWorkspaceAlerts } = await loadWorkspaceModules();

  const domains = {
    status: 'ready',
    items: [
      { id: 'dom-expired', primaryDomain: 'expired.example.com', state: 'active' },
      { id: 'dom-suspended', primaryDomain: 'suspended.example.com', state: 'suspended' },
    ],
  };
  const certificates = {
    status: 'ready',
    items: [
      {
        id: 'cert-1',
        domainId: 'dom-expired',
        primaryDomain: 'expired.example.com',
        state: 'expired',
        status: 'expired',
        expiresAt: '2025-01-01T00:00:00.000Z',
      },
    ],
  };
  const servers = {
    status: 'ready',
    items: [
      {
        id: 'srv-1',
        displayName: 'Ana Sunucu',
        connectivity: 'online',
        inventory: {
          cpu: { count: 4, usagePercent: 92 },
          memory: { usedBytes: 15 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 },
          filesystem: { usedBytes: 91 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 },
        },
      },
    ],
  };
  const jobs = {
    status: 'ready',
    items: [
      {
        id: 'job-fail-1',
        operation: 'ssl.renew',
        status: 'failed',
        error: { message: 'ACME doğrulama hatası' },
      },
    ],
  };

  const alerts = computeWorkspaceAlerts({ domains, websites: { items: [] }, certificates, servers, jobs });
  assert.ok(alerts.some((a) => a.category === 'ssl' && a.href.includes('dom-expired')));
  assert.ok(alerts.some((a) => a.category === 'server' && a.title.includes('CPU')));
  assert.ok(alerts.some((a) => a.category === 'server' && a.title.includes('RAM')));
  assert.ok(alerts.some((a) => a.category === 'server' && a.title.includes('Disk')));
  assert.ok(alerts.some((a) => a.category === 'job' && a.id === 'job-failed-job-fail-1'));
  assert.ok(alerts.some((a) => a.category === 'domain' && a.id === 'domain-suspended-dom-suspended'));
});

test('NotificationCenterDrawer renders and switches between Görev Kuyruğu, Sistem Uyarıları, and Bildirimler', async () => {
  const { NotificationCenterDrawer, WorkspaceContext } = await loadWorkspaceModules();

  const workspaceValue = {
    domains: {
      status: 'ready',
      items: [{ id: 'dom-1', primaryDomain: 'ornek.com', state: 'suspended' }],
    },
    websites: { status: 'ready', items: [] },
    certificates: { status: 'ready', items: [] },
    servers: {
      status: 'ready',
      items: [
        {
          id: 'srv-1',
          displayName: 'Test Sunucu',
          connectivity: 'online',
          inventory: {
            cpu: { count: 4, usagePercent: 88 },
            memory: { usedBytes: 4 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 },
            filesystem: { usedBytes: 90 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 },
          },
        },
      ],
    },
    jobs: {
      status: 'ready',
      items: [
        { id: 'job-run-1', operation: 'site.deploy', status: 'running', resourceType: 'website' },
        { id: 'job-fail-2', operation: 'backup.create', status: 'failed', error: { message: 'Disk dolu' } },
      ],
    },
    notice: 'Nginx yapılandırması başarıyla doğrulandı.',
    setNotice: () => {},
    observe: () => {},
  };

  const tree = React.createElement(
    MemoryRouter,
    null,
    React.createElement(
      WorkspaceContext.Provider,
      { value: workspaceValue },
      React.createElement(NotificationCenterDrawer, { open: true, onClose: () => {} }),
    ),
  );

  const html = renderToStaticMarkup(tree);
  assert.match(html, /Bildirim ve Görev Merkezi/);
  assert.match(html, /Görev Kuyruğu/);
  assert.match(html, /Sistem Uyarıları/);
  assert.match(html, /Bildirimler/);
  assert.match(html, /site\.deploy/);
  assert.match(html, /İncele/);

  const alertsTree = React.createElement(
    MemoryRouter,
    null,
    React.createElement(
      WorkspaceContext.Provider,
      { value: workspaceValue },
      React.createElement(NotificationCenterDrawer, { open: true, initialTab: 'alerts', onClose: () => {} }),
    ),
  );
  const alertsHtml = renderToStaticMarkup(alertsTree);
  assert.match(alertsHtml, /Yüksek CPU kullanımı/);
  assert.match(alertsHtml, /Yüksek Disk doluluğu/);
  assert.match(alertsHtml, /Askıya alınmış alan adı/);
  assert.match(alertsHtml, /Uyarıları Temizle/);
  assert.match(alertsHtml, /Kapat/);
  assert.match(alertsHtml, /▶ Yayını Etkinleştir/);
  assert.match(alertsHtml, /quickResume=1/);

  const noticesTree = React.createElement(
    MemoryRouter,
    null,
    React.createElement(
      WorkspaceContext.Provider,
      { value: workspaceValue },
      React.createElement(NotificationCenterDrawer, { open: true, initialTab: 'notices', onClose: () => {} }),
    ),
  );
  const noticesHtml = renderToStaticMarkup(noticesTree);
  assert.match(noticesHtml, /Nginx yapılandırması başarıyla doğrulandı\./);
  assert.match(noticesHtml, /Temizle/);
});
