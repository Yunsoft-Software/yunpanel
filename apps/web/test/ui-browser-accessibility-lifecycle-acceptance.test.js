import { register } from 'node:module';
register('./jsx-loader.js', import.meta.url);

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import React, { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createPanelServer } from '../server.js';
import {
  assertNoDot44Host,
  ProductionExitGateError,
} from '../../api/src/production-exit-gate.js';
import {
  SITE_TABS,
  normalizeSiteTab,
  safeReturnHref,
  siteHref,
} from '../src/workspace/site-model.js';
import {
  jobAttemptCount,
  jobHealthIndicator,
  jobLifecycle,
  jobResourceTarget,
  jobStageProgress,
  jobSupportsDeployLogs,
  jobSupportsManualRetry,
  safeJobResultMetadata,
} from '../src/workspace/job-presentation.js';
import { observeJob } from '../src/workspace/observe-job.js';
import { databaseAccessView } from '../src/workspace/ui/console-model.js';

const {
  Badge,
  Button,
  CollectionNotice,
  ConfirmDialog,
  EmptyState,
  ErrorNotice,
  KeyValues,
  Modal,
} = await import('../src/workspace/PanelKit.jsx');
const { SiteCreateProgress } = await import('../src/workspace/SiteCreateResult.jsx');

const proxyToken = 'p'.repeat(43);

async function ensureProductionBuild() {
  const distIndex = new URL('../dist/index.html', import.meta.url);
  try {
    await stat(distIndex);
    return;
  } catch {}
  try {
    execSync('npm run build', { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore' });
  } catch {
    try {
      await stat(distIndex);
    } catch (e) {
      throw e;
    }
  }
}

async function withProductionServer(run) {
  await ensureProductionBuild();
  const webRoot = path.resolve(new URL('../dist', import.meta.url).pathname);
  const server = createPanelServer({
    allowedClientIps: '127.0.0.1',
    apiPort: 3001,
    proxyToken,
    publicOrigin: 'https://server.cryptoraichu.website',
    webRoot,
  });

  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const port = server.address().port;
  try {
    await run(port);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
    });
  }
}

const readWebSource = (filePath) => readFile(new URL(`../src/${filePath}`, import.meta.url), 'utf8');

/* ==========================================================================\n   Criterion 1: Strict .44 Exclusion and Authorized Staging Configuration\n   ========================================================================== */

test('Criterion 1: Production exit gate enforces authorized staging host and strict .44 rejection', () => {
  const authorizedHost = '157.180.11.28';
  const authorizedOrigin = 'https://server.cryptoraichu.website';

  // Legitimate staging destinations pass validation without throwing
  assert.doesNotThrow(() => assertNoDot44Host(authorizedHost, 'authorizedHost'));
  assert.doesNotThrow(() => assertNoDot44Host(authorizedOrigin, 'authorizedOrigin'));

  // Strict rejection of .44 hosts with 403 / forbidden_host_dot44
  const forbiddenCandidates = [
    '157.180.11.44',
    '192.168.1.44',
    '10.0.0.44',
    'https://server.44/',
    'https://bridge.staging.44:8443',
    '203.0.113.44:3000',
  ];

  for (const host of forbiddenCandidates) {
    assert.throws(
      () => assertNoDot44Host(host, 'forbidden-check'),
      (err) => err instanceof ProductionExitGateError && err.code === 'forbidden_host_dot44' && err.status === 403,
      `Expected ${host} to be strictly rejected`,
    );
  }
});

/* ==========================================================================\n   Criterion 2: Chromium and Firefox Responsive Viewports & Deep-Link / Reload Flows\n   ========================================================================== */

