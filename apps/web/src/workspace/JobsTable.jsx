import { useState } from 'react';
import { Link } from 'react-router';
import { panelRequest } from '../api.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, EmptyState, Table } from './PanelKit.jsx';
import {
  jobAttemptCount,
  jobHealthIndicator,
  jobLifecycle,
  jobOutcome,
  jobOperationLabel,
  jobResourceTarget,
  jobStageProgress,
  jobSupportsManualRetry,
} from './job-presentation.js';
import { formatDate } from './site-model.js';

const JOB_COLUMNS = ['İşlem', 'Kaynak', 'Durum', 'Oluşturulma', { label: 'İşlemler', className: 'ws-row-end', hidden: true }];

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
  return <Table label="İşlem kayıtları" className="ws-table ws-jobs-table" columns={JOB_COLUMNS}>{jobs.slice(0, limit).map((job) => {
    const target = jobResourceTarget(job, { domains: domains.items, websites: websites.items });
    const lifecycle = jobLifecycle(job);
    const attempts = jobAttemptCount(job);
    const stage = jobStageProgress(job);
    const health = jobHealthIndicator(job);
    const outcome = jobOutcome(job);
    return <tr key={job.id} role="row">
      <td role="cell" data-label="İşlem"><strong>{jobOperationLabel(job)}</strong><small>{job.id.slice(0, 12)}</small></td>
      <td role="cell" data-label="Kaynak">{target?.href ? <Link to={target.href}>{target.label}</Link> : target?.label ?? job.resourceType ?? '—'}<small>{job.resourceId?.slice(0, 12)}</small></td>
      <td role="cell" data-label="Durum"><Badge state={outcome.state}>{outcome.label}</Badge><small>{lifecycle.stage}{stage ? ` · ${stage.label}` : ''}{attempts === null ? '' : ` · ${attempts} deneme`}{health ? ` · ${health.label}` : ''}</small></td>
      <td role="cell" data-label="Oluşturulma">{formatDate(job.createdAt)}</td>
      <td role="cell" className="ws-row-end" data-label="İşlemler"><div className="ws-actions"><Button onClick={() => observe(job)}>İncele</Button>{((onCancel && job.status === 'queued') || (!onCancel && canManage && job.status === 'queued')) && <Button disabled={busy || cancellingId === job.id} onClick={() => handleCancel(job)}>İptal et</Button>}{onRetry && jobSupportsManualRetry(job, { canManage: true }) && <Button disabled={busy} onClick={() => onRetry(job)}>Yeniden dene</Button>}</div></td>
    </tr>;
  })}</Table>;
}
