// Presentation sequencing for the existing site-create API, not a host/retry engine.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STEP_STATES = new Set(['pending', 'applying', 'succeeded', 'failed', 'blocked', 'compensating', 'compensated']);
const record = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const validId = (value) => typeof value === 'string' && UUID.test(value);
const invalid = () => new Error('Site oluşturma sonucu doğrulanamadı.');

export const EMPTY_SITE_SUBMISSION = Object.freeze({ phase: 'idle', created: null, steps: Object.freeze([]), error: null });
export function siteSubmissionBusy(state) {
  return ['previewing', 'creating', 'provisioning'].includes(state.phase);
}

function expectedResult(preview, input) {
  if (!record(preview) || preview.operationId !== input.operationId
    || !validId(preview.ids?.websiteId) || !validId(preview.ids?.primaryDomainId)
    || preview.hostname?.primaryDomain !== input.primaryDomain
    || typeof preview.previewDigest !== 'string' || !/^[a-f0-9]{64}$/.test(preview.previewDigest)
    || preview.confirmation !== `create-site:${input.operationId}:${preview.previewDigest}`
    || !validId(preview.provisioning?.operationId)
    || preview.provisioning.websiteId !== preview.ids.websiteId) throw invalid();
  return Object.freeze({
    operationId: input.operationId, provisioningId: preview.provisioning.operationId,
    websiteId: preview.ids.websiteId, domainId: preview.ids.primaryDomainId,
    serverId: input.serverId, primaryDomain: input.primaryDomain,
    parentDomainId: input.parentDomainId ?? null,
  });
}
function createdRecord(result, expected) {
  const domain = result?.primaryDomain;
  const website = result?.website;
  if (!record(result) || result.operationId !== expected.operationId
    || !record(domain) || !record(website)
    || domain.id !== expected.domainId || domain.websiteId !== expected.websiteId
    || website.id !== expected.websiteId || website.serverId !== expected.serverId
    || domain.serverId !== expected.serverId || domain.primaryDomain !== expected.primaryDomain
    || (domain.parentDomainId ?? null) !== expected.parentDomainId) throw invalid();
  // Never copy a whole response, form, password, runtime intent or error object.
  return Object.freeze({ id: domain.id, websiteId: website.id, primaryDomain: domain.primaryDomain });
}
function provisioningState(operation, expected) {
  if (!record(operation) || operation.operationId !== expected.provisioningId
    || operation.websiteId !== expected.websiteId || typeof operation.ready !== 'boolean'
    || !Array.isArray(operation.steps) || operation.steps.length < 1) throw invalid();
  const ids = new Set();
  const steps = operation.steps.map((step) => {
    if (!record(step) || typeof step.id !== 'string' || !/^[a-z0-9_]{1,80}$/.test(step.id)
      || ids.has(step.id) || !STEP_STATES.has(step.state) || typeof step.required !== 'boolean') throw invalid();
    ids.add(step.id);
    return Object.freeze({ id: step.id, state: step.state, required: step.required });
  });
  const required = steps.filter((step) => step.required);
  if (operation.ready !== (required.length > 0 && required.every((step) => step.state === 'succeeded'))) throw invalid();
  return { ready: operation.ready, steps: Object.freeze(steps) };
}

export function createSiteSubmission({ request, advance, isCurrent = () => true, onState = () => {} } = {}) {
  if ([request, advance, isCurrent, onState].some((fn) => typeof fn !== 'function')) throw new TypeError('Site oluşturma istemcisi eksik.');
  let state = EMPTY_SITE_SUBMISSION;
  let running = false;
  let sealed = false;
  let disposed = false;
  function publish(patch) {
    state = Object.freeze({ ...state, ...patch });
    onState(state);
  }
  async function submit(input, { signal } = {}) {
    // A create POST is single-attempt for this form, even when its reply is lost.
    if (running || sealed || disposed) return state;
    const current = () => !disposed && !signal?.aborted && isCurrent() === true;
    if (!current()) return state;
    if (!record(input) || !validId(input.operationId) || !validId(input.serverId)
      || typeof input.primaryDomain !== 'string' || !input.primaryDomain) throw new TypeError('Site oluşturma girdisi eksik.');
    // Hold one immutable request snapshot; edits cannot change the preview/apply pair.
    const snapshot = structuredClone(input);
    running = true;
    publish({ ...EMPTY_SITE_SUBMISSION, phase: 'previewing' });
    let stage = 'preview';
    try {
      if (!current()) return state;
      const preview = await request('/sites/create-preview', { method: 'POST', body: { input: snapshot }, signal });
      if (!current()) return state;
      const expected = expectedResult(preview, snapshot);
      sealed = true;
      stage = 'create';
      publish({ phase: 'creating' });
      if (!current()) return state;
      const result = await request('/sites', {
        method: 'POST', body: { input: snapshot, previewDigest: preview.previewDigest, confirmation: preview.confirmation }, signal,
      });
      if (!current()) return state;
      const created = createdRecord(result, expected);
      // Commit the verified record to the screen BEFORE any further await.
      publish({ phase: 'recorded', created, error: null });
      stage = 'provisioning';
      const initial = provisioningState(result.provisioning, expected);
      publish({ steps: initial.steps, phase: initial.ready ? 'ready' : 'provisioning' });
      if (initial.ready || !current()) return state;
      let last = initial;
      const final = await advance(expected.provisioningId, {
        signal,
        onStep: (response) => {
          if (!current()) return;
          if (response?.operationId !== expected.provisioningId) throw invalid();
          last = provisioningState(response.operation, expected);
          publish({ steps: last.steps });
        },
      });
      if (!current()) return state;
      last = provisioningState(final, expected);
      publish({ phase: last.ready ? 'ready' : 'attention', steps: last.steps, error: last.ready ? null
        : 'Site kaydı oluşturuldu; kurulumun kalan adımlarını Genel Bakış bölümünden kontrol edin.' });
    } catch {
      if (current()) publish({
        phase: stage === 'preview' ? 'error' : state.created ? 'attention' : 'uncertain',
        error: stage === 'preview'
          ? 'Önizleme doğrulanamadı. Formu ve güncel site bilgilerini kontrol edip tekrar deneyin.'
          : state.created
            ? 'Site kaydı oluşturuldu, ancak kurulumun son durumu doğrulanamadı. Aynı siteyi yeniden oluşturmayın; Genel Bakış bölümünden kontrol edin.'
            : 'Oluşturma isteğinin sonucu doğrulanamadı. Sunucuda kayıt oluşmuş olabilir. Yeniden oluşturmadan önce Web Siteleri listesinden kontrol edin.',
      });
    } finally {
      running = false;
    }
    return state;
  }
  return Object.freeze({
    submit,
    getState: () => state,
    // React scope/unmount fence; cancelling observation never claims host rollback.
    dispose: () => { disposed = true; },
  });
}
