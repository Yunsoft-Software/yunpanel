// Client-side consistency checks complement, never replace, API authorization.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const JOB_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const USER = /^yunapp-[a-f0-9]{12}$/;
const record = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const taskFields = ['id', 'websiteId', 'serverId', 'applicationId', 'unixUser', 'name', 'schedule', 'command', 'enabled', 'revision'];
const unresolved = new Set(['submitting', 'queued', 'running', 'verifying', 'unverified', 'unknown']);

export class CronTaskClientError extends Error {
  constructor(code) { super(code); this.name = 'CronTaskClientError'; this.code = code; }
}
function requireValue(value, code = 'cron_response_invalid') {
  if (!value) throw new CronTaskClientError(code);
}
function text(value, max, code) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/u.test(value), code);
  return value.trim();
}
export function cronDraft(value) {
  requireValue(record(value) && typeof value.enabled === 'boolean', 'cron_input_invalid');
  const schedule = text(value.schedule, 320, 'cron_schedule_invalid').replace(/ +/g, ' ');
  requireValue(schedule.split(' ').length === 5, 'cron_schedule_invalid');
  return Object.freeze({ name: text(value.name, 80, 'cron_name_invalid'), schedule,
    command: text(value.command, 4096, 'cron_command_invalid'), enabled: value.enabled });
}
export function cronScope(value) {
  requireValue(record(value) && [value.websiteId, value.serverId, value.applicationId].every((id) => typeof id === 'string' && UUID.test(id))
    && typeof value.unixUser === 'string' && USER.test(value.unixUser), 'cron_scope_invalid');
  return Object.freeze({ websiteId: value.websiteId, serverId: value.serverId, applicationId: value.applicationId, unixUser: value.unixUser });
}
export function cronTask(value, scope, { listing = false } = {}) {
  requireValue(record(value));
  const id = value.id ?? (listing ? value.taskId : null);
  // Reconciliation deliberately returns taskId and omits serverId. Its other
  // binding fields are still mandatory; a raw task must carry its serverId.
  const reconciledShape = listing && value.id === undefined && value.taskId !== undefined;
  requireValue(typeof id === 'string' && UUID.test(id) && (value.taskId === undefined || value.taskId === id)
    && value.websiteId === scope.websiteId && value.applicationId === scope.applicationId
    && value.unixUser === scope.unixUser
    && (value.serverId === scope.serverId || (reconciledShape && value.serverId === undefined))
    && positive(value.revision));
  return Object.freeze({ id, ...scope, ...cronDraft(value), revision: value.revision });
}
export function cronList(value, scope) {
  requireValue(record(value) && value.websiteId === scope.websiteId && Array.isArray(value.tasks)
    && value.tasks.length <= 100 && typeof value.reconciled === 'boolean'
    && [true, false, null].includes(value.cronServiceActive));
  const ids = new Set();
  const items = value.tasks.map((entry) => {
    const task = cronTask(entry, scope, { listing: true });
    requireValue(!ids.has(task.id)); ids.add(task.id);
    let hostState = 'unknown';
    if (value.cronServiceActive === false) hostState = 'service_inactive';
    else if (entry.hostFileExists === false) hostState = 'missing_host_file';
    else if (entry.hostFileExists === true && entry.hostFileExact === false) hostState = 'drifted';
    else if (value.cronServiceActive === true && entry.hostFileExists === true && entry.hostFileExact === true
      && typeof entry.expectedSha256 === 'string' && SHA.test(entry.expectedSha256)
      && entry.currentSha256 === entry.expectedSha256) hostState = 'ready';
    return Object.freeze({ ...task, hostState });
  });
  return Object.freeze({ items: Object.freeze(items), cronServiceActive: value.cronServiceActive });
}
function sameTask(left, right) { return taskFields.every((field) => left[field] === right[field]); }
function readJob(value, task, kind, expectedId = null) {
  requireValue(record(value) && typeof value.id === 'string' && JOB_ID.test(value.id)
    && (expectedId === null || value.id === expectedId) && value.serverId === task.serverId
    && value.resourceType === 'website_cron' && value.resourceId === task.id
    && value.operation === (kind === 'remove' ? 'cron.remove' : 'cron.apply')
    && ['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(value.status), 'cron_job_invalid');
  return Object.freeze({ ...value, result: record(value.result) ? Object.freeze({ ...value.result }) : value.result });
}
function verifyResult(job, task, kind) {
  const result = job.result;
  requireValue(record(result) && result.version === 1 && result.taskId === task.id
    && result.websiteId === task.websiteId && result.applicationId === task.applicationId
    && result.unixUser === task.unixUser && result.revision === task.revision
    && typeof result.desiredStateSha256 === 'string' && SHA.test(result.desiredStateSha256)
    && typeof result.sideEffects === 'boolean', 'cron_result_unverified');
  if (kind === 'remove') {
    requireValue(result.removed === true && ((result.contentSha256 === result.desiredStateSha256 && result.sideEffects === true)
      || (result.contentSha256 === null && result.sideEffects === false)), 'cron_result_unverified');
  } else requireValue(result.applied === true && result.contentSha256 === result.desiredStateSha256, 'cron_result_unverified');
}
const messages = Object.freeze({
  cron_input_invalid: 'Görev bilgilerini ve etkinlik tercihini kontrol edin.',
  cron_name_invalid: 'Görev adı 1–80 karakter olmalıdır.',
  cron_schedule_invalid: 'Zamanlama dakika, saat, gün, ay ve haftanın günü olmak üzere beş alandan oluşmalıdır.',
  cron_command_invalid: 'Komut tek satır ve en fazla 4096 karakter olmalıdır.',
  cron_scope_invalid: 'Sitenin sunucu, uygulama veya sistem kullanıcısı bağı doğrulanamadı.',
  cron_response_invalid: 'Yanıt bu sitenin görev kaydıyla eşleşmiyor. Listeyi yeniden okuyun.',
  cron_job_invalid: 'İşlem kaydı seçilen görevle eşleşmiyor. Başarılı kabul edilmedi.',
  cron_result_unverified: 'Sunucu işleminin sonucu doğrulanamadı. Otomatik tekrar yapılmadı.',
  cron_revision_conflict: 'Görev başka bir işlemde değişti. Listeyi yenileyip yeni kaydı inceleyin.',
  cron_stale: 'Görev inceleme sonrasında değişti. Listeyi yenileyip yeniden inceleyin.',
  cron_context_unready: 'Site, yetki veya işlem bilgisi güncel değil. Yenileyip yeniden deneyin.',
  cron_busy: 'Bu görev ekranında sonuç bekleyen bir işlem var.',
  cron_unknown: 'İsteğin sonucu bilinmiyor; yeniden gönderilmedi. Görev listesini ve işlem geçmişini kontrol edin.',
  cron_read_failed: 'Güncel görev bilgisi alınamadı. Mevcut işlem yeniden gönderilmedi.',
  cron_forbidden: 'Bu siteye erişim izni veya oturum geçerliliği kayboldu.',
});
export function cronErrorMessage(error) { return messages[error?.code] ?? 'Görev işlemi tamamlanmadı. Güncel listeyi ve işlem kaydını kontrol edin.'; }

export function createCronTaskClient({ scope: rawScope, request, isCurrent = () => true, canWrite = () => true, onJob = () => {} }) {
  const scope = cronScope(rawScope);
  requireValue(typeof request === 'function', 'cron_input_invalid');
  const base = `/websites/${encodeURIComponent(scope.websiteId)}/crons`;
  const taskPath = (id) => `${base}/${encodeURIComponent(id)}`;
  const controller = new AbortController();
  const listeners = new Set();
  let active = true, writing = false, polling = false, readSequence = 0, mutationSequence = 0;
  let state = Object.freeze({ items: null, cronServiceActive: null, fresh: false, loading: false, busy: false,
    denied: false, error: null, operation: null, reads: 0 });
  const current = () => active && isCurrent();
  function publish(patch) {
    if (!current()) return;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) { try { listener(state); } catch { /* View errors cannot replay a write. */ } }
  }
  function checkCurrent() { requireValue(current() && !state.denied, 'cron_context_unready'); }
  function checkWrite(task = null) { checkCurrent(); requireValue(canWrite(task), 'cron_context_unready'); }
  function report(error, fallback = null) {
    if (!current()) return;
    if ([401, 403].includes(error?.status) || ['unauthorized', 'forbidden'].includes(error?.code)) {
      readSequence++; mutationSequence++;
      publish({ denied: true, items: null, fresh: false, loading: false, busy: false, operation: null, error: messages.cron_forbidden });
    } else publish({ error: fallback ?? cronErrorMessage(error) });
  }
  async function read(path) {
    checkCurrent();
    const value = await request(path, { signal: controller.signal });
    checkCurrent(); return value;
  }
  function observe(job, first) { try { onJob(job, first); } catch { /* A drawer callback is not a job failure. */ } }
  async function load() {
    if (!current() || state.denied || writing) return null;
    const sequence = ++readSequence, mutation = mutationSequence;
    publish({ loading: true, fresh: false, error: null });
    try {
      const value = cronList(await read(base), scope);
      if (sequence !== readSequence || mutation !== mutationSequence) return null;
      publish({ ...value, fresh: true, reads: state.reads + 1 }); return value;
    } catch (error) { if (sequence === readSequence && mutation === mutationSequence) report(error, error?.code ? null : messages.cron_read_failed); return null; }
    finally { if (sequence === readSequence && mutation === mutationSequence) publish({ loading: false }); }
  }
  async function mutate(kind, input, selected) {
    if (!current() || state.denied || writing || polling || unresolved.has(state.operation?.phase)) return false;
    let sent = false, prior = null;
    try {
      checkWrite(selected); requireValue(state.fresh, 'cron_context_unready');
      const draft = kind === 'remove' ? null : cronDraft(input);
      prior = selected ? cronTask(selected, scope) : null;
      requireValue(kind !== 'remove' || prior, 'cron_input_invalid');
      writing = true; readSequence++; mutationSequence++;
      publish({ busy: true, loading: false, error: null });
      if (prior) {
        const latest = cronTask(await read(taskPath(prior.id)), scope);
        requireValue(sameTask(latest, prior), 'cron_stale');
      }
      checkWrite(prior);
      const body = kind === 'remove' ? { expectedRevision: prior.revision }
        : prior ? { ...draft, expectedRevision: prior.revision } : draft;
      const method = kind === 'remove' ? 'DELETE' : prior ? 'PATCH' : 'POST';
      sent = true;
      publish({ fresh: false, operation: Object.freeze({ kind, phase: 'submitting', task: prior, job: null, reads: state.reads }) });
      const value = await request(prior ? taskPath(prior.id) : base, { method, body, signal: controller.signal });
      checkCurrent();
      let task = prior;
      if (kind === 'remove') requireValue(record(value) && value.accepted === true && value.taskId === prior.id && value.websiteId === scope.websiteId);
      else {
        task = cronTask(value?.task, scope);
        requireValue((!prior || (task.id === prior.id && task.revision === prior.revision + 1))
          && ['name', 'schedule', 'command', 'enabled'].every((field) => task[field] === draft[field]));
      }
      const job = readJob(value?.job, task, kind);
      publish({ operation: Object.freeze({ kind, task, job, phase: ['failed', 'cancelled'].includes(job.status) ? 'failed' : job.status === 'succeeded' ? 'verifying' : job.status }) });
      observe(job, true); return true;
    } catch (error) {
      if (sent && current() && ![401, 403].includes(error?.status) && !['unauthorized', 'forbidden'].includes(error?.code)) {
        // Even an HTTP error can follow a saved record and failed queue write.
        publish({ fresh: false, operation: Object.freeze({ kind, task: prior, job: null, phase: 'unknown', reads: state.reads }) });
        report(error, messages.cron_unknown);
      } else report(error);
      return false;
    } finally { writing = false; publish({ busy: false }); }
  }
  async function refreshOperation() {
    const operation = state.operation;
    if (!current() || state.denied || writing || polling || !operation?.job || ['succeeded', 'failed'].includes(operation.phase)) return false;
    polling = true; publish({ busy: true, error: null });
    try {
      const job = readJob(await read(`/jobs/${encodeURIComponent(operation.job.id)}`), operation.task, operation.kind, operation.job.id);
      checkCurrent();
      if (state.operation !== operation) return false;
      const next = { ...operation, job };
      if (['failed', 'cancelled'].includes(job.status)) {
        publish({ operation: Object.freeze({ ...next, phase: 'failed' }) }); observe(job, false); return false;
      }
      if (job.status !== 'succeeded') {
        publish({ operation: Object.freeze({ ...next, phase: job.status }) }); observe(job, false); return false;
      }
      verifyResult(job, operation.task, operation.kind);
      publish({ operation: Object.freeze({ ...next, phase: 'verifying' }) }); observe(job, false);
      const listing = await load();
      checkCurrent();
      if (!listing || state.operation?.job?.id !== job.id) return false;
      const present = listing.items.find((item) => item.id === operation.task.id);
      const verified = operation.kind === 'remove' ? !present : present && sameTask(present, operation.task);
      publish({ operation: Object.freeze({ ...next, phase: verified ? 'succeeded' : 'verifying' }) });
      return Boolean(verified);
    } catch (error) {
      if (current() && ['cron_job_invalid', 'cron_result_unverified', 'cron_response_invalid'].includes(error?.code)) {
        publish({ operation: Object.freeze({ ...operation, phase: 'unverified' }) });
      }
      report(error, error?.code ? null : messages.cron_read_failed); return false;
    } finally { polling = false; publish({ busy: false }); }
  }
  return Object.freeze({
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    load, save: (draft, task = null) => mutate('apply', draft, task), remove: (task) => mutate('remove', null, task), refreshOperation,
    acknowledgeUnknown() {
      // Explicit user acknowledgement after a fresh GET is not success evidence.
      if (!current() || state.denied || state.busy || state.operation?.phase !== 'unknown'
        || !state.fresh || state.reads <= state.operation.reads) return false;
      publish({ operation: null, error: messages.cron_unknown }); return true;
    },
    dispose() { active = false; controller.abort(); listeners.clear(); },
  });
}
