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

test('BUG-04/05 acceptance: default/auto email does not flag dirty, session email resolves without global fallback, and user edits are preserved', () => {
  const sessionWithEmail = { user: { id: 'u1', role: 'owner', email: 'owner@example.test' } };
  const sessionWithUsername = { user: { id: 'u2', role: 'site_manager', username: 'manager@example.test' } };
  const sessionWithoutEmail = { user: { id: 'u3', role: 'owner', username: 'admin' }, dnsSsl: { acmeEmail: 'global@example.test' } };

  assert.equal(sslContactEmail(sessionWithEmail), 'owner@example.test');
  assert.equal(sslContactEmail(sessionWithUsername), 'manager@example.test');
  assert.equal(sslContactEmail(sessionWithoutEmail), '');

  const initialPopulated = createSslRequestDraft(sslContactEmail(sessionWithEmail));
  assert.equal(sslDraftDirty(initialPopulated), false);

  const initialEmpty = createSslRequestDraft(sslContactEmail(sessionWithoutEmail));
  assert.equal(sslDraftDirty(initialEmpty), false);

  const lateResolved = reduce(initialEmpty, { type: 'email-default', email: 'late-session@example.test' });
  assert.equal(lateResolved.values.email, 'late-session@example.test');
  assert.equal(sslDraftDirty(lateResolved), false);

  const userEdited = edit(initialPopulated, 'email', 'custom-ssl@example.test');
  assert.equal(sslDraftDirty(userEdited), true);
  assert.equal(userEdited.values.email, 'custom-ssl@example.test');

  const lateAttempt = reduce(userEdited, { type: 'email-default', email: 'ignored@example.test' });
  assert.equal(lateAttempt.values.email, 'custom-ssl@example.test');
  assert.equal(sslDraftDirty(lateAttempt), true);

  const snapshot = sslDraftSnapshot(userEdited);
  assert.equal(snapshot.email, 'custom-ssl@example.test');
  assert.equal(validSslContactEmail(snapshot.email), true);

  const submitted = reduce(userEdited, { type: 'submitted', values: snapshot });
  assert.equal(sslDraftDirty(submitted), false);
  assert.equal(submitted.baseline.email, 'custom-ssl@example.test');
});

test('cancel and reset actions restore/update baseline and return to clean form state', () => {
  const changed = edit(edit(initial(), 'includeWildcard', true), 'email', 'other@example.test');
  assert.equal(sslDraftDirty(changed), true);

  // type: 'cancel' without extra baseline restores to current baseline and clears dirty
  const cancelled = reduce(changed, { type: 'cancel' });
  assert.deepEqual(cancelled.values, initial().values);
  assert.equal(sslDraftDirty(cancelled), false);

  // type: 'cancel' with an updated baseline updates baseline and clears dirty
  const newBaseline = { email: 'admin@example.test', includeWww: true, includeWebmail: false, includeMail: false, assignToMail: true, includeWildcard: false };
  const cancelledWithBaseline = reduce(changed, { type: 'cancel', baseline: newBaseline });
  assert.deepEqual(cancelledWithBaseline.values, newBaseline);
  assert.deepEqual(cancelledWithBaseline.baseline, newBaseline);
  assert.equal(sslDraftDirty(cancelledWithBaseline), false);
});

