import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, EmptyState } from './PanelKit.jsx';
import { formatDate } from './site-model.js';

export default function JobsTable({ jobs, limit = 10, onCancel, busy = false }) {
  const { observe } = useWorkspace();
  if (!jobs.length) return <EmptyState title="Henüz işlem kaydı yok" detail="Deploy, SSL ve yapılandırma işlemleri çalıştırıldığında burada listelenir." icon="jobs" />;
  return <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>İşlem</th><th>Kaynak</th><th>Durum</th><th>Oluşturulma</th><th><span className="ws-sr-only">İşlemler</span></th></tr></thead><tbody>{jobs.slice(0, limit).map((job) => <tr key={job.id}>
    <td><strong>{job.type ?? job.operation}</strong><small>{job.id.slice(0, 12)}</small></td><td>{job.resourceType ?? '—'}<small>{job.resourceId?.slice(0, 12)}</small></td><td><Badge state={job.status} /></td><td>{formatDate(job.createdAt)}</td><td><div className="ws-actions"><Button onClick={() => observe(job)}>İncele</Button>{onCancel && job.status === 'queued' && <Button disabled={busy} onClick={() => onCancel(job)}>İptal et</Button>}</div></td>
  </tr>)}</tbody></table></div>;
}
