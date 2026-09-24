// Uses the existing mailbox PATCH and mail configuration job. No domain-status
// change, deletion, policy cleanup, password storage or automatic write replay.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const JOB = /^[A-Za-z0-9._:-]{8,128}$/;
const record = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const revision = (value) => Number.isSafeInteger(value) && value > 0;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function requireValue(condition) {
  if (!condition) throw Object.assign(new Error('Posta erişim işlemi doğrulanamadı.'), { code: 'mailbox_access_response_invalid' });
}
export const EMPTY_MAILBOX_ACCESS = Object.freeze({ status: 'idle', snapshot: null, approval: null, job: null, applied: false, error: null, changes: 0 });
export const mailboxAccessBusy = (state) => ['loading', 'checking', 'sending', 'preparing'].includes(state.status);

export function createMailboxAccessPreparation({ target, request, isCurrent = () => true, canManage = () => false, onState = () => {} } = {}) {
  requireValue(record(target) && typeof target.id === 'string' && UUID.test(target.id)
    && typeof target.mailDomainId === 'string' && UUID.test(target.mailDomainId)
    && typeof target.address === 'string' && /^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9.-]+$/.test(target.address)
    && target.address.length <= 254);
  if ([request, isCurrent, canManage, onState].some((fn) => typeof fn !== 'function')) throw new TypeError('Posta istemcisi eksik.');
  const identity = Object.freeze({ ...target });
  const base = `/mailboxes/${encodeURIComponent(identity.id)}`;
  const domainBase = `/mail-domains/${encodeURIComponent(identity.mailDomainId)}`;
  const lifetime = new AbortController();
  let state = EMPTY_MAILBOX_ACCESS, busy = false, disposed = false, expectedJob = null, unresolvedApply = false;
  const current = () => !disposed && !lifetime.signal.aborted && isCurrent() === true;
  const publish = (patch) => { if (current()) { state = Object.freeze({ ...state, ...patch }); onState(state); } };
  function check(write = false) {
    if (!current()) throw Object.assign(new Error('Takip durduruldu.'), { name: 'AbortError' });
    if (write && canManage() !== true) throw Object.assign(new Error('Yetki değişti.'), { status: 403 });
  }
  async function call(path, options = {}, write = false) {
    check(write); const value = await request(path, { ...options, signal: lifetime.signal }); check(write); return value;
  }
  function mailbox(value) {
    requireValue(record(value) && value.id === identity.id && value.mailDomainId === identity.mailDomainId
      && value.address === identity.address && revision(value.revision) && typeof value.enabled === 'boolean');
    return value;
  }
  async function snapshot() {
    const box = mailbox(await call(base));
    const domain = await call(domainBase);
    requireValue(record(domain) && domain.id === identity.mailDomainId && domain.domainName === identity.address.split('@')[1]
      && domain.managementMode === 'local' && revision(domain.revision) && ['enabled', 'disabled'].includes(domain.status));
    return Object.freeze({ revision: box.revision, enabled: box.enabled, domainRevision: domain.revision, domainStatus: domain.status });
  }
  async function preview(view) {
    const value = await call(`${domainBase}/config-preview`, { method: 'POST', body: { expectedRevision: view.domainRevision, status: view.domainStatus } });
    requireValue(record(value) && value.version === 1 && value.operation === 'mail_configuration_apply'
      && value.mailDomainId === identity.mailDomainId && value.expectedRevision === view.domainRevision
      && value.currentStatus === view.domainStatus && value.desiredStatus === view.domainStatus
      && value.readyToApply === true && value.sideEffects === false && Array.isArray(value.blockers) && value.blockers.length === 0
      && typeof value.previewDigest === 'string' && SHA.test(value.previewDigest)
      && typeof value.configuration?.sha256 === 'string' && SHA.test(value.configuration.sha256)
      && value.configurationSha256 === value.configuration.sha256
      && value.confirmation === `apply-mail-configuration:${identity.mailDomainId}:${value.previewDigest}`);
    return Object.freeze({ expectedRevision: view.domainRevision, status: view.domainStatus,
      previewDigest: value.previewDigest, configurationSha256: value.configuration.sha256, confirmation: value.confirmation });
  }
  function job(value, expected) {
    requireValue(record(value) && typeof value.id === 'string' && JOB.test(value.id)
      && (!expected.id || value.id === expected.id) && value.operation === 'mail.config.apply'
      && value.resourceType === 'mail_domain' && value.resourceId === identity.mailDomainId
      && ['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(value.status));
    if (value.status === 'succeeded') {
      const result = value.result;
      requireValue(record(result) && result.version === 3 && result.applied === true && result.sideEffects === true
        && result.mailDomainId === identity.mailDomainId && result.configurationSha256 === expected.body.configurationSha256
        && result.previousRevision === expected.view.domainRevision && result.previousStatus === expected.view.domainStatus
        && result.desiredStatus === expected.view.domainStatus);
    }
    return Object.freeze({ id: value.id, status: value.status });
  }
  function failure(error, action = null) {
    if (!current()) return;
    if ([401, 403].includes(error?.status)) {
      expectedJob = null; unresolvedApply = false;
      publish({ ...EMPTY_MAILBOX_ACCESS, status: 'forbidden', error: 'Posta hesabı yetkiniz doğrulanamadı. Güncel oturumla yeniden kontrol edin.' }); return;
    }
    publish({ status: unresolvedApply ? 'uncertain' : 'error', approval: null, applied: false,
      error: action === 'disable' ? 'Hesap kapatma sonucu doğrulanamadı. Aynı istek tekrarlanmadı; durumu yenileyin.'
        : unresolvedApply ? 'Uygulama sonucu doğrulanamadı. Yeniden göndermek yerine mevcut iş kimliğini doğrulayın.'
          : 'Güncel kayıt veya önizleme doğrulanamadı. Durumu yenileyip yeniden onaylayın.',
    });
  }
  async function inspect() {
    let latestJob = state.job;
    if (expectedJob?.id) latestJob = job(await call(`/jobs/${encodeURIComponent(expectedJob.id)}`), expectedJob);
    const view = await snapshot();
    const completed = latestJob?.status === 'succeeded' && expectedJob && same(view, expectedJob.view) && view.enabled === false;
    const waiting = latestJob && ['queued', 'running'].includes(latestJob.status);
    if (completed || (latestJob && ['failed', 'cancelled'].includes(latestJob.status))) unresolvedApply = false;
    publish({ snapshot: view, job: latestJob, applied: Boolean(completed),
      status: waiting ? 'waiting' : unresolvedApply ? 'uncertain' : 'ready',
      error: latestJob && ['failed', 'cancelled'].includes(latestJob.status) ? 'Yapılandırma uygulanmadı. İşlem geçmişinden mevcut işin hatasını kontrol edin.' : null });
  }
  async function load() {
    if (busy || !current()) return state;
    busy = true; publish({ status: 'loading', approval: null, error: null });
    try { await inspect(); } catch (error) { failure(error); } finally { busy = false; }
    return state;
  }
  async function prepare(action) {
    if (busy || !current() || state.status !== 'ready' || unresolvedApply || !['disable', 'apply'].includes(action)) return state;
    busy = true; publish({ status: 'preparing', approval: null, error: null, applied: false });
    try {
      check(true); const view = await snapshot();
      requireValue(action === 'disable' ? view.enabled === true : view.enabled === false);
      const body = action === 'disable' ? Object.freeze({ expectedRevision: view.revision, enabled: false }) : await preview(view);
      check(true);
      const confirmation = action === 'disable' ? `disable-mailbox:${identity.address}:${view.revision}` : body.confirmation;
      publish({ status: 'ready', snapshot: view, approval: Object.freeze({ action, view, body, confirmation }) });
    } catch (error) { failure(error); } finally { busy = false; }
    return state;
  }
  async function perform(approval, confirmation) {
    if (busy || !current() || state.status !== 'ready' || unresolvedApply || !approval || approval !== state.approval || confirmation !== approval.confirmation) return state;
    busy = true; let sent = null; publish({ status: 'checking', error: null });
    try {
      check(true); const view = await snapshot(); requireValue(same(view, approval.view));
      if (approval.action === 'apply') requireValue(same(await preview(view), approval.body));
      publish({ status: 'sending' }); check(true); sent = approval.action;
      if (sent === 'disable') {
        const value = mailbox(await call(base, { method: 'PATCH', body: approval.body }, true));
        requireValue(value.enabled === false && value.revision === view.revision + 1);
        const latest = await snapshot(); requireValue(latest.enabled === false && latest.revision === value.revision);
        publish({ status: 'ready', snapshot: latest, approval: null, applied: false, changes: state.changes + 1 });
      } else {
        unresolvedApply = true; expectedJob = { body: approval.body, view, id: null };
        publish({ job: null, applied: false });
        const value = await call(`${domainBase}/config-apply`, { method: 'POST', body: approval.body }, true);
        const queued = job(value, expectedJob); expectedJob.id = queued.id;
        publish({ job: queued, approval: null, changes: state.changes + 1 }); await inspect();
      }
    } catch (error) { failure(error, sent); } finally { busy = false; }
    return state;
  }
  async function resume(id) {
    if (busy || !current() || !expectedJob || typeof id !== 'string' || !JOB.test(id) || (expectedJob.id && expectedJob.id !== id)) return state;
    busy = true; publish({ status: 'loading', approval: null, error: null });
    try { const value = job(await call(`/jobs/${encodeURIComponent(id)}`), { ...expectedJob, id });
      expectedJob.id = id; publish({ job: value }); await inspect();
    } catch (error) { failure(error); } finally { busy = false; }
    return state;
  }
  return Object.freeze({ load, prepare, perform, resume, getState: () => state,
    cancel: () => { if (!busy) publish({ approval: null }); }, dispose: () => { disposed = true; lifetime.abort(); } });
}
