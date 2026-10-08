import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { register } from 'node:module';
import test from 'node:test';

register('./jsx-loader.js', import.meta.url);

// ---------------------------------------------------------------------------
// Part 1: Preserve original static / architectural wiring assertions
// ---------------------------------------------------------------------------

const source = await readFile(new URL('../src/workspace/MailDomainsPage.jsx', import.meta.url), 'utf8');

test('mail management retains all integration panels behind explicit sections', () => {
  for (const panel of ['MailboxesPanel', 'MailWebmailPanel', 'MailAliasesPanel', 'MailDkimDiagnosticsPanel', 'MailConfigurationPanel', 'MailOperationsPanel']) {
    assert.ok(source.includes(`<${panel}`), panel);
  }
  for (const key of ['mailboxes', 'webmail', 'aliases', 'security', 'configuration', 'operations']) {
    assert.ok(source.includes(`hidden={section !== '${key}'}`), key);
  }
});

test('mail section links preserve query state and domain changes reset component identity', () => {
  assert.match(source, /new URLSearchParams\(params\)/);
  assert.match(source, /next\.set\('section', key\)/);
  assert.match(source, /<MailDomainDetail key=\{mailDomainId\}/);
  assert.match(source, /aria-current=\{section === key \? 'page'/);
});

test('mail listing has real filtering and pagination without pretending external accounts are local', () => {
  assert.match(source, /paginateConsoleItems\(filtered/);
  assert.match(source, /item\.managementMode === mode/);
  assert.match(source, /domain\.managementMode === 'local'/);
  assert.match(source, /Harici mail sağlayıcısı/);
  assert.doesNotMatch(source, /window\.open|localStorage|sessionStorage/);
});

test('mailboxes panel exposes connection settings, reception, and test delivery diagnostics', async () => {
  const mailboxesSource = await readFile(new URL('../src/workspace/MailboxesPanel.jsx', import.meta.url), 'utf8');
  assert.match(mailboxesSource, /MailboxDiagnosticsModal/);
  assert.match(mailboxesSource, /getMailboxDeliveryDiagnostics/);
  assert.match(mailboxesSource, /sendMailboxTestDelivery/);
  assert.match(mailboxesSource, /İstemci Bağlantı Ayarları/);
  assert.match(mailboxesSource, /Posta Kutusu Durumu/);
  assert.match(mailboxesSource, /DNS ve Doğrulama Durumu/);
  assert.match(mailboxesSource, /Teslimat Testi/);
});

test('mail DKIM and operations panels expose DNS requirements, connection settings, and authentic delivery test', async () => {
  const dkimSource = await readFile(new URL('../src/workspace/MailDkimDiagnosticsPanel.jsx', import.meta.url), 'utf8');
  assert.match(dkimSource, /getMailDeliveryDiagnostics/);
  assert.match(dkimSource, /sendMailDomainTestDelivery/);
  assert.match(dkimSource, /İstemci Bağlantı Bilgileri/);
  assert.match(dkimSource, /DNS Teslimat Gereksinimleri/);
  assert.match(dkimSource, /Teslimat Testi/);

  const opsSource = await readFile(new URL('../src/workspace/MailOperationsPanel.jsx', import.meta.url), 'utf8');
  assert.match(opsSource, /ServiceConnectionDiagnosticsPanel/);
  assert.match(opsSource, /ServiceTestDeliveryPanel/);
  assert.match(opsSource, /getServerMailDeliveryDiagnostics/);
  assert.match(opsSource, /sendServerMailTestDelivery/);
  assert.match(opsSource, /Yönlendirme/);
  assert.match(opsSource, /secret masking/);
});

// ---------------------------------------------------------------------------
// Part 2: React Component Integration Tests with Real Subpanels
// ---------------------------------------------------------------------------

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { MemoryRouter, Routes, Route, useNavigate } = await import('react-router');
const { createElement, act, StrictMode } = React;
const { PanelSessionProvider } = await import('../src/panel-session.jsx');
const { WorkspaceContext } = await import('../src/workspace/WorkspaceContext.jsx');
const { default: MailDomainsPage } = await import('../src/workspace/MailDomainsPage.jsx');
const {
  setupMockDom,
  clickElement,
  changeInput,
  submitForm,
  flush: flushHelper,
} = await import('./mail-test-helpers.js');
const {
  mockDomains,
  mockMailboxes,
  mockAliases,
  mockWebmailMapping,
  mockCertificates,
  mockDkim,
  mockDeliveryDiagnostics,
  mockServerDiagnostics,
  createMockFetchRouter,
} = await import('./mail-fixtures.js');

const { doc } = setupMockDom();
const flush = (count, ms) => flushHelper(act, count, ms);

const session = {
  user: { id: 'owner-id', username: 'admin', role: 'owner' },
  access: { mode: 'management', permissions: ['*'] },
  security: { ownerMfaRequired: false, enrollmentRequired: false, managementAllowed: true },
};

function createWorkspace(observedJobs = []) {
  return {
    servers: { items: [{ id: 'srv-1', name: 'local-server' }], status: 'ready', refresh: () => {} },
    observe: (job) => { observedJobs.push(job); },
    updateJob: () => {},
    can: () => true,
    canManage: true,
    isOwner: true,
    isSiteManager: false,
    isReseller: false,
    isCustomer: false,
    readOnly: false,
  };
}

test('/mail listing has search with Turkish casing, mode filtering, and pagination over 20 items', async () => {
  const { fetchMock } = createMockFetchRouter();
  globalThis.fetch = fetchMock;

  const workspaceValue = createWorkspace();
  const container = doc.createElement('div');
  const root = createRoot(container);

  await act(async () => {
    root.render(
      createElement(StrictMode, null,
        createElement(PanelSessionProvider, { session },
          createElement(WorkspaceContext.Provider, { value: workspaceValue },
            createElement(MemoryRouter, { initialEntries: ['/mail'] },
              createElement(Routes, null,
                createElement(Route, { path: '/mail', element: createElement(MailDomainsPage) }),
              ),
            ),
          ),
        ),
      ),
    );
  });
  await flush();

  // 1. Initial listing check: total 20 domains, page 1 of 2 (15 per page)
  assert.ok(container.textContent.includes('20 sonuç'), 'Should show total count 20');
  assert.ok(container.textContent.includes('1 / 2'), 'Should display page 1 / 2');

  const rowsPage1 = container.querySelectorAll((el) => el.tagName === 'TR' && el.attributes?.role === 'row');
  assert.equal(rowsPage1.length, 15, 'Page 1 should render 15 domain rows');

  const prevBtn = container.querySelectorAll((el) => el.tagName === 'BUTTON' && el.textContent.includes('Önceki'))[0];
  const nextBtn = container.querySelectorAll((el) => el.tagName === 'BUTTON' && el.textContent.includes('Sonraki'))[0];
  assert.ok(prevBtn.attributes.disabled !== undefined, 'Önceki button should be disabled on page 1');
  assert.ok(nextBtn.attributes.disabled === undefined, 'Sonraki button should be enabled on page 1');

  // 2. Pagination transition: Click Sonraki to go to Page 2
  await act(async () => {
    clickElement(nextBtn);
  });
  await flush();

  assert.ok(container.textContent.includes('2 / 2'), 'Should display page 2 / 2');
  assert.ok(prevBtn.attributes.disabled === undefined, 'Önceki button should be enabled on page 2');
  assert.ok(nextBtn.attributes.disabled !== undefined, 'Sonraki button should be disabled on page 2');

  const rowsPage2 = container.querySelectorAll((el) => el.tagName === 'TR' && el.attributes?.role === 'row');
  assert.equal(rowsPage2.length, 5, 'Page 2 should render remaining 5 domain rows');

  // 3. Search filter with Turkish casing (İ / i / I / ı and Ş / ş)
  const searchInput = container.querySelectorAll((el) => el.tagName === 'INPUT' && (el.attributes?.type === 'search' || el.type === 'search'))[0];
  assert.ok(searchInput, 'Search input must exist');

  // Search with uppercase Turkish "İSTANBUL" -> matches "istanbul-ticaret.com"
  await act(async () => {
    changeInput(searchInput, 'İSTANBUL');
  });
  await flush();

  assert.ok(container.textContent.includes('istanbul-ticaret.com'), 'Search İSTANBUL must match istanbul-ticaret.com');
  assert.ok(container.textContent.includes('1 sonuç'), 'Should have exactly 1 match');
  assert.ok(container.textContent.includes('1 / 1'), 'Page reset to 1 / 1');

  // Search with lowercase "şirket" -> matches "şirket-ana.com"
  await act(async () => {
    changeInput(searchInput, 'şirket');
  });
  await flush();

  assert.ok(container.textContent.includes('şirket-ana.com'), 'Search şirket must match şirket-ana.com');
  assert.ok(container.textContent.includes('1 sonuç'), 'Should have exactly 1 match');

  // 4. Mode filter: switch to 'local'
  const modeSelect = container.querySelectorAll((el) => el.tagName === 'SELECT' && el.attributes?.['aria-label'] === 'Mail yönetim modu')[0];
  assert.ok(modeSelect, 'Mode filter select must exist');

  await act(async () => {
    changeInput(searchInput, '');
  });
  await flush();

  await act(async () => {
    changeInput(modeSelect, 'local');
  });
  await flush();

  assert.ok(container.textContent.includes('12 sonuç'), 'Mode local should show 12 results');
  assert.ok(container.textContent.includes('1 / 1'), '12 items fit on single page 1 / 1');

  // Mode filter: switch to 'external'
  await act(async () => {
    changeInput(modeSelect, 'external');
  });
  await flush();

  assert.ok(container.textContent.includes('8 sonuç'), 'Mode external should show 8 results');
  assert.ok(container.textContent.includes('harici-mail-1.net'), 'External domain visible');

  await act(async () => {
    root.unmount();
  });
});

test('mail detail mounts all 6 real subpanels concurrently with section tab toggling', async () => {
  const { fetchMock } = createMockFetchRouter();
  globalThis.fetch = fetchMock;

  const workspaceValue = createWorkspace();
  const container = doc.createElement('div');
  const root = createRoot(container);

  await act(async () => {
    root.render(
      createElement(StrictMode, null,
        createElement(PanelSessionProvider, { session },
          createElement(WorkspaceContext.Provider, { value: workspaceValue },
            createElement(MemoryRouter, { initialEntries: ['/mail/local-1'] },
              createElement(Routes, null,
                createElement(Route, { path: '/mail/:mailDomainId', element: createElement(MailDomainsPage) }),
              ),
            ),
          ),
        ),
      ),
    );
  });
  await flush();

  // 1. Verify all 6 panels are concurrently mounted in the DOM inside .ws-mail-pane (NO STUBS)
  const panes = container.querySelectorAll('.ws-mail-pane');
  assert.equal(panes.length, 6, 'Exactly 6 .ws-mail-pane elements must be mounted concurrently');

  // Verify default active section is mailboxes (pane 0 visible, 1-5 hidden)
  assert.equal(panes[0].attributes.hidden, undefined, 'MailboxesPanel pane should NOT be hidden');
  assert.notEqual(panes[1].attributes.hidden, undefined, 'Webmail pane should be hidden');
  assert.notEqual(panes[2].attributes.hidden, undefined, 'Aliases pane should be hidden');
  assert.notEqual(panes[3].attributes.hidden, undefined, 'Security pane should be hidden');
  assert.notEqual(panes[4].attributes.hidden, undefined, 'Configuration pane should be hidden');
  assert.notEqual(panes[5].attributes.hidden, undefined, 'Operations pane should be hidden');

  // Verify authentic content of each real subpanel
  assert.ok(panes[0].textContent.includes('admin@şirket-ana.com'), 'Pane 0 contains real MailboxesPanel data');
  assert.ok(panes[1].textContent.includes('Webmail (Roundcube)'), 'Pane 1 contains real MailWebmailPanel data');
  assert.ok(panes[2].textContent.includes('Mail aliasları'), 'Pane 2 contains real MailAliasesPanel data');
  assert.ok(panes[3].textContent.includes('DKIM') && panes[3].textContent.includes('rsa2048'), 'Pane 3 contains real MailDkimDiagnosticsPanel data');
  assert.ok(panes[4].textContent.includes('Host mail configuration'), 'Pane 4 contains real MailConfigurationPanel data');
  assert.ok(panes[5].textContent.includes('Roundcube webmail'), 'Pane 5 contains real MailOperationsPanel data');

  // 2. Tab link navigation toggles hidden attributes while preserving panes
  const navTabs = container.querySelector('.ws-tabs');
  assert.ok(navTabs, 'Navigation tabs must exist');
  const tabLinks = navTabs.querySelectorAll('a');
  assert.equal(tabLinks.length, 6, 'Must render 6 section tab links');

  // Click on "Webmail" tab link
  const webmailLink = tabLinks.find((link) => link.textContent.includes('Webmail'));
  await act(async () => {
    clickElement(webmailLink);
  });
  await flush();

  assert.notEqual(panes[0].attributes.hidden, undefined, 'Mailboxes pane should now be hidden');
  assert.equal(panes[1].attributes.hidden, undefined, 'Webmail pane should now be visible');

  // Click on "Takma adlar" (Aliases) tab link
  const aliasesLink = tabLinks.find((link) => link.textContent.includes('Takma adlar'));
  await act(async () => {
    clickElement(aliasesLink);
  });
  await flush();

  assert.notEqual(panes[1].attributes.hidden, undefined, 'Webmail pane should now be hidden');
  assert.equal(panes[2].attributes.hidden, undefined, 'Aliases pane should now be visible');

  // Click on "DNS ve DKIM" tab link
  const securityLink = tabLinks.find((link) => link.textContent.includes('DNS ve DKIM'));
  await act(async () => {
    clickElement(securityLink);
  });
  await flush();

  assert.notEqual(panes[2].attributes.hidden, undefined, 'Aliases pane should now be hidden');
  assert.equal(panes[3].attributes.hidden, undefined, 'Security pane should now be visible');

  await act(async () => {
    root.unmount();
  });
});

test('section tab switching preserves user draft inputs and durable job observation across panels', async () => {
  const { fetchMock } = createMockFetchRouter();
  globalThis.fetch = fetchMock;

  const observedJobs = [];
  const workspaceValue = createWorkspace(observedJobs);
  const container = doc.createElement('div');
  const root = createRoot(container);

  await act(async () => {
    root.render(
      createElement(StrictMode, null,
        createElement(PanelSessionProvider, { session },
          createElement(WorkspaceContext.Provider, { value: workspaceValue },
            createElement(MemoryRouter, { initialEntries: ['/mail/local-1'] },
              createElement(Routes, null,
                createElement(Route, { path: '/mail/:mailDomainId', element: createElement(MailDomainsPage) }),
              ),
            ),
          ),
        ),
      ),
    );
  });
  await flush();

  const panes = container.querySelectorAll('.ws-mail-pane');
  const tabLinks = container.querySelector('.ws-tabs').querySelectorAll('a');
  const mailboxesLink = tabLinks.find((link) => link.textContent.includes('Posta kutuları'));
  const webmailLink = tabLinks.find((link) => link.textContent.includes('Webmail'));
  const aliasesLink = tabLinks.find((link) => link.textContent.includes('Takma adlar'));

  // 1. Open MailboxCreateModal in MailboxesPanel and type a draft localPart & password
  const createMbBtn = panes[0].querySelectorAll((el) => el.tagName === 'BUTTON' && el.textContent.includes('Mailbox oluştur'))[0];
  assert.ok(createMbBtn, 'Mailbox oluştur button must exist');

  await act(async () => {
    clickElement(createMbBtn);
  });
  await flush();

  const modal = container.querySelector('.ws-modal');
  assert.ok(modal, 'MailboxCreateModal must be opened');
  const inputs = modal.querySelectorAll('input');
  assert.ok(inputs.length >= 2, 'Should have localPart and password inputs');

  await act(async () => {
    changeInput(inputs[0], 'draft-user');
    changeInput(inputs[1], 'SecretDraft123!');
  });
  await flush();

  assert.equal(inputs[0].value, 'draft-user');
  assert.equal(inputs[1].value, 'SecretDraft123!');

  // 2. Switch section to Webmail
  await act(async () => {
    clickElement(webmailLink);
  });
  await flush();

  assert.notEqual(panes[0].attributes.hidden, undefined, 'Mailboxes pane hidden during tab navigation');
  assert.equal(panes[1].attributes.hidden, undefined, 'Webmail pane now visible');

  // 3. Switch to Aliases and open an AliasEditor draft
  await act(async () => {
    clickElement(aliasesLink);
  });
  await flush();

  const createAliasBtn = panes[2].querySelectorAll((el) => el.tagName === 'BUTTON' && el.textContent.includes('Alias oluştur'))[0];
  assert.ok(createAliasBtn, 'Alias oluştur button must exist');

  await act(async () => {
    clickElement(createAliasBtn);
  });
  await flush();

  const aliasModals = container.querySelectorAll('.ws-modal');
  assert.ok(aliasModals.length >= 2, 'Both Mailbox and Alias modals exist simultaneously');

  const aliasSourceInput = panes[2].querySelector('.ws-modal').querySelector('input');
  await act(async () => {
    changeInput(aliasSourceInput, 'sales-team');
  });
  await flush();
  assert.equal(aliasSourceInput.value, 'sales-team');

  // 4. Switch back to Mailboxes tab: Verify mailbox modal & input draft survived completely
  await act(async () => {
    clickElement(mailboxesLink);
  });
  await flush();

  assert.equal(panes[0].attributes.hidden, undefined, 'Mailboxes pane restored to visible');
  assert.equal(inputs[0].value, 'draft-user', 'Draft user input preserved across tab navigation');
  assert.equal(inputs[1].value, 'SecretDraft123!', 'Draft password preserved across tab navigation');

  // 5. Switch back to Aliases tab: Verify alias modal & input draft survived completely
  await act(async () => {
    clickElement(aliasesLink);
  });
  await flush();

  assert.equal(panes[2].attributes.hidden, undefined, 'Aliases pane restored to visible');
  assert.equal(aliasSourceInput.value, 'sales-team', 'Alias draft source preserved across tab navigation');

  // 6. Verify durable job observation retention
  const sampleJob = { id: 'job-durable-1', type: 'mail-config', status: 'running', progress: 50 };
  workspaceValue.observe(sampleJob);
  assert.equal(observedJobs.length, 1);
  assert.equal(observedJobs[0].id, 'job-durable-1');

  // Switch tabs again: verify all panels and observed state remain intact
  await act(async () => {
    clickElement(webmailLink);
  });
  await flush();
  assert.equal(observedJobs.length, 1, 'Observed durable job survives tab navigation');

  await act(async () => {
    root.unmount();
  });
});

test('navigating between mail domains resets component identity and clears previous domain drafts/state', async () => {
  let navTarget = null;
  function NavigatorSpy() {
    const navigate = useNavigate();
    navTarget = navigate;
    return null;
  }

  const { fetchMock } = createMockFetchRouter({
    customHandler: (url) => {
      if (url.includes('/mail-domains/local-2/webmail')) {
        return new Response(JSON.stringify({ data: { mapping: null, job: null } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/mail-domains/local-2/dkim') || url.includes('/mail-domains/local-2/diagnostics/delivery')) {
        return new Response(JSON.stringify({ data: null }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/mail-domains/local-2')) {
        return new Response(JSON.stringify({ data: mockDomains[1] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/mailboxes') && url.includes('local-2')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/mail-aliases') && url.includes('local-2')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return undefined;
    },
  });
  globalThis.fetch = fetchMock;

  const workspaceValue = createWorkspace();
  const container = doc.createElement('div');
  const root = createRoot(container);

  await act(async () => {
    root.render(
      createElement(StrictMode, null,
        createElement(PanelSessionProvider, { session },
          createElement(WorkspaceContext.Provider, { value: workspaceValue },
            createElement(MemoryRouter, { initialEntries: ['/mail/local-1'] },
              createElement(NavigatorSpy),
              createElement(Routes, null,
                createElement(Route, { path: '/mail/:mailDomainId', element: createElement(MailDomainsPage) }),
              ),
            ),
          ),
        ),
      ),
    );
  });
  await flush();

  // In local-1: Open MailboxCreateModal and enter draft
  const createMbBtn = container.querySelectorAll((el) => el.tagName === 'BUTTON' && el.textContent.includes('Mailbox oluştur'))[0];
  await act(async () => {
    clickElement(createMbBtn);
  });
  await flush();

  const modal = container.querySelector('.ws-modal');
  assert.ok(modal, 'Modal should be open in local-1');
  const input = modal.querySelector('input');
  await act(async () => {
    changeInput(input, 'local1-draft-user');
  });
  await flush();
  assert.equal(input.value, 'local1-draft-user');

  // Navigate to local-2 (domain change)
  await act(async () => {
    navTarget('/mail/local-2');
  });
  await flush();

  // Verify that MailDomainDetail key={mailDomainId} remounted fresh
  assert.ok(container.textContent.includes('istanbul-ticaret.com'), 'Now shows local-2 domain title');
  const remainingModals = container.querySelectorAll('.ws-modal');
  assert.equal(remainingModals.length, 0, 'All modals from local-1 must be unmounted and closed');
  assert.ok(!container.textContent.includes('local1-draft-user'), 'Draft from previous domain must not leak into new domain');

  await act(async () => {
    root.unmount();
  });
});

test('real session actions: authentic SMTP test delivery, DKIM preview & apply with durable job observation', async () => {
  const observedJobs = [];
  const { fetchMock, apiCalls } = createMockFetchRouter({
    customHandler: (url, method, body) => {
      // SMTP Domain Test Delivery
      if (url.includes('/mail-domains/local-1/test-delivery') && method === 'POST') {
        return new Response(JSON.stringify({
          data: {
            delivered: true,
            recipient: body.recipient,
            routing: 'local',
            messageId: 'msg-smtp-test-1234',
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      // SMTP Mailbox Test Delivery
      if (url.includes('/mailboxes/mb-1/test-delivery') && method === 'POST') {
        return new Response(JSON.stringify({
          data: {
            delivered: true,
            recipient: body.recipient,
            routing: 'local',
            messageId: 'msg-mb-smtp-5678',
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      // DKIM Preview
      if (url.includes('/mail-domains/local-1/dkim/config-preview') && method === 'POST') {
        return new Response(JSON.stringify({
          data: {
            readyToApply: true,
            selector: 'mail',
            previewDigest: 'digest-dkim-999',
            configuration: { sha256: 'sha256-dkim-888', domains: 'şirket-ana.com' },
            confirmation: 'apply-dkim:local-1:mail',
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      // DKIM Apply
      if (url.includes('/mail-domains/local-1/dkim/config-apply') && method === 'POST') {
        return new Response(JSON.stringify({
          data: {
            id: 'job-dkim-apply-1',
            type: 'mail_dkim_apply',
            status: 'running',
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return undefined;
    },
  });
  globalThis.fetch = fetchMock;

  const workspaceValue = createWorkspace(observedJobs);
  const container = doc.createElement('div');
  const root = createRoot(container);

  await act(async () => {
    root.render(
      createElement(StrictMode, null,
        createElement(PanelSessionProvider, { session },
          createElement(WorkspaceContext.Provider, { value: workspaceValue },
            createElement(MemoryRouter, { initialEntries: ['/mail/local-1?section=security'] },
              createElement(Routes, null,
                createElement(Route, { path: '/mail/:mailDomainId', element: createElement(MailDomainsPage) }),
              ),
            ),
          ),
        ),
      ),
    );
  });
  await flush();

  const panes = container.querySelectorAll('.ws-mail-pane');
  const securityPane = panes[3];

  // 1. SMTP Domain Test Delivery in Security (DKIM) panel
  const testInput = securityPane.querySelector('input[type="email"]');
  assert.ok(testInput, 'Test recipient email input exists in DKIM diagnostics');

  await act(async () => {
    changeInput(testInput, 'probe@cryptoraichu.website');
  });
  await flush();

  const sendTestBtn = securityPane.querySelectorAll((el) => el.tagName === 'BUTTON' && el.textContent.includes('Test E-postası Gönder'))[0];
  assert.ok(sendTestBtn, 'Send test button exists');

  await act(async () => {
    clickElement(sendTestBtn);
  });
  await flush();

  const smtpCall = apiCalls.find((c) => c.url.includes('/mail-domains/local-1/test-delivery'));
  assert.ok(smtpCall, 'SMTP domain test delivery endpoint called');
  assert.equal(smtpCall.body.recipient, 'probe@cryptoraichu.website');
  assert.ok(securityPane.textContent.includes('Test E-postası Başarıyla Gönderildi'), 'SMTP success notice rendered');
  assert.ok(securityPane.textContent.includes('msg-smtp-test-1234'), 'Message ID displayed');

  // 2. DKIM Preview & Apply with durable job observation
  const previewBtn = securityPane.querySelectorAll((el) => el.tagName === 'BUTTON' && el.textContent.includes('Signing preview'))[0];
  assert.ok(previewBtn, 'Signing preview button exists');

  await act(async () => {
    clickElement(previewBtn);
  });
  await flush();

  const dkimPreviewCall = apiCalls.find((c) => c.url.includes('/dkim/config-preview') && c.method === 'POST');
  assert.ok(dkimPreviewCall, 'DKIM preview endpoint called');
  assert.ok(securityPane.textContent.includes('digest-dkim-999'), 'Preview digest rendered');

  const applyBtn = securityPane.querySelectorAll((el) => el.tagName === 'BUTTON' && el.textContent.includes('DKIM signing apply'))[0];
  assert.ok(applyBtn, 'DKIM signing apply button exists');

  await act(async () => {
    clickElement(applyBtn);
  });
  await flush();

  const confirmDialog = container.querySelector('.ws-modal');
  assert.ok(confirmDialog, 'ConfirmDialog must appear for DKIM apply');
  const confirmInput = confirmDialog.querySelector('input');
  if (confirmInput) {
    await act(async () => {
      changeInput(confirmInput, 'apply-dkim:local-1:mail');
    });
    await flush();
  }
  const confirmBtn = confirmDialog.querySelectorAll((el) => el.tagName === 'BUTTON' && el.textContent.includes('DKIM apply'))[0];

  await act(async () => {
    clickElement(confirmBtn);
  });
  await flush();

  const dkimApplyCall = apiCalls.find((c) => c.url.includes('/dkim/config-apply') && c.method === 'POST');
  assert.ok(dkimApplyCall, 'DKIM apply endpoint called');
  assert.equal(observedJobs.length, 1, 'Job observer must be invoked');
  assert.equal(observedJobs[0].id, 'job-dkim-apply-1', 'Observed DKIM durable job');
  assert.ok(securityPane.textContent.includes('DKIM configuration işi kuyruğa alındı'), 'Job queue notice displayed');

  // 3. SMTP Mailbox Delivery Test via MailboxDiagnosticsModal in Mailboxes panel
  const tabLinks = container.querySelector('.ws-tabs').querySelectorAll('a');
  const mailboxesLink = tabLinks.find((l) => l.textContent.includes('Posta kutuları'));
  await act(async () => {
    clickElement(mailboxesLink);
  });
  await flush();

  const mailboxesPane = panes[0];
  const diagBtn = mailboxesPane.querySelectorAll((el) => el.tagName === 'BUTTON' && el.textContent.includes('Tanılama'))[0];
  assert.ok(diagBtn, 'Tanılama button on mailbox row must exist');

  await act(async () => {
    clickElement(diagBtn);
  });
  await flush();

  const diagModal = container.querySelector('.ws-modal');
  assert.ok(diagModal, 'MailboxDiagnosticsModal must be open');
  assert.ok(diagModal.textContent.includes('İstemci Bağlantı Ayarları'), 'Modal renders client connection settings');
  assert.ok(diagModal.textContent.includes('Posta Kutusu Durumu'), 'Modal renders mailbox reception status');

  const mbTestInput = diagModal.querySelector('input');
  assert.ok(mbTestInput, 'Test recipient input in mailbox modal');
  await act(async () => {
    changeInput(mbTestInput, 'client-box@cryptoraichu.website');
  });
  await flush();

  const mbSendBtn = diagModal.querySelectorAll((el) => el.tagName === 'BUTTON' && el.textContent.includes('Test E-postası Gönder'))[0];
  await act(async () => {
    clickElement(mbSendBtn);
  });
  await flush();

  const mbSmtpCall = apiCalls.find((c) => c.url.includes('/mailboxes/mb-1/test-delivery'));
  assert.ok(mbSmtpCall, 'Mailbox test delivery endpoint called');
  assert.equal(mbSmtpCall.body.recipient, 'client-box@cryptoraichu.website');
  assert.ok(diagModal.textContent.includes('Test E-postası Başarıyla Gönderildi'), 'Mailbox test success notice displayed');

  await act(async () => {
    root.unmount();
  });
});

test('real session actions: Roundcube webmail preview & bind with durable job observation', async () => {
  const observedJobs = [];
  const { fetchMock, apiCalls } = createMockFetchRouter({
    customHandler: (url, method) => {
      // Unmapped initial state to exercise bind
      if (url.includes('/mail-domains/local-1/webmail') && method === 'GET') {
        return new Response(JSON.stringify({ data: { mapping: null, job: null } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/mail-domains/local-1/webmail/bind-preview') && method === 'POST') {
        return new Response(JSON.stringify({
          data: {
            readyToApply: true,
            hostname: 'webmail.şirket-ana.com',
            previewDigest: 'digest-rc-bind-777',
            confirmation: 'bind-webmail:local-1',
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/mail-domains/local-1/webmail/bind') && method === 'POST') {
        return new Response(JSON.stringify({
          data: {
            job: {
              id: 'job-rc-bind-99',
              type: 'mail_webmail_bind',
              status: 'running',
            },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/roundcube/config-apply') && method === 'POST') {
        return new Response(JSON.stringify({
          data: {
            id: 'job-rc-global-apply-55',
            type: 'roundcube_apply',
            status: 'running',
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return undefined;
    },
  });
  globalThis.fetch = fetchMock;

  const workspaceValue = createWorkspace(observedJobs);
  const container = doc.createElement('div');
  const root = createRoot(container);

  await act(async () => {
    root.render(
      createElement(StrictMode, null,
        createElement(PanelSessionProvider, { session },
          createElement(WorkspaceContext.Provider, { value: workspaceValue },
            createElement(MemoryRouter, { initialEntries: ['/mail/local-1?section=webmail'] },
              createElement(Routes, null,
                createElement(Route, { path: '/mail/:mailDomainId', element: createElement(MailDomainsPage) }),
              ),
            ),
          ),
        ),
      ),
    );
  });
  await flush();

  const panes = container.querySelectorAll('.ws-mail-pane');
  const webmailPane = panes[1];

  // 1. Preview Roundcube Bind
  const previewBtn = webmailPane.querySelectorAll((el) => el.tagName === 'BUTTON' && el.textContent.includes('Önizleme Oluştur'))[0];
  assert.ok(previewBtn, 'Önizleme Oluştur button must exist in Webmail panel');

  await act(async () => {
    clickElement(previewBtn);
  });
  await flush();

  const bindPreviewCall = apiCalls.find((c) => c.url.includes('/webmail/bind-preview') && c.method === 'POST');
  assert.ok(bindPreviewCall, 'previewBindMailWebmail endpoint called');
  assert.equal(bindPreviewCall.body.certificateId, 'cert-1');
  assert.ok(webmailPane.textContent.includes('digest-rc-bind-777'), 'Preview digest rendered');

  // 2. Bind Roundcube with ConfirmDialog
  const bindBtn = webmailPane.querySelectorAll((el) => el.tagName === 'BUTTON' && el.textContent.includes('Webmail (Roundcube) Bağla'))[0];
  assert.ok(bindBtn, 'Webmail Bağla button must exist');

  await act(async () => {
    clickElement(bindBtn);
  });
  await flush();

  const confirmDialog = container.querySelector('.ws-modal');
  assert.ok(confirmDialog, 'ConfirmDialog for Webmail bind appears');
  const confirmInput = confirmDialog.querySelector('input');
  if (confirmInput) {
    await act(async () => {
      changeInput(confirmInput, 'bind-webmail:local-1');
    });
    await flush();
  }
  const confirmBtn = confirmDialog.querySelectorAll((el) => el.tagName === 'BUTTON' && el.textContent.includes('Webmail Bağla'))[0];

  await act(async () => {
    clickElement(confirmBtn);
  });
  await flush();

  const bindCall = apiCalls.find((c) => c.url.includes('/webmail/bind'));
  assert.ok(bindCall, 'bindMailWebmail endpoint called');
  assert.equal(observedJobs.length, 1, 'Observed Roundcube bind durable job');
  assert.equal(observedJobs[0].id, 'job-rc-bind-99');

  // 3. Roundcube Global Operations Apply in Operations Panel
  const tabLinks = container.querySelector('.ws-tabs').querySelectorAll('a');
  const opsLink = tabLinks.find((l) => l.textContent.includes('Kuyruk ve loglar'));
  await act(async () => {
    clickElement(opsLink);
  });
  await flush();

  const opsPane = panes[5];
  assert.ok(opsPane.textContent.includes('Roundcube webmail'), 'Operations panel rendered');
  const configApplyBtn = opsPane.querySelectorAll((el) => el.tagName === 'BUTTON' && el.textContent.includes('Config apply'))[0];
  assert.ok(configApplyBtn, 'Roundcube Config apply button must exist');

  await act(async () => {
    clickElement(configApplyBtn);
  });
  await flush();

  const rcConfirmDialog = container.querySelector('.ws-modal');
  assert.ok(rcConfirmDialog, 'ConfirmDialog for Roundcube global apply appears');
  const rcConfirmBtn = rcConfirmDialog.querySelectorAll((el) => el.tagName === 'BUTTON' && el.textContent.includes('Roundcube apply'))[0];

  await act(async () => {
    clickElement(rcConfirmBtn);
  });
  await flush();

  const rcApplyCall = apiCalls.find((c) => c.url.includes('/roundcube/config-apply'));
  assert.ok(rcApplyCall, 'applyRoundcube endpoint called');
  assert.equal(observedJobs.length, 2, 'Observed global Roundcube durable job');
  assert.equal(observedJobs[1].id, 'job-rc-global-apply-55');

  await act(async () => {
    root.unmount();
  });
});

test('real session actions: mailbox lifecycle (create, password rotation) and alias lifecycle (create, update, delete)', async () => {
  const { fetchMock, apiCalls } = createMockFetchRouter({
    customHandler: (url, method, body) => {
      // Mailbox create
      if (url.includes('/mailboxes') && method === 'POST') {
        return new Response(JSON.stringify({
          data: { id: 'mb-created-1', mailDomainId: 'local-1', address: body.address, revision: 1 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // Mailbox password rotation
      if (url.includes('/mailboxes/mb-1/password') && method === 'POST') {
        return new Response(JSON.stringify({
          data: { id: 'mb-1', revision: 2 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // Alias create
      if (url.includes('/mail-aliases') && method === 'POST') {
        return new Response(JSON.stringify({
          data: { id: 'al-created-1', mailDomainId: 'local-1', source: body.source, destinations: body.destinations, revision: 1 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // Alias update
      if (url.includes('/mail-aliases/al-1') && method === 'PATCH') {
        return new Response(JSON.stringify({
          data: { id: 'al-1', revision: 2, destinations: body.destinations },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // Alias delete
      if (url.includes('/mail-aliases/al-1') && method === 'DELETE') {
        return new Response(JSON.stringify({ data: { deleted: true } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return undefined;
    },
  });
  globalThis.fetch = fetchMock;

  const workspaceValue = createWorkspace();
  const container = doc.createElement('div');
  const root = createRoot(container);

  await act(async () => {
    root.render(
      createElement(StrictMode, null,
        createElement(PanelSessionProvider, { session },
          createElement(WorkspaceContext.Provider, { value: workspaceValue },
            createElement(MemoryRouter, { initialEntries: ['/mail/local-1?section=mailboxes'] },
              createElement(Routes, null,
                createElement(Route, { path: '/mail/:mailDomainId', element: createElement(MailDomainsPage) }),
              ),
            ),
          ),
        ),
      ),
    );
  });
  await flush();

  const panes = container.querySelectorAll('.ws-mail-pane');
  const mailboxesPane = panes[0];

  // 1. Mailbox Create
  const createMbBtn = mailboxesPane.querySelectorAll((el) => el.tagName === 'BUTTON' && el.textContent.includes('Mailbox oluştur'))[0];
  await act(async () => {
    clickElement(createMbBtn);
  });
  await flush();

  const createModal = container.querySelector('.ws-modal');
  assert.ok(createModal, 'MailboxCreateModal is displayed');
  const mbInputs = createModal.querySelectorAll('input');
  await act(async () => {
    changeInput(mbInputs[0], 'destek');
    changeInput(mbInputs[1], 'GuvenliParola2026!');
  });
  await flush();

  const mbSubmitForm = createModal.querySelector('form');
  await act(async () => {
    submitForm(mbSubmitForm);
  });
  await flush();

  const mbCreateCall = apiCalls.find((c) => c.url.includes('/mailboxes') && c.method === 'POST');
  assert.ok(mbCreateCall, 'createMailbox endpoint called');
  assert.equal(mbCreateCall.body.mailDomainId, 'local-1');
  assert.equal(mbCreateCall.body.address, 'destek@şirket-ana.com');
  assert.equal(mbCreateCall.body.password, 'GuvenliParola2026!');

  // 2. Mailbox Password Rotation
  const pwdBtn = mailboxesPane.querySelectorAll((el) => el.tagName === 'BUTTON' && el.textContent === 'Parola')[0];
  assert.ok(pwdBtn, 'Parola button must exist on mailbox row');

  await act(async () => {
    clickElement(pwdBtn);
  });
  await flush();

  const pwdModal = container.querySelector('.ws-modal');
  assert.ok(pwdModal, 'PasswordModal is displayed');
  const pwdInput = pwdModal.querySelector('input[type="password"]');
  await act(async () => {
    changeInput(pwdInput, 'YeniSifre2026*');
  });
  await flush();

  const pwdForm = pwdModal.querySelector('form');
  await act(async () => {
    submitForm(pwdForm);
  });
  await flush();

  const pwdCall = apiCalls.find((c) => c.url.includes('/password') && c.method === 'POST');
  assert.ok(pwdCall, 'rotateMailboxPassword endpoint called');
  assert.equal(pwdCall.body.expectedRevision, 1);
  assert.equal(pwdCall.body.password, 'YeniSifre2026*');

  // 3. Switch to Aliases tab for Alias lifecycle
  const tabLinks = container.querySelector('.ws-tabs').querySelectorAll('a');
  const aliasesLink = tabLinks.find((l) => l.textContent.includes('Takma adlar'));
  await act(async () => {
    clickElement(aliasesLink);
  });
  await flush();

  const aliasesPane = panes[2];

  // 3a. Alias Create
  const createAliasBtn = aliasesPane.querySelectorAll((el) => el.tagName === 'BUTTON' && el.textContent.includes('Alias oluştur'))[0];
  await act(async () => {
    clickElement(createAliasBtn);
  });
  await flush();

  const aliasModal = container.querySelector('.ws-modal');
  assert.ok(aliasModal, 'AliasEditor modal is displayed');
  const aliasSourceInput = aliasModal.querySelector('input');
  const aliasDestTextarea = aliasModal.querySelector('textarea');
  await act(async () => {
    changeInput(aliasSourceInput, 'satis');
    changeInput(aliasDestTextarea, 'admin@şirket-ana.com\ninfo@şirket-ana.com');
  });
  await flush();

  const aliasForm = aliasModal.querySelector('form');
  await act(async () => {
    submitForm(aliasForm);
  });
  await flush();

  const aliasCreateCall = apiCalls.find((c) => c.url.includes('/mail-aliases') && c.method === 'POST');
  assert.ok(aliasCreateCall, 'createMailAlias endpoint called');
  assert.equal(aliasCreateCall.body.mailDomainId, 'local-1');
  assert.equal(aliasCreateCall.body.source, 'satis@şirket-ana.com');
  assert.deepEqual(aliasCreateCall.body.destinations, ['admin@şirket-ana.com', 'info@şirket-ana.com']);

  // 3b. Alias Update
  const editAliasBtn = aliasesPane.querySelectorAll((el) => el.tagName === 'BUTTON' && el.textContent.includes('Düzenle'))[0];
  assert.ok(editAliasBtn, 'Düzenle button exists on alias row');

  await act(async () => {
    clickElement(editAliasBtn);
  });
  await flush();

  const editModal = container.querySelector('.ws-modal');
  const editDestTextarea = editModal.querySelector('textarea');
  await act(async () => {
    changeInput(editDestTextarea, 'guncel@şirket-ana.com');
  });
  await flush();

  const editForm = editModal.querySelector('form');
  await act(async () => {
    submitForm(editForm);
  });
  await flush();

  const aliasUpdateCall = apiCalls.find((c) => c.url.includes('/mail-aliases/al-1') && c.method === 'PATCH');
  assert.ok(aliasUpdateCall, 'updateMailAlias endpoint called');
  assert.equal(aliasUpdateCall.body.expectedRevision, 1);
  assert.deepEqual(aliasUpdateCall.body.destinations, ['guncel@şirket-ana.com']);

  // 3c. Alias Delete
  const delAliasBtn = aliasesPane.querySelectorAll((el) => el.tagName === 'BUTTON' && el.textContent.includes('Sil'))[0];
  assert.ok(delAliasBtn, 'Sil button exists on alias row');

  await act(async () => {
    clickElement(delAliasBtn);
  });
  await flush();

  const delConfirmDialog = container.querySelector('.ws-modal');
  assert.ok(delConfirmDialog, 'ConfirmDialog for alias deletion appears');
  const delConfirmInput = delConfirmDialog.querySelector('input');
  if (delConfirmInput) {
    await act(async () => {
      changeInput(delConfirmInput, 'delete-mail-alias:iletisim@şirket-ana.com');
    });
    await flush();
  }
  const delConfirmBtn = delConfirmDialog.querySelectorAll((el) => el.tagName === 'BUTTON' && el.textContent.includes('Aliası sil'))[0];

  await act(async () => {
    clickElement(delConfirmBtn);
  });
  await flush();

  const aliasDeleteCall = apiCalls.find((c) => c.url.includes('/mail-aliases/al-1') && c.method === 'DELETE');
  assert.ok(aliasDeleteCall, 'deleteMailAlias endpoint called');
  assert.equal(aliasDeleteCall.body.expectedRevision, 1);
  assert.equal(aliasDeleteCall.body.confirmation, 'delete-mail-alias:iletisim@şirket-ana.com');

  await act(async () => {
    root.unmount();
  });
});

test('real session actions: mail configuration preview & apply with durable job observation', async () => {
  const observedJobs = [];
  const { fetchMock, apiCalls } = createMockFetchRouter({
    customHandler: (url, method, body) => {
      // Config Preview
      if (url.includes('/config-preview') && method === 'POST') {
        return new Response(JSON.stringify({
          data: {
            readyToApply: true,
            currentStatus: 'enabled',
            desiredStatus: body.status,
            domains: ['şirket-ana.com'],
            previewDigest: 'digest-cfg-apply-111',
            configuration: {
              sha256: 'sha-host-config-222',
              artifactDigests: [{ path: '/etc/postfix/main.cf', sha256: 'postfix-sha', sensitive: false }],
              counts: { mailboxes: 2, aliases: 1 },
            },
            confirmation: 'apply-mail-config:local-1',
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      // Config Apply
      if (url.includes('/config-apply') && method === 'POST') {
        return new Response(JSON.stringify({
          data: {
            id: 'job-mail-config-88',
            type: 'mail_configuration_apply',
            status: 'running',
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return undefined;
    },
  });
  globalThis.fetch = fetchMock;

  const workspaceValue = createWorkspace(observedJobs);
  const container = doc.createElement('div');
  const root = createRoot(container);

  await act(async () => {
    root.render(
      createElement(StrictMode, null,
        createElement(PanelSessionProvider, { session },
          createElement(WorkspaceContext.Provider, { value: workspaceValue },
            createElement(MemoryRouter, { initialEntries: ['/mail/local-1?section=configuration'] },
              createElement(Routes, null,
                createElement(Route, { path: '/mail/:mailDomainId', element: createElement(MailDomainsPage) }),
              ),
            ),
          ),
        ),
      ),
    );
  });
  await flush();

  const panes = container.querySelectorAll('.ws-mail-pane');
  const configPane = panes[4];
  assert.ok(configPane.textContent.includes('Host mail configuration'), 'Configuration panel rendered');

  // Change desired status to 'disabled'
  const statusSelect = configPane.querySelector('select');
  assert.ok(statusSelect, 'Status select dropdown must exist');
  await act(async () => {
    changeInput(statusSelect, 'disabled');
  });
  await flush();

  // Click Preview oluştur
  const previewBtn = configPane.querySelectorAll((el) => el.tagName === 'BUTTON' && el.textContent.includes('Preview oluştur'))[0];
  assert.ok(previewBtn, 'Preview oluştur button must exist');

  await act(async () => {
    clickElement(previewBtn);
  });
  await flush();

  const configPreviewCall = apiCalls.find((c) => c.url.includes('/mail-domains/local-1/config-preview') && c.method === 'POST');
  assert.ok(configPreviewCall, 'previewMailConfiguration endpoint called');
  assert.equal(configPreviewCall.body.expectedRevision, 2);
  assert.equal(configPreviewCall.body.status, 'disabled');
  assert.ok(configPane.textContent.includes('digest-cfg-apply-111'), 'Preview digest rendered');
  assert.ok(configPane.textContent.includes('sha-host-config-222'), 'Config SHA rendered');

  // Click Apply Preview
  const applyBtn = configPane.querySelectorAll((el) => el.tagName === 'BUTTON' && el.textContent.includes('Bu preview’ı apply et'))[0];
  assert.ok(applyBtn, 'Bu preview’ı apply et button must exist');

  await act(async () => {
    clickElement(applyBtn);
  });
  await flush();

  const confirmDialog = container.querySelector('.ws-modal');
  assert.ok(confirmDialog, 'ConfirmDialog for Mail configuration appears');
  const confirmInput = confirmDialog.querySelector('input');
  if (confirmInput) {
    await act(async () => {
      changeInput(confirmInput, 'apply-mail-config:local-1');
    });
    await flush();
  }
  const confirmBtn = confirmDialog.querySelectorAll((el) => el.tagName === 'BUTTON' && el.textContent.includes('Mail config apply'))[0];

  await act(async () => {
    clickElement(confirmBtn);
  });
  await flush();

  const configApplyCall = apiCalls.find((c) => c.url.includes('/mail-domains/local-1/config-apply') && c.method === 'POST');
  assert.ok(configApplyCall, 'applyMailConfiguration endpoint called');
  assert.equal(configApplyCall.body.expectedRevision, 2);
  assert.equal(configApplyCall.body.status, 'disabled');
  assert.equal(configApplyCall.body.previewDigest, 'digest-cfg-apply-111');
  assert.equal(observedJobs.length, 1, 'Observed mail config apply durable job');
  assert.equal(observedJobs[0].id, 'job-mail-config-88');
  assert.ok(configPane.textContent.includes('Mail configuration işi kuyruğa alındı'), 'Job queue notice displayed');

  await act(async () => {
    root.unmount();
  });
});
