import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { panelRequest } from '../api.js';
import { sessionTransitionPending, sessionVersion } from '../session-client.js';
import { Badge, Button, ErrorNotice, KeyValues, Modal } from './PanelKit.jsx';
import { useWorkspace } from './WorkspaceContext.jsx';
import { formatBytes, jobActive, jobFromResponse } from './site-model.js';
import { newerJob } from './job-tracking.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_PHP_FILE_BYTES = 16 * 1024 * 1024;
const COPY_MODES = Object.freeze({
  static: Object.freeze({ slug: 'static-copy', operation: 'website.static.copy', requestParam: 'staticCopyRequest',
    missingCode: 'static_copy_request_not_found', title: 'Statik siteyi kopyala', submitLabel: 'Dosyaları kopyala',
    intro: 'Yalnız statik web dosyaları kopyalanır. Yeni oluşturulmuş veya boş bir hedef site seçin.',
    noTargets: 'Bu sunucuda seçilebilir statik hedef site bulunamadı.' }),
  php: Object.freeze({ slug: 'php-copy', operation: 'website.php.copy', requestParam: 'phpCopyRequest',
    missingCode: 'php_copy_request_not_found', title: 'PHP sitesini kopyala', submitLabel: 'Siteyi kopyala',
    intro: 'Kopyalama için kaynak sitenin giriş dosyasını ve veritabanı bağlantısını hazırlayın. Boş bir veritabanı bağlı yeni bir PHP sitesi seçin.',
    noTargets: 'Bu sunucuda seçilebilir PHP hedefi bulunamadı.' }),
});
const requestMissing = (error, mode) => Boolean(mode) && error?.status === 404 && error.code === mode.missingCode;

export function siteCopyRequest(params, { id: websiteId, runtimeType }) {
  const param = COPY_MODES[runtimeType]?.requestParam;
  if (!param || !UUID.test(websiteId ?? '')) return null;
  const value = params.get(param);
  const prefix = `${websiteId}:`;
  if (!value?.startsWith(prefix)) return null;
  const id = value.slice(prefix.length);
  return UUID.test(id) ? { param, value, id } : null;
}

export function siteCopyRequestView(requestId, editingId, lookup, runtimeType) {
  if (!requestId) return 'form';
  if (lookup?.requestId === requestId && requestMissing(lookup.error, COPY_MODES[runtimeType])) {
    return editingId === requestId ? 'form' : 'missing';
  }
  return 'tracking';
}

function copySiteOptions(website, websites, applications, domains) {
  const { serverId, runtimeType } = website;
  const parentDomains = new Set(domains.map((item) => item.parentDomainId).filter(Boolean));
  const excluded = new Set(domains.filter((item) => item.parentDomainId || parentDomains.has(item.id)).map((item) => item.websiteId));
  const eligibleApps = new Set(applications.filter((item) => item.serverId === serverId && item.type === runtimeType
    && (runtimeType === 'php' || (item.repositoryUrl === null && item.state === 'active' && item.currentReleaseId))).map((item) => item.id));
  const domainsByWebsite = new Map();
  if (runtimeType === 'php') {
    for (const domain of domains) {
      const sites = domainsByWebsite.get(domain.websiteId) ?? [];
      sites.push(domain);
      domainsByWebsite.set(domain.websiteId, sites);
    }
  }
  return websites.filter((item) => {
    if (item.serverId !== serverId || item.runtimeType !== runtimeType || !eligibleApps.has(item.applicationId) || excluded.has(item.id)) return false;
    if (runtimeType !== 'php') return true;
    const bound = domainsByWebsite.get(item.id) ?? [];
    const [domain] = bound;
    return bound.length === 1 && domain.serverId === serverId && domain.targetType === 'php'
      && domain.target?.applicationId === item.applicationId && domain.state === 'active'
      && domain.appliedRevision === domain.desiredRevision && !domain.nginxSettings?.documentRoot;
  });
}

