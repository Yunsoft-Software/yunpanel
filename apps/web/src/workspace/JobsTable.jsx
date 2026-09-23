import { Link } from 'react-router';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, EmptyState } from './PanelKit.jsx';
import { jobAttemptCount, jobLifecycle, jobResourceTarget } from './job-presentation.js';
import { formatDate } from './site-model.js';

export default function JobsTable({ jobs, limit = 10, onCancel, busy = false }) {
  const { observe, domains, websites } = useWorkspace();
  if (!jobs.length) return <EmptyState title="Henüz işlem kaydı yok" detail="Deploy, SSL ve yapılandırma işlemleri çalıştırıldığında burada listelenir." icon="jobs" />;
  return <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>İşlem</th><th>Kaynak</th><th>Durum</th><th>Oluşturulma</th><th><span className="ws-sr-only">İşlemler</span></th></tr></thead><tbody>{jobs.slice(0, limit).map((job) => {
    const target = jobResourceTarget(job, { domains: domains.items, websites: websites.items });
    const lifecycle = jobLifecycle(job);
    const attempts = jobAttemptCount(job);
    return <tr key={job.id}>
      <td><strong>{job.type ?? job.operation}</strong><small>{job.id.slice(0, 12)}</small></td>
      <td>{target?.href ? <Link to={target.href}>{target.label}</Link> : target?.label ?? job.resourceType ?? '—'}<small>{job.resourceId?.slice(0, 12)}</small></td>
      <td><Badge state={job.status} /><small>{lifecycle.stage}{attempts === null ? '' : ` · ${attempts} deneme`}</small></td>
      <td>{formatDate(job.createdAt)}</td>
      <td><div className="ws-actions"><Button onClick={() => observe(job)}>İncele</Button>{onCancel && job.status === 'queued' && <Button disabled={busy} onClick={() => onCancel(job)}>İptal et</Button>}</div></td>
    </tr>;
  })}</tbody></table></div>;
}
