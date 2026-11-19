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
const COPY_OPERATION = 'website.static.copy';
const NO_REQUEST = 'static_copy_request_not_found';

export const STATIC_COPY_REQUEST_PARAM = 'staticCopyRequest';

export function staticCopyRequestId(params, websiteId) {
  const value = params.get(STATIC_COPY_REQUEST_PARAM);
  const prefix = `${websiteId}:`;
  if (!UUID.test(websiteId ?? '') || !value?.startsWith(prefix)) return null;
  const requestId = value.slice(prefix.length);
  return UUID.test(requestId) ? requestId : null;
}

function copySiteOptions(website, websites, applications, domains) {
  const parentDomains = new Set(domains.map((item) => item.parentDomainId).filter(Boolean));
  const excluded = new Set(domains.filter((item) => item.parentDomainId || parentDomains.has(item.id)).map((item) => item.websiteId));
  const eligibleApps = new Set(applications.filter((item) => item.serverId === website.serverId && item.type === 'static'
    && item.repositoryUrl === null && item.state === 'active' && item.currentReleaseId).map((item) => item.id));
  return websites.filter((item) => item.serverId === website.serverId && item.runtimeType === 'static'
    && eligibleApps.has(item.applicationId) && !excluded.has(item.id));
}

function copyPlan(value, targetWebsiteId) {
  if (value?.targetWebsiteId !== targetWebsiteId || !Number.isSafeInteger(value.files) || value.files < 0
    || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || !SHA256.test(value.previewDigest ?? '')
    || typeof value.confirmation !== 'string' || !value.confirmation) {
    throw new Error('Kopyalama önizlemesi doğrulanamadı.');
  }
  return { targetWebsiteId, files: value.files, bytes: value.bytes, previewDigest: value.previewDigest, confirmation: value.confirmation };
}

function scopedJob(value, serverId, applicationId) {
  const job = jobFromResponse(value);
  if (job.operation !== COPY_OPERATION || job.serverId !== serverId || job.resourceType !== 'application' || job.resourceId !== applicationId) {
    throw new Error('Kopyalama işi bu siteyle eşleşmiyor.');
  }
  return job;
}