function copyPlan(value, targetWebsiteId, php) {
  if (value?.targetWebsiteId !== targetWebsiteId || !Number.isSafeInteger(value.files) || value.files < 0
    || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || !SHA256.test(value.previewDigest ?? '')
    || typeof value.confirmation !== 'string' || !value.confirmation
    || (php && (value.files !== 1 || value.bytes < 1 || value.bytes > MAX_PHP_FILE_BYTES
      || !Number.isSafeInteger(value.tables) || value.tables < 1 || value.tables > 256))) {
    throw new Error('Kopyalama önizlemesi doğrulanamadı.');
  }
  return { targetWebsiteId, files: value.files, bytes: value.bytes, previewDigest: value.previewDigest,
    confirmation: value.confirmation, ...(php ? { tables: value.tables } : {}) };
}

function scopedJob(value, operation, serverId, applicationId) {
  const job = jobFromResponse(value);
  if (job.operation !== operation || job.serverId !== serverId || job.resourceType !== 'application' || job.resourceId !== applicationId) {
    throw new Error('Kopyalama işi bu siteyle eşleşmiyor.');
  }
  return job;
}

export default function SiteCopyDialog({ website }) {
  const { applications, websites, domains, updateJob } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const { id: websiteId, applicationId, serverId, runtimeType } = website;
  const mode = COPY_MODES[runtimeType];
  const php = runtimeType === 'php';
  const requestId = siteCopyRequest(params, website)?.id ?? null;
  const root = `/websites/${encodeURIComponent(websiteId)}/${mode.slug}`;
  const generation = sessionVersion();
  const [open, setOpen] = useState(Boolean(requestId));
  const [targetId, setTargetId] = useState('');
  const [preview, setPreview] = useState(null);
  const [submissionError, setSubmissionError] = useState(null);
  const [lookup, setLookup] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const life = useRef(null);
  const mutation = useRef(false);

  const sites = copySiteOptions(website, websites.items, applications.items, domains.items);
  const eligible = sites.some((site) => site.id === websiteId);
  const targets = sites.filter((site) => site.id !== websiteId && site.applicationId !== applicationId);
  const target = targets.find((site) => site.id === targetId);
  const readyPlan = preview?.targetWebsiteId === target?.id ? preview : null;
  const job = result?.requestId === requestId ? result.job : null;
  const finished = job !== null && !jobActive(job);
  const view = siteCopyRequestView(requestId, editingId, lookup, runtimeType);
  const editing = view === 'form' && Boolean(requestId);
  const lookupError = lookup?.requestId === requestId ? lookup.error : null;

  useEffect(() => {
    const scope = { controller: new AbortController(), generation };
    life.current = scope;
    return () => scope.controller.abort();
  }, [root, generation]);

  function storeRequest(id) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (id) next.set(mode.requestParam, `${websiteId}:${id}`);
      else if (siteCopyRequest(previous, website)) next.delete(mode.requestParam);
      return next;
    }, { replace: true });
  }

  function isCurrent(scope) {
    return scope && life.current === scope && !scope.controller.signal.aborted
      && scope.generation === sessionVersion() && !sessionTransitionPending();
  }

  function recordJob(id, current) {
    setResult((previous) => ({ requestId: id, job: newerJob(previous?.requestId === id ? previous.job : null, current) }));
    updateJob(current);
  }

  useEffect(() => {
    if (!requestId || editing || finished || busy === 'submit') return;
    const scope = life.current;
    const controller = new AbortController();
    let timer;
    let failures = 0;
    const active = () => !controller.signal.aborted && isCurrent(scope);
    async function read() {
      if (!active()) return;
      try {
        const value = await panelRequest(`${root}/requests/${encodeURIComponent(requestId)}`, { signal: controller.signal });
        if (!active()) return;
        const current = scopedJob(value, mode.operation, serverId, applicationId);
        recordJob(requestId, current);
        setLookup(null);
        setSubmissionError(null);
        failures = 0;
        if (jobActive(current)) timer = setTimeout(read, 1800);
      } catch (error) {
        if (!active() || error.name === 'AbortError') return;
        if ([401, 403, 404].includes(error.status)) setResult(null);
        setLookup({ requestId, error });
        failures += 1;
        if (failures < 3 && !requestMissing(error, mode) && ![401, 403].includes(error.status)) timer = setTimeout(read, 1800);
      }
    }
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [requestId, editing, finished, busy, root, mode, serverId, applicationId, generation, refresh, updateJob]);

  async function submit(event) {
    event.preventDefault();
    const scope = life.current;
    if (!eligible || !target || view !== 'form' || mutation.current || !isCurrent(scope)) return;
    mutation.current = true;
    setBusy(readyPlan ? 'submit' : 'preview');
    setSubmissionError(null);
    try {
      if (!readyPlan) {
        const value = await panelRequest(`${root}/preview`, { method: 'POST', body: { targetWebsiteId: target.id }, signal: scope.controller.signal });
        if (isCurrent(scope)) setPreview(copyPlan(value, target.id, php));
        return;
      }
      const id = requestId ?? crypto.randomUUID();
      if (!requestId) storeRequest(id);
      setEditingId(null);
      setLookup(null);
      const { targetWebsiteId, previewDigest, confirmation } = readyPlan;
      const value = await panelRequest(`${root}/requests`, { method: 'POST',
        body: { targetWebsiteId, requestId: id, previewDigest, confirmation }, signal: scope.controller.signal });
      if (isCurrent(scope)) recordJob(id, scopedJob(value, mode.operation, serverId, applicationId));
    } catch (error) {
      if (isCurrent(scope) && error.name !== 'AbortError') {
        setSubmissionError(error);
      }
    } finally {
      mutation.current = false;
      if (isCurrent(scope)) setBusy(null);
    }
  }

  function closeDialog() {
    setOpen(false);
    if (!requestId || finished || editing) {
      if (finished) storeRequest(null);
      setEditingId(null);
      setTargetId('');
      setPreview(null);
      setSubmissionError(null);
      setLookup(null);
      setResult(null);
    }
  }

  function reopenPreview() {
    setPreview(null);
    setEditingId(requestId);
  }

  if (!eligible && !requestId) return null;
  return <>
    <Button icon={requestId ? 'jobs' : 'folder'} onClick={() => setOpen(true)}>{requestId ? 'Kopyalama durumu' : 'Siteyi kopyala'}</Button>
    {open && <Modal title={mode.title} busy={Boolean(busy)} onClose={closeDialog}>
      {view !== 'form' ? <>
        {job ? <div role="status"><Badge state={job.status} /></div> : !submissionError && !lookupError && <div role="status" className="ws-loading"><span className="ws-spinner" />Kopyalama durumu bekleniyor…</div>}
        <ErrorNotice error={job?.error?.message ?? (submissionError ?? lookupError)?.message} />
        {job?.status === 'succeeded' && <KeyValues items={[
          ['Kopyalanan dosya', job.result?.filesCopied], ['Kopyalanan boyut', formatBytes(job.result?.bytesCopied)],
          ...(php ? [['Kopyalanan tablo', job.result?.tablesCopied], ['Veritabanı boyutu', formatBytes(job.result?.databaseBytes)]] : []),
        ]} />}
        <footer className="ws-modal-footer">
          <Button disabled={Boolean(busy)} onClick={closeDialog}>Kapat</Button>
          {!finished && (submissionError || lookupError) && <Button icon="refresh" onClick={() => { setLookup(null); setRefresh((value) => value + 1); }}>Durumu yenile</Button>}
          {eligible && view === 'missing' && <Button variant="primary" onClick={reopenPreview}>Önizlemeye dön</Button>}
        </footer>
      </> : <form onSubmit={submit}>
        <p className="ws-muted">{mode.intro}</p>
        {targets.length ? <label>Hedef site<select required value={targetId} disabled={Boolean(busy)} onChange={(event) => {
          setTargetId(event.target.value); setPreview(null); setSubmissionError(null);
        }}><option value="">Site seçin</option>{targets.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label>
          : <p className="ws-muted">{mode.noTargets}</p>}
        {readyPlan && <KeyValues items={[
          ['Hedef site', target.name], ['Dosya sayısı', readyPlan.files], ['Toplam boyut', formatBytes(readyPlan.bytes)],
          ...(php ? [['Tablo sayısı', readyPlan.tables]] : []),
        ]} />}
        <ErrorNotice error={submissionError?.message} />
        <footer className="ws-modal-footer"><Button disabled={Boolean(busy)} onClick={closeDialog}>Vazgeç</Button>
          <Button type="submit" variant="primary" disabled={!eligible || !target || Boolean(busy)}>{busy ? 'İşleniyor…' : readyPlan ? mode.submitLabel : 'Önizle'}</Button>
        </footer>
      </form>}
    </Modal>}
  </>;
}
