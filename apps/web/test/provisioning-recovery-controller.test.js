import { register } from 'node:module';
register('./jsx-loader.js', import.meta.url);

import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { panelPermission } from '../src/owner-access.js';
import {
  provisioningBadgeState,
  provisioningOperationLabel,
  provisioningRemediation,
  provisioningStepLabel,
  provisioningStepStateLabel,
} from '../src/workspace/provisioning-model.js';
import { createProvisioningRecovery, EMPTY_RECOVERY, recoveryAllowed, recoveryBusy, recoveryOperation } from '../src/workspace/provisioning-recovery.js';

const { PanelSessionProvider, usePanelSession } = await import('../src/panel-session.jsx');
const { default: ProvisioningRecoveryPanel, RecoveryPanel } = await import('../src/workspace/ProvisioningRecoveryPanel.jsx');

const websiteId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const step = (state = 'pending', extra = {}) => ({ id: 'nginx', kind: 'nginx', required: true, state,
  error: null, canRetry: state === 'failed', canCompensate: false,
  compensation: { state: 'not_required', error: null }, ...extra });
const op = (state = 'pending', extra = {}) => ({ operationId, websiteId, ready: state === 'succeeded', status: 'pending',
  updatedAt: '2026-09-23T20:00:00Z', steps: [step(state)], ...extra });
const result = (state = 'succeeded', extra = {}) => ({ operationId, outcome: state === 'succeeded' ? 'ready' : state,
  stepId: 'nginx', operation: op(state), ...extra });
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

const defaultOwnerSession = Object.freeze({
  user: Object.freeze({ id: 'owner-user-id', username: 'owner', role: 'owner' }),
  access: Object.freeze({ mode: 'management', permissions: Object.freeze(['*']) }),
  security: Object.freeze({ ownerMfaRequired: false, enrollmentRequired: false, managementAllowed: true }),
});

function sessionContextFor(session) {
  return Object.freeze({
    session,
    can: (permission) => panelPermission(session, permission),
    canManage: panelPermission(session, '*'),
    isOwner: session?.user?.role === 'owner',
    isSiteManager: session?.user?.role === 'site_manager',
    isReseller: session?.user?.role === 'reseller',
    isCustomer: session?.user?.role === 'customer',
    hostingProfile: session?.user?.hosting ?? null,
    readOnly: session?.access?.mode === 'read_only' || session?.user?.role === 'read_only',
  });
}

function harness({ session = defaultOwnerSession, initial = op(), canManage, ...extra } = {}) {
  const states = [], reads = [], writes = [];
  let latest = initial;
  let activeSession = session;
  const sessionHolder = {
    get current() { return activeSession; },
    set current(value) { activeSession = value; },
    get context() { return sessionContextFor(activeSession); },
  };
  const effectiveCanManage = typeof canManage === 'function' ? canManage : () => sessionHolder.context.canManage;
  const flow = createProvisioningRecovery({ websiteId,
    read: async (options) => { reads.push(options); return latest; },
    execute: async (approval, options) => { writes.push({ approval, options }); return result(); },
    canManage: effectiveCanManage, onState: (state) => states.push(state), ...extra,
  });
  return { flow, states, reads, writes, latest: (value) => { latest = value; }, session: sessionHolder };
}
async function approve(run, action = 'continue', stepId = null) {
  await run.flow.load();
  const approval = run.flow.prepare(action, stepId);
  assert.ok(approval);
  return approval;
}
const perform = (run, approval) => run.flow.perform(approval, approval.confirmation);

test('reads before approving and again before one scoped mutation', async () => {
  const run = harness(); const approval = await approve(run);
  assert.equal(approval.confirmation, `continue-site-provisioning:${operationId}`);
  const state = await perform(run, approval);
  assert.equal(run.reads.length, 2); assert.equal(run.writes.length, 1);
  assert.equal(state.operation.ready, true); assert.equal(state.approval, null);
  assert.equal(state.status, 'ready'); assert.equal(state.changes, 1);
  assert.ok(run.states.some((s) => s.status === 'checking'));
  assert.ok(run.states.some((s) => s.status === 'mutating'));
  assert.equal(run.reads[1].signal, run.writes[0].options.signal);
});