export default function StaticSiteCopyDialog({ website }) {
  const { applications, websites, domains, updateJob } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const { id: websiteId, applicationId, serverId } = website;
  const requestId = staticCopyRequestId(params, websiteId);
  const root = `/websites/${encodeURIComponent(websiteId)}/static-copy`;
  const generation = sessionVersion();
  const [open, setOpen] = useState(Boolean(requestId));
  const [targetId, setTargetId] = useState('');
  const [preview, setPreview] = useState(null);
  const [submissionError, setSubmissionError] = useState(null);
  const [lookupError, setLookupError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const life = useRef(null);
  const mutation = useRef(false);
  const rejected = useRef(null);

  const sites = copySiteOptions(website, websites.items, applications.items, domains.items);
  const eligible = sites.some((site) => site.id === websiteId);
  const targets = sites.filter((site) => site.id !== websiteId && site.applicationId !== applicationId);
  const target = targets.find((site) => site.id === targetId);
  const readyPlan = preview?.targetWebsiteId === target?.id ? preview : null;
  const job = result?.requestId === requestId ? result.job : null;
  const finished = job !== null && !jobActive(job);

  useEffect(() => {
    const scope = { controller: new AbortController(), generation };
    life.current = scope;
    return () => scope.controller.abort();
  }, [root, generation]);

  function storeRequest(id) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (id) next.set(STATIC_COPY_REQUEST_PARAM, `${websiteId}:${id}`);
      else if (staticCopyRequestId(previous, websiteId)) next.delete(STATIC_COPY_REQUEST_PARAM);
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
    if (!requestId || finished || busy === 'submit') return;
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
        const current = scopedJob(value, serverId, applicationId);
        recordJob(requestId, current);
        setLookupError(null);
        setSubmissionError(null);
        rejected.current = null;
        failures = 0;
        if (jobActive(current)) timer = setTimeout(read, 1800);
      } catch (error) {
        if (!active() || error.name === 'AbortError') return;
        if (error.status === 404 && error.code === NO_REQUEST && rejected.current === requestId) {
          rejected.current = null;
          setPreview(null);
          setLookupError(null);
          storeRequest(null);
          return;
        }
        if ([401, 403, 404].includes(error.status)) setResult(null);
        setLookupError(error);
        failures += 1;
        if (failures < 3 && ![401, 403].includes(error.status)) timer = setTimeout(read, 1800);
      }
    }
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [requestId, finished, busy, root, serverId, applicationId, generation, refresh, updateJob]);

  async function submit(event) {
    event.preventDefault();
    const scope = life.current;
    if (!eligible || !target || requestId || mutation.current || !isCurrent(scope)) return;
    mutation.current = true;
    setBusy(readyPlan ? 'submit' : 'preview');
    setSubmissionError(null);
    setLookupError(null);
    let id;
    try {
      if (!readyPlan) {
        const value = await panelRequest(`${root}/preview`, { method: 'POST', body: { targetWebsiteId: target.id }, signal: scope.controller.signal });
        if (isCurrent(scope)) setPreview(copyPlan(value, target.id));
        return;
      }
      id = crypto.randomUUID();
      storeRequest(id);
      const { targetWebsiteId, previewDigest, confirmation } = readyPlan;
      const value = await panelRequest(`${root}/requests`, { method: 'POST',
        body: { targetWebsiteId, requestId: id, previewDigest, confirmation }, signal: scope.controller.signal });
      if (isCurrent(scope)) recordJob(id, scopedJob(value, serverId, applicationId));
    } catch (error) {
      if (isCurrent(scope) && error.name !== 'AbortError') {
        if (id && [400, 401, 403, 404, 409, 422].includes(error.status)) rejected.current = id;
        setSubmissionError(error);
      }
    } finally {
      mutation.current = false;
      if (isCurrent(scope)) setBusy(null);
    }
  }

  function closeDialog() {
    setOpen(false);
    if (!requestId || finished) {
      if (finished) storeRequest(null);
      setTargetId('');
      setPreview(null);
      setSubmissionError(null);
      setLookupError(null);
      setResult(null);
    }
  }

  if (!eligible && !requestId) return null;
  return <>
    <Button icon={requestId ? 'jobs' : 'folder'} onClick={() => setOpen(true)}>{requestId ? 'Kopyalama durumu' : 'Siteyi kopyala'}</Button>
    {open && <Modal title="Statik siteyi kopyala" busy={Boolean(busy)} onClose={closeDialog}>
      {requestId ? <>
        {job ? <div role="status"><Badge state={job.status} /></div> : !submissionError && !lookupError && <div role="status" className="ws-loading"><span className="ws-spinner" />Kopyalama durumu bekleniyor…</div>}
        <ErrorNotice error={job?.error?.message ?? (submissionError ?? lookupError)?.message} />
        {job?.status === 'succeeded' && <KeyValues items={[
          ['Kopyalanan dosya', job.result?.filesCopied], ['Kopyalanan boyut', formatBytes(job.result?.bytesCopied)],
        ]} />}
        <footer className="ws-modal-footer">
          <Button disabled={Boolean(busy)} onClick={closeDialog}>Kapat</Button>
          {!finished && (submissionError || lookupError) && <Button icon="refresh" onClick={() => { setLookupError(null); setRefresh((value) => value + 1); }}>Durumu yenile</Button>}
        </footer>
      </> : <form onSubmit={submit}>
        <p className="ws-muted">Yalnız statik web dosyaları kopyalanır. Yeni oluşturulmuş veya boş bir hedef site seçin.</p>
        {targets.length ? <label>Hedef site<select required value={targetId} disabled={Boolean(busy)} onChange={(event) => {
          setTargetId(event.target.value); setPreview(null); setSubmissionError(null);
        }}><option value="">Site seçin</option>{targets.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label>
          : <p className="ws-muted">Bu sunucuda seçilebilir statik hedef site bulunamadı.</p>}
        {readyPlan && <KeyValues items={[
          ['Hedef site', target.name], ['Dosya sayısı', readyPlan.files], ['Toplam boyut', formatBytes(readyPlan.bytes)],
        ]} />}
        <ErrorNotice error={submissionError?.message} />
        <footer className="ws-modal-footer"><Button disabled={Boolean(busy)} onClick={closeDialog}>Vazgeç</Button>
          <Button type="submit" variant="primary" disabled={!eligible || !target || Boolean(busy)}>{busy ? 'İşleniyor…' : readyPlan ? 'Dosyaları kopyala' : 'Önizle'}</Button>
        </footer>
      </form>}
    </Modal>}
  </>;
}
