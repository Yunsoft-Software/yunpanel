// Presentation of the existing ssl.renew job. Never issues, installs or retries
// a certificate itself; dates always come from the API's stored certificate.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const FINGERPRINT = /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/i;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const record = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const invalid = () => Object.assign(new Error('SSL işlem kaydı doğrulanamadı.'), { code: 'ssl_renewal_unverified' });
const requireValue = (condition) => { if (!condition) throw invalid(); };
function date(value) {
  requireValue(typeof value === 'string' && value.length <= 80 && Number.isFinite(Date.parse(value)));
  return new Date(value).toISOString();
}
export function renewalMetadata(value) {
  requireValue(record(value) && typeof value.fingerprint256 === 'string' && FINGERPRINT.test(value.fingerprint256));
  const validFrom = date(value.validFrom), validTo = date(value.validTo);
  requireValue(Date.parse(validTo) > Date.parse(validFrom));
  return Object.freeze({ validFrom, validTo, fingerprint256: value.fingerprint256.toUpperCase() });
}
export function renewalOutcome(job, before, certificate, dryRun) {
  requireValue(job.status === 'succeeded' && record(job.result) && job.result.certName === before.certName
    && job.result.dryRun === dryRun && job.result.staging !== true && certificate.certName === before.certName);
  if (dryRun) {
    requireValue(job.result.status === 'validated');
    return certificate.state === 'active' ? 'tested' : 'syncing';
  }
  requireValue(job.result.status === 'renewed');
  const result = renewalMetadata(job.result);
  if (certificate.state !== 'active' || !equal(result, renewalMetadata(certificate))) return 'syncing';
  const original = renewalMetadata(before);
  // A fingerprint identifies the material; contradictory dates are not renewal.
  if (original.fingerprint256 === result.fingerprint256) {
    requireValue(equal(original, result));
    return 'unchanged';
  }
  return 'renewed';
}
export const EMPTY_SSL_RENEWAL = Object.freeze({
  status: 'idle', approval: null, before: null, certificate: null, job: null,
  dryRun: null, outcome: null, error: null, terminalVersion: 0, syncVersion: 0,
});
export const sslRenewalBusy = (state) => ['preparing', 'checking', 'sending', 'reading'].includes(state.status);

