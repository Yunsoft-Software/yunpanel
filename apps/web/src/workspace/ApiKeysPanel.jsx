import { useEffect, useState } from 'react';
import { panelRequest } from '../api.js';
import { Button, ErrorNotice, Section } from './PanelKit.jsx';

export function apiKeyRequest(values) {
  return { name: values.name.trim(), parentDomain: values.parentDomain.trim().toLowerCase(), portMin: Number(values.portMin), portMax: Number(values.portMax) };
}

const date = (value) => value ? new Date(value).toLocaleString('tr-TR') : '—';

// Keys for the automation API. A new key's secret is shown once and never again.
export default function ApiKeysPanel() {
  const [keys, setKeys] = useState(null);
  const [values, setValues] = useState({ name: '', parentDomain: '', portMin: '32000', portMax: '32999' });
  const [created, setCreated] = useState(null);
  const [revoking, setRevoking] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const edit = (key) => (event) => setValues(current => ({ ...current, [key]: event.target.value }));

  async function load() {
    try { setKeys((await panelRequest('/api-keys')).keys); }
    catch (failure) { setError(failure.message); }
  }
  useEffect(() => { void load(); }, []);

  async function run(operation) {
    setBusy(true); setError(null);
    try { await operation(); await load(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  return <Section title="API anahtarları">
    <ErrorNotice error={error} />
    {created && <div className="ws-notice ws-notice-warn" role="status"><div>
      <p>Anahtar yalnız şimdi gösterilir. Kopyalayıp güvenli bir yere kaydedin.</p>
      <code className="ws-secret">{created}</code>
      <div className="ws-actions">
        <Button onClick={() => navigator.clipboard?.writeText(created)}>Kopyala</Button>
        <Button onClick={() => setCreated(null)}>Kapat</Button>
      </div>
    </div></div>}
    {keys?.length === 0 && <p className="ws-muted">Anahtar yok.</p>}
    {keys?.length > 0 && <div className="ws-table-scroll"><table className="ws-table">
      <thead><tr><th>Ad</th><th>Alan adı</th><th>Portlar</th><th>Son kullanım</th><th /></tr></thead>
      <tbody>{keys.map(key => <tr key={key.id}>
        <td>{key.name}</td><td>{key.scope.parentDomain}</td><td>{key.scope.portMin}–{key.scope.portMax}</td>
        <td>{key.revokedAt ? 'İptal edildi' : date(key.lastUsedAt)}</td>
        <td>{!key.revokedAt && (revoking === key.id
          ? <span className="ws-actions"><Button variant="danger" disabled={busy}
            onClick={() => run(async () => { await panelRequest(`/api-keys/${encodeURIComponent(key.id)}`, { method: 'DELETE' }); setRevoking(null); })}>İptal et</Button>
            <Button disabled={busy} onClick={() => setRevoking(null)}>Vazgeç</Button></span>
          : <Button disabled={busy} onClick={() => setRevoking(key.id)}>İptal…</Button>)}</td>
      </tr>)}</tbody>
    </table></div>}
    <form className="ws-form" onSubmit={event => { event.preventDefault();
      run(async () => { const result = await panelRequest('/api-keys', { method: 'POST', body: apiKeyRequest(values) }); setCreated(result.token);
        setValues(current => ({ ...current, name: '' })); }); }}>
      <div className="ws-form-grid">
        <label>Ad<input value={values.name} required maxLength="64" placeholder="Kurulum servisi" onChange={edit('name')} /></label>
        <label>Üst alan adı<input value={values.parentDomain} required maxLength="253" placeholder="st.alan.com" spellCheck={false} onChange={edit('parentDomain')} /></label>
        <label>İlk port<input type="number" min="1024" max="65535" value={values.portMin} required onChange={edit('portMin')} /></label>
        <label>Son port<input type="number" min="1024" max="65535" value={values.portMax} required onChange={edit('portMax')} /></label>
      </div>
      <div className="ws-actions"><Button type="submit" variant="primary" disabled={busy}>Anahtar oluştur</Button></div>
    </form>
  </Section>;
}
