import { useCallback, useEffect, useState } from 'react';
import { panelRequest } from '../api.js';
import { Button, ConfirmDialog, EmptyState, ErrorNotice, Section } from './PanelKit.jsx';

function parentPath(value) {
  const parts = value.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function sizeLabel(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 ** 2)).toFixed(1)} MB`;
}

export default function FilesPanel({ websiteId }) {
  const [path, setPath] = useState('');
  const [listing, setListing] = useState(null);
  const [editor, setEditor] = useState(null);
  const [folderName, setFolderName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async (nextPath = path) => {
    setBusy(true); setError(null); setEditor(null);
    try {
      const result = await panelRequest(`/websites/${encodeURIComponent(websiteId)}/files?path=${encodeURIComponent(nextPath)}`);
      setPath(nextPath); setListing(result);
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }, [path, websiteId]);

  useEffect(() => { void load(''); }, [websiteId]);

  async function openFile(file) {
    setBusy(true); setError(null);
    try {
      const result = await panelRequest(`/websites/${encodeURIComponent(websiteId)}/files/text?path=${encodeURIComponent(file.path)}`);
      setEditor({ path: file.path, content: result.content, sha256: result.sha256 });
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }

  async function save(event) {
    event.preventDefault();
    if (!editor || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await panelRequest(`/websites/${encodeURIComponent(websiteId)}/files/text`, {
        method: 'PUT', body: { path: editor.path, content: editor.content, expectedSha256: editor.sha256 },
      });
      setEditor((current) => ({ ...current, sha256: result.sha256 }));
      await load(path);
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }

  async function createFolder(event) {
    event.preventDefault();
    const name = folderName.trim();
    if (!name || name.includes('/') || busy) return;
    setBusy(true); setError(null);
    try {
      const target = path ? `${path}/${name}` : name;
      await panelRequest(`/websites/${encodeURIComponent(websiteId)}/files/mkdir`, { method: 'POST', body: { path: target } });
      setFolderName(''); await load(path);
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!deleteTarget || busy) return;
    setBusy(true); setError(null);
    try {
      await panelRequest(`/websites/${encodeURIComponent(websiteId)}/files`, {
        method: 'DELETE',
        body: { path: deleteTarget.path, confirmation: `delete:${websiteId}:${deleteTarget.path}` },
      });
      setDeleteTarget(null); await load(path);
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }

  return <>
    <Section title="Site dosyaları" description="Aktif release kökünü site kullanıcısının yetkileriyle yönetin." actions={<Button icon="refresh" disabled={busy} onClick={() => load(path)}>Yenile</Button>}>
      <ErrorNotice error={error} />
      <div className="ws-section-body ws-actions"><Button disabled={busy || !path} onClick={() => load(parentPath(path))}>Üst klasör</Button><strong>/{path}</strong></div>
      {busy && !listing && <div className="ws-loading" role="status"><span className="ws-spinner" />Dosyalar yükleniyor…</div>}
      {listing?.entries?.length ? <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Ad</th><th>Tür</th><th>Boyut</th><th>Yetki</th><th className="ws-row-end">İşlem</th></tr></thead><tbody>{listing.entries.map((entry) => <tr key={entry.path}><td><strong>{entry.name}</strong></td><td>{entry.type === 'directory' ? 'Klasör' : entry.type === 'file' ? 'Dosya' : entry.type}</td><td>{sizeLabel(entry.size)}</td><td>{entry.mode}</td><td className="ws-row-end"><div className="ws-actions">{entry.type === 'directory' && <Button disabled={busy} onClick={() => load(entry.path)}>Aç</Button>}{entry.type === 'file' && <><Button disabled={busy} onClick={() => openFile(entry)}>Düzenle</Button><a className="ws-button ws-button-secondary" href={`/api/panel/websites/${encodeURIComponent(websiteId)}/files/download?path=${encodeURIComponent(entry.path)}`}>İndir</a></>}<Button variant="danger" disabled={busy} onClick={() => setDeleteTarget(entry)}>Sil</Button></div></td></tr>)}</tbody></table></div> : listing && <EmptyState title="Klasör boş" detail="Bu dizinde henüz dosya veya klasör yok." icon="file" />}
      <form className="ws-form ws-section-body" onSubmit={createFolder}><label>Yeni klasör adı<input value={folderName} onChange={(event) => setFolderName(event.target.value)} maxLength={255} autoComplete="off" /></label><div className="ws-actions"><Button type="submit" variant="primary" disabled={busy || !folderName.trim() || folderName.includes('/')}>Klasör oluştur</Button></div></form>
    </Section>
    {editor && <Section title={editor.path} description="Kaydetme sırasında dosyanın siz açtıktan sonra değişmediği doğrulanır."><form className="ws-form" onSubmit={save}><ErrorNotice error={error} /><label>Dosya içeriği<textarea rows={22} value={editor.content} onChange={(event) => setEditor((current) => ({ ...current, content: event.target.value }))} spellCheck={false} /></label><footer className="ws-form-footer"><Button disabled={busy} onClick={() => setEditor(null)}>Kapat</Button><Button type="submit" variant="primary" disabled={busy}>Kaydet</Button></footer></form></Section>}
    {deleteTarget && <ConfirmDialog title={`${deleteTarget.name} silinsin mi?`} message="Dosya veya boş klasör aktif release içinden kalıcı olarak silinecek." confirmation={deleteTarget.name} confirmLabel="Sil" busy={busy} error={error} onCancel={() => setDeleteTarget(null)} onConfirm={remove} />}
  </>;
}
