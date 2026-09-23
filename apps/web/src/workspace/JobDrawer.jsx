import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { panelRequest } from '../api.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, EmptyState, ErrorNotice, KeyValues, Modal } from './PanelKit.jsx';
import {
  jobAttemptCount,
  jobLifecycle,
  jobResourceTarget,
  jobSupportsDeployLogs,
  safeJobResultMetadata,
} from './job-presentation.js';
import { formatDate, jobActive, jobFinishedAt } from './site-model.js';
import { observeJob } from './observe-job.js';

export default function JobDrawer() {
  const { observedJob: job, jobOpen, closeJob, updateJob, refreshAll } = useWorkspace();
  if (!jobOpen || !job) return null;
  // Close/reopen and switching jobs create a fresh observer with no trusted data.
  return <JobObservation key={job.id} id={job.id} close={closeJob} update={updateJob} refresh={refreshAll} />;
}

function JobObservation({ id, close, update, refresh }) {
  const { domains, websites } = useWorkspace();
  const [state, setState] = useState({ job: null, error: null });
  const [logs, setLogs] = useState({ status: 'idle', data: null, error: null });
  useEffect(() => observeJob({ id, request: panelRequest, onState: setState, onJob: update, onDone: refresh }), [id, update, refresh]);
  const { job, error } = state;
  const supportsLogs = jobSupportsDeployLogs(job);
  const loadLogs = useCallback(async () => {
    if (!supportsLogs) return;
    const controller = new AbortController();
    setLogs((current) => ({ ...current, status: current.data ? 'refreshing' : 'loading', error: null }));
    try {
      const data = await panelRequest(`/jobs/${encodeURIComponent(id)}/logs/deploy?limit=50`, { signal: controller.signal });
      setLogs({ status: 'ready', data, error: null });
    } catch (failure) {
      if (failure.name !== 'AbortError') setLogs((current) => ({ ...current, status: current.data ? 'stale' : 'error', error: failure.message }));
    }
    return () => controller.abort();
  }, [id, supportsLogs]);
  useEffect(() => {
    if (!supportsLogs) {
      setLogs({ status: 'idle', data: null, error: null });
      return undefined;
    }
    let active = true;
    const controller = new AbortController();
    setLogs((current) => ({ ...current, status: current.data ? 'refreshing' : 'loading', error: null }));
    panelRequest(`/jobs/${encodeURIComponent(id)}/logs/deploy?limit=50`, { signal: controller.signal })
      .then((data) => { if (active) setLogs({ status: 'ready', data, error: null }); })
      .catch((failure) => { if (active && failure.name !== 'AbortError') setLogs((current) => ({ ...current, status: current.data ? 'stale' : 'error', error: failure.message })); });
    return () => { active = false; controller.abort(); };
  }, [id, supportsLogs, job?.status]);
  const lifecycle = jobLifecycle(job);
  const target = jobResourceTarget(job, { domains: domains.items, websites: websites.items });
  const metadata = safeJobResultMetadata(job);
  return <Modal title="İşlem durumu" onClose={close}>
    {!job && !error && <div className="ws-loading" role="status"><span className="ws-spinner" />İşlem kaydı doğrulanıyor…</div>}
    <ErrorNotice error={error ?? (job?.status === 'failed' ? job.error?.message ?? job.error?.code ?? 'İşlem başarısız.' : null)} />
    {job && <><div className="ws-job-status"><Badge state={job.status} /><h3>{job.type ?? job.operation}</h3><p>{jobActive(job) ? 'İstek kabul edildi; henüz tamamlanmadı. Bu pencereyi kapatsanız da iş sunucuda devam eder.' : job.status === 'succeeded' ? 'Sunucu işlemi başarıyla tamamladı.' : 'İşlem sonucunu aşağıdan inceleyin.'}</p></div>
      <KeyValues items={[
        ['İş kimliği', job.id],
        ['Kaynak', target?.href ? <Link key="resource" to={target.href} onClick={close}>{target.label}</Link> : target?.label ?? job.resourceType ?? '—'],
        ['Kaynak kimliği', job.resourceId ?? '—'],
        ['Aşama', lifecycle.stage],
        ['Durum açıklaması', lifecycle.detail],
        ['Deneme sayısı', jobAttemptCount(job) ?? 'Bildirilmedi'],
        ['Oluşturulma', formatDate(job.createdAt)],
        ['Başlama', formatDate(job.startedAt)],
        ['Tamamlanma', formatDate(jobFinishedAt(job))],
        ...metadata,
      ]} />
      {job.diagnosis && <div className="ws-notice ws-notice-warn"><div><strong>{job.diagnosis.message}</strong><p>{job.diagnosis.action}</p><small>{job.diagnosis.code}</small></div></div>}
      {job.error?.code && <div className="ws-section-body"><strong>Güvenli hata kodu</strong><p><code>{job.error.code}</code></p></div>}
      {supportsLogs && <div className="ws-section-body"><div className="ws-actions"><strong>Deploy logu</strong><Button icon="refresh" disabled={logs.status === 'loading' || logs.status === 'refreshing'} onClick={loadLogs}>Yenile</Button></div><ErrorNotice error={logs.error} />{logs.status === 'loading' && !logs.data && <div className="ws-loading" role="status"><span className="ws-spinner" />Deploy logu yükleniyor…</div>}{logs.data?.entries?.length ? <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Zaman</th><th>Seviye</th><th>Aşama</th><th>Mesaj</th></tr></thead><tbody>{logs.data.entries.map((entry, index) => <tr key={entry.cursor ?? `${entry.timestamp}:${index}`}><td>{formatDate(entry.timestamp)}</td><td>{entry.level}</td><td>{entry.stage ?? '—'}</td><td><code>{entry.message}</code></td></tr>)}</tbody></table></div> : logs.data && <EmptyState icon="file" title="Deploy logu yok" detail="Bu iş için saklanan bounded deploy log kaydı bulunamadı." />}</div>}
    </>}
    <footer className="ws-modal-footer"><Button onClick={close}>Kapat</Button></footer>
  </Modal>;
}
