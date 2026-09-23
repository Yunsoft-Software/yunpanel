// Client sequencing only. Host inspection, locks and authorization stay in the
// existing provisioning engine. Never replay a POST after an uncertain result.
const STEP_STATES = new Set(['pending', 'applying', 'blocked', 'succeeded', 'failed', 'compensating', 'compensated']);
const OUTCOMES = new Set(['progressed', 'reconciled', 'ready', 'failed', 'blocked', 'interrupted', 'compensated', 'compensation_interrupted', 'compensation_failed']);
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

export async function advanceProvisioning({ operationId, read, advance, maxSteps = 30, signal, onStep, isCurrent = () => true } = {}) {
  if (typeof operationId !== 'string' || !UUID.test(operationId)
    || typeof read !== 'function' || typeof advance !== 'function' || typeof isCurrent !== 'function'
    || !Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 100) {
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
    // A rejected request (including 429/5xx/timeout) does not prove non-execution.
    // Propagate it, with no automatic retry or swallowed manual-retry failure.
    const result = await advance({ signal });
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