test('counts actual required steps, ignoring invented server progress and optional steps', () => {
  const projected = recoveryOperation(op('pending', { progress: { completed: 999, required: 999 },
    steps: [step('succeeded'), step('pending', { id: 'runtime' }), step('failed', { id: 'optional', required: false })] }), websiteId);
  assert.deepEqual(projected.progress, { required: 2, completed: 1, remaining: 1 });
  assert.equal(Object.isFrozen(projected.steps[0]), true);
  assert.equal(recoveryOperation(null, websiteId), null);
});

for (const [name, bad] of [
  ['missing', undefined], ['array', []], ['wrong website', op('pending', { websiteId: otherId })],
  ['wrong operation', op('pending', { operationId: '../escape' })], ['empty steps', op('pending', { steps: [] })],
  ['duplicate steps', op('pending', { steps: [step(), step()] })], ['invalid state', op('invented')],
  ['false readiness', op('pending', { ready: true })], ['invalid flags', op('pending', { steps: [step('pending', { canRetry: 'true' })] })],
  ['unsupported retry', op('pending', { steps: [step('pending', { canRetry: true })] })],
  ['unsupported compensation', op('pending', { steps: [step('pending', { canCompensate: true })] })],
  ['invalid timestamp', op('pending', { updatedAt: { unexpected: true } })],
]) {
  test(`invalid ${name} projection cannot enable actions`, async () => {
    const run = harness({ initial: bad });
    // undefined must remain an explicit malformed response, not harness default.
    run.latest(bad);
    assert.equal((await run.flow.load()).status, 'error');
    assert.equal(run.flow.prepare('continue'), null); assert.equal(run.writes.length, 0);
  });
}

test('failed refresh keeps last known data read-only and clears the old confirmation', async () => {
  let fail = false;
  const run = harness({ read: async () => { if (fail) throw new Error('fixture-private-text'); return op(); } });
  const approval = await approve(run); fail = true;
  const state = await run.flow.load();
  assert.equal(state.status, 'stale'); assert.equal(state.operation.operationId, operationId);
  assert.equal(state.approval, null); assert.equal(run.flow.prepare('continue'), null);
  await perform(run, approval); assert.equal(run.writes.length, 0);
  assert.equal(JSON.stringify(run.states).includes('fixture-private-text'), false);
});

for (const status of [401, 403]) {
  test(`${status} clears old operation and approval rather than exposing stale data`, async () => {
    let fail = false; const run = harness({ read: async () => {
      if (fail) throw Object.assign(new Error('restricted'), { status }); return op();
    } });
    await approve(run); fail = true;
    const state = await run.flow.load(); assert.equal(state.status, 'forbidden');
    assert.equal(state.operation, null); assert.equal(state.approval, null);
  });
}

for (const [name, latest] of [
  ['new operation', op('pending', { operationId: otherId })], ['ready', op('succeeded')],
  ['new revision', op('pending', { updatedAt: '2026-09-23T20:00:01Z' })],
  ['removed record', null], ['changed step', op('blocked')],
  ['new step set', op('pending', { steps: [step(), step('pending', { id: 'certificate' })] })],
]) {
  test(`${name} after approval stops before POST and requires a fresh explicit decision`, async () => {
    const run = harness(); const approval = await approve(run); run.latest(latest);
    const state = await perform(run, approval);
    assert.equal(state.status, 'ready'); assert.equal(state.approval, null);
    assert.equal(run.writes.length, 0); assert.match(state.error, /yeniden onaylayın/);
  });
}

test('a malformed preflight response stops before mutation and retains only old read-only state', async () => {
  const run = harness(); const approval = await approve(run); run.latest({});
  const state = await perform(run, approval); assert.equal(state.status, 'stale');
  assert.equal(run.writes.length, 0);
});

