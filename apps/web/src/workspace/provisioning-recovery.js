// Manual recovery on the existing API. This is not a host lock or retry engine.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATES = new Set(['pending', 'applying', 'blocked', 'succeeded', 'failed', 'compensating', 'compensated']);
const OUTCOMES = new Set(['progressed', 'reconciled', 'ready', 'failed', 'blocked', 'interrupted', 'compensated', 'compensation_interrupted', 'compensation_failed']);
const record = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const code = (value) => typeof value === 'string' && /^[a-z0-9_.:-]{1,160}$/i.test(value) ? value : null;
const invalid = () => Object.assign(new Error('Kurulum kaydı doğrulanamadı.'), { code: 'provisioning_recovery_invalid' });
const stamp = (operation) => JSON.stringify(operation);

export function recoveryOperation(value, websiteId) {
  if (typeof websiteId !== 'string' || !UUID.test(websiteId)) throw invalid();
  if (value === null) return null;
  if (!record(value) || value.websiteId !== websiteId || typeof value.operationId !== 'string' || !UUID.test(value.operationId)
    || typeof value.ready !== 'boolean' || !Array.isArray(value.steps)
    || value.steps.length < 1 || value.steps.length > 256) throw invalid();
  const ids = new Set();
  const steps = value.steps.map((step) => {
    if (!record(step) || typeof step.id !== 'string' || !/^[a-z0-9_]{1,80}$/.test(step.id)
      || ids.has(step.id) || !STATES.has(step.state) || typeof step.required !== 'boolean'
      || typeof step.canRetry !== 'boolean' || typeof step.canCompensate !== 'boolean'
      || !record(step.compensation) || !code(step.compensation.state)) throw invalid();
    if (step.canRetry && (step.state !== 'failed' || !['pending', 'not_required'].includes(step.compensation.state))) throw invalid();
    if (step.canCompensate && (!['succeeded', 'failed'].includes(step.state) || !['pending', 'failed'].includes(step.compensation.state))) throw invalid();
    ids.add(step.id);
    return Object.freeze({
      id: step.id, kind: code(step.kind), state: step.state, required: step.required,
      canRetry: step.canRetry, canCompensate: step.canCompensate, error: code(step.error),
      compensation: Object.freeze({ state: step.compensation.state, error: code(step.compensation.error) }),
    });
  });
  const required = steps.filter((step) => step.required);
  const completed = required.filter((step) => step.state === 'succeeded').length;
  if (value.ready && (!required.length || completed !== required.length)) throw invalid();
  // Only documented public metadata is retained. No intent/evidence/raw error.
  const timestamp = (time) => {
    if (time == null) return null;
    if (typeof time !== 'string' || time.length > 40 || !Number.isFinite(Date.parse(time))) throw invalid();
    return time;
  };
  return Object.freeze({
    operationId: value.operationId, websiteId, ready: value.ready, status: code(value.status),
    createdAt: timestamp(value.createdAt), updatedAt: timestamp(value.updatedAt),
    steps: Object.freeze(steps),
    progress: Object.freeze({ required: required.length, completed, remaining: required.length - completed }),
  });
}

export function recoveryAllowed(operation, action, stepId = null) {
  if (!operation) return false;
  if (action === 'continue') {
    if (stepId !== null || operation.ready) return false;
    const required = operation.steps.filter((step) => step.required);
    return !required.some((step) => ['failed', 'compensated'].includes(step.state))
      && required.some((step) => ['pending', 'blocked', 'applying', 'compensating'].includes(step.state));
  }
  const step = operation.steps.find((item) => item.id === stepId);
  return action === 'retry' ? step?.canRetry === true
    : action === 'compensate' && step?.canCompensate === true;
}

function verifiedResult(value, approved, websiteId) {
  if (!record(value) || value.operationId !== approved.operationId || !OUTCOMES.has(value.outcome)) throw invalid();
  const operation = recoveryOperation(value.operation, websiteId);
  if (!operation || operation.operationId !== approved.operationId
    || (value.stepId !== null && !operation.steps.some((step) => step.id === value.stepId))) throw invalid();
  if (approved.action === 'compensate' && value.stepId !== approved.stepId) throw invalid();
  if ((value.outcome === 'ready') !== operation.ready) throw invalid();
  const step = operation.steps.find((item) => item.id === value.stepId);
  if (['progressed', 'reconciled'].includes(value.outcome) && step?.state !== 'succeeded') throw invalid();
  if (value.outcome === 'compensated' && step?.state !== 'compensated') throw invalid();
  return operation;
}

export const EMPTY_RECOVERY = Object.freeze({ status: 'idle', operation: null, approval: null, error: null, notice: null, changes: 0 });
export const recoveryBusy = (state) => ['loading', 'refreshing', 'checking', 'mutating'].includes(state.status);

