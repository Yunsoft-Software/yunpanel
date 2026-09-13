import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { createDockerProject, validateDockerProject } from './docker-compose-client.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Button, ErrorNotice, KeyValues, Modal } from './PanelKit.jsx';

export default function DockerProjectCreateDialog({ onClose }) {
  const { servers, setNotice } = useWorkspace();
  const navigate = useNavigate();
  const server = servers.items.length === 1 ? servers.items[0] : null;
  const [projectName, setProjectName] = useState('');
  const [document, setDocument] = useState('services:\n  web:\n    image: nginx:latest\n');
  const [validation, setValidation] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pending = useRef(false);

  async function validate() {
    if (pending.current || !server) return;
    pending.current = true; setBusy(true); setError(null); setValidation(null);
    try {
      setValidation(await validateDockerProject({ serverId: server.id, projectName, document, environment: {} }));
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally { pending.current = false; setBusy(false); }
  }

  async function create(event) {
    event.preventDefault();
    if (pending.current || !server) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const result = await createDockerProject({ serverId: server.id, projectName, document });
      setNotice(`${result.project.projectName} Compose projesi kaydedildi.`);
      navigate(`/docker/${encodeURIComponent(result.project.id)}`);
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally { pending.current = false; setBusy(false); }
  }

  return <Modal title="Docker Compose projesi ekle" onClose={onClose} busy={busy} wide><form onSubmit={create} className="ws-form"><ErrorNotice error={error} />{!server && <div className="ws-notice ws-notice-warn" role="alert">Yerel sunucu kimliği hazır olmadan Compose projesi oluşturulamaz.</div>}<fieldset disabled={busy || !server}><div className="ws-form-grid"><label>Proje adı<input value={projectName} onChange={(event) => { setProjectName(event.target.value); setValidation(null); }} pattern="[a-z0-9][a-z0-9_-]{0,62}" required autoComplete="off" spellCheck={false} placeholder="shop_app" /></label></div><label>Compose document<textarea rows={18} value={document} onChange={(event) => { setDocument(event.target.value); setValidation(null); }} required spellCheck={false} /></label>{validation && <KeyValues items={[
    ['Servis', validation.serviceCount], ['Network', validation.networks?.length ?? 0], ['Volume', validation.volumes?.length ?? 0], ['Secret', validation.secretCount], ['Config', validation.configCount], ['Yan etki', validation.sideEffects === false ? 'Yok' : 'Bilinmiyor'],
  ]} />}<footer className="ws-modal-footer"><Button disabled={busy} onClick={onClose}>Vazgeç</Button><Button disabled={busy || !server || !projectName || !document} onClick={validate}>Validate</Button><Button variant="primary" type="submit" disabled={busy || !server || !projectName || !document}>{busy ? 'İşleniyor…' : 'Projeyi kaydet'}</Button></footer></fieldset></form></Modal>;
}