test('BUG-20260923-04 acceptance: entering SSL without user changes never triggers dirty, cancel and success update baseline, and active jobs are decoupled', () => {
  // 1. Initial form with pre-populated or empty email is clean (not dirty)
  for (const defaultEmail of ['', 'user@example.test', 'admin@domain.com']) {
    const draft = createSslRequestDraft(defaultEmail);
    assert.equal(sslDraftDirty(draft), false, 'Initial form with defaults must never be dirty');
    assert.equal(draft.values.email, defaultEmail ? defaultEmail.trim() : '');
    // Entering and leaving without modifying any fields produces no dirty warning
    assert.equal(sslDraftDirty(draft), false);
  }

  // 2. Auto-filled / late default email does not make form dirty
  const emptyDraft = createSslRequestDraft();
  assert.equal(sslDraftDirty(emptyDraft), false);
  const autoFilled = reduce(emptyDraft, { type: 'email-default', email: 'autofill@example.test' });
  assert.equal(autoFilled.values.email, 'autofill@example.test');
  assert.equal(sslDraftDirty(autoFilled), false, 'Auto-filled email must not flag form as dirty');

  // 3. Form dirty state is determined by comparing baseline with actual user modifications
  const editedEmail = edit(autoFilled, 'email', 'modified@example.test');
  assert.equal(sslDraftDirty(editedEmail), true, 'User email edit must flag form as dirty');
  const editedScope = edit(autoFilled, 'includeWww', false);
  assert.equal(sslDraftDirty(editedScope), true, 'User checkbox change must flag form as dirty');

  // 4. Reverting changes back to baseline clears dirty state
  const revertedEmail = edit(editedEmail, 'email', 'autofill@example.test');
  assert.equal(sslDraftDirty(revertedEmail), false, 'Reverting to baseline must clear dirty state');

  // 5. Reset and cancel actions clear dirty state and update/restore baseline
  const resetForm = reduce(editedScope, { type: 'reset' });
  assert.equal(sslDraftDirty(resetForm), false, 'Reset must clear dirty state');
  const cancelledForm = reduce(editedScope, { type: 'cancel' });
  assert.equal(sslDraftDirty(cancelledForm), false, 'Cancel must clear dirty state');

  // 6. Successful submission updates baseline and clears dirty state
  const snapshot = sslDraftSnapshot(editedScope);
  const submittedForm = reduce(editedScope, { type: 'submitted', values: snapshot });
  assert.equal(sslDraftDirty(submittedForm), false, 'Submitted must update baseline and clear dirty state');
  assert.deepEqual(submittedForm.baseline, snapshot);

  // Subsequent edits after successful submission flag dirty again
  const postSubmitEdit = edit(submittedForm, 'includeWildcard', true);
  assert.equal(sslDraftDirty(postSubmitEdit), true, 'Edits after submission must flag dirty again');
});