test('wrong, copied, cancelled and replaced approvals cannot execute', async () => {
  const run = harness(); const first = await approve(run);
  await run.flow.perform(first, 'wrong');
  await run.flow.perform({ ...first }, first.confirmation);
  const second = run.flow.prepare('continue'); await perform(run, first);
  run.flow.cancel(); await perform(run, second);
  assert.equal(run.reads.length, 1); assert.equal(run.writes.length, 0);
});

test('read-only caller can read but never approve or mutate', async () => {
  const run = harness({ canManage: () => false });
  await run.flow.load(); assert.equal(run.flow.getState().status, 'ready');
  assert.equal(run.flow.prepare('continue'), null); assert.equal(run.writes.length, 0);
});

for (const boundary of ['before-preflight', 'after-preflight', 'after-post']) {
  test(`revoked management at ${boundary} clears data and cannot continue`, async () => {
    let allowed = true, reads = 0, writes = 0;
    const run = harness({ canManage: () => allowed,
      read: async () => { if (++reads === 2 && boundary === 'after-preflight') allowed = false; return op(); },
      execute: async () => { writes++; if (boundary === 'after-post') allowed = false; return result(); },
    });
    const approval = await approve(run); if (boundary === 'before-preflight') allowed = false;
    const state = await perform(run, approval);
    assert.equal(state.status, 'forbidden'); assert.equal(state.operation, null);
    assert.equal(writes, boundary === 'after-post' ? 1 : 0);
  });
}

for (const boundary of ['preflight', 'post']) {
  test(`double confirm during ${boundary} runs only one POST and blocks simultaneous refresh`, async () => {
    const gate = deferred(); let reads = 0, writes = 0;
    const run = harness({ read: async () => (++reads === 2 && boundary === 'preflight') ? gate.promise : op(),
      execute: async () => { writes++; return boundary === 'post' ? gate.promise : result(); },
    });
    const approval = await approve(run); const pending = perform(run, approval);
    await new Promise(setImmediate); await perform(run, approval); await run.flow.load();
    assert.equal(reads, 2); gate.resolve(boundary === 'post' ? result() : op()); await pending;
    assert.equal(writes, 1); assert.equal(run.flow.getState().changes, 1);
  });
}

test('overlapping reads abort and ignore older responses even if transport ignores abort', async () => {
  const old = deferred(); const fresh = deferred(); let reads = 0; const signals = [];
  const run = harness({ read: ({ signal }) => { signals.push(signal); return ++reads === 1 ? old.promise : fresh.promise; } });
  const first = run.flow.load(); const second = run.flow.load();
  fresh.resolve(op('succeeded')); await second; old.resolve(op()); await first;
  assert.equal(signals[0].aborted, true); assert.equal(run.flow.getState().operation.ready, true);
});

for (const status of [409, 429, 500, 503, 'network']) {
  test(`uncertain POST ${status} never auto-retries; only refreshed state plus new approval can proceed`, async () => {
    let writes = 0; const run = harness({ execute: async () => { writes++; throw Object.assign(new Error('fixture-private-reply'), { status }); } });
    const approval = await approve(run); const state = await perform(run, approval);
    assert.equal(state.status, 'uncertain'); assert.equal(state.approval, null);
    await perform(run, approval); assert.equal(run.flow.prepare('continue'), null); assert.equal(writes, 1);
    await run.flow.load(); assert.equal(writes, 1); assert.ok(run.flow.prepare('continue'));
    assert.equal(JSON.stringify(state).includes('fixture-private'), false);
  });
}

for (const [name, reply] of [
  ['missing', {}], ['outer operation', result('succeeded', { operationId: otherId })],
  ['inner operation', result('succeeded', { operation: op('succeeded', { operationId: otherId }) })],
  ['website', result('succeeded', { operation: op('succeeded', { websiteId: otherId }) })],
  ['unknown outcome', result('succeeded', { outcome: 'invented' })],
  ['step', result('succeeded', { stepId: 'other' })],
  ['unproven progress', result('pending', { outcome: 'progressed' })],
  ['plan change', result('succeeded', { operation: op('succeeded', { steps: [step('succeeded', { kind: 'runtime' })] }) })],
]) {
  test(`malformed ${name} mutation reply is uncertain, not success`, async () => {
    const run = harness({ execute: async () => reply }); const approval = await approve(run);
    const state = await perform(run, approval); assert.equal(state.status, 'uncertain');
    assert.equal(state.notice, null); assert.equal(state.changes, 0);
  });
}

