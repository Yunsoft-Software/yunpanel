import { useMemo, useRef, useState } from 'react';
import {
  replaceDockerEnvironment,
  setDockerCredential,
  updateDockerProject,
  validateSavedDockerProject,
} from './docker-compose-client.js';
import { parseDockerEnvironmentText } from './docker-compose-model.js';
import { useUnsavedChanges } from './UnsavedChanges.jsx';
import { Badge, Button, ConfirmDialog, ErrorNotice, KeyValues, Section } from './PanelKit.jsx';

export default function DockerConfigPanel({ data, onChanged }) {
  const project = data.project;
  const environment = data.environment ?? { revision: 0, keys: [], variableCount: 0 };
  const credentials = Array.isArray(data.credentials) ? data.credentials : [];
  const [document, setDocument] = useState('');
  const [environmentText, setEnvironmentText] = useState('');
  const [credential, setCredential] = useState({ registryHost: '', username: '', secret: '' });
  const [validation, setValidation] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const pending = useRef(false);
  const credentialRevision = useMemo(() => credentials.find((item) => item.registryHost === credential.registryHost.trim().toLowerCase())?.revision ?? 0, [credentials, credential.registryHost]);
  useUnsavedChanges(Boolean(document || environmentText || credential.registryHost || credential.username || credential.secret));

  async function mutate(callback, success) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try { await callback(); setNotice(success); onChanged?.(); }
    catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { pending.current = false; setBusy(false); }
  }

  function requestDocumentUpdate(event) {
    event.preventDefault(); setError(null);
    if (!document) return;
    setConfirm({
      kind: 'document',
      title: 'Compose desired state’i değiştir',
      message: `${project.projectName} projesinin revision ${project.revision} Compose document’ı tam olarak verilen yeni document ile değiştirilecek. Çalışan containerlar otomatik değiştirilmez; ayrıca lifecycle işlemi başlatılmalıdır.`,
      value: `replace-compose:${project.projectName}:${project.revision}`,
    });
  }

  function requestEnvironmentReplace(event) {
    event.preventDefault(); setError(null);
    try {
      const variables = parseDockerEnvironmentText(environmentText);
      setConfirm({
        kind: 'environment', variables,
        title: 'Compose environment’ın tamamını değiştir',
        message: `${project.projectName} için listede bulunmayan mevcut environment anahtarları silinecek. Gizli mevcut değerler API tarafından geri okunmadığı için korunacak bütün değerleri yeniden girmeniz gerekir.`,
        value: `replace-compose-env:${project.projectName}:${environment.revision}`,
      });
    } catch (failure) { setError(failure.message); }
  }

  async function applyConfirmed() {
    const current = confirm; if (!current) return;
    if (current.kind === 'document') {
      await mutate(async () => {
        await updateDockerProject(project.id, { expectedRevision: project.revision, document });
        setDocument(''); setValidation(null); setConfirm(null);
      }, 'Compose desired state kaydedildi. Runtime değiştirilmedi.');
      return;
    }
    await mutate(async () => {
      await replaceDockerEnvironment(project.id, { expectedRevision: environment.revision, variables: current.variables });
      setEnvironmentText(''); setConfirm(null);
    }, 'Compose environment şifreli store’a kaydedildi. Runtime değiştirilmedi.');
  }

  async function validateSaved() {
    await mutate(async () => { setValidation(await validateSavedDockerProject(project.id)); }, 'Kayıtlı Compose state environment ile doğrulandı.');
  }

  function saveCredential(event) {
    event.preventDefault();
    const input = { ...credential, registryHost: credential.registryHost.trim().toLowerCase(), expectedRevision: credentialRevision };
    mutate(async () => {
      await setDockerCredential(project.id, input);
      setCredential({ registryHost: '', username: '', secret: '' });
    }, `${input.registryHost} registry credential kaydedildi.`);
  }

  return <><Section title="Compose desired state" description="Şifreli Compose document API tarafından geri gösterilmez. Değiştirmek için tam yeni document verin; revision stale ise mutation reddedilir."><div className="ws-section-body"><ErrorNotice error={error} />{notice && <p role="status" className="ws-notice">{notice}</p>}<div className="ws-actions"><Button disabled={busy} onClick={validateSaved}>Kayıtlı state’i validate et</Button></div>{validation && <KeyValues items={[
    ['Project revizyonu', validation.projectRevision], ['Environment revizyonu', validation.environmentRevision], ['Servis', validation.validation?.serviceCount], ['Compose SHA-256', validation.validation?.composeSha256],
  ]} />}<form className="ws-form" onSubmit={requestDocumentUpdate}><fieldset disabled={busy}><label>Yeni tam Compose document<textarea rows={14} value={document} onChange={(event) => setDocument(event.target.value)} spellCheck={false} placeholder="services:\n  web:\n    image: nginx:latest" required /></label><p className="ws-muted">Bu yalnız desired state’i değiştirir. Build/pull/restart işlemini Lifecycle bölümünden ayrı başlatın.</p><Button type="submit" variant="primary" disabled={!document || busy}>Desired state’i değiştir</Button></fieldset></form></div></Section>
  <Section title="Compose environment" description="Değerler şifreli tutulur ve geri okunmaz. Replace işlemi için korunacak bütün değerleri yeniden girin."><div className="ws-section-body"><KeyValues items={[
    ['Revizyon', environment.revision], ['Değişken', environment.variableCount ?? environment.keys?.length ?? 0], ['Anahtarlar', environment.keys?.join(', ') || '—'], ['Son değişiklik', environment.updatedAt ?? '—'],
  ]} /><form className="ws-form" onSubmit={requestEnvironmentReplace}><fieldset disabled={busy}><label>Tam environment listesi<textarea rows={9} value={environmentText} onChange={(event) => setEnvironmentText(event.target.value)} spellCheck={false} placeholder="NODE_ENV=production\nAPI_URL=https://example.test" /></label><p className="ws-muted">Katı KEY=value biçimi kullanın. Boş liste onaylanırsa mevcut environment temizlenir.</p><Button type="submit" disabled={busy}>Environment’ı değiştir</Button></fieldset></form></div></Section>
  <Section title="Registry credentials" description="Secret ve username değeri geri okunmaz; yalnız configured/revision metadata’sı gösterilir."><div className="ws-section-body">{credentials.length > 0 && <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Registry</th><th>Durum</th><th>Revizyon</th><th>Güncellendi</th></tr></thead><tbody>{credentials.map((item) => <tr key={item.registryHost}><td><strong>{item.registryHost}</strong></td><td><Badge state={item.configured ? 'active' : 'unknown'}>{item.configured ? 'Yapılandırıldı' : 'Yok'}</Badge></td><td>{item.revision}</td><td>{item.updatedAt ?? '—'}</td></tr>)}</tbody></table></div>}<form className="ws-form" onSubmit={saveCredential}><fieldset disabled={busy}><div className="ws-form-grid"><label>Registry host<input value={credential.registryHost} onChange={(event) => setCredential({ ...credential, registryHost: event.target.value })} required placeholder="ghcr.io" autoCapitalize="none" spellCheck={false} /></label><label>Username<input value={credential.username} onChange={(event) => setCredential({ ...credential, username: event.target.value })} required autoComplete="off" /></label><label>Secret / token<input type="password" value={credential.secret} onChange={(event) => setCredential({ ...credential, secret: event.target.value })} required autoComplete="new-password" /></label></div><p className="ws-muted">Bu host daha önce kayıtlıysa revision {credentialRevision} üzerinden rotation yapılır; secret hiçbir public response’a dönmez.</p><Button type="submit" disabled={busy}>Credential kaydet / rotate et</Button></fieldset></form></div></Section>
  {confirm && <ConfirmDialog title={confirm.title} message={confirm.message} confirmation={confirm.value} busy={busy} error={error} onCancel={() => setConfirm(null)} onConfirm={applyConfirmed} confirmLabel="Değişikliği uygula" />}</>;
}
