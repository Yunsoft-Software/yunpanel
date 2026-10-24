import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { panelRequest, waitForJob } from '../api.js';
import { sessionVersion } from '../session-client.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, ErrorNotice, KeyValues, Modal } from './PanelKit.jsx';

export default function DatabaseSetupDialog({ website = null, databaseName = '', onClose, onChanged }) {
  const { websites, domains, updateJob, jobs } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const [siteId, setSiteId] = useState(website?.id ?? (websites.status === 'ready' && websites.items.length === 1 ? websites.items[0].id : '')), [name, setName] = useState(databaseName);
  const [password, setPassword] = useState(''), [mode, setMode] = useState(databaseName ? 'bind' : 'create');
  const [busy, setBusy] = useState(false), [error, setError] = useState(null), [result, setResult] = useState(null);
  const live = useRef(true), pending = useRef(false), generation = useRef(sessionVersion());
  const current = () => live.current && generation.current === sessionVersion();
  const selected = website ?? websites.items.find((item) => item.id === siteId);
  const available = websites.status === 'ready' ? websites.items.filter((item) => item.applicationId) : [];
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const remember = (id) => setParams((previous) => { const next = new URLSearchParams(previous); next.set('databaseJob', id); return next; }, { replace: true });
  const forget = () => setParams((previous) => { const next = new URLSearchParams(previous); next.delete('databaseJob'); return next; }, { replace: true });
  async function follow(job) {
    setMode('continue');
    setResult({ job }); updateJob(job); jobs.refresh(); remember(job.id);
    let terminal;
    try { terminal = await waitForJob(job.id); }
    catch (failure) {
      if (current() && failure.job) { setResult({ job: failure.job }); updateJob(failure.job); }
      throw new Error(failure.job ? 'Kurulum tamamlanmadı. İşlem geçmişini kontrol edip mevcut kuruluma devam edin.' : 'İşlem sonucu okunamadı. Aynı işlem kaydını yeniden kontrol edin.');
    }
    if (!current()) return;
    setResult({ job: terminal }); updateJob(terminal);
    if (terminal.status !== 'succeeded') throw new Error('Kurulum tamamlanmadı. Oluşan kaynaklar korunuyor; işlem kaydını kontrol edip kuruluma devam edin.');
    await onChanged?.();
  }
  useEffect(() => {
    const id = params.get('databaseJob'); if (!id || pending.current) return;
    pending.current = true; setBusy(true);
    panelRequest(`/jobs/${encodeURIComponent(id)}`).then((job) => {
      if (!current()) return;
      if (job.operation !== 'database.credential.apply') throw new Error('Bu kayıt veritabanı kurulumu değil.');
      setName(job.resourceId); return follow(job);
    }).catch((failure) => { if (current()) setError(failure); }).finally(() => { if (current()) { pending.current = false; setBusy(false); } });
  }, []);
  async function submit(event) {
    event.preventDefault(); if (pending.current || !selected || !current()) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      if (result?.job && ['queued', 'running'].includes(result.job.status)) { await follow(result.job); return; }
      const setup = await panelRequest(`/servers/${encodeURIComponent(selected.serverId)}/websites/${encodeURIComponent(selected.id)}/databases`, {
        method: 'POST', body: { databaseName: name, mode, expectedWebsiteRevision: selected.revision,
          ...(password ? { password } : {}) },
      });
      if (!current()) return;
      setPassword(''); await follow(setup.job);
    } catch (failure) { if (current()) setError(failure); }
    finally { if (current()) { pending.current = false; setBusy(false); } }
  }
  const done = result?.job?.status === 'succeeded';
  return <Modal title={databaseName ? `${databaseName} · Siteye bağla` : 'Veritabanı oluştur'} busy={busy} onClose={() => { if (!busy) { forget(); onClose(); } }}>
    <ErrorNotice error={error} />
    {result && <div role="status"><Badge state={result.job.status} /> <p>{done ? `${name} hazır. Site bağlantısı ve kullanıcı izinleri uygulandı.` : busy ? 'Veritabanı ve erişim izinleri hazırlanıyor…' : 'Kurulum sonucu yukarıda gösteriliyor.'}</p></div>}
    {done ? <footer className="ws-modal-footer"><Button variant="primary" onClick={() => { forget(); onClose(); }}>Tamam</Button></footer> : <form className="ws-form" onSubmit={submit}>
      {!website && <label>Web sitesi<select required disabled={busy} value={siteId} onChange={(event) => setSiteId(event.target.value)}><option value="">Site seçin</option>{available.map((item) => <option key={item.id} value={item.id}>{domains.items.find((domain) => domain.websiteId === item.id)?.primaryDomain ?? item.name}</option>)}</select></label>}
      <label>Veritabanı adı<input required disabled={busy || Boolean(databaseName)} value={name} onChange={(event) => setName(event.target.value)} pattern="[A-Za-z0-9_]{1,64}" maxLength="64" autoCapitalize="none" spellCheck={false} autoComplete="off" placeholder="ornek_site" /></label>
      <label>Kullanıcı parolası<input type="password" disabled={busy || Boolean(result)} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength="16" maxLength="128" placeholder="Boş bırakırsanız güçlü parola oluşturulur" /><small>En az 16 karakter. Harf, rakam ve _ ! @ # % ^ * + = . : , - kullanabilirsiniz.</small></label>
      <p className="ws-muted">Bu siteye özel veritabanı kullanıcısı otomatik oluşturulur. Bağlantı bilgileri ve parola işlem tamamlanınca erişilebilir.</p>
      {result && <label>Devam biçimi<select value={mode} onChange={(event) => setMode(event.target.value)}><option value="continue">Mevcut kuruluma devam et</option></select></label>}
      <footer className="ws-modal-footer"><Button disabled={busy} onClick={() => { forget(); onClose(); }}>Vazgeç</Button><Button variant="primary" type="submit" disabled={busy || !selected}>{busy ? 'Kuruluyor…' : result ? 'Kuruluma devam et' : databaseName ? 'Bağla ve erişimi hazırla' : 'Oluştur'}</Button></footer>
    </form>}
  </Modal>;
}