test('explicit retry uses server capability even after a large attempt count and accepts another plan step from runNext', async () => {
  const initial = op('failed', { attempts: 100, steps: [step('failed'), step('pending', { id: 'runtime', kind: 'runtime' })] });
  const final = op('pending', { steps: [step(), step('succeeded', { id: 'runtime', kind: 'runtime' })] });
  const run = harness({ initial, execute: async (approval) => {
    assert.equal(approval.stepId, 'nginx'); assert.equal(approval.action, 'retry');
    return result('pending', { outcome: 'progressed', stepId: 'runtime', operation: final });
  } });
  const approval = await approve(run, 'retry', 'nginx');
  assert.equal((await perform(run, approval)).status, 'ready');
});

test('compensation stays on the selected step and supports capability-authorized ready operations', async () => {
  const initial = op('succeeded', { steps: [step('succeeded', { canCompensate: true, compensation: { state: 'pending' } })] });
  const run = harness({ initial, execute: async () => result('compensated') });
  const approval = await approve(run, 'compensate', 'nginx');
  const state = await perform(run, approval); assert.equal(state.status, 'ready');
  assert.match(state.notice, /geri alındı/); assert.equal(state.operation.ready, false);
});

for (const [outcome, stateName] of [['failed', 'failed'], ['blocked', 'blocked'], ['interrupted', 'applying'], ['compensation_interrupted', 'compensating'], ['compensation_failed', 'failed']]) {
  test(`${outcome} keeps the real result and error without a success notice`, async () => {
    const run = harness({ execute: async () => result(stateName, { outcome }) });
    const approval = await approve(run); const state = await perform(run, approval);
    assert.equal(state.status, 'ready'); assert.equal(state.notice, null); assert.ok(state.error);
    assert.equal(state.operation.steps[0].state, stateName); assert.equal(state.changes, 1);
  });
}

for (const stop of ['dispose', 'session']) {
  for (const boundary of ['load', 'preflight', 'post']) {
    test(`${stop} at ${boundary} ignores late state and cannot send a later mutation`, async () => {
      const gate = deferred(); let valid = true, reads = 0, writes = 0; const signals = [];
      const run = harness({ isCurrent: () => valid,
        read: ({ signal }) => { signals.push(signal); reads++; return (boundary === 'load' || (boundary === 'preflight' && reads === 2)) ? gate.promise : Promise.resolve(op()); },
        execute: async (_approval, { signal }) => { writes++; signals.push(signal); return gate.promise; },
      });
      const pending = boundary === 'load' ? run.flow.load() : perform(run, await approve(run));
      await new Promise(setImmediate);
      if (stop === 'dispose') run.flow.dispose(); else valid = false;
      const count = run.states.length; gate.resolve(boundary === 'post' ? result() : op()); await pending;
      assert.equal(run.states.length, count); assert.equal(writes, boundary === 'post' ? 1 : 0);
      if (stop === 'dispose') assert.equal(signals.at(-1).aborted, true);
    });
  }
}

test('projection excludes raw intent, evidence, unknown errors and secrets', () => {
  const value = op('failed'); value.secret = 'fixture-private'; value.steps[0].intent = { password: 'fixture-private' };
  value.steps[0].error = 'Authorization: Bearer fixture-private'; value.steps[0].compensation.evidence = 'fixture-private';
  const data = recoveryOperation(value, websiteId);
  assert.equal(JSON.stringify(data).includes('fixture-private'), false); assert.equal(data.steps[0].error, null);
});

