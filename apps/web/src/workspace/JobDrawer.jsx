import { useEffect, useState } from 'react';
import { panelRequest } from '../api.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, ErrorNotice, KeyValues, Modal } from './PanelKit.jsx';
import { formatDate, jobActive, jobFinishedAt } from './site-model.js';
import { observeJob } from './observe-job.js';

export default function JobDrawer() {
  const { observedJob: job, jobOpen, closeJob, updateJob, refreshAll } = useWorkspace();
  if (!jobOpen || !job) return null;
  // Close/reopen and switching jobs create a fresh observer with no trusted data.
  return <JobObservation key={job.id} id={job.id} close={closeJob} update={updateJob} refresh={refreshAll} />;
}

function JobObservation({ id, close, update, refresh }) {
  const [state, setState] = useState({ job: null, error: null });
  useEffect(() => observeJob({ id, request: panelRequest, onState: setState, onJob: update, onDone: refresh }), [id, update, refresh]);
  const { job, error } = state;
  return <Modal title="İşlem durumu" onClose={close}>
    {!job && !error && <div className="ws-loading" role="status"><span className="ws-spinner" />İşlem kaydı doğrulanıyor…</div>}
    <ErrorNotice error={error ?? (job?.status === 'failed' ? job.error?.message ?? job.error?.code ?? 'İşlem başarısız.' : null)} />
    {job && <><div className="ws-job-status"><Badge state={job.status} /><h3>{job.type ?? job.operation}</h3><p>{jobActive(job) ? 'İstek kabul edildi; henüz tamamlanmadı. Bu pencereyi kapatsanız da iş sunucuda devam eder.' : job.status === 'succeeded' ? 'Sunucu işlemi başarıyla tamamladı.' : 'İşlem sonucunu aşağıdan inceleyin.'}</p></div>
      <KeyValues items={[
        ['İş kimliği', job.id], ['Kaynak', job.resourceType], ['Oluşturulma', formatDate(job.createdAt)],
        ['Tamamlanma', formatDate(jobFinishedAt(job))],
        ...(job.result?.activeState ? [['Servis durumu', `${job.result.activeState} / ${job.result.subState ?? '—'}`]] : []),
        ...(typeof job.result?.healthy === 'boolean' ? [['Sağlık kontrolü', job.result.healthy ? 'Başarılı' : 'Başarısız']] : []),
      ]} /></>}
    <footer className="ws-modal-footer"><Button onClick={close}>Kapat</Button></footer>
  </Modal>;
}
