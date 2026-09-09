import { useEffect, useState } from 'react';
import { panelRequest } from '../api.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, ErrorNotice, KeyValues, Modal } from './PanelKit.jsx';
import { formatDate, jobActive } from './site-model.js';

export default function JobDrawer() {
  const { observedJob: job, jobOpen, closeJob, updateJob, refreshAll } = useWorkspace();
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!jobOpen || !job?.id) return undefined;
    const controller = new AbortController(); let timer; setError(null);
    async function poll() {
      try {
        const next = await panelRequest(`/jobs/${encodeURIComponent(job.id)}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        updateJob(next); setError(null);
        if (jobActive(next)) timer = setTimeout(poll, 1500); else refreshAll();
      } catch (failure) {
        if (!controller.signal.aborted && failure.name !== 'AbortError') { setError('İşin güncel durumu alınamadı. İş sunucuda devam ediyor olabilir.'); timer = setTimeout(poll, 4000); }
      }
    }
    poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [job?.id, jobOpen, updateJob, refreshAll]);
  if (!jobOpen || !job) return null;
  return <Modal title="İşlem durumu" onClose={closeJob}><div className="ws-job-status"><Badge state={job.status} /><h3>{job.type ?? job.operation}</h3><p>{jobActive(job) ? 'İstek kabul edildi; henüz tamamlanmadı. Bu pencereyi kapatsanız da iş sunucuda devam eder.' : job.status === 'succeeded' ? 'Sunucu işlemi başarıyla tamamladı.' : 'İşlem sonucunu aşağıdan inceleyin.'}</p></div>
    <ErrorNotice error={error ?? (job.status === 'failed' ? job.error?.message ?? job.error?.code ?? 'İşlem başarısız.' : null)} />
    <KeyValues items={[
      ['İş kimliği', job.id], ['Kaynak', job.resourceType], ['Oluşturulma', formatDate(job.createdAt)],
      ['Tamamlanma', formatDate(job.completedAt)],
      ...(job.result?.activeState ? [['Servis durumu', `${job.result.activeState} / ${job.result.subState ?? '—'}`]] : []),
      ...(typeof job.result?.healthy === 'boolean' ? [['Sağlık kontrolü', job.result.healthy ? 'Başarılı' : 'Başarısız']] : []),
    ]} />
    <footer className="ws-modal-footer"><Button onClick={closeJob}>Kapat</Button></footer>
  </Modal>;
}
