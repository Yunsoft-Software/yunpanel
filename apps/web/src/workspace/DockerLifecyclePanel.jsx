import { useRef, useState } from 'react';
import { applyDockerAction, previewDockerAction } from './docker-compose-client.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Button, ConfirmDialog, ErrorNotice, Section } from './PanelKit.jsx';

const ACTIONS = Object.freeze([
  ['build', 'Build'],
  ['pull', 'Pull'],
  ['start', 'Başlat'],
  ['stop', 'Durdur'],
  ['restart', 'Restart'],
]);

export default function DockerLifecyclePanel({ project, onChanged }) {
  const { observe, jobs, resourceBusy, setNotice } = useWorkspace();
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inFlight = useRef(false);
  const locked = busy || jobs.status !== 'ready' || resourceBusy('docker_project', project.id);

  async function preview(action) {
    if (inFlight.current || locked) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const result = await previewDockerAction(project.id, action);
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

  return <><Section title="Lifecycle" description="Her işlem önce güncel Compose project/env/credential revizyonlarına bağlanan preview üretir; stale preview çalıştırılmaz."><div className="ws-section-body"><ErrorNotice error={error} /><div className="ws-actions">{ACTIONS.map(([action, label]) => <Button key={action} disabled={locked} onClick={() => preview(action)}>{label}</Button>)}</div></div></Section>{pending && <ConfirmDialog
    title={`Docker Compose ${pending.action}`}
    message={`${project.projectName} için ${pending.action} işlemi current desired state ile sıraya alınacak. Preview digest: ${pending.preview.previewDigest}`}
    confirmation={pending.preview.confirmation}
    busy={busy}
    error={error}
    onCancel={() => { if (!busy) setPending(null); }}
    onConfirm={apply}
    confirmLabel="İşi sıraya al"
  />}</>;
}

export const dockerLifecycleInternals = Object.freeze({ actions: ACTIONS.map(([value]) => value) });
