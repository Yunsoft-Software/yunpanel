import {
  mailboxRemovalTarget, mailboxRemovalSnapshot, mailboxRemovalEligible, mailboxRemovalPreview,
  mailboxRemovalJob, mailboxRemovalJobId, mailboxRemovalFinalResult, mailboxRemovalInvalid,
} from './mailbox-removal-model.js';

const ERROR_TEXT = Object.freeze({
  mail_data_delete_domain_disable_required: 'Önce Yapılandırma bölümünde bu alan adının postasını kapatıp uygulayın. Diğer posta kutuları da etkilenir.',
  mail_data_delete_backup_stale: 'Posta verisi yedekten sonra değişti. Önce güncel durumu kontrol edin; eski yedekle silme yapılmaz.',
  mail_data_delete_dependencies_exist: 'Kota, yönlendirme, takma ad veya çalışan iş engellerini kaldırıp durumu yenileyin.',
  mail_domain_job_conflict: 'Bu posta alan adında çalışan bir işlem var. Tamamlandıktan sonra durumu yenileyin.',
  mail_delete_impact_not_clear: 'Silme önkoşulları değişti. Kayıt kaldırılmadı; durumu yenileyin.',
  mailbox_removal_changed: 'Posta kutusu veya silme etkisi değişti. Güncel durumu inceleyip yeniden onaylayın.',
});
export const EMPTY_MAILBOX_REMOVAL = Object.freeze({
  status: 'idle', snapshot: null, approval: null, job: null, backupId: null,
  receipt: null, result: null, uncertain: false, error: null,
});
const signature = (value) => JSON.stringify(value);
const waiting = (job) => job && ['queued', 'running'].includes(job.status);