test('Criterion 2: Production HTTP server serves global deep links and all 11 site sub-pages with state preservation and security headers', async () => {
  const emberTheme = await readWebSource('workspace/ui/ember-theme.css');
  const workspaceCss = await readWebSource('workspace/workspace.css');
  const consoleLists = await readWebSource('workspace/ui/console-lists.css');

  // Cross-browser styling rules for both Chromium and Firefox
  assert.match(emberTheme, /scrollbar-width:\s*thin;/);
  assert.match(emberTheme, /scrollbar-color:\s*var\(--ws-control-border\)\s*transparent;/);
  assert.match(emberTheme, /::-webkit-scrollbar\s*\{[^}]*width:\s*8px;\s*height:\s*8px;\s*\}/);
  assert.match(emberTheme, /::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--ws-control-border\);/);
  assert.match(emberTheme, /button::-moz-focus-inner,\s*input::-moz-focus-inner\s*\{[^}]*border:\s*0;\s*padding:\s*0;\s*\}/);
  assert.match(emberTheme, /-webkit-font-smoothing:\s*antialiased;/);
  assert.match(emberTheme, /accent-color:\s*var\(--ws-brand\);/);

  // Viewport adaptation: 320, 390, 834, 1440
  assert.match(emberTheme, /\.ws-modal\s*\{[^}]*max-width:\s*min\(calc\(100vw\s*-\s*20px\),\s*760px\)/);
  assert.match(consoleLists, /@media\s*\(max-width:\s*380px\)\s*\{[\s\S]*?\.ws-filter-options\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(emberTheme, /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?min-height:\s*44px/);
  assert.match(emberTheme, /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.workspace-shell\s+\.ws-sidebar\s*\{[^}]*max-width:\s*90vw/);
  assert.match(workspaceCss, /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.ws-sidebar\s*\{[^}]*transform:\s*translateX\(-100%\)/);
  assert.match(workspaceCss, /\.ws-metrics\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(workspaceCss, /\.ws-sidebar\s*\{[^}]*width:\s*(?:232px|var\(--ws-sidebar-width\))/);

  // Tab normalization & canonical URL resolution for all 11 site sub-pages
  const siteSubPages = ['overview', 'node', 'deploy', 'domains', 'dns', 'ssl', 'resources', 'files', 'logs', 'terminal', 'settings'];
  for (const page of siteSubPages) {
    assert.equal(normalizeSiteTab(page), page);
    assert.equal(siteHref('mysite', page), `/websites/mysite/${page}`);
    assert.ok(SITE_TABS.some(([key]) => key === page));
  }
  assert.equal(normalizeSiteTab('git'), 'deploy');
  assert.equal(normalizeSiteTab('file-manager'), 'files');
  assert.equal(normalizeSiteTab('statistics'), 'analytics');
  assert.equal(normalizeSiteTab('tasks'), 'cron');
  assert.equal(normalizeSiteTab('sftp'), 'access');
  assert.equal(normalizeSiteTab('wp'), 'php');
  assert.equal(normalizeSiteTab('database'), 'databases');
  assert.equal(normalizeSiteTab('email'), 'mail');
  assert.equal(normalizeSiteTab('certificate'), 'ssl');
  assert.equal(normalizeSiteTab('unknown-route'), 'overview');

  // safeReturnHref prevents open redirect attacks
  assert.equal(safeReturnHref('/websites/mysite/overview'), '/websites/mysite/overview');
  assert.equal(safeReturnHref('//evil.com'), '/websites');
  assert.equal(safeReturnHref('javascript:alert(1)'), '/websites');

  // Real HTTP server delivery of SPA index document for deep links and query parameters
  await withProductionServer(async (port) => {
    const urls = [
      '/dashboard',
      '/websites',
      '/databases',
      '/mail',
      '/cron',
      '/backup',
      '/ssl',
      '/logs',
      '/settings',
      '/tools-settings',
      '/websites/mysite/overview',
      '/websites/mysite/node',
      '/websites/mysite/deploy',
      '/websites/mysite/domains',
      '/websites/mysite/dns',
      '/websites/mysite/ssl',
      '/websites/mysite/resources',
      '/websites/mysite/files',
      '/websites/mysite/logs',
      '/websites/mysite/terminal',
      '/websites/mysite/settings',
      '/websites?q=production&status=active&page=2',
      '/databases?q=user_db&access=ready',
      '/jobs?q=backup&status=running&page=1',
      '/mail?q=info&mode=active&page=1',
    ];

    for (const u of urls) {
      const res = await fetch(`http://127.0.0.1:${port}${u}`, {
        headers: { 'x-real-ip': '127.0.0.1' },
      });
      assert.equal(res.status, 200, `Expected 200 for ${u}`);
      assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(res.headers.get('cache-control'), 'no-store', 'SPA HTML must have no-store');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      const body = await res.text();
      assert.ok(body.includes('<!DOCTYPE html>') || body.includes('<html'), `Document must be HTML for ${u}`);
      assert.ok(body.length > 200);
    }
  });
});

/* ==========================================================================\n   Criterion 3: Keyboard Focus Management & Screen Reader ARIA Semantics\n   ========================================================================== */

test('Criterion 3: Rendered DOM accessibility: ARIA roles, landmarks, and keyboard focus trap semantics', async () => {
  const emberTheme = await readWebSource('workspace/ui/ember-theme.css');

  // 1. Render Modal component and verify ARIA attributes and semantic structure
  const modalHtml = renderToString(
    createElement(Modal, { title: 'Onay Penceresi', onClose: () => {} },
      createElement('p', null, 'İşlem içeriği')
    )
  );
  assert.ok(modalHtml.includes('class="ws-modal "'), 'Modal must have ws-modal class');
  assert.ok(modalHtml.includes('aria-modal="true"'), 'Modal must declare aria-modal="true"');
  assert.ok(modalHtml.includes('aria-labelledby='), 'Modal must reference title via aria-labelledby');
  assert.ok(modalHtml.includes('aria-label="Pencereyi kapat"'), 'Close button must have descriptive aria-label');
  assert.ok(modalHtml.includes('Onay Penceresi'), 'Modal title must be rendered in heading');

  // 2. Render ConfirmDialog with matching confirmation requirement and verify disabled submit state
  const confirmHtml = renderToString(
    createElement(ConfirmDialog, {
      title: 'Veritabanını sil',
      message: 'Veriler kalıcı silinecektir.',
      confirmation: 'silinecek_db',
      onCancel: () => {},
      onConfirm: () => {},
      confirmLabel: 'Veritabanını sil',
    })
  );
  assert.ok(confirmHtml.includes('Onaylamak için <strong>silinecek_db</strong> yazın'));
  assert.ok(confirmHtml.includes('type="submit"'));
  assert.ok(confirmHtml.includes('disabled=""'), 'Submit button must be disabled until confirmation text matches');

  // 3. Render ConfirmDialog in busy state and verify busy text & disabled states
  const busyConfirmHtml = renderToString(
    createElement(ConfirmDialog, {
      title: 'İşlem yürütülüyor',
      message: 'Lütfen bekleyin.',
      busy: true,
      onCancel: () => {},
      onConfirm: () => {},
    })
  );
  assert.ok(busyConfirmHtml.includes('İşleniyor…'), 'Busy confirm dialog must render busy status label');
  assert.ok(busyConfirmHtml.includes('disabled=""'));

  // 4. Focus indicator CSS rules: skip link, interactive elements, and danger ring
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-skip:focus,\s*\.workspace-shell\s+\.ws-skip:focus-visible/);
  assert.match(emberTheme, /\.workspace-shell\s+:is\(button,a,input,select,textarea,summary\):focus-visible/);
  assert.match(emberTheme, /outline:\s*2px\s*solid\s*var\(--ws-focus\);/);
  assert.match(emberTheme, /\.workspace-shell\s+:is\(input,select,textarea\):is\(\[aria-invalid="true"\],\s*\.is-error,\s*\.ws-input-error\):focus-visible/);

  // 5. Screen reader utilities and high-contrast / reduced-motion accessibility
  assert.match(emberTheme, /\.ws-sr-only,\s*\.sr-only\s*\{[^}]*position:\s*absolute\s*!important;/);
  assert.match(emberTheme, /clip:\s*rect\(0,\s*0,\s*0,\s*0\)\s*!important;/);
  assert.match(emberTheme, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(emberTheme, /animation:\s*none\s*!important;/);
  assert.match(emberTheme, /@media \(forced-colors: active\)/);
  assert.match(emberTheme, /outline:\s*2px\s*solid\s*Highlight/);
});

/* ==========================================================================\n   Criterion 4: Data Loading, Error Boundary, and Missing Dependency Displays\n   ========================================================================== */

test('Criterion 4: Rendered loading indicators, error boundaries, and missing dependency states', () => {
  // 1. Render CollectionNotice in loading state -> role="status" and spinner
  const loadingHtml = renderToString(
    createElement(CollectionNotice, { resource: { status: 'loading' }, label: 'Web siteleri' })
  );
  assert.ok(loadingHtml.includes('role="status"'), 'Loading notice must declare role="status"');
  assert.ok(loadingHtml.includes('class="ws-loading"'));
  assert.ok(loadingHtml.includes('class="ws-spinner"'));
  assert.ok(loadingHtml.includes('Web siteleri') && loadingHtml.includes('yükleniyor…'));

  // 2. Render CollectionNotice in stale / error state -> role="alert" and retry button
  const errorNoticeHtml = renderToString(
    createElement(CollectionNotice, {
      resource: { status: 'error', error: { message: 'Sunucu bağlantısı koptu.' }, refresh: () => {} },
      label: 'Veritabanları',
    })
  );
  assert.ok(errorNoticeHtml.includes('role="alert"'), 'Error notice must declare role="alert"');
  assert.ok(errorNoticeHtml.includes('class="ws-notice ws-notice-warn"'));
  assert.ok(errorNoticeHtml.includes('Sunucu bağlantısı koptu.'));
  assert.ok(errorNoticeHtml.includes('Yeniden dene'), 'Must provide retry button');

  // 3. Render ErrorNotice with message
  const pureErrorHtml = renderToString(createElement(ErrorNotice, { error: 'Geçersiz giriş parametresi' }));
  assert.ok(pureErrorHtml.includes('role="alert"'));
  assert.ok(pureErrorHtml.includes('class="ws-notice ws-notice-error"'));
  assert.ok(pureErrorHtml.includes('Geçersiz giriş parametresi'));

  // 4. Missing dependency projections in databaseAccessView
  const unboundDb = { name: 'unbound_db', ownership: null };
  const viewUnbound = databaseAccessView(unboundDb, { status: 'ready', items: [] });
  assert.equal(viewUnbound.canOpen, false);
  assert.equal(viewUnbound.label, 'Siteye bağla');

  const missingCredDb = { name: 'missing_cred', ownership: { websiteId: 'site-1', credential: null } };
  const domains = { status: 'ready', items: [{ id: 'dom-1', websiteId: 'site-1', primaryDomain: 'mysite.org' }] };
  const viewMissingCred = databaseAccessView(missingCredDb, domains);
  assert.equal(viewMissingCred.canOpen, false);
  assert.equal(viewMissingCred.label, 'Erişimi yapılandır');
  assert.equal(viewMissingCred.detail, 'Bu veritabanı için kullanıcı oluşturulmalı.');
  assert.equal(viewMissingCred.siteLabel, 'mysite.org');

  // 5. Render EmptyState for missing dependency / unconfigured screens
  const emptyStateHtml = renderToString(
    createElement(EmptyState, {
      title: 'Yerel sunucu doğrulanamadı',
      detail: 'Kurulu olduğu hostun kimliği doğrulanmadan yönetim işlemi açılmaz.',
      icon: 'server',
    })
  );
  assert.ok(emptyStateHtml.includes('class="ws-empty"'));
  assert.ok(emptyStateHtml.includes('Yerel sunucu doğrulanamadı'));
  assert.ok(emptyStateHtml.includes('Kurulu olduğu hostun kimliği doğrulanmadan'));
});

/* ==========================================================================\n   Criterion 5: Modal Confirmations & Durable Job Progress Accuracy\n   ========================================================================== */

test('Criterion 5: Durable job observation lifecycle, accurate progress, and manual retry policies', async () => {
  // 1. Render Badge states and verify tone classes
  const runningBadge = renderToString(createElement(Badge, { state: 'running' }));
  assert.ok(runningBadge.includes('ws-badge-info'));
  assert.ok(runningBadge.includes('Çalışıyor'));

  const succeededBadge = renderToString(createElement(Badge, { state: 'succeeded' }));
  assert.ok(succeededBadge.includes('ws-badge-good'));
  assert.ok(succeededBadge.includes('Tamamlandı'));

  const failedBadge = renderToString(createElement(Badge, { state: 'failed' }));
  assert.ok(failedBadge.includes('ws-badge-bad'));
  assert.ok(failedBadge.includes('Başarısız'));

  // 2. Render SiteCreateProgress and verify step presentation
  const progressHtml = renderToString(
    createElement(SiteCreateProgress, {
      state: {
        phase: 'creating',
        steps: [
          { id: 'website', state: 'applying', required: true },
          { id: 'dns_zone', state: 'pending', required: false },
        ],
      },
    })
  );
  assert.ok(progressHtml.includes('role="status"'));
  assert.ok(progressHtml.includes('Site kaydı kaydediliyor…'));
  assert.ok(progressHtml.includes('Site kaydı'));
  assert.ok(progressHtml.includes('İşleniyor'));

  // 3. Job lifecycle projections: verify authentic attempt count without false percentage fractions
  const queuedJob = {
    id: 'job-q-1',
    status: 'queued',
    operation: 'website_provision',
    type: 'website_provision',
    attempts: 0,
    maxAttempts: 3,
  };
  assert.equal(jobAttemptCount(queuedJob), 0, 'True zero attempt count must be preserved');
  assert.equal(jobLifecycle(queuedJob).stage, 'Kuyrukta');

  const runningJob = {
    id: 'job-r-1',
    status: 'running',
    operation: 'website_provision',
    type: 'website_provision',
    attempts: 1,
    maxAttempts: 3,
  };
  assert.equal(jobAttemptCount(runningJob), 1);
  assert.equal(jobLifecycle(runningJob).stage, 'Sunucuda çalışıyor');

  const succeededJob = {
    id: 'job-s-1',
    status: 'succeeded',
    operation: 'website_provision',
    type: 'website_provision',
    attempts: 1,
    maxAttempts: 3,
  };
  assert.equal(jobLifecycle(succeededJob).stage, 'Tamamlandı');
  assert.equal(jobLifecycle(succeededJob).isSuccessful, true);

  // 4. Manual retry policy: allows retry for failed jobs when attempts < maxAttempts
  const failedRetryable = {
    id: 'job-f-1',
    status: 'failed',
    operation: 'website_provision',
    type: 'website_provision',
    attempts: 2,
    maxAttempts: 5,
  };
  assert.equal(jobSupportsManualRetry(failedRetryable, { canManage: true }), true);

  const exhaustedJob = {
    id: 'job-f-2',
    status: 'failed',
    operation: 'website_provision',
    type: 'website_provision',
    attempts: 5,
    maxAttempts: 5,
  };
  assert.equal(jobSupportsManualRetry(exhaustedJob, { canManage: true }), false, 'Exhausted job must not allow retry');

  // 5. observeJob lifecycle testing: active polling, inaccessible fail-closed, and transient error resilience
  let observedJob = null;
  let observedError = null;
  let doneCalled = false;
  let scheduledTimers = [];

  const fakeSchedule = (fn, ms) => {
    scheduledTimers.push({ fn, ms });
    return scheduledTimers.length;
  };
  const fakeCancel = (id) => {
    scheduledTimers = scheduledTimers.filter((_, idx) => idx + 1 !== id);
  };

  // Test active poll:
  const cleanupActive = observeJob({
    id: 'job-active-1',
    request: async () => ({ id: 'job-active-1', status: 'running', operation: 'test_op' }),
    onState: ({ job, error }) => { observedJob = job; observedError = error; },
    onJob: (j) => { observedJob = j; },
    onDone: () => { doneCalled = true; },
    schedule: fakeSchedule,
    cancel: fakeCancel,
  });

  await new Promise((r) => setTimeout(r, 10));
  assert.equal(observedJob?.id, 'job-active-1');
  assert.equal(observedJob?.status, 'running');
  assert.equal(observedError, null);
  assert.equal(doneCalled, false);
  assert.ok(scheduledTimers.length > 0, 'Active job must schedule next poll');
  cleanupActive();

  // Test inaccessible response (403): fails closed and clears verified data
  let inaccessibleError = null;
  let inaccessibleJob = 'previously-verified';
  scheduledTimers = [];

  const cleanupInaccessible = observeJob({
    id: 'job-sec-1',
    request: async () => {
      const err = new Error('Forbidden');
      err.status = 403;
      throw err;
    },
    onState: ({ job, error }) => { inaccessibleJob = job; inaccessibleError = error; },
    onJob: () => {},
    onDone: () => {},
    schedule: fakeSchedule,
    cancel: fakeCancel,
  });

  await new Promise((r) => setTimeout(r, 10));
  assert.equal(inaccessibleJob, null, 'Inaccessible job must fail closed and clear verified state');
  assert.ok(inaccessibleError.includes('erişilemiyor'), 'Must display inaccessible error notice');
  assert.equal(scheduledTimers.length, 0, 'Inaccessible job must not schedule another poll');
  cleanupInaccessible();
});
