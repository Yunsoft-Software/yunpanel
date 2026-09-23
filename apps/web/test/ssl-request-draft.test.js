import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SSL_SCOPE_DEFAULTS, sslContactEmail, validSslContactEmail, sslDraftKey,
  createSslRequestDraft, sslDraftDirty, sslDraftSnapshot, sslRequestDraftReducer as reduce,
} from '../src/workspace/ssl-request-draft.js';
const edit = (state, field, value) => reduce(state, { type: 'edit', field, value });
const initial = () => createSslRequestDraft('owner@example.test');

test('actual account email wins over an email-shaped login name', () => {
  assert.equal(sslContactEmail({ user: { email: ' real@example.test ', username: 'login@example.test' } }), 'real@example.test');
  assert.equal(sslContactEmail({ user: { username: 'login@example.test' } }), 'login@example.test');
});
test('no account address means an empty field, never a global server address', () => {
  for (const session of [null, {}, { user: { username: 'owner' } },
    { user: { email: 'bad', username: 'admin' }, dnsSsl: { acmeEmail: 'other@example.test' } }]) {
    assert.equal(sslContactEmail(session), '');
  }
});
test('malformed addresses are rejected without throwing', () => {
  for (const value of ['', '   ', 'no-at.example', 'a@b', 'a b@c.test', 0, {}, null, 'x'.repeat(255) + '@a.test']) {
    assert.equal(validSslContactEmail(value), false);
    assert.equal(createSslRequestDraft(value).values.email, '');
  }
  assert.equal(validSslContactEmail(' user+tag@example.test '), true);
});
test('initial automatic defaults, empty or populated, are never unsaved changes', () => {
  for (const email of ['', 'owner@example.test']) {
    const state = createSslRequestDraft(email);
    assert.equal(sslDraftDirty(state), false);
    assert.deepEqual(state.values, { email, ...SSL_SCOPE_DEFAULTS });
    assert.notEqual(state.values, state.baseline);
  }
});
test('late authenticated address fills an untouched field and its baseline together', () => {
  const state = reduce(createSslRequestDraft(), { type: 'email-default', email: 'late@example.test' });
  assert.equal(state.values.email, 'late@example.test'); assert.equal(sslDraftDirty(state), false);
});
test('late default does not erase independent checkbox edits', () => {
  const changed = edit(createSslRequestDraft(), 'includeMail', false);
  const state = reduce(changed, { type: 'email-default', email: 'late@example.test' });
  assert.equal(state.values.email, 'late@example.test');
  assert.equal(state.values.includeMail, false); assert.equal(state.baseline.includeMail, true);
  assert.equal(sslDraftDirty(state), true);
});
test('manual address and intentional blank cannot be overwritten by late defaults', () => {
  for (const email of ['typed@example.test', '']) {
    const changed = edit(initial(), 'email', email);
    const state = reduce(changed, { type: 'email-default', email: 'late@example.test' });
    assert.equal(state, changed); assert.equal(state.values.email, email);
    assert.equal(sslDraftDirty(state), true);
  }
});
test('restoring the email baseline clears dirty but does not permit a late overwrite', () => {
  let state = edit(initial(), 'email', 'new@example.test');
  state = edit(state, 'email', 'owner@example.test');
  assert.equal(sslDraftDirty(state), false);
  assert.equal(reduce(state, { type: 'email-default', email: 'late@example.test' }), state);
});
test('all five scope and assignment checkboxes track edits and reversals without an email', () => {
  for (const [field, defaultValue] of Object.entries(SSL_SCOPE_DEFAULTS)) {
    const changed = edit(createSslRequestDraft(), field, !defaultValue);
    assert.equal(sslDraftDirty(changed), true, field);
    assert.equal(sslDraftDirty(edit(changed, field, defaultValue)), false, field);
  }
});
test('whitespace stripped from the request email does not produce a false warning', () => {
  const state = edit(initial(), 'email', ' owner@example.test ');
  assert.equal(sslDraftDirty(state), false);
  assert.equal(sslDraftSnapshot(state).email, 'owner@example.test');
});
test('explicit reset restores all baseline fields without mutating the old state', () => {
  const changed = edit(edit(initial(), 'includeWildcard', true), 'email', 'other@example.test');
  const reset = reduce(changed, { type: 'reset' });
  assert.deepEqual(reset.values, initial().values); assert.equal(sslDraftDirty(reset), false);
  assert.equal(changed.values.includeWildcard, true); assert.equal(changed.values.email, 'other@example.test');
});
test('closing confirmation, failure and test result do not acknowledge the draft', () => {
  const changed = edit(initial(), 'includeWww', false);
  for (const type of ['confirmation-cancel', 'failed', 'queued', 'test-succeeded']) {
    assert.equal(reduce(changed, { type }), changed);
    assert.equal(sslDraftDirty(reduce(changed, { type })), true);
  }
});
test('successful real request sets baseline to its submitted snapshot', () => {
  const changed = edit(edit(initial(), 'includeWww', false), 'email', 'other@example.test');
  const submitted = sslDraftSnapshot(changed);
  assert.ok(Object.isFrozen(submitted));
  const state = reduce(changed, { type: 'submitted', values: submitted });
  assert.equal(sslDraftDirty(state), false);
  assert.notEqual(state.baseline, submitted);
  assert.equal(reduce(state, { type: 'email-default', email: 'late@example.test' }), state);
});
test('a late completion cannot acknowledge edits made after its snapshot', () => {
  const submitted = sslDraftSnapshot(initial());
  const changed = edit(initial(), 'includeWildcard', true);
  const state = reduce(changed, { type: 'submitted', values: submitted });
  assert.equal(state.values.includeWildcard, true); assert.equal(sslDraftDirty(state), true);
});
test('edits after success re-enable the warning instead of being hidden by a requested flag', () => {
  const changed = edit(initial(), 'includeMail', false);
  const state = reduce(changed, { type: 'submitted', values: sslDraftSnapshot(changed) });
  assert.equal(sslDraftDirty(edit(state, 'assignToMail', true)), true);
  assert.equal(sslDraftDirty(edit(state, 'email', 'third@example.test')), true);
});
test('invalid or incomplete submissions cannot clear unsaved data', () => {
  const state = edit(initial(), 'includeMail', false);
  for (const values of [null, {}, { email: 'other@example.test' }, { ...sslDraftSnapshot(state), includeMail: 'false' }]) {
    assert.equal(reduce(state, { type: 'submitted', values }), state);
  }
});
test('unknown or wrongly typed fields cannot alter or extend the form', () => {
  const state = initial();
  for (const [field, value] of [['__proto__', true], ['toString', true], ['email', null], ['includeWww', 'false'], ['emailTouched', false]]) {
    assert.equal(edit(state, field, value), state);
  }
});
test('source defaults stay immutable and independent across forms', () => {
  const a = initial(); const b = initial();
  a.values.includeMail = false;
  assert.equal(b.values.includeMail, true); assert.equal(a.baseline.includeMail, true);
  assert.ok(Object.isFrozen(SSL_SCOPE_DEFAULTS));
});
test('form identity isolates domain, server, actor, role and session generation without tokens', () => {
  const domain = { id: 'd', serverId: 'local' };
  const session = { user: { id: 'owner', role: 'owner', email: 'a@example.test' }, csrfToken: 'not-in-key' };
  const key = sslDraftKey(domain, session, 1);
  for (const other of [sslDraftKey({ ...domain, id: 'b' }, session, 1),
    sslDraftKey({ ...domain, serverId: 'remote' }, session, 1),
    sslDraftKey(domain, { user: { id: 'other', role: 'owner' } }, 1),
    sslDraftKey(domain, { user: { id: 'owner', role: 'site_manager' } }, 1),
    sslDraftKey(domain, session, 2)]) assert.notEqual(other, key);
  assert.equal(sslDraftKey(domain, { ...session, user: { ...session.user, email: 'b@example.test' } }, 1), key);
  assert.equal(key.includes('not-in-key'), false); assert.equal(key.includes('@'), false);
});