// Sequences existing public APIs. Never disables a whole domain, clears policies,
// retries a mutation, deletes without a backup, or treats a job 202 as completion.
export function createMailboxRemoval({ target: input, request, isCurrent = () => true, canManage = () => false, onState = () => {} } = {}) {
  const target = mailboxRemovalTarget(input);
  if ([request, isCurrent, canManage, onState].some((fn) => typeof fn !== 'function')) throw new TypeError('Posta istemcisi eksik.');
  const base = `/mailboxes/${encodeURIComponent(target.id)}`;
  let state = EMPTY_MAILBOX_REMOVAL, inFlight = false, disposed = false, ticket = null;
  const lifetime = new AbortController();
  const current = () => !disposed && !lifetime.signal.aborted && isCurrent() === true;
  const publish = (patch) => { if (current()) { state = Object.freeze({ ...state, ...patch }); onState(state); } };
  function check(write = false) {
    if (!current()) throw Object.assign(new Error('İzleme durduruldu.'), { name: 'AbortError' });
    if (write && canManage() !== true) throw Object.assign(new Error('Yetki değişti.'), { status: 403 });
  }
  async function call(path, options = {}, write = false) {
    check(write);
    const value = await request(path, { ...options, signal: lifetime.signal });
    check(write);
    return value;
  }
  async function snapshot() {
    const mailbox = await call(base);
    const domain = await call(`/mail-domains/${encodeURIComponent(target.mailDomainId)}`);
    const impact = await call(`${base}/delete-impact`);
    return mailboxRemovalSnapshot(mailbox, domain, impact, target);
  }
  async function preview(action, view, backupId) {
    const value = action === 'backup' ? await call(`${base}/data/backup-preview`)
      : await call(`${base}/data/delete-preview`, { method: 'POST', body: { backupId } });
    return mailboxRemovalPreview(value, target, view, action, backupId);
  }
  function adopt(job) {
    const patch = { job };
    if (job.status === 'succeeded') {
      patch.uncertain = false;
      if (job.action === 'backup') patch.backupId = job.backupId;
      else { patch.backupId = job.backupId; patch.receipt = job; }
    }
    if (['failed', 'cancelled'].includes(job.status)) {
      patch.uncertain = true;
      patch.error = 'İş tamamlanmadı. Aynı yazma otomatik tekrarlanmayacak; işlem geçmişinden hata veya kurtarma durumunu kontrol edin.';
    }
    publish(patch);
  }
  async function inspect() {
    if (ticket) adopt(mailboxRemovalJob(await call(`/jobs/${encodeURIComponent(ticket.id)}`), target, ticket));
    const view = await snapshot();
    publish({ snapshot: view, status: waiting(state.job) ? 'waiting' : 'ready' });
  }
  function failed(error, sent) {
    if (!current()) return;
    if ([401, 403].includes(error?.status)) {
      ticket = null;
      publish({ ...EMPTY_MAILBOX_REMOVAL, status: 'forbidden', error: 'Bu posta kutusuna erişiminiz doğrulanamadı. Güncel oturumla yeniden kontrol edin.' });
      return;
    }
    if (error?.status === 404 && error?.code === 'mailbox_not_found') {
      publish({ status: 'absent', snapshot: null, approval: null, error: 'Posta kutusu kaydı bulunamadı. Tek başına bu cevap, veri silme ve hizmet kapatma işlemlerinin tamamlandığını kanıtlamaz.' });
      return;
    }
    publish({ status: sent ? 'uncertain' : 'error', approval: null, uncertain: state.uncertain || sent,
      error: sent ? 'İsteğin sonucu doğrulanamadı; sunucuda uygulanmış olabilir. Otomatik tekrar yapılmaz. Durumu yenileyin veya işlem kimliğiyle mevcut işi okuyun.'
        : Object.hasOwn(ERROR_TEXT, error?.code) ? ERROR_TEXT[error.code] : 'Güncel posta kutusu işlemi doğrulanamadı. Durumu yenileyin; veri veya kayıt silinmiş sayılmadı.',
    });
  }
  async function refresh() {
    if (inFlight || !current() || state.status === 'deleted') return state;
    inFlight = true; publish({ status: 'loading', approval: null, error: null });
    try { await inspect(); } catch (error) { failed(error, false); }
    finally { inFlight = false; }
    return state;
  }
  async function resume(jobId) {
    if (inFlight || !current() || state.status === 'deleted') return state;
    if (!mailboxRemovalJobId(jobId) || (state.receipt && state.receipt.id !== jobId)) return state;
    inFlight = true; publish({ status: 'loading', approval: null, error: null });
    try {
      const value = await call(`/jobs/${encodeURIComponent(jobId)}`);
      const job = mailboxRemovalJob(value, target, { id: jobId, action: value?.operation === 'mail.data.backup' ? 'backup' : 'delete' });
      ticket = { id: job.id, action: job.action };
      adopt(job);
      publish({ snapshot: await snapshot(), status: waiting(job) ? 'waiting' : 'ready' });
    } catch (error) { failed(error, false); }
    finally { inFlight = false; }
    return state;
  }
  function allowed(action, view) {
    if (state.uncertain || waiting(state.job) || !mailboxRemovalEligible(view)) return false;
    if (action === 'finalize') return Boolean(state.receipt && state.receipt.revision === view.revision
      && mailboxRemovalEligible(view, { allowData: false }));
    return !state.receipt && (action === 'backup' || (action === 'delete' && mailboxRemovalJobId(state.backupId)));
  }
  async function prepare(action) {
    if (inFlight || !current() || state.status !== 'ready' || !['backup', 'delete', 'finalize'].includes(action)) return state;
    inFlight = true; publish({ status: 'preparing', approval: null, error: null });
    try {
      check(true);
      const view = await snapshot();
      check(true);
      publish({ snapshot: view });
      if (!allowed(action, view)) throw Object.assign(mailboxRemovalInvalid(), { code: 'mail_data_delete_dependencies_exist' });
      const data = action === 'finalize'
        ? { confirmation: `delete-mailbox:${target.address}`, expectedRevision: view.revision, deleteJobId: state.receipt.id }
        : await preview(action, view, state.backupId);
      check(true);
      publish({ status: 'ready', approval: Object.freeze({ action, data, snapshot: signature(view) }) });
    } catch (error) { failed(error, false); }
    finally { inFlight = false; }
    return state;
  }
  async function confirm(approval, confirmation) {
    if (inFlight || !current() || state.status !== 'ready' || !approval || approval !== state.approval
      || confirmation !== approval.data.confirmation) return state;
    inFlight = true; let sent = false;
    publish({ status: 'checking', error: null });
    try {
      check(true);
      const view = await snapshot();
      check(true);
      publish({ snapshot: view });
      if (signature(view) !== approval.snapshot || !allowed(approval.action, view)) {
        throw Object.assign(mailboxRemovalInvalid(), { code: 'mailbox_removal_changed' });
      }
      if (approval.action === 'finalize') {
        publish({ status: 'sending' }); check(true); sent = true;
        const value = await call(base, { method: 'DELETE', body: approval.data }, true);
        const result = mailboxRemovalFinalResult(value, target, state.receipt);
        publish({ status: 'deleted', approval: null, result, uncertain: false });
      } else {
        const latest = await preview(approval.action, view, state.backupId);
        if (signature(latest) !== signature(approval.data)) throw Object.assign(mailboxRemovalInvalid(), { code: 'mailbox_removal_changed' });
        const { expectedRevision, expectedPreviewDigest, confirmation: text } = latest;
        const body = { expectedRevision, expectedPreviewDigest, confirmation: text,
          ...(approval.action === 'delete' ? { backupId: latest.backupId } : {}) };
        // A previous completed backup must not reconcile an unknown NEW write.
        ticket = null; publish({ status: 'sending', job: null }); check(true); sent = true;
        const queued = await call(`${base}/data/${approval.action}`, { method: 'POST', body }, true);
        if (queued?.previewDigest !== expectedPreviewDigest || queued?.job?.operation !== `mail.data.${approval.action}`) throw mailboxRemovalInvalid();
        const expected = { id: queued.job.id, action: approval.action, preview: latest };
        const job = mailboxRemovalJob(queued.job, target, expected);
        ticket = expected; publish({ approval: null }); adopt(job);
        // Re-read after the acknowledged operation; no automatic next mutation.
        await inspect();
      }
    } catch (error) { failed(error, sent); }
    finally { inFlight = false; }
    return state;
  }
  return Object.freeze({ refresh, resume, prepare, confirm, getState: () => state,
    cancel: () => { if (!inFlight) publish({ approval: null }); },
    dispose: () => { disposed = true; lifetime.abort(); },
  });
}