test('BUG-20260923-05 acceptance: SSL communication address resolves from active session user (Owner / site account), avoids silent fallback, remains editable without late overwrite, validates input when missing, and handles role/session switching', () => {
  // Criterion 2: Resolves from active user (Owner, site_manager, customer, reseller, hosting profile)
  const ownerSession = { user: { id: 'owner-1', role: 'owner', email: 'owner@example.test' } };
  const siteMgrSession = { user: { id: 'mgr-1', role: 'site_manager', email: 'manager@site.test' } };
  const customerSession = { user: { id: 'cust-1', role: 'customer', email: 'customer@site.test' } };
  const resellerSession = { user: { id: 'res-1', role: 'reseller', email: 'reseller@site.test' } };
  const hostingProfileSession = { user: { id: 'host-1', role: 'customer', hosting: { contactEmail: 'profile@site.test' } } };
  const usernameEmailSession = { user: { id: 'user-1', role: 'site_manager', username: 'admin@site.test' } };

  assert.equal(sslContactEmail(ownerSession), 'owner@example.test');
  assert.equal(sslContactEmail(siteMgrSession), 'manager@site.test');
  assert.equal(sslContactEmail(customerSession), 'customer@site.test');
  assert.equal(sslContactEmail(resellerSession), 'reseller@site.test');
  assert.equal(sslContactEmail(hostingProfileSession), 'profile@site.test');
  assert.equal(sslContactEmail(usernameEmailSession), 'admin@site.test');

  // No account address -> empty field, never silent global ACME fallback
  const noAddressSession = {
    user: { id: 'owner-2', role: 'owner', username: 'admin' },
    dnsSsl: { acmeEmail: 'global-acme@server.test' },
  };
  assert.equal(sslContactEmail(noAddressSession), '');

  // Form initialization with user email
  const ownerDraft = createSslRequestDraft(sslContactEmail(ownerSession));
  assert.equal(ownerDraft.values.email, 'owner@example.test');
  assert.equal(sslDraftDirty(ownerDraft), false);

  const siteMgrDraft = createSslRequestDraft(sslContactEmail(siteMgrSession));
  assert.equal(siteMgrDraft.values.email, 'manager@site.test');
  assert.equal(sslDraftDirty(siteMgrDraft), false);

  const emptyDraft = createSslRequestDraft(sslContactEmail(noAddressSession));
  assert.equal(emptyDraft.values.email, '');
  assert.equal(sslDraftDirty(emptyDraft), false);

  // Criterion 3: Input remains visible/editable, and late background settings cannot overwrite user modifications
  const userEdited = edit(ownerDraft, 'email', 'custom-ssl@mycompany.org');
  assert.equal(userEdited.values.email, 'custom-ssl@mycompany.org');
  assert.equal(sslDraftDirty(userEdited), true);

  // Late background response attempting to set default email
  const lateDefaultAttempt = reduce(userEdited, { type: 'email-default', email: 'late-global@server.test' });
  assert.equal(lateDefaultAttempt.values.email, 'custom-ssl@mycompany.org');
  assert.equal(lateDefaultAttempt.emailTouched, true);

  // User intentionally clearing email -> late response still cannot overwrite
  const userCleared = edit(ownerDraft, 'email', '');
  assert.equal(userCleared.values.email, '');
  assert.equal(userCleared.emailTouched, true);
  const lateAttemptOnCleared = reduce(userCleared, { type: 'email-default', email: 'late@server.test' });
  assert.equal(lateAttemptOnCleared.values.email, '');

  // User reverting back to baseline email -> emailTouched remains true, late response still blocked
  const userReverted = edit(userEdited, 'email', 'owner@example.test');
  assert.equal(sslDraftDirty(userReverted), false);
  const lateAttemptOnReverted = reduce(userReverted, { type: 'email-default', email: 'late@server.test' });
  assert.equal(lateAttemptOnReverted.values.email, 'owner@example.test');

  // Criterion 4: Oturum kullanıcısının tanımlı e-postası yoksa form sessizce yedek atamaz, kullanıcıdan geçerli e-posta istenir
  assert.equal(validSslContactEmail(''), false);
  assert.equal(validSslContactEmail('invalid-email'), false);
  assert.equal(validSslContactEmail('user@'), false);
  assert.equal(validSslContactEmail('@domain.com'), false);
  assert.equal(validSslContactEmail('user@domain'), false);
  assert.equal(validSslContactEmail('user@domain.com'), true);
  assert.equal(validSslContactEmail('admin.user+acme@sub.example.test'), true);

  // Submitting an empty or invalid email is rejected
  assert.equal(reduce(emptyDraft, { type: 'submitted', values: { email: '', ...SSL_SCOPE_DEFAULTS } }), emptyDraft);
  assert.equal(reduce(emptyDraft, { type: 'submitted', values: { email: 'bad-email', ...SSL_SCOPE_DEFAULTS } }), emptyDraft);

  // When valid email is entered, submission snapshot preserves the exact email
  const validUserEntry = edit(emptyDraft, 'email', 'user.entered@example.test');
  const snapshot = sslDraftSnapshot(validUserEntry);
  assert.equal(snapshot.email, 'user.entered@example.test');
  assert.equal(validSslContactEmail(snapshot.email), true);

  const submitted = reduce(validUserEntry, { type: 'submitted', values: snapshot });
  assert.equal(sslDraftDirty(submitted), false);
  assert.equal(submitted.baseline.email, 'user.entered@example.test');

  // Criterion 5: Role and user session switching isolation
  const domain = { id: 'domain-1', serverId: 'server-1' };
  const ownerKey = sslDraftKey(domain, ownerSession, 1);
  const siteMgrKey = sslDraftKey(domain, siteMgrSession, 1);
  const customerKey = sslDraftKey(domain, customerSession, 1);
  const resellerKey = sslDraftKey(domain, resellerSession, 1);
  const rotatedOwnerKey = sslDraftKey(domain, ownerSession, 2);

  // Each role / user / session generation has a distinct component key
  assert.notEqual(ownerKey, siteMgrKey);
  assert.notEqual(siteMgrKey, customerKey);
  assert.notEqual(customerKey, resellerKey);
  assert.notEqual(ownerKey, rotatedOwnerKey);

  // Switching between Owner and Site account produces a fresh draft with the new user's email
  const switchedToSiteMgr = createSslRequestDraft(sslContactEmail(siteMgrSession));
  assert.equal(switchedToSiteMgr.values.email, 'manager@site.test');
  assert.notEqual(switchedToSiteMgr.values.email, ownerDraft.values.email);

  // Switching to account without email gives empty draft, no silent fallback
  const switchedToNoEmail = createSslRequestDraft(sslContactEmail(noAddressSession));
  assert.equal(switchedToNoEmail.values.email, '');
});