export function createSslRenewal({ target, request, isCurrent = () => true, canManage = () => false,
  canStart = () => true, onState = () => {} } = {}) {
  requireValue(record(target) && typeof target.id === 'string' && UUID.test(target.id)
    && typeof target.certificateId === 'string' && UUID.test(target.certificateId)
    && typeof target.serverId === 'string' && ID.test(target.serverId)
    && (target.websiteId == null || (typeof target.websiteId === 'string' && UUID.test(target.websiteId)))
    && typeof target.primaryDomain === 'string' && /^[a-z0-9.-]{1,253}$/.test(target.primaryDomain));
  if ([request, isCurrent, canManage, canStart, onState].some((fn) => typeof fn !== 'function')) throw new TypeError('SSL istemcisi eksik.');
  const scope = { id: target.id, certificateId: target.certificateId, serverId: target.serverId,
    websiteId: target.websiteId ?? null, primaryDomain: target.primaryDomain };
  const domainPath = `/domains/${encodeURIComponent(scope.id)}`;
  const certPath = `/certificates/${encodeURIComponent(scope.certificateId)}`;
  const lifetime = new AbortController();
  let state = EMPTY_SSL_RENEWAL, busy = false, sealed = false, disposed = false;
  let known = null, terminalSeen = false, polls = 0, syncReads = 0;
  const current = () => !disposed && !lifetime.signal.aborted && isCurrent() === true;
  const publish = (patch) => { if (current()) { state = Object.freeze({ ...state, ...patch }); onState(state); } };
  function check(write = false) {
    if (!current()) throw Object.assign(new Error('Takip durduruldu.'), { name: 'AbortError' });
    if (write && canManage() !== true) throw Object.assign(new Error('Yetki değişti.'), { status: 403 });
  }
  async function call(path, options = {}) {
    check(); const value = await request(path, { ...options, signal: lifetime.signal }); check(); return value;
  }
  function binding(domain) {
    requireValue(record(domain) && domain.id === scope.id && domain.serverId === scope.serverId
      && (domain.websiteId ?? null) === scope.websiteId && domain.certificateId === scope.certificateId
      && domain.primaryDomain === scope.primaryDomain && domain.httpsMode === 'managed'
      && Number.isSafeInteger(domain.desiredRevision) && domain.desiredRevision > 0);
    return { ...scope, desiredRevision: domain.desiredRevision };
  }
  async function snapshot() {
    const initial = binding(await call(domainPath));
    const value = await call(certPath);
    requireValue(record(value) && value.id === scope.certificateId && value.domainId === scope.id
      && value.serverId === scope.serverId && value.staging === false && (value.purpose ?? 'web') === 'web'
      && ['active', 'renewing', 'error'].includes(value.state)
      && value.source === 'acme' && value.renewalMode === 'automatic'
      && typeof value.certName === 'string' && /^[a-z0-9.-]{1,253}$/.test(value.certName));
    const certificate = Object.freeze({ id: value.id, certName: value.certName, state: value.state, ...renewalMetadata(value) });
    requireValue(equal(initial, binding(await call(domainPath))));
    return Object.freeze({ binding: Object.freeze(initial), certificate });
  }
  function jobProjection(value) {
    requireValue(record(value) && typeof value.id === 'string' && UUID.test(value.id)
      && (!known || value.id === known.id) && value.operation === 'ssl.renew'
      && value.resourceType === 'certificate' && value.resourceId === scope.certificateId
      && value.serverId === scope.serverId
      && ['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(value.status));
    const result = value.status === 'succeeded' ? value.result : null;
    if (value.status === 'succeeded') requireValue(record(result) && typeof result.certName === 'string'
      && /^[a-z0-9.-]{1,253}$/.test(result.certName) && typeof result.dryRun === 'boolean'
      && result.dryRun === state.dryRun && result.status === (state.dryRun ? 'validated' : 'renewed')
      && (result.staging === undefined || result.staging === false));
    // Never retain raw payloads, paths, API error text or secret material.
    const safeResult = result ? Object.freeze({ certName: result.certName, status: result.status,
      dryRun: result.dryRun, staging: result.staging,
      ...(result.dryRun === false ? renewalMetadata(result) : {}) }) : null;
    const next = Object.freeze({ id: value.id, serverId: scope.serverId, type: 'ssl.renew', operation: 'ssl.renew',
      resourceType: 'certificate', resourceId: scope.certificateId, status: value.status, result: safeResult });
    if (known && TERMINAL.has(known.status)) requireValue(equal(known, next));
    return next;
  }
  function failure(error) {
    if (!current()) return;
    if ([401, 403].includes(error?.status)) {
      known = null; sealed = true;
      publish({ ...EMPTY_SSL_RENEWAL, status: 'forbidden', error: 'SSL erişiminiz doğrulanamadı. Güncel oturumla yeniden kontrol edin.' });
      return;
    }
    publish({ status: sealed ? 'unverified' : 'error', approval: null,
      error: sealed ? 'İşlemin veya sertifika kaydının sonucu doğrulanamadı. Yenileme tekrar gönderilmedi; durumu ve İşlem geçmişini kontrol edin.'
        : 'Güncel sertifika veya site bağı doğrulanamadı. Bilgileri yenileyip yeniden onaylayın.' });
  }
  async function inspect() {
    if (!known) {
      const view = await snapshot();
      publish({ certificate: view.certificate, status: sealed ? 'uncertain' : 'idle',
        error: sealed ? 'İstek cevabı kayboldu; sunucuda iş başlamış olabilir. İşlem geçmişini kontrol edin. Bu ekrandan otomatik tekrar yapılmayacak.' : null });
      return;
    }
    const next = jobProjection(await call(`/jobs/${encodeURIComponent(known.id)}`));
    known = next;
    if (!TERMINAL.has(next.status)) {
      publish({ job: next, status: ++polls < 120 ? 'waiting' : 'paused' });
      return;
    }
    if (!terminalSeen) {
      terminalSeen = true;
      publish({ job: next, terminalVersion: state.terminalVersion + 1 });
    }
    if (next.status !== 'succeeded') {
      sealed = false;
      publish({ status: 'failed', job: next, outcome: next.status, approval: null,
        error: next.status === 'cancelled' ? 'Yenileme işi iptal edildi; yeni geçerlilik süresi varsayılmadı.' : 'Yenileme işi başarısız oldu. İşlem ayrıntısını ve mevcut sertifikayı kontrol edin.' });
      return;
    }
    const view = await snapshot();
    const outcome = renewalOutcome(next, state.before, view.certificate, state.dryRun);
    if (outcome === 'syncing') {
      publish({ status: ++syncReads < 8 ? 'syncing' : 'unverified', job: next, certificate: view.certificate,
        outcome, error: 'İş tamamlandı, ancak kalıcı sertifika kaydı henüz aynı sonucu göstermiyor. Yenileme tekrar gönderilmeden kayıt yeniden okunacak.' });
      return;
    }
    const changed = state.outcome !== outcome || !equal(state.certificate, view.certificate);
    sealed = false;
    publish({ status: 'complete', job: next, certificate: view.certificate, outcome, error: null,
      syncVersion: state.syncVersion + (changed ? 1 : 0) });
  }
  async function prepare(dryRun) {
    if (busy || sealed || !current() || canStart() !== true || typeof dryRun !== 'boolean') return state;
    busy = true; publish({ status: 'preparing', approval: null, error: null });
    try {
      check(true); const view = await snapshot(); check(true); requireValue(view.certificate.state === 'active');
      publish({ status: 'idle', certificate: view.certificate,
        approval: Object.freeze({ dryRun, view, confirmation: scope.primaryDomain }) });
    } catch (error) { failure(error); } finally { busy = false; }
    return state;
  }
  async function confirm(approval, confirmation) {
    if (busy || sealed || !current() || canStart() !== true || !approval || approval !== state.approval
      || confirmation !== approval.confirmation) return state;
    busy = true; publish({ status: 'checking', error: null });
    try {
      check(true); requireValue(equal(await snapshot(), approval.view)); check(true); requireValue(canStart() === true);
      sealed = true; known = null; terminalSeen = false; polls = 0; syncReads = 0;
      publish({ status: 'sending', approval: null, job: null, outcome: null, before: approval.view.certificate, dryRun: approval.dryRun });
      const value = await call(`${certPath}/renew`, { method: 'POST', body: { dryRun: approval.dryRun } });
      check(true); known = jobProjection(value); publish({ job: known });
      await inspect();
    } catch (error) { failure(error); } finally { busy = false; }
    return state;
  }
  async function refresh() {
    if (busy || !current()) return state;
    busy = true; publish({ status: 'reading', approval: null, error: null });
    try { await inspect(); } catch (error) { failure(error); } finally { busy = false; }
    return state;
  }
  return Object.freeze({ prepare, confirm, refresh, getState: () => state,
    cancel: () => { if (!busy) publish({ approval: null }); },
    dispose: () => { disposed = true; lifetime.abort(); } });
}
