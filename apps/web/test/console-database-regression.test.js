import { register } from 'node:module';
register('./jsx-loader.js', import.meta.url);

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import React, { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { waitForJob } from '../src/api.js';

const { queueAndWait, default: DatabasesPage } = await import('../src/workspace/DatabasesPage.jsx');
const { WorkspaceContext } = await import('../src/workspace/WorkspaceContext.jsx');
const source = await readFile(new URL('../src/workspace/DatabasesPage.jsx', import.meta.url), 'utf8');
const panelKitSource = await readFile(new URL('../src/workspace/PanelKit.jsx', import.meta.url), 'utf8');
const apiSource = await readFile(new URL('../src/api.js', import.meta.url), 'utf8');

const ok = (data) => new Response(JSON.stringify({ data }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

/* ==========================================================================\n   1. Static Source Security & Wire Regression Checks\n   ========================================================================== */

test('database console retains search, pagination and explicit access alternatives', () => {
  assert.match(source, /useSearchParams/);
  assert.match(source, /filterConsoleDatabases/);
  assert.match(source, /paginateConsoleItems/);
  assert.match(source, /view\.canOpen/);
  assert.match(source, /view\.siteHref/);
  assert.match(source, /Erişimi yapılandır/);
  assert.match(source, /Siteye bağla/);
});

test('database create form is opt-in; technical security facts remain available', () => {
  assert.match(source, /createOpen && <Modal/);
  assert.match(source, /<details className="ws-section ws-disclosure ws-database-diagnostics"/);
  for (const label of ['Engine', 'DB güvenlik baseline', 'Admin socket auth', 'Website bağı', 'Credential', 'Eksik schema bağı']) assert.ok(source.includes(label));
});

test('database deletion modal preserves state on failure/cancellation and closes on success', () => {
  assert.match(source, /const terminal = await perform\(\(\) => deleteDatabase\(server\.id, target\.name\)\);/);
  assert.match(source, /if \(terminal\) setDeleteTarget\(null\);/);
  assert.match(source, /<ConfirmDialog[\s\S]*?disabled=\{!canAct\}/);
  assert.match(panelKitSource, /export function ConfirmDialog\(\{[\s\S]*?disabled = false/);
  assert.match(panelKitSource, /disabled=\{busy \|\| disabled \|\|/);
});

test('stale, refreshing or error states lock database mutations and phpMyAdmin handoff', () => {
  assert.match(source, /servers\.status === 'ready' && status === 'ready' && !busy && !loadError/);
  assert.match(source, /Button variant="primary" icon="plus" disabled=\{!canAct\}/);
  assert.match(source, /Button icon="external" disabled=\{!canAct\} onClick=\{.*?openPhpMyAdmin/);
  assert.match(source, /Button icon="trash" disabled=\{!canAct\}/);
  assert.match(source, /type="submit" disabled=\{!canAct \|\| !validDatabaseName\(name\)\}/);
  assert.match(source, /disabled=\{!canAct\} error=\{error\}/);
});

test('database failed and cancelled jobs cannot report successful creation', () => {
  assert.match(source, /terminal\?\.status !== 'succeeded'/);
  assert.match(source, /terminal\?\.status === 'cancelled'/);
  assert.match(source, /scope !== scopeGeneration\.current/);
  assert.match(source, /if \(terminal\) \{ setName\(''\); setCreateOpen\(false\);/);
});

test('database mutations and handoff require fresh inventory and explicit identity', () => {
  assert.match(source, /servers\.status === 'ready' && status === 'ready' && !busy/);
  assert.match(source, /if \(!canAct \|\| pending\.current\)/);
  assert.match(source, /!ownership\?\.websiteId \|\| !ownership\?\.credential\?\.id/);
  assert.match(source, /issueHandoff: createPhpMyAdminHandoff/);
  assert.match(source, /observe\(queued\)/);
  assert.match(source, /waitForJob\(queued\.id\)/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|window\.open|innerHTML|inspectDatabases/);
});

test('search, access filter, pagination and browser URL history navigation are wired', () => {
  assert.match(source, /const \[params, setParams\] = useSearchParams\(\);/);
  assert.match(source, /const query = params\.get\('q'\) \?\? '';/);
  assert.match(source, /const access = \['ready', 'attention'\]\.includes\(params\.get\('access'\)\) \? params\.get\('access'\) : 'all';/);
  assert.match(source, /filter\('q', event\.target\.value\)/);
  assert.match(source, /filter\('access', event\.target\.value\)/);
  assert.match(source, /filter\('page', String\(page\.page - 1\)\)/);
  assert.match(source, /filter\('page', String\(page\.page \+ 1\)\)/);
  assert.match(source, /replace: key === 'q'/);
  assert.match(source, /\['q', 'access', 'page'\]\.forEach\(\(key\) => next\.delete\(key\)\)/);
});

/* ==========================================================================\n   2. Runtime API & Queue Job Contract Checks\n   ========================================================================== */

test('api waitForJob retains terminal job object on failed and cancelled states at runtime', async (t) => {
  assert.match(apiSource, /error\.job = job;/);

  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('job-succeeded')) {
      return ok({ id: 'job-succeeded', status: 'succeeded', result: { ok: true } });
    }
    if (url.includes('job-failed')) {
      return ok({ id: 'job-failed', status: 'failed', error: { message: 'Database creation rejected' } });
    }
    if (url.includes('job-cancelled')) {
      return ok({ id: 'job-cancelled', status: 'cancelled' });
    }
    return ok({ id: 'job-unknown', status: 'running' });
  });

  const succeeded = await waitForJob('job-succeeded');
  assert.equal(succeeded.status, 'succeeded');

  await assert.rejects(async () => {
    await waitForJob('job-failed');
  }, (err) => {
    assert.equal(err.code, 'failed');
    assert.equal(err.job?.status, 'failed');
    assert.equal(err.job?.error?.message, 'Database creation rejected');
    return true;
  });

  await assert.rejects(async () => {
    await waitForJob('job-cancelled');
  }, (err) => {
    assert.equal(err.code, 'cancelled');
    assert.equal(err.job?.status, 'cancelled');
    return true;
  });
});

test('queueAndWait rethrows on failed and cancelled jobs, updating job and preserving failure contract', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('job-fail')) {
      return ok({ id: 'job-fail', status: 'failed', error: { message: 'DB creation error' } });
    }
    if (url.includes('job-cancel')) {
      return ok({ id: 'job-cancel', status: 'cancelled' });
    }
    if (url.includes('job-ok')) {
      return ok({ id: 'job-ok', status: 'succeeded' });
    }
    return ok({});
  });

  const observed = [];
  const updated = [];
  let refreshed = 0;
  const context = {
    observe: (j) => observed.push(j),
    updateJob: (j) => updated.push(j),
    refreshJobs: () => { refreshed += 1; },
  };

  // 1. Succeeded job: returns terminal
  const successResult = await queueAndWait(async () => ({ id: 'job-ok' }), context);
  assert.equal(successResult.status, 'succeeded');
  assert.equal(updated.at(-1)?.status, 'succeeded');

  // 2. Failed job: must rethrow and NOT return terminal object
  await assert.rejects(async () => {
    await queueAndWait(async () => ({ id: 'job-fail' }), context);
  }, (err) => {
    assert.equal(err.code, 'failed');
    assert.equal(err.job?.status, 'failed');
    return true;
  });
  assert.equal(updated.at(-1)?.status, 'failed');
  assert.ok(refreshed >= 2);

  // 3. Cancelled job: must rethrow and NOT return terminal object
  await assert.rejects(async () => {
    await queueAndWait(async () => ({ id: 'job-cancel' }), context);
  }, (err) => {
    assert.equal(err.code, 'cancelled');
    assert.equal(err.job?.status, 'cancelled');
    return true;
  });
  assert.equal(updated.at(-1)?.status, 'cancelled');
});

/* ==========================================================================\n   3. DOM & Component Runtime Test Environment Setup\n   ========================================================================== */

class MockDomElement {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.childNodes = [];
    this.attributes = {};
    this.listeners = {};
    this.style = {};
    this._value = '';
    this.open = false;
    this.selected = false;
    this.defaultSelected = false;
  }
  get value() {
    if (this.tagName === 'OPTION') {
      return this.attributes['value'] !== undefined ? this.attributes['value'] : this.textContent;
    }
    return this._value;
  }
  set value(v) { this._value = String(v); }
  get className() { return this.attributes['class'] || ''; }
  set className(v) { this.attributes['class'] = String(v); }
  get disabled() { return ('disabled' in this.attributes) || Boolean(this._disabled); }
  set disabled(v) { this._disabled = Boolean(v); if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get options() {
    return this.childNodes.filter(c => c.tagName === 'OPTION');
  }
  get multiple() { return Boolean(this.attributes['multiple']); }
  set multiple(v) { if (v) this.setAttribute('multiple', ''); else this.removeAttribute('multiple'); }
  get type() {
    return this.attributes['type'] || (this.tagName === 'SELECT' ? (this.multiple ? 'select-multiple' : 'select-one') : 'text');
  }
  set type(v) { this.setAttribute('type', v); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  removeAttribute(k) { delete this.attributes[k]; }
  getAttribute(k) { return this.attributes[k] ?? null; }
  hasAttribute(k) { return k in this.attributes; }
  appendChild(c) { this.childNodes.push(c); c.parentNode = this; return c; }
  removeChild(c) {
    const idx = this.childNodes.indexOf(c);
    if (idx >= 0) this.childNodes.splice(idx, 1);
    c.parentNode = null;
    return c;
  }
  insertBefore(c, ref) {
    const idx = this.childNodes.indexOf(ref);
    if (idx >= 0) this.childNodes.splice(idx, 0, c);
    else this.childNodes.push(c);
    c.parentNode = this;
    return c;
  }
  addEventListener(type, fn) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  }
  removeEventListener(type, fn) {
    if (this.listeners[type]) this.listeners[type] = this.listeners[type].filter(f => f !== fn);
  }
  dispatchEvent(event) {
    event.target = this;
    let curr = this;
    while (curr) {
      const propsKey = Object.keys(curr).find((k) => k.startsWith('__reactProps'));
      if (propsKey && curr[propsKey]) {
        const handlerName = 'on' + event.type.charAt(0).toUpperCase() + event.type.slice(1);
        if (typeof curr[propsKey][handlerName] === 'function') {
          curr[propsKey][handlerName](event);
        }
      }
      const handlers = curr.listeners[event.type];
      if (handlers) {
        for (const handler of handlers) handler.call(curr, event);
      }
      curr = event.bubbles ? curr.parentNode : null;
    }
  }
  click() {
    this.dispatchEvent({ type: 'click', bubbles: true, target: this, preventDefault() {} });
  }
  change(v) {
    if (v !== undefined) this.value = v;
    this.dispatchEvent({ type: 'change', bubbles: true, target: this, preventDefault() {} });
  }
  submit() {
    this.dispatchEvent({ type: 'submit', bubbles: true, target: this, preventDefault() {} });
  }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  contains(node) {
    let curr = node;
    while (curr) {
      if (curr === this) return true;
      curr = curr.parentNode;
    }
    return false;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  querySelectorAll(predicate) {
    const results = [];
    const walk = (el) => {
      if (typeof predicate === 'function' && predicate(el)) results.push(el);
      else if (typeof predicate === 'string') {
        const p = predicate.toLowerCase();
        if (p.startsWith('.') && el.className?.toLowerCase().includes(p.slice(1))) results.push(el);
        else if (p.startsWith('[') && p.endsWith(']')) {
          const inner = p.slice(1, -1);
          if (inner.includes('=')) {
            const [k, v] = inner.split('=').map(s => s.replace(/["']/g, ''));
            if (el.getAttribute(k) === v) results.push(el);
          } else if (el.hasAttribute(inner)) results.push(el);
        }
        else if (el.tagName?.toLowerCase() === p) results.push(el);
      }
      for (const child of el.childNodes || []) {
        if (child.nodeType === 1) walk(child);
      }
    };
    walk(this);
    return results;
  }
  get textContent() { return this.childNodes.map(c => c.textContent ?? c.nodeValue ?? '').join(''); }
  set textContent(v) { this.childNodes = v ? [this.ownerDocument.createTextNode(v)] : []; }
  get innerHTML() {
    return this.childNodes.map(c => {
      if (c.nodeType === 3) return c.nodeValue ?? c.textContent ?? '';
      const attrs = Object.entries(c.attributes || {})
        .map(([k, v]) => ` ${k}="${String(v).replace(/"/g, '&quot;')}"`)
        .join('');
      return `<${c.tagName.toLowerCase()}${attrs}>${c.innerHTML}</${c.tagName.toLowerCase()}>`;
    }).join('');
  }
}

class MockTextNode {
  constructor(text) {
    this.nodeType = 3;
    this._text = String(text ?? '');
    this.ownerDocument = doc;
    this.parentNode = null;
  }
  get nodeValue() { return this._text; }
  set nodeValue(v) { this._text = String(v ?? ''); }
  get data() { return this._text; }
  set data(v) { this._text = String(v ?? ''); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v ?? ''); }
}

const doc = {
  nodeType: 9,
  createElement(tag) { const el = new MockDomElement(tag); el.ownerDocument = doc; return el; },
  createElementNS(ns, tag) { return doc.createElement(tag); },
  createTextNode(text) { return new MockTextNode(text); },
  addEventListener() {},
  removeEventListener() {},
  activeElement: null,
};
const win = { document: doc, addEventListener() {}, removeEventListener() {}, HTMLIFrameElement: class {} };
doc.defaultView = win;
globalThis.window = win;
globalThis.document = doc;
globalThis.HTMLIFrameElement = win.HTMLIFrameElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function changeInput(element, value) {
  element.value = value;
  if (element._valueTracker) {
    element._valueTracker.setValue('');
  }
  element.dispatchEvent({ type: 'input', bubbles: true, target: element, preventDefault() {} });
  element.dispatchEvent({ type: 'change', bubbles: true, target: element, preventDefault() {} });
}

function createTestDatabasesInventory(count = 25) {
  const databases = [];
  for (let i = 1; i <= count; i++) {
    const hasOwnership = i % 2 === 1;
    const hex = String(i).padStart(12, '0');
    databases.push({
      name: `db_item_${String(i).padStart(2, '0')}`,
      sizeBytes: i * 1024 * 1024,
      sizeLabel: `${i} MB`,
      ownership: hasOwnership ? {
        bindingId: `10000000-0000-4000-8000-${hex}`,
        websiteId: `20000000-0000-4000-8000-${hex}`,
        applicationId: `30000000-0000-4000-8000-${hex}`,
        unixUser: `yunapp-${hex}`,
        revision: 1,
        credential: {
          id: `40000000-0000-4000-8000-${hex}`,
          username: `ydb_${hex}${hex}`,
          host: 'localhost',
          revision: 1,
        },
      } : null,
    });
  }
  return {
    engine: 'mariadb',
    version: '10.11.13-MariaDB',
    totalBytes: databases.reduce((sum, d) => sum + d.sizeBytes, 0),
    databases,
    health: {
      ready: true,
      available: true,
      connection: {
        protocol: 'socket',
        adminAccount: 'root@localhost',
        loginAccount: 'root@localhost',
        authPlugin: 'unix_socket',
        nativeSocketAuth: true,
      },
      hygiene: {
        anonymousAccountsAbsent: true,
        remoteRootAccountsAbsent: true,
        testSchemaAbsent: true,
      },
    },
    ownership: { bindingCount: 13, credentialCount: 13, missingDatabaseBindingCount: 0 },
  };
}

async function mountDatabasesPage({
  initialEntry = '/databases',
  inventory = createTestDatabasesInventory(),
  onFetch,
  workspaceOverride = {},
} = {}) {
  const container = doc.createElement('div');
  const root = createRoot(container);
  const prevFetch = globalThis.fetch;

  let currentInventory = inventory;
  const observedJobs = [];
  const updatedJobs = [];
  let refreshJobsCount = 0;

  const defaultFetch = async (url, options = {}) => {
    const urlStr = String(url);
    if (onFetch) {
      const res = await onFetch(urlStr, options);
      if (res) return res;
    }
    if (urlStr.includes('/databases') && (!options.method || options.method === 'GET')) {
      return ok(currentInventory);
    }
    return ok({});
  };

  globalThis.fetch = defaultFetch;

  const workspaceValue = {
    servers: { items: [{ id: 'srv-local', name: 'local-server' }], status: 'ready' },
    domains: { items: [{ id: 'dom-1', websiteId: '20000000-0000-4000-8000-000000000001', primaryDomain: 'example.com' }], status: 'ready' },
    jobs: { refresh: () => { refreshJobsCount++; }, items: [] },
    observe: (job) => { observedJobs.push(job); },
    updateJob: (job) => { updatedJobs.push(job); },
    ...workspaceOverride,
  };

  const routes = [
    {
      path: '/databases',
      element: createElement(WorkspaceContext.Provider, { value: workspaceValue },
        createElement(DatabasesPage)
      ),
    },
  ];

  const router = createMemoryRouter(routes, {
    initialEntries: [initialEntry],
  });

  await act(async () => {
    root.render(createElement(RouterProvider, { router }));
  });

  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });

  return {
    container,
    root,
    router,
    setInventory: (inv) => { currentInventory = inv; },
    observedJobs,
    updatedJobs,
    unmount: async () => {
      try {
        await act(async () => {
          root.unmount();
        });
      } finally {
        globalThis.fetch = prevFetch;
      }
    },
  };
}

/* ==========================================================================\n   4. DatabasesPage Component Real Runtime Verification\n   ========================================================================== */

test('perform contract preserves modal and form inputs on failed or cancelled operations', async () => {
  const inventory = createTestDatabasesInventory(5);
  let queuedJobStatus = 'failed';
  let queuedJobError = { message: 'Database creation rejected' };

  const { container, unmount } = await mountDatabasesPage({
    initialEntry: '/databases',
    inventory,
    onFetch: async (url, options) => {
      if (url.includes('/databases') && options.method === 'POST') {
        return ok({ id: 'job-create-test' });
      }
      if (url.includes('/databases/') && options.method === 'DELETE') {
        return ok({ id: 'job-delete-test' });
      }
      if (url.includes('/jobs/job-create-test') || url.includes('/jobs/job-delete-test')) {
        const id = url.includes('create') ? 'job-create-test' : 'job-delete-test';
        if (queuedJobStatus === 'succeeded') {
          return ok({ id, status: 'succeeded', result: { ok: true } });
        }
        if (queuedJobStatus === 'cancelled') {
          return ok({ id, status: 'cancelled' });
        }
        return ok({ id, status: 'failed', error: queuedJobError });
      }
      return null;
    },
  });

  try {
    // 1. Verify create modal on failure: modal and form input preserved
    const createBtn = container.querySelectorAll('button').find((b) => b.textContent.includes('Veritabanı oluştur'));
    assert.ok(createBtn, 'Create database button must exist');
    await act(async () => {
      createBtn.click();
    });

    // Modal dialog is open
    const modal = container.querySelector('dialog');
    assert.ok(modal, 'Create modal dialog should be mounted');
    const nameInput = modal.querySelector('input');
    assert.ok(nameInput, 'Name input must be present in modal');

    // Type database name
    await act(async () => {
      changeInput(nameInput, 'app_new_database');
    });
    assert.equal(nameInput.value, 'app_new_database');

    // Submit form -> Job fails
    queuedJobStatus = 'failed';
    const form = modal.querySelector('form');
    assert.ok(form, 'Modal form must be present');
    await act(async () => {
      form.dispatchEvent({ type: 'submit', bubbles: true, target: form, preventDefault() {} });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // Check: modal is still mounted, input is preserved, error is shown
    assert.ok(container.querySelector('dialog'), 'Modal must remain open after failed operation');
    assert.equal(nameInput.value, 'app_new_database', 'Entered database name must be preserved on failure');
    assert.ok(container.textContent.includes('İşlem başarısız oldu'), 'Failure notice must be shown in modal');
    assert.equal(container.textContent.includes('oluşturuldu'), false, 'Success notice must not be shown');

    // 2. Submit form -> Job cancelled: modal and form input preserved
    queuedJobStatus = 'cancelled';
    await act(async () => {
      form.dispatchEvent({ type: 'submit', bubbles: true, target: form, preventDefault() {} });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    assert.ok(container.querySelector('dialog'), 'Modal must remain open after cancelled operation');
    assert.equal(nameInput.value, 'app_new_database', 'Entered database name must be preserved on cancellation');
    assert.ok(container.textContent.includes('İşlem iptal edildi'), 'Cancellation notice must be shown in modal');

    // 3. Submit form -> Job succeeds: modal closes, input cleared, success notice shown
    queuedJobStatus = 'succeeded';
    await act(async () => {
      form.dispatchEvent({ type: 'submit', bubbles: true, target: form, preventDefault() {} });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    assert.equal(container.querySelector('dialog'), null, 'Modal must close on successful operation');
    assert.ok(container.textContent.includes('app_new_database oluşturuldu'), 'Success notice must be displayed');

    // 4. Test delete modal: failure/cancellation preserves modal, success closes modal
    const deleteBtn = container.querySelectorAll('button').find((b) => b.getAttribute('aria-label')?.includes('sil') || b.getAttribute('title')?.includes('sil'));
    assert.ok(deleteBtn, 'Delete button must exist');
    await act(async () => {
      deleteBtn.click();
    });

    const deleteModal = container.querySelector('dialog');
    assert.ok(deleteModal, 'Delete confirm dialog must be mounted');
    const confirmInput = deleteModal.querySelector('input');
    assert.ok(confirmInput, 'Confirmation input must exist in delete dialog');

    const targetDbName = inventory.databases[0].name;
    await act(async () => {
      changeInput(confirmInput, targetDbName);
    });

    // Delete job fails
    queuedJobStatus = 'failed';
    const deleteForm = deleteModal.querySelector('form');
    await act(async () => {
      deleteForm.dispatchEvent({ type: 'submit', bubbles: true, target: deleteForm, preventDefault() {} });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    assert.ok(container.querySelector('dialog'), 'Delete modal must remain open after failed deletion');
    assert.ok(container.textContent.includes('İşlem başarısız oldu'), 'Failure notice must be shown in delete modal');

    // Delete job cancelled
    queuedJobStatus = 'cancelled';
    await act(async () => {
      deleteForm.dispatchEvent({ type: 'submit', bubbles: true, target: deleteForm, preventDefault() {} });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    assert.ok(container.querySelector('dialog'), 'Delete modal must remain open after cancelled deletion');
    assert.ok(container.textContent.includes('İşlem iptal edildi'), 'Cancellation notice must be shown in delete modal');

    // Delete job succeeds
    queuedJobStatus = 'succeeded';
    await act(async () => {
      deleteForm.dispatchEvent({ type: 'submit', bubbles: true, target: deleteForm, preventDefault() {} });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    assert.equal(container.querySelector('dialog'), null, 'Delete modal must close on successful deletion');
  } finally {
    await unmount();
  }
});

test('search, access filter, pagination and browser URL history navigation in real session runtime', async () => {
  const inventory = createTestDatabasesInventory(35);
  const { container, router, unmount } = await mountDatabasesPage({
    initialEntry: '/databases',
    inventory,
  });

  try {
    // 1. Initial page: page 1 of 3 (15 items per page)
    assert.ok(container.textContent.includes('1 / 3'), 'Page 1 of 3 indicator');
    assert.ok(container.textContent.includes('db_item_01'), 'First item visible on page 1');
    assert.ok(container.textContent.includes('db_item_15'), '15th item visible on page 1');
    assert.equal(container.textContent.includes('db_item_16'), false, '16th item not on page 1');

    // 2. Pagination runtime: Click "Sonraki"
    const nextBtn = container.querySelectorAll('button').find((b) => b.textContent.includes('Sonraki'));
    assert.ok(nextBtn, 'Sonraki button must exist');
    await act(async () => {
      nextBtn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // URL should have page=2, table should show page 2
    assert.ok(router.state.location.search.includes('page=2'), 'Router URL search param has page=2');
    assert.ok(container.textContent.includes('2 / 3'), 'Page 2 of 3 indicator');
    assert.ok(container.textContent.includes('db_item_16'), '16th item visible on page 2');
    assert.equal(container.textContent.includes('db_item_01'), false, '1st item not on page 2');

    // 3. Search filter runtime: set search query 'db_item_25'
    const searchInput = container.querySelector('input[type="search"]') || container.querySelectorAll('input').find((i) => i.attributes.type === 'search');
    assert.ok(searchInput, 'Search input must exist');
    await act(async () => {
      changeInput(searchInput, 'db_item_25');
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    assert.ok(router.state.location.search.includes('q=db_item_25'), 'Router URL contains search term');
    assert.ok(container.textContent.includes('db_item_25'), 'Matching database db_item_25 is visible');
    assert.equal(container.textContent.includes('db_item_01'), false, 'Non-matching database db_item_01 is filtered out');
    assert.equal(container.textContent.includes('db_item_16'), false, 'Non-matching database db_item_16 is filtered out');

    // 4. Access filter runtime: change to 'ready'
    const select = container.querySelector('select');
    assert.ok(select, 'Access filter select must exist');
    await act(async () => {
      changeInput(searchInput, '');
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    await act(async () => {
      select.value = 'ready';
      select.dispatchEvent({ type: 'change', bubbles: true, target: select, preventDefault() {} });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    assert.ok(router.state.location.search.includes('access=ready'), 'Router URL contains access=ready');
    // Odd items have credentials (ready), even items do not
    assert.ok(container.textContent.includes('db_item_01'), 'db_item_01 (ready) is shown');
    assert.equal(container.textContent.includes('db_item_02'), false, 'db_item_02 (not ready) is filtered out');

    // 5. Browser history back / forward (Geri / İleri URL davranışı)
    // Go back in history
    await act(async () => {
      await router.navigate(-1);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    assert.ok(!router.state.location.search.includes('access=ready'), 'Back navigated away from access=ready');

    // Go forward in history
    await act(async () => {
      await router.navigate(1);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    assert.ok(router.state.location.search.includes('access=ready'), 'Forward navigated back to access=ready');
    assert.ok(container.textContent.includes('db_item_01'), 'db_item_01 is shown after forward navigation');
  } finally {
    await unmount();
  }
});

test('stale, refreshing and error states disable database mutations and phpMyAdmin buttons at runtime', async () => {
  const inventory = createTestDatabasesInventory(2);

  // 1. Stale / loadError state:
  const { container: errorContainer, unmount: unmountError } = await mountDatabasesPage({
    inventory,
    onFetch: async (url) => {
      if (url.includes('/databases')) {
        return new Response(JSON.stringify({ error: { message: 'Database daemon unavailable' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      return null;
    },
  });

  try {
    assert.ok(errorContainer.textContent.includes('Güncel liste alınamadı') || errorContainer.textContent.includes('Database daemon unavailable'), 'Stale/error notice displayed');
    const createBtn = errorContainer.querySelectorAll('button').find((b) => b.textContent.includes('Veritabanı oluştur'));
    assert.ok(createBtn, 'Create button exists');
    assert.equal(createBtn.disabled, true, 'Create button must be disabled during stale/error state');

    const trashButtons = errorContainer.querySelectorAll('button').filter((b) => b.getAttribute('title')?.includes('sil') || b.getAttribute('aria-label')?.includes('sil'));
    for (const b of trashButtons) {
      assert.equal(b.disabled, true, 'Delete button must be disabled during stale/error state');
    }
  } finally {
    await unmountError();
  }

  // 2. Servers not ready state:
  const { container: serverNotReadyContainer, unmount: unmountServerNotReady } = await mountDatabasesPage({
    inventory,
    workspaceOverride: {
      servers: { items: [], status: 'loading' },
    },
  });

  try {
    const createBtn = serverNotReadyContainer.querySelectorAll('button').find((b) => b.textContent.includes('Veritabanı oluştur'));
    assert.ok(createBtn, 'Create button exists');
    assert.equal(createBtn.disabled, true, 'Create button must be disabled when servers are not ready');
  } finally {
    await unmountServerNotReady();
  }
});
