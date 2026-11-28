import { useRef, useState } from 'react';
import { applyDockerAction, previewDockerAction } from './docker-compose-client.js';
import { dockerRemovalMessage, dockerRemovalVolumes } from './docker-compose-model.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, ConfirmDialog, ConfirmationForm, ErrorNotice, Modal, Section, Table } from './PanelKit.jsx';

const ACTIONS = Object.freeze([
  ['build', 'Derle'],
  ['pull', 'İmajları indir'],
  ['start', 'Başlat'],
  ['stop', 'Durdur'],
  ['restart', 'Yeniden başlat'],
  ['remove', 'Projeyi kaldır'],
]);

function actionLabel(action) {
  return ACTIONS.find(([key]) => key === action)?.[1] ?? action;
}

function RemovalVolumes({ summary, busy, onChoose }) {
  if (summary.rows.length === 0) return null;
  return <>
    <Table label="Projenin volume'ları" columns={['Volume', 'Durum']}>
      {summary.rows.map((row) => <tr key={row.volumeName}><td><code>{row.volumeName}</code></td><td>{row.deleted ? <Badge state="error">{row.status}</Badge> : row.status}</td></tr>)}
    </Table>
    {summary.canDelete && <div className="ws-actions" role="group" aria-label="Volume verileri">
      <Button aria-pressed={!summary.deleteVolumes} variant={summary.deleteVolumes ? 'secondary' : 'primary'} disabled={busy} onClick={() => onChoose(false)}>Volume'ları koru</Button>
      <Button aria-pressed={summary.deleteVolumes} variant={summary.deleteVolumes ? 'danger' : 'secondary'} disabled={busy} onClick={() => onChoose(true)}>Volume'ları da sil</Button>
    </div>}
  </>;
}

export default function DockerLifecyclePanel({ project, onChanged }) {
  const { observe, jobs, resourceBusy, setNotice } = useWorkspace();
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inFlight = useRef(false);
  const locked = busy || jobs.status !== 'ready' || resourceBusy('docker_project', project.id);

  async function preview(action, { deleteVolumes = false } = {}) {
    if (inFlight.current || locked) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const result = await previewDockerAction(project.id, action, action === 'remove' ? { deleteVolumes } : undefined);
      setPending({ action, preview: result });
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally {
      inFlight.current = false; setBusy(false);
    }
  }

  async function apply() {
    if (inFlight.current || !pending) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const result = await applyDockerAction(project.id, pending.action, pending.preview);
      if (result?.job) observe(result.job);
      setNotice(`${project.projectName}: ${pending.action} işi sıraya alındı.`);
      setPending(null);
      jobs.refresh();
      onChanged?.();
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally {
      inFlight.current = false; setBusy(false);
    }
  }

  const cancel = () => { if (!busy) { setPending(null); setError(null); } };
  const removal = pending?.action === 'remove' ? dockerRemovalVolumes(pending.preview) : null;

  return <><Section title="Proje işlemleri" description="Projeyi başlatın, durdurun veya kaldırın. Kaldırma konteynerleri ve projeye ait ağları temizler; volume'lar ve imajlar korunur, volume'ları silmek kaldırma sırasında ayrıca seçilir."><div className="ws-section-body"><ErrorNotice error={pending ? null : error} /><div className="ws-actions">{ACTIONS.map(([action, label]) => <Button key={action} disabled={locked} onClick={() => preview(action)}>{label}</Button>)}</div></div></Section>
    {pending && removal && <Modal title={`Docker Compose: ${actionLabel(pending.action)}`} onClose={cancel} busy={busy} unsavedGuard={false}>
      <RemovalVolumes summary={removal} busy={busy} onChoose={(deleteVolumes) => { if (deleteVolumes !== removal.deleteVolumes) preview('remove', { deleteVolumes }); }} />
      <ConfirmationForm
        key={pending.preview.previewDigest}
        message={dockerRemovalMessage(project.projectName, removal)}
        confirmation={pending.preview.confirmation}
        busy={busy}
        error={error}
        onCancel={cancel}
        onConfirm={apply}
        confirmLabel="İşi sıraya al"
      />
    </Modal>}
    {pending && !removal && <ConfirmDialog
      title={`Docker Compose: ${actionLabel(pending.action)}`}
      message={`${project.projectName} için işlem sıraya alınacak.`}
      confirmation={pending.preview.confirmation}
      busy={busy}
      error={error}
      onCancel={cancel}
      onConfirm={apply}
      confirmLabel="İşi sıraya al"
    />}</>;
}

export const dockerLifecycleInternals = Object.freeze({ actions: ACTIONS.map(([value]) => value) });
