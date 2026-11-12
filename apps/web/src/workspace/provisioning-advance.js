// Client sequencing only. Host inspection, locks and authorization stay in the
// existing provisioning engine. Never replay a POST after an uncertain result.
const STEP_STATES = new Set(['pending', 'applying', 'blocked', 'succeeded', 'failed', 'compensating', 'compensated']);
const STOP_STEP_STATES = new Set(['failed', 'blocked', 'compensating', 'compensated']);
const OUTCOMES = new Set(['progressed', 'reconciled', 'ready', 'failed', 'blocked', 'interrupted', 'compensated', 'compensation_interrupted', 'compensation_failed']);
const LOCK_CONTENTION_CODES = new Set(['site_mutation_locked', 'site_mutation_lock_race']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

function invalidResponse() {
  const error = new Error('Kurulumun güncel sonucu doğrulanamadı. Otomatik ilerleme durduruldu; site genel bakışından durumu yeniden kontrol edin.');
  error.code = 'provisioning_response_invalid';
  return error;
}
function checkAbort(signal) {
  if (signal?.aborted) {
    const error = new Error('Kurulum takibi durduruldu; sunucudaki işlem devam ediyor olabilir.');
    error.name = 'AbortError';
    throw error;
  }
}
function isPreExecutionLockConflict(error) {
  return Boolean(error && error.status === 409 && LOCK_CONTENTION_CODES.has(error.code));
}
function verifiedOperation(operation, id, websiteId = null) {
  if (!isRecord(operation) || operation.operationId !== id
    || typeof operation.websiteId !== 'string' || !UUID.test(operation.websiteId)
    || (websiteId !== null && operation.websiteId !== websiteId)
    || typeof operation.ready !== 'boolean' || !Array.isArray(operation.steps)) throw invalidResponse();
  const ids = new Set();
  for (const step of operation.steps) {
    if (!isRecord(step) || typeof step.id !== 'string' || !/^[a-z0-9_]{1,80}$/.test(step.id)
      || ids.has(step.id) || !STEP_STATES.has(step.state)
      || typeof step.required !== 'boolean') throw invalidResponse();
    ids.add(step.id);
  }
  if (operation.ready && operation.steps.some((step) => step.required && step.state !== 'succeeded')) throw invalidResponse();
  return operation;
}
function canAdvance(operation) {
  // A new automated run does not silently retry/remediate a stopped or in-flight
  // operation. The explicit recovery controls still use the same server API.
  return !operation.ready && operation.steps.some((step) => step.state === 'pending')
    && operation.steps.every((step) => ['pending', 'succeeded'].includes(step.state));
}
function verifiedResult(result, previous, id) {
  if (!isRecord(result) || result.operationId !== id || !OUTCOMES.has(result.outcome)) throw invalidResponse();
  const operation = verifiedOperation(result.operation, id, previous.websiteId);
  const before = new Map(previous.steps.map((step) => [step.id, step]));
  if (operation.steps.length !== before.size || operation.steps.some((step) => {
    const old = before.get(step.id);
    return !old || old.required !== step.required || (old.state === 'succeeded' && step.state !== 'succeeded');
  })) throw invalidResponse();
  if (result.stepId !== null && !before.has(result.stepId)) throw invalidResponse();
  if ((result.outcome === 'ready') !== operation.ready) throw invalidResponse();
  if (['progressed', 'reconciled'].includes(result.outcome)) {
    const step = operation.steps.find((item) => item.id === result.stepId);
    if (!step || step.state !== 'succeeded' || before.get(step.id).state === 'succeeded') throw invalidResponse();
  }
  return operation;
}
function verifiedReconciledOperation(snapshot, previous, id) {
  const latest = verifiedOperation(snapshot, id, previous.websiteId);
  if (latest.steps.length !== previous.steps.length) throw invalidResponse();
  for (let i = 0; i < latest.steps.length; i += 1) {
    const before = previous.steps[i];
    const current = latest.steps[i];
    if (current.id !== before.id
      || current.required !== before.required
      || (before.state === 'succeeded' && current.state !== 'succeeded')) {
      throw invalidResponse();
    }
  }
  if (latest.status === 'abandoned' && latest.ready) throw invalidResponse();
  const requiredSteps = latest.steps.filter((step) => step.required);
  if (latest.status !== 'abandoned' && requiredSteps.length > 0
    && requiredSteps.every((step) => step.state === 'succeeded') && !latest.ready) {
    throw invalidResponse();
  }
  return latest;
}
function reconciliationEvent(previous, latest, id) {
  let changedStep = null;
  let stepProgressed = false;
  for (let i = 0; i < latest.steps.length; i += 1) {
    const before = previous.steps[i];
    const current = latest.steps[i];
    if (current.state !== before.state) {
      changedStep = current;
      if (current.state === 'succeeded') stepProgressed = true;
      if (STOP_STEP_STATES.has(current.state)) break;
    }
  }
  const readyChanged = latest.ready !== previous.ready;
  const statusChanged = latest.status !== previous.status;
  if (!changedStep && !readyChanged && !statusChanged) return null;

  let outcome = 'interrupted';
  if (latest.ready) outcome = 'ready';
  else if (latest.steps.some((step) => step.state === 'failed')) outcome = 'failed';
  else if (latest.status === 'abandoned' || latest.steps.some((step) => step.state === 'blocked')) outcome = 'blocked';
  else if (latest.steps.some((step) => step.state === 'compensating')) outcome = 'compensation_interrupted';
  else if (latest.steps.some((step) => step.state === 'compensated')) outcome = 'compensated';
  else if (stepProgressed) outcome = 'reconciled';

  return {
    operationId: id,
    outcome,
    stepId: changedStep ? changedStep.id : null,
    operation: latest,
  };
}
function shouldStopReconciliation(operation) {
  return operation.ready === true
    || operation.status === 'abandoned'
    || operation.steps.some((step) => STOP_STEP_STATES.has(step.state));
}
async function waitForPollDelay(delayMs, signal, checkCurrent) {
  checkCurrent();
  if (delayMs > 0) {
    let timer = null;
    let onAbort = null;
    try {
      await new Promise((resolve, reject) => {
        onAbort = () => {
          try {
            checkCurrent();
          } catch (abortError) {
            reject(abortError);
            return;
          }
          const abortError = new Error('Kurulum takibi durduruldu; sunucudaki işlem devam ediyor olabilir.');
          abortError.name = 'AbortError';
          reject(abortError);
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(resolve, delayMs);
      });
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }
  checkCurrent();
}

export async function advanceProvisioning({
  operationId,
  read,
  advance,
  maxSteps = 30,
  lockPollLimit = 0,
  lockPollDelayMs = 500,
  signal,
  onStep,
  isCurrent = () => true,
} = {}) {
  if (typeof operationId !== 'string' || !UUID.test(operationId)
    || typeof read !== 'function' || typeof advance !== 'function' || typeof isCurrent !== 'function'
    || !Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 100
    || !Number.isSafeInteger(lockPollLimit) || lockPollLimit < 0 || lockPollLimit > 600
    || !Number.isSafeInteger(lockPollDelayMs) || lockPollDelayMs < 0 || lockPollDelayMs > 5000) {
    throw new TypeError('Geçerli kurulum kimliği, istemci ve 1–100 adımlık ilerleme sınırı gerekir.');
  }
  const checkCurrent = () => {
    checkAbort(signal);
    if (isCurrent() !== true) {
      const error = new Error('Oturum değişti; önceki kurulum otomatik ilerletilmeyecek.');
      error.name = 'AbortError';
      error.code = 'session_superseded';
      throw error;
    }
  };
  checkCurrent();
  const snapshot = await read({ signal });
  checkCurrent();
  let operation = verifiedOperation(snapshot, operationId);
  for (let index = 0; index < maxSteps && canAdvance(operation); index += 1) {
    checkCurrent();
    let result;
    try {
      // A rejected request (including 429/5xx/timeout) does not prove non-execution.
      // Propagate it, with no automatic retry or swallowed manual-retry failure.
      result = await advance({ signal });
    } catch (error) {
      if (!isPreExecutionLockConflict(error) || lockPollLimit < 1) throw error;
      checkCurrent();
      for (let poll = 0; poll < lockPollLimit; poll += 1) {
        await waitForPollDelay(lockPollDelayMs, signal, checkCurrent);
        const nextSnapshot = await read({ signal });
        checkCurrent();
        const latest = verifiedReconciledOperation(nextSnapshot, operation, operationId);
        const event = reconciliationEvent(operation, latest, operationId);
        operation = latest;
        if (event) {
          checkCurrent();
          if (typeof onStep === 'function') onStep(event);
          checkCurrent();
        }
        if (shouldStopReconciliation(operation)) return operation;
      }
      return operation;
    }
    checkCurrent();
    operation = verifiedResult(result, operation, operationId);
    if (typeof onStep === 'function') onStep(result);
    checkCurrent();
    if (!['progressed', 'reconciled'].includes(result.outcome)) break;
  }
  // This limit counts successful step advances, not failed attempts. It never
  // manufactures ready/retryExhausted or disables server-provided canRetry.
  return operation;
}
