import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getDockerProjectDocument,
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
  const initialDocument = typeof data.document === 'string'
    ? data.document
    : (typeof project?.document === 'string' ? project.document : '');
  const [document, setDocument] = useState(initialDocument);
  const [environmentText, setEnvironmentText] = useState('');
  const [credential, setCredential] = useState({ registryHost: '', username: '', secret: '' });
  const [validation, setValidation] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const pending = useRef(false);
  useEffect(() => {
    if (!document && initialDocument) {
      setDocument(initialDocument);
    }
  }, [initialDocument, document]);
  const credentialRevision = useMemo(() => credentials.find((item) => item.registryHost === credential.registryHost.trim().toLowerCase())?.revision ?? 0, [credentials, credential.registryHost]);
  useUnsavedChanges(Boolean((document && document !== initialDocument) || environmentText || credential.registryHost || credential.username || credential.secret));

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
      title: 'Compose yapılandırmasını değiştir',
      message: `${project.projectName} projesinin ${project.revision}. revizyon Compose dosyası girdiğiniz yeni içerikle tamamen değiştirilecek. Çalışan konteynerler otomatik değişmez; değişikliğin çalışması için projeyi ayrıca yeniden başlatın.`,
      value: `replace-compose:${project.projectName}:${project.revision}`,
    });
  }

  function requestEnvironmentReplace(event) {
    event.preventDefault(); setError(null);
    try {
      const variables = parseDockerEnvironmentText(environmentText);
      setConfirm({
        kind: 'environment', variables,
        title: 'Ortam değişkenlerinin tamamını değiştir',
        message: `${project.projectName} için listede bulunmayan mevcut ortam değişkenleri silinecek. Gizli değerler geri okunamadığı için korumak istediğiniz bütün değerleri yeniden girmeniz gerekir.`,
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
      }, 'Compose yapılandırması kaydedildi. Çalışan konteynerler değiştirilmedi.');
      return;
    }
    await mutate(async () => {
      await replaceDockerEnvironment(project.id, { expectedRevision: environment.revision, variables: current.variables });
      setEnvironmentText(''); setConfirm(null);
    }, 'Ortam değişkenleri şifreli olarak kaydedildi. Çalışan konteynerler değiştirilmedi.');
  }

  async function validateSaved() {
    await mutate(async () => { setValidation(await validateSavedDockerProject(project.id)); }, 'Kayıtlı Compose yapılandırması ortam değişkenleriyle birlikte doğrulandı.');
  }

  async function loadCurrentComposeDocument() {
    await mutate(async () => {
      if (initialDocument) {
        setDocument(initialDocument);
        return;
      }
      const res = await getDockerProjectDocument(project.id);
      const loaded = typeof res === 'string' ? res : (res?.document ?? '');
      if (!loaded) throw new Error('Mevcut Compose YAML içeriği alınamadı.');
      setDocument(loaded);
    }, 'Mevcut Compose YAML editöre yüklendi.');
  }

  function saveCredential(event) {
    event.preventDefault();
    const input = { ...credential, registryHost: credential.registryHost.trim().toLowerCase(), expectedRevision: credentialRevision };
    mutate(async () => {
      await setDockerCredential(project.id, input);
      setCredential({ registryHost: '', username: '', secret: '' });
    }, `${input.registryHost} kayıt defteri erişim bilgisi kaydedildi.`);
  }

  return <><Section title="Compose yapılandırması" description="Mevcut Compose YAML tanımını düzenleyin veya yeni bir yapılandırma kaydedin."><div className="ws-section-body"><ErrorNotice error={error} />{notice && <p role="status" className="ws-notice">{notice}</p>}<div className="ws-actions"><Button disabled={busy} onClick={loadCurrentComposeDocument}>Mevcut Compose YAML'ı Editöre Yükle</Button><Button disabled={busy} onClick={validateSaved}>Kayıtlı yapılandırmayı doğrula</Button></div>{validation && <KeyValues items={[
    ['Proje revizyonu', validation.projectRevision], ['Ortam değişkenleri revizyonu', validation.environmentRevision], ['Servis', validation.validation?.serviceCount], ['Compose SHA-256', validation.validation?.composeSha256],
  ]} />}<form className="ws-form" onSubmit={requestDocumentUpdate}><fieldset disabled={busy}><label>Yeni Compose içeriğinin tamamı<textarea rows={14} value={document} onChange={(event) => setDocument(event.target.value)} spellCheck={false} placeholder="services:\n  web:\n    image: nginx:latest" required /></label><Button type="submit" variant="primary" disabled={!document || busy}>Yapılandırmayı değiştir</Button></fieldset></form></div></Section>
  <Section title="Ortam değişkenleri" description="Servis ortam değişkenlerini KEY=value biçiminde tanımlayın."><div className="ws-section-body"><KeyValues items={[
    ['Revizyon', environment.revision], ['Değişken', environment.variableCount ?? environment.keys?.length ?? 0], ['Anahtarlar', environment.keys?.join(', ') || '—'], ['Son değişiklik', environment.updatedAt ?? '—'],
  ]} /><form className="ws-form" onSubmit={requestEnvironmentReplace}><fieldset disabled={busy}><label>Ortam değişkenlerinin tamamı<textarea rows={9} value={environmentText} onChange={(event) => setEnvironmentText(event.target.value)} spellCheck={false} placeholder="NODE_ENV=production\nAPI_URL=https://example.test" /></label><Button type="submit" disabled={busy}>Ortam değişkenlerini değiştir</Button></fieldset></form></div></Section>
  <Section
    title="Kayıt defteri erişim bilgileri"
    description="GHCR, Docker Hub veya özel konteyner kayıt defterleri için erişim bilgileri."
  >
    <div className="ws-section-body">
      {credentials.length > 0 && (
        <div className="ws-table-scroll">
          <table className="ws-table">
            <thead>
              <tr>
                <th>Kayıt defteri</th>
                <th>Durum</th>
                <th>Revizyon</th>
                <th>Güncellendi</th>
              </tr>
            </thead>
            <tbody>
              {credentials.map((item) => (
                <tr key={item.registryHost}>
                  <td>
                    <strong>{item.registryHost}</strong>
                  </td>
                  <td>
                    <Badge state={item.configured ? 'active' : 'unknown'}>{item.configured ? 'Yapılandırıldı' : 'Yok'}</Badge>
                  </td>
                  <td>{item.revision}</td>
                  <td>{item.updatedAt ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form className="ws-form" onSubmit={saveCredential}>
        <fieldset disabled={busy}>
          <div className="ws-form-grid">
            <label>
              Kayıt defteri adresi
              <input
                value={credential.registryHost}
                onChange={(event) => setCredential({ ...credential, registryHost: event.target.value })}
                required
                placeholder="ghcr.io"
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>
            <label>
              Kullanıcı adı
              <input
                value={credential.username}
                onChange={(event) => setCredential({ ...credential, username: event.target.value })}
                required
                autoComplete="off"
              />
            </label>
            <label>
              Parola veya erişim anahtarı
              <input
                type="password"
                value={credential.secret}
                onChange={(event) => setCredential({ ...credential, secret: event.target.value })}
                required
                autoComplete="new-password"
              />
            </label>
          </div>
          <Button type="submit" disabled={busy}>
            Erişim bilgisini kaydet veya yenile
          </Button>
        </fieldset>
      </form>
    </div>
  </Section>
  {confirm && <ConfirmDialog title={confirm.title} message={confirm.message} confirmation={confirm.value} busy={busy} error={error} onCancel={() => setConfirm(null)} onConfirm={applyConfirmed} confirmLabel="Değişikliği uygula" />}</>;
}