export function DatabaseConnectionDialog({ website, binding, onClose }) {
  const [connection, setConnection] = useState(null), [error, setError] = useState(null), [busy, setBusy] = useState(false);
  const live = useRef(true), generation = useRef(sessionVersion());
  const current = () => live.current && generation.current === sessionVersion();
  const endpoint = `/servers/${encodeURIComponent(website.serverId)}/websites/${encodeURIComponent(website.id)}/databases/${encodeURIComponent(binding.id)}/connection`;
  async function read(revealPassword = false) {
    setBusy(true); setError(null);
    try {
      const value = await panelRequest(endpoint, { method: 'POST', body: { revealPassword } });
      if (current()) setConnection(value);
    } catch (failure) { if (current()) setError(failure); }
    finally { if (current()) setBusy(false); }
  }
  useEffect(() => { live.current = true; void read(); return () => { live.current = false; }; }, [endpoint]);
  useEffect(() => {
    if (!connection?.password) return;
    const timer = setTimeout(() => setConnection((value) => value ? { ...value, password: null } : value), 60_000);
    return () => clearTimeout(timer);
  }, [connection?.password]);
  return <Modal title={`${binding.databaseName} · Bağlantı bilgileri`} onClose={onClose}>
    <ErrorNotice error={error} />{connection && <><KeyValues items={[
      ['Sunucu', connection.host], ['Port', connection.port], ['Veritabanı', connection.databaseName], ['Kullanıcı', connection.username],
    ]} /><label>Parola<input type="password" readOnly autoComplete="off" value={connection.password ?? ''} placeholder="Güvenli depoda saklanıyor" /></label>
    <div className="ws-actions"><Button disabled={busy} onClick={() => read(true)}>Parolaya eriş</Button>{connection.password && <Button onClick={() => navigator.clipboard.writeText(connection.password).catch(() => setError(new Error('Parola kopyalanamadı.')))}>Parolayı kopyala</Button>}</div>
    <p className="ws-muted">Parola erişimi kaydedilir ve 60 saniye sonra bu pencereden temizlenir.</p>
    <pre className="ws-code">{`DB_HOST=${connection.host}\nDB_PORT=${connection.port}\nDB_DATABASE=${connection.databaseName}\nDB_USERNAME=${connection.username}\nDB_PASSWORD=<parolanız>`}</pre></>}
    {!connection && !error && <p role="status">Bağlantı bilgileri yükleniyor…</p>}
  </Modal>;
}
