import { useEffect, useRef, useState } from 'react';
import { panelRequest } from '../api.js';
import { useCollection } from './useCollection.js';
import { useUnsavedChanges } from './UnsavedChanges.jsx';
import { Badge, Button, CollectionNotice, ConfirmDialog, EmptyState, ErrorNotice, Section } from './PanelKit.jsx';

export default function EnvironmentPanel({ application }) {
  const variables = useCollection(`/applications/${encodeURIComponent(application.id)}/environment`, { pollMs: 0 });
  const [form, setForm] = useState({ key: '', value: '', secret: true });
  const [importForm, setImportForm] = useState({ content: '', mode: 'merge', secret: true });
  const [environment, setEnvironment] = useState(null); const [replaceImport, setReplaceImport] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(null); const [remove, setRemove] = useState(null); const [notice, setNotice] = useState(null);
  const requests = useRef(null); const pending = useRef(false);
  async function refreshEnvironment(signal = requests.current?.signal) {
    const next = await panelRequest(`/applications/${encodeURIComponent(application.id)}/environment/status`, { signal });
    if (!signal?.aborted) setEnvironment(next);
    return next;
  }
  useEffect(() => {
    requests.current = new AbortController();
    refreshEnvironment(requests.current.signal).catch((failure) => {
      if (failure.name !== 'AbortError') setError(failure.message);
    });
    return () => requests.current.abort();
  }, [application.id]);
  useUnsavedChanges(Boolean(form.key || form.value || importForm.content));
  async function mutate(action) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try { await action(); variables.refresh(); await refreshEnvironment(); }
    catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { pending.current = false; if (!requests.current.signal.aborted) setBusy(false); }
  }
  function save(event) {
    event.preventDefault();
    mutate(async () => {
      await panelRequest(`/applications/${encodeURIComponent(application.id)}/environment/${encodeURIComponent(form.key)}`, { method: 'PUT', body: { value: form.value, secret: form.secret }, signal: requests.current.signal });
      setForm({ key: '', value: '', secret: true }); setNotice('Değişken kaydedildi. Çalışan uygulamaya uygulamak için yeniden başlatın veya deploy edin.');
    });
  }
  function applyImport(mode) {
    mutate(async () => {
      const confirmation = mode === 'replace'
        ? `replace-environment:${application.id}:${environment.savedRevision}`
        : null;
      await panelRequest(`/applications/${encodeURIComponent(application.id)}/environment/import`, {
        method: 'POST',
        body: { ...importForm, mode, expectedRevision: environment.savedRevision, confirmation },
        signal: requests.current.signal,
      });
      setImportForm({ content: '', mode: 'merge', secret: true }); setReplaceImport(false);
      setNotice(`Ortam değişkenleri ${mode === 'replace' ? 'değiştirildi' : 'birleştirildi'}. Çalışan prosese uygulamak için restart veya deploy başlatın.`);
    });
  }
  function submitImport(event) {
    event.preventDefault();
    if (importForm.mode === 'replace') setReplaceImport(true);
    else applyImport('merge');
  }
  return <Section title="Ortam değişkenleri" description="Değerler yalnızca bu uygulamaya aittir. Gizli değerler listede gösterilmez.">
    <CollectionNotice resource={variables} label="Ortam değişkenleri" />
    {environment && <div className="ws-section-body"><p role="status"><Badge state={environment.appliedToRunningProcess ? 'active' : 'draft'}>{environment.appliedToRunningProcess ? 'Çalışan prosese uygulandı' : 'Yalnız diskte kayıtlı'}</Badge></p><p className="ws-muted">Kaydedilen revision {environment.savedRevision}; uygulanan revision {environment.appliedRevision ?? 'yok'}. {environment.appliedToRunningProcess ? 'Çalışan release bu değerleri kullanıyor.' : 'Restart veya deploy tamamlanana kadar çalışan process eski değerleri kullanabilir.'}</p>{environment.lastChange && <p className="ws-muted">Son değişiklik: {environment.lastChange.added} eklendi, {environment.lastChange.updated} güncellendi, {environment.lastChange.deleted} silindi.</p>}</div>}
    {variables.items.length > 0 && <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Değişken</th><th>Değer</th><th>Görünürlük</th><th>İşlem</th></tr></thead><tbody>{variables.items.map((variable) => <tr key={variable.key}><td><strong>{variable.key}</strong></td><td>{variable.secret ? '••••••••' : variable.value}</td><td><Badge state="unknown">{variable.secret ? 'Gizli' : 'Düz metin'}</Badge></td><td><Button disabled={busy || variables.status !== 'ready'} onClick={() => setRemove(variable)}>Sil</Button></td></tr>)}</tbody></table></div>}
    {variables.status === 'ready' && !variables.items.length && <EmptyState title="Özel değişken yok" detail="Uygulamanızın ihtiyacı olan ortam değişkenlerini aşağıdan ekleyin." icon="code" />}
    <form className="ws-form" onSubmit={save}><fieldset disabled={busy || variables.status !== 'ready'}><div className="ws-form-grid"><label>Değişken adı<input value={form.key} required pattern="[A-Za-z_][A-Za-z0-9_]*" autoCapitalize="none" spellCheck={false} onChange={(event) => setForm({ ...form, key: event.target.value })} /></label><label>Değer<input value={form.value} type={form.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} onChange={(event) => setForm({ ...form, value: event.target.value })} /></label><label>Görünürlük<select value={form.secret ? 'secret' : 'plain'} onChange={(event) => setForm({ ...form, secret: event.target.value === 'secret' })}><option value="secret">Gizli</option><option value="plain">Düz metin</option></select></label></div><p className="ws-muted">Aynı isimde değişken varsa değeri değiştirilir. Parola ve anahtarlar için gizli seçimini kullanın.</p><Button type="submit" variant="primary" disabled={busy}>{busy ? 'Kaydediliyor…' : 'Değişkeni kaydet'}</Button></fieldset><ErrorNotice error={error} />{notice && <p role="status" className="ws-notice">{notice}</p>}</form>
    <form className="ws-form" onSubmit={submitImport}><fieldset disabled={busy || variables.status !== 'ready' || !environment}><label>.env içeriği<textarea rows="7" value={importForm.content} required maxLength={12 * 1024} spellCheck={false} placeholder="API_URL=https://example.test" onChange={(event) => setImportForm({ ...importForm, content: event.target.value })} /></label><div className="ws-form-grid"><label>İçe aktarma modu<select value={importForm.mode} onChange={(event) => setImportForm({ ...importForm, mode: event.target.value })}><option value="merge">Mevcutlarla birleştir</option><option value="replace">Tümünü değiştir</option></select></label><label>Görünürlük<select value={importForm.secret ? 'secret' : 'plain'} onChange={(event) => setImportForm({ ...importForm, secret: event.target.value === 'secret' })}><option value="secret">Tümünü gizli kaydet</option><option value="plain">Tümünü düz metin kaydet</option></select></label></div><p className="ws-muted">Yalnız katı KEY=value biçimi kabul edilir. Duplicate, reserved, multiline ve sınırı aşan değerler hiçbir değişiklik yapılmadan reddedilir.</p><Button type="submit" variant="primary" disabled={busy || !importForm.content}>{busy ? 'İçe aktarılıyor…' : '.env içeriğini içe aktar'}</Button></fieldset></form>
    {remove && <ConfirmDialog title="Ortam değişkenini sil" message={`${application.name} uygulamasındaki ${remove.key} değişkeni silinecek. Uygulamaya yeniden başlatma/deploy ile uygulanır.`} confirmation={remove.key} busy={busy} error={error} onCancel={() => setRemove(null)} onConfirm={() => mutate(async () => { await panelRequest(`/applications/${encodeURIComponent(application.id)}/environment/${encodeURIComponent(remove.key)}`, { method: 'DELETE', signal: requests.current.signal }); setRemove(null); setNotice('Değişken silindi. Çalışan uygulamaya uygulamak için yeniden başlatın.'); })} confirmLabel="Değişkeni sil" />}
    {replaceImport && environment && <ConfirmDialog title="Ortam değişkenlerinin tamamını değiştir" message={`${application.name} için içe aktarılan listede bulunmayan mevcut değişkenler silinecek. Değişiklik yalnız restart/deploy sonrasında çalışan prosese uygulanır.`} confirmation={`replace-environment:${application.id}:${environment.savedRevision}`} busy={busy} error={error} onCancel={() => setReplaceImport(false)} onConfirm={() => applyImport('replace')} confirmLabel="Tümünü değiştir" />}
  </Section>;
}
