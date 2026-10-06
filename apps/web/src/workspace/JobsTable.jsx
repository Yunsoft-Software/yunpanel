import { useState } from 'react';
import { Link } from 'react-router';
import { panelRequest } from '../api.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, EmptyState } from './PanelKit.jsx';
import {
  jobAttemptCount,
  jobHealthIndicator,
  jobLifecycle,
  jobResourceTarget,
  jobStageProgress,
  jobSupportsManualRetry,
} from './job-presentation.js';
import { formatDate } from './site-model.js';

export default function JobsTable({ jobs, limit = 10, onCancel, onRetry, busy = false }) {
  const { observe, domains, websites, canManage, refreshAll } = useWorkspace();
  const [cancellingId, setCancellingId] = useState(null);
  const handleCancel = async (job) => {
    if (onCancel) return onCancel(job);
    if (!canManage) return;
    setCancellingId(job.id);
    try {
      await panelRequest(`/jobs/${encodeURIComponent(job.id)}/cancel`, { method: 'POST', body: {} });
      if (typeof refreshAll === 'function') refreshAll();
    } catch {
      observe(job);
    } finally {
      setCancellingId(null);
    }
  };
  if (!jobs.length) return <EmptyState title="Henüz işlem kaydı yok" detail="Deploy, SSL ve yapılandırma işlemleri çalıştırıldığında burada listelenir." icon="jobs" />;
  return <div className="ws-table-scroll"><table className="ws-table" role="table" aria-label="İşlem kayıtları"><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">İşlem</th><th scope="col" role="columnheader">Kaynak</th><th scope="col" role="columnheader">Durum</th><th scope="col" role="columnheader">Oluşturulma</th><th scope="col" role="columnheader" className="ws-row-end"><span className="ws-sr-only">İşlemler</span></th></tr></thead><tbody role="rowgroup">{jobs.slice(0, limit).map((job) => {
    const target = jobResourceTarget(job, { domains: domains.items, websites: websites.items });
    const lifecycle = jobLifecycle(job);
    const attempts = jobAttemptCount(job);
    const stage = jobStageProgress(job);
    const health = jobHealthIndicator(job);
    return <tr key={job.id} role="row">
      <td role="cell" data-label="İşlem"><strong>{job.type ?? job.operation}</strong><small>{job.id.slice(0, 12)}</small></td>
      <td role="cell" data-label="Kaynak">{target?.href ? <Link to={target.href}>{target.label}</Link> : target?.label ?? job.resourceType ?? '—'}<small>{job.resourceId?.slice(0, 12)}</small></td>
      <td role="cell" data-label="Durum"><Badge state={job.status} /><small>{lifecycle.stage}{stage ? ` · ${stage.label}` : ''}{attempts === null ? '' : ` · ${attempts} deneme`}{health ? ` · ${health.label}` : ''}</small></td>
      <td role="cell" data-label="Oluşturulma">{formatDate(job.createdAt)}</td>
      <td role="cell" className="ws-row-end" data-label="İşlemler"><div className="ws-actions"><Button onClick={() => observe(job)}>İncele</Button>{((onCancel && job.status === 'queued') || (!onCancel && canManage && job.status === 'queued')) && <Button disabled={busy || cancellingId === job.id} onClick={() => handleCancel(job)}>İptal et</Button>}{onRetry && jobSupportsManualRetry(job, { canManage: true }) && <Button disabled={busy} onClick={() => onRetry(job)}>Yeniden dene</Button>}</div></td>
    </tr>;
  })}</tbody></table></div>;
}