export function createProvisioningRecovery({ websiteId, read, execute, isCurrent = () => true, canManage = () => false, onState = () => {} } = {}) {
  if (typeof websiteId !== 'string' || !UUID.test(websiteId)
    || [read, execute, isCurrent, canManage, onState].some((fn) => typeof fn !== 'function')) throw new TypeError('Kurulum istemcisi eksik.');
  let state = EMPTY_RECOVERY;
  let generation = 0;
  let disposed = false;
  let writing = false;
  let controller = null;
  const publish = (patch) => { state = Object.freeze({ ...state, ...patch }); onState(state); };
  const current = (version) => !disposed && version === generation && isCurrent() === true && !controller?.signal.aborted;
  const denied = () => publish({ status: 'forbidden', operation: null, approval: null, notice: null, error: 'Kurulum işlemi için yetkiniz değişti. Site erişimini yeniden kontrol edin.' });
  function failure(error, uncertain) {
    if (error?.status === 401 || error?.status === 403) { denied(); return; }
    publish({ status: uncertain ? 'uncertain' : state.operation ? 'stale' : 'error', approval: null, notice: null,
      error: uncertain
        ? 'İşlemin sonucu doğrulanamadı; sunucuda uygulanmış olabilir. Tekrar işlem yapmadan önce Durumu yenile ile kontrol edin.'
        : 'Güncel kurulum kaydı alınamadı. İşlemler kapalı; Durumu yenile ile yeniden deneyin.',
    });
  }
  async function load() {
    if (disposed || writing || isCurrent() !== true) return state;
    controller?.abort(); controller = new AbortController(); const version = ++generation;
    const signal = controller.signal;
    publish({ status: state.operation ? 'refreshing' : 'loading', approval: null, error: null, notice: null });
    try {
      const result = await read({ signal });
      if (current(version)) publish({ status: 'ready', operation: recoveryOperation(result, websiteId) });
    } catch (error) { if (current(version)) failure(error, false); }
    return state;
  }
  function prepare(action, stepId = null) {
    if (disposed || writing || isCurrent() !== true || canManage() !== true || state.status !== 'ready'
      || !recoveryAllowed(state.operation, action, stepId)) return null;
    const operationId = state.operation.operationId;
    const confirmation = `${action}-site-provisioning:${operationId}${action === 'continue' ? '' : `:${stepId}`}`;
    const approval = Object.freeze({ action, stepId, operationId, confirmation, snapshot: stamp(state.operation) });
    publish({ approval, error: null, notice: null });
    return approval;
  }
  function cancel() {
    if (!disposed && !writing && isCurrent() === true) publish({ approval: null });
  }
  async function perform(approval, confirmation) {
    if (disposed || writing || isCurrent() !== true || state.status !== 'ready'
      || !approval || approval !== state.approval || confirmation !== approval.confirmation) return state;
    if (canManage() !== true) { denied(); return state; }
    writing = true; controller?.abort(); controller = new AbortController(); const version = ++generation;
    const signal = controller.signal;
    let sent = false;
    publish({ status: 'checking', error: null, notice: null });
    try {
      const value = await read({ signal });
      if (!current(version)) return state;
      if (canManage() !== true) { denied(); return state; }
      const latest = recoveryOperation(value, websiteId);
      if (stamp(latest) !== approval.snapshot || !recoveryAllowed(latest, approval.action, approval.stepId)) {
        publish({ status: 'ready', operation: latest, approval: null, error: 'Kurulum kaydı değişti. Güncel adımları inceleyip işlemi yeniden onaylayın.' });
        return state;
      }
      publish({ status: 'mutating' });
      if (!current(version)) return state;
      if (canManage() !== true) { denied(); return state; }
      sent = true;
      const result = await execute(approval, { signal });
      if (!current(version)) return state;
      if (canManage() !== true) { denied(); return state; }
      const operation = verifiedResult(result, approval, websiteId);
      // The plan's identity and order cannot silently change in a write response.
      if (JSON.stringify(operation.steps.map(({ id, kind, required }) => [id, kind, required]))
        !== JSON.stringify(latest.steps.map(({ id, kind, required }) => [id, kind, required]))) throw invalid();
      if (latest.steps.some((old, index) => old.state === 'succeeded'
        && operation.steps[index].state !== 'succeeded'
        && !(approval.action === 'compensate' && old.id === approval.stepId))) throw invalid();
      const stopped = !['progressed', 'reconciled', 'ready', 'compensated'].includes(result.outcome);
      publish({ status: 'ready', operation, approval: null, changes: state.changes + 1,
        error: stopped ? 'Kurulum tamamlanmadı. Güncel adım durumunu ve hata ayrıntısını inceleyin.' : null,
        notice: stopped ? null : result.outcome === 'compensated' ? 'Seçilen adım geri alındı. Diğer kaynakların durumu aşağıda korunuyor.'
          : operation.ready ? 'Zorunlu kurulum adımları tamamlandı. Yayın, SSL ve postayı ilgili araçlardan doğrulayın.'
            : 'Adım doğrulandı. Kalan kurulum adımları aşağıda gösteriliyor.',
      });
    } catch (error) { if (current(version)) failure(error, sent); }
    finally { writing = false; }
    return state;
  }
  return Object.freeze({ load, prepare, cancel, perform, getState: () => state,
    dispose: () => { disposed = true; generation++; controller?.abort(); },
  });
}