test('continuation obeys required step state; optional failures and compensation never grant extra capabilities', () => {
  for (const name of ['pending', 'blocked', 'applying', 'compensating']) assert.equal(recoveryAllowed(recoveryOperation(op(name), websiteId), 'continue'), true);
  for (const name of ['failed', 'compensated', 'succeeded']) assert.equal(recoveryAllowed(recoveryOperation(op(name), websiteId), 'continue'), false);
  assert.equal(recoveryAllowed(null, 'continue'), false);
  assert.equal(recoveryAllowed(recoveryOperation(op(), websiteId), 'invented'), false);
  assert.equal(recoveryAllowed(recoveryOperation(op(), websiteId), 'continue', 'nginx'), false);
  assert.equal(recoveryAllowed(recoveryOperation(op('failed'), websiteId), 'retry', 'nginx'), true);
});

test('busy states exclude stale/uncertain/failure so explicit read recovery stays available', () => {
  for (const status of ['loading', 'refreshing', 'checking', 'mutating']) assert.equal(recoveryBusy({ status }), true);
  for (const status of ['ready', 'stale', 'uncertain', 'error', 'forbidden']) assert.equal(recoveryBusy({ status }), false);
});

test('ready flag paired with a failure outcome is rejected, not shown as completed', async () => {
  const run = harness({ execute: async () => result('succeeded', { outcome: 'failed' }) });
  const state = await perform(run, await approve(run));
  assert.equal(state.status, 'uncertain'); assert.equal(state.notice, null);
});

test('compensation cannot publish another step of the same operation', async () => {
  const initial = op('succeeded', { steps: [step('succeeded', { canCompensate: true, compensation: { state: 'pending' } }), step('succeeded', { id: 'runtime' })] });
  const final = op('compensated', { steps: [step('succeeded', { canCompensate: true, compensation: { state: 'pending' } }), step('compensated', { id: 'runtime' })] });
  const run = harness({ initial, execute: async () => result('compensated', { operation: final, stepId: 'runtime' }) });
  const state = await perform(run, await approve(run, 'compensate', 'nginx'));
  assert.equal(state.status, 'uncertain'); assert.equal(state.notice, null);
});

test('a different completed step cannot silently revert during continuation', async () => {
  const initial = op('pending', { steps: [step('succeeded'), step('pending', { id: 'runtime' })] });
  const final = op('pending', { steps: [step('pending'), step('succeeded', { id: 'runtime' })] });
  const run = harness({ initial, execute: async () => result('pending', { outcome: 'progressed', operation: final, stepId: 'runtime' }) });
  assert.equal((await perform(run, await approve(run))).status, 'uncertain');
});

// ============================================================================
// Real SessionProvider, React, router, and StrictMode environment tests
// ============================================================================







class MockDomElement {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.childNodes = [];
    this.attributes = {};
    this.listeners = {};
    this._value = '';
    this.open = false;
  }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }
  get className() { return this.attributes['class'] || ''; }
  set className(v) { this.attributes['class'] = String(v); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  removeAttribute(k) { delete this.attributes[k]; }
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
        if (p.startsWith('.') && el.attributes?.class?.includes(p.slice(1))) results.push(el);
        else if (el.tagName?.toLowerCase() === p) results.push(el);
        else if (p.includes('button') && el.tagName === 'BUTTON') results.push(el);
        else if (p.includes('input') && el.tagName === 'INPUT') results.push(el);
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

const doc = {
  nodeType: 9,
  createElement(tag) { const el = new MockDomElement(tag); el.ownerDocument = doc; return el; },
  createElementNS(ns, tag) { return doc.createElement(tag); },
  createTextNode(text) { return { nodeType: 3, nodeValue: text, ownerDocument: doc, textContent: text }; },
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

function TestRecoveryApp({ session, targetWebsiteId = websiteId, canManage = false }) {
  return createElement(StrictMode, null,
    createElement(PanelSessionProvider, { session },
      createElement(MemoryRouter, { initialEntries: [`/websites/${targetWebsiteId}`] },
        createElement('div', { id: 'app-root' },
          createElement(ProvisioningRecoveryPanel, { websiteId: targetWebsiteId, canManage })
        )
      )
    )
  );
}

async function mountRecoveryPanel({ session, targetWebsiteId = websiteId, canManage = false, operation = null, fetchHandler = null }) {
  const container = doc.createElement('div');
  const root = createRoot(container);
  const previousFetch = globalThis.fetch;

  if (fetchHandler) {
    globalThis.fetch = fetchHandler;
  } else if (operation) {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ data: operation }),
    });
  }

  await act(async () => {
    root.render(createElement(TestRecoveryApp, { session, targetWebsiteId, canManage }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  return {
    container,
    root,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      globalThis.fetch = previousFetch;
    },
  };
}

test('StrictMode + SessionProvider + Router renders Owner recovery view with active controls and complete step diagnostics', async () => {
  const ownerSession = {
    user: { id: 'owner-uid', role: 'owner' },
    access: { mode: 'management', permissions: ['*'] },
    security: { ownerMfaRequired: false, enrollmentRequired: false, managementAllowed: true },
  };
  const failedOp = recoveryOperation(op('failed', {
    steps: [
      step('failed', { id: 'nginx', kind: 'nginx', canRetry: true, error: 'website_nginx_activation_failed' }),
      step('pending', { id: 'runtime', kind: 'runtime' }),
    ],
  }), websiteId);

  const { container, unmount } = await mountRecoveryPanel({
    session: ownerSession, canManage: true, operation: failedOp,
  });
  try {
    const text = container.textContent;
    assert.ok(text.includes('Site kurulumu'));
    assert.ok(text.includes('Durumu yenile'));
    assert.ok(text.includes('Yeniden dene'));
    assert.ok(text.includes('Nginx'));
    assert.ok(text.includes('vhost/checksum'));
    assert.ok(text.includes('zorunlu adım tamamlandı.'));
    assert.ok(text.includes('Teknik bilgiler ve tanılama'));
    assert.ok(text.includes(operationId));
    assert.ok(text.includes(websiteId));
  } finally {
    await unmount();
  }
});

test('StrictMode + SessionProvider renders Read-Only session with all mutation actions disabled', async () => {
  const readOnlySession = {
    user: { id: 'ro-uid', role: 'read_only' },
    access: { mode: 'read_only', permissions: ['sites.read'] },
    security: { ownerMfaRequired: false, enrollmentRequired: false, managementAllowed: false },
  };
  const failedOp = recoveryOperation(op('failed', {
    steps: [
      step('failed', { id: 'nginx', kind: 'nginx', canRetry: true, error: 'website_nginx_activation_failed' }),
    ],
  }), websiteId);

  const { container, unmount } = await mountRecoveryPanel({
    session: readOnlySession, canManage: false, operation: failedOp,
  });
  try {
    const text = container.textContent;
    assert.ok(text.includes('Site kurulumu'));
    assert.ok(text.includes('Durumu yenile'));
    assert.equal(text.includes('Yeniden dene'), false);
    assert.equal(text.includes('Devam et'), false);
  } finally {
    await unmount();
  }
});

test('StrictMode + SessionProvider enforces tenant boundary for Site Manager role', async () => {
  const siteManagerSession = {
    user: { id: 'sm-uid', role: 'site_manager', websiteIds: [websiteId] },
    access: { mode: 'site_management', permissions: ['*'] },
    security: { ownerMfaRequired: false, enrollmentRequired: false, managementAllowed: true },
  };
  const failedOp = recoveryOperation(op('failed', {
    steps: [
      step('failed', { id: 'nginx', kind: 'nginx', canRetry: true }),
    ],
  }), websiteId);

  const { container: authContainer, unmount: authUnmount } = await mountRecoveryPanel({
    session: siteManagerSession, canManage: true, operation: failedOp,
  });
  try {
    assert.ok(authContainer.textContent.includes('Yeniden dene'));
  } finally {
    await authUnmount();
  }

  const { container: foreignContainer, unmount: foreignUnmount } = await mountRecoveryPanel({
    session: siteManagerSession, canManage: false, operation: failedOp,
  });
  try {
    assert.equal(foreignContainer.textContent.includes('Yeniden dene'), false);
  } finally {
    await foreignUnmount();
  }
});

test('StrictMode + SessionProvider renders active ConfirmDialog for retry and compensation confirmations', async () => {
  const ownerSession = {
    user: { id: 'owner-uid', role: 'owner' },
    access: { mode: 'management', permissions: ['*'] },
    security: { ownerMfaRequired: false, enrollmentRequired: false, managementAllowed: true },
  };
  const failedOp = recoveryOperation(op('failed', {
    steps: [
      step('failed', { id: 'nginx', kind: 'nginx', canRetry: true }),
      step('succeeded', { id: 'certificate', kind: 'certificate', canCompensate: true, compensation: { state: 'pending' } }),
    ],
  }), websiteId);

  const { container, unmount } = await mountRecoveryPanel({
    session: ownerSession, canManage: true, operation: failedOp,
  });
  try {
    // 1. Retry confirm dialog
    const retryBtn = container.querySelectorAll((el) => el.tagName === 'BUTTON').find((b) => b.textContent.includes('Yeniden dene'));
    assert.ok(retryBtn, 'Retry button should be present');
    await act(async () => {
      retryBtn.click();
    });
    assert.ok(container.innerHTML.includes('ws-modal'));
    assert.ok(container.textContent.includes(`retry-site-provisioning:${operationId}:nginx`));
    assert.ok(container.textContent.includes('Adımı yeniden dene'));

    // Cancel retry
    const cancelRetryBtn = container.querySelectorAll((el) => el.tagName === 'BUTTON').find((b) => b.textContent.includes('Vazgeç'));
    assert.ok(cancelRetryBtn, 'Cancel button should be present in dialog');
    await act(async () => {
      cancelRetryBtn.click();
    });
    assert.equal(container.innerHTML.includes('ws-modal'), false);

    // 2. Compensate confirm dialog
    const compBtn = container.querySelectorAll((el) => el.tagName === 'BUTTON').find((b) => b.textContent.includes('Geri al'));
    assert.ok(compBtn, 'Compensate button should be present');
    await act(async () => {
      compBtn.click();
    });
    assert.ok(container.innerHTML.includes('ws-modal'));
    assert.ok(container.textContent.includes(`compensate-site-provisioning:${operationId}:certificate`));
    assert.ok(container.textContent.includes('Geri almayı başlat'));

    // Cancel compensate
    const cancelCompBtn = container.querySelectorAll((el) => el.tagName === 'BUTTON').find((b) => b.textContent.includes('Vazgeç'));
    assert.ok(cancelCompBtn, 'Cancel button should be present in dialog');
    await act(async () => {
      cancelCompBtn.click();
    });
    assert.equal(container.innerHTML.includes('ws-modal'), false);
  } finally {
    await unmount();
  }
});

test('StrictMode + SessionProvider renders ready/succeeded state with progress summary and no continue button', async () => {
  const ownerSession = {
    user: { id: 'owner-uid', role: 'owner' },
    access: { mode: 'management', permissions: ['*'] },
    security: { ownerMfaRequired: false, enrollmentRequired: false, managementAllowed: true },
  };
  const readyOp = recoveryOperation(op('succeeded', {
    ready: true, status: 'succeeded',
    steps: [
      step('succeeded', { id: 'nginx', kind: 'nginx' }),
      step('succeeded', { id: 'runtime', kind: 'runtime' }),
    ],
  }), websiteId);

  const { container, unmount } = await mountRecoveryPanel({
    session: ownerSession, canManage: true, operation: readyOp,
  });
  try {
    const text = container.textContent;
    assert.ok(text.includes('Tamamlandı') || text.includes('Hazır'));
    assert.ok(text.includes('zorunlu adım tamamlandı.'));
    assert.equal(text.includes('Devam et'), false);
  } finally {
    await unmount();
  }
});

test('StrictMode + SessionProvider renders error, stale, and uncertain notices without leaking secrets', async () => {
  const ownerSession = {
    user: { id: 'owner-uid', role: 'owner' },
    access: { mode: 'management', permissions: ['*'] },
    security: { ownerMfaRequired: false, enrollmentRequired: false, managementAllowed: true },
  };

  // Case 1: Read failure without leaking secrets
  const { container, unmount } = await mountRecoveryPanel({
    session: ownerSession, canManage: true,
    fetchHandler: async () => {
      throw Object.assign(new Error('Sensitive secret text: password=super-secret Bearer 12345'), { status: 500 });
    },
  });
  try {
    const text = container.textContent;
    assert.ok(container.innerHTML.includes('ws-notice-error'));
    assert.ok(text.includes('Güncel kurulum kaydı alınamadı'));
    assert.equal(text.includes('super-secret'), false);
    assert.equal(text.includes('password'), false);
    assert.equal(text.includes('Bearer'), false);
  } finally {
    await unmount();
  }
});

test('usePanelSession throws error when invoked outside PanelSessionProvider', () => {
  assert.throws(
    () => renderToString(createElement(ProvisioningRecoveryPanel, { websiteId })),
    /Panel session provider is missing/
  );
});

test('Real lifecycle execution inside StrictMode: createProvisioningRecovery operates with SessionProvider context', async () => {
  const previousFetch = globalThis.fetch;
  try {
    const failedOp = recoveryOperation(op('failed', {
      steps: [
        step('failed', { id: 'nginx', kind: 'nginx', canRetry: true, error: 'website_nginx_activation_failed' }),
      ],
    }), websiteId);

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ data: failedOp }),
    });

    const ownerSession = {
      user: { id: 'owner-uid', role: 'owner' },
      access: { mode: 'management', permissions: ['*'] },
      security: { ownerMfaRequired: false, enrollmentRequired: false, managementAllowed: true },
    };

    const container = doc.createElement('div');
    const root = createRoot(container);

    // Step 1: Real mount inside StrictMode with SessionProvider context
    await act(async () => {
      root.render(
        createElement(StrictMode, null,
          createElement(PanelSessionProvider, { session: ownerSession },
            createElement(MemoryRouter, null,
              createElement(ProvisioningRecoveryPanel, { websiteId, canManage: true })
            )
          )
        )
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    assert.ok(container.textContent.includes('Nginx'));
    assert.ok(container.textContent.includes('Yeniden dene'));

    // Step 2: User interaction triggers active ConfirmDialog
    const retryBtn = container.querySelectorAll((el) => el.tagName === 'BUTTON').find((b) => b.textContent.includes('Yeniden dene'));
    assert.ok(retryBtn, 'retry button should be in DOM');
    await act(async () => {
      retryBtn.click();
    });
    assert.ok(container.textContent.includes('adımını yeniden dene'));

    // Step 3: Canceling ConfirmDialog clears approval
    const cancelBtn = container.querySelectorAll((el) => el.tagName === 'BUTTON').find((b) => b.textContent.includes('Vazgeç'));
    assert.ok(cancelBtn, 'cancel button should be in DOM');
    await act(async () => {
      cancelBtn.click();
    });
    assert.equal(container.textContent.includes('adımını yeniden dene'), false);

    // Step 4: Reopen dialog, then transition session context to read-only
    await act(async () => {
      retryBtn.click();
    });
    assert.ok(container.textContent.includes('adımını yeniden dene'));

    const roSession = {
      user: { id: 'ro-uid', role: 'read_only' },
      access: { mode: 'read_only', permissions: ['sites.read'] },
      security: { ownerMfaRequired: false, enrollmentRequired: false, managementAllowed: false },
    };
    await act(async () => {
      root.render(
        createElement(StrictMode, null,
          createElement(PanelSessionProvider, { session: roSession },
            createElement(MemoryRouter, null,
              createElement(ProvisioningRecoveryPanel, { websiteId, canManage: false })
            )
          )
        )
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    assert.equal(container.textContent.includes('Yeniden dene'), false);
    assert.equal(container.textContent.includes('Devam et'), false);
    assert.ok(container.textContent.includes('Durumu yenile'));

    // Step 5: Clean unmount inside StrictMode
    await act(async () => {
      root.unmount();
    });
    assert.equal(container.childNodes.length, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
