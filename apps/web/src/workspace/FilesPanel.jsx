import { useCallback, useEffect, useRef, useState } from 'react';
import { panelRequest, uploadSiteFile } from '../api.js';
import { formatBytes, formatDate } from './site-model.js';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorNotice,
  Icon,
  Modal,
  Section,
} from './PanelKit.jsx';

function parentPath(value) {
  const parts = value.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function breadcrumbSegments(currentPath) {
  if (!currentPath) return [];
  const parts = currentPath.split('/').filter(Boolean);
  return parts.map((part, index) => ({
    name: part,
    path: parts.slice(0, index + 1).join('/'),
  }));
}

export default function FilesPanel({ websiteId, runtimeType }) {
  const [path, setPath] = useState('');
  const [listing, setListing] = useState(null);
  const [selectedPaths, setSelectedPaths] = useState([]);
  const [editor, setEditor] = useState(null);
  const [createType, setCreateType] = useState(null); // 'file' | 'folder' | null
  const [createName, setCreateName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  const supported = ['static', 'node', 'php', 'python'].includes(runtimeType);

  const load = useCallback(async (nextPath = path) => {
    setBusy(true);
    setError(null);
    setSelectedPaths([]);
    try {
      const result = await panelRequest(`/websites/${encodeURIComponent(websiteId)}/files?path=${encodeURIComponent(nextPath)}`);
      setPath(nextPath);
      setListing(result);
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally {
      setBusy(false);
    }
  }, [path, websiteId]);

  useEffect(() => {
    if (supported) {
      void load('');
    } else {
      setPath('');
      setListing(null);
      setEditor(null);
    }
  }, [websiteId, supported]);

  function toggleSelectAll() {
    if (!listing?.entries?.length) return;
    if (selectedPaths.length === listing.entries.length) {
      setSelectedPaths([]);
    } else {
      setSelectedPaths(listing.entries.map((entry) => entry.path));
    }
  }

  function toggleSelect(entryPath) {
    setSelectedPaths((current) => (
      current.includes(entryPath)
        ? current.filter((p) => p !== entryPath)
        : [...current, entryPath]
    ));
  }

  async function openFile(file) {
    setBusy(true);
    setError(null);
    try {
      const result = await panelRequest(`/websites/${encodeURIComponent(websiteId)}/files/text?path=${encodeURIComponent(file.path)}`);
      setEditor({
        path: file.path,
        name: file.name,
        content: result.content,
        sha256: result.sha256,
      });
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveEditor(event) {
    event.preventDefault();
    if (!editor || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await panelRequest(`/websites/${encodeURIComponent(websiteId)}/files/text`, {
        method: 'PUT',
        body: { path: editor.path, content: editor.content, expectedSha256: editor.sha256 },
      });
      setEditor((current) => (current ? { ...current, sha256: result.sha256 } : null));
      await load(path);
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateItem(event) {
    event.preventDefault();
    const name = createName.trim();
    if (!name || name.includes('/') || busy || !createType) return;
    setBusy(true);
    setError(null);
    try {
      const targetPath = path ? `${path}/${name}` : name;
      const endpoint = createType === 'folder' ? 'mkdir' : 'file';
      await panelRequest(`/websites/${encodeURIComponent(websiteId)}/files/${endpoint}`, {
        method: 'POST',
        body: { path: targetPath },
      });
      setCreateType(null);
      setCreateName('');
      await load(path);
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeSingle() {
    if (!deleteTarget || busy) return;
    setBusy(true);
    setError(null);
    try {
      await panelRequest(`/websites/${encodeURIComponent(websiteId)}/files`, {
        method: 'DELETE',
        body: {
          path: deleteTarget.path,
          confirmation: `delete:${websiteId}:${deleteTarget.path}`,
        },
      });
      const removedPath = deleteTarget.path;
      setDeleteTarget(null);
      setSelectedPaths((current) => current.filter((p) => p !== removedPath));
      await load(path);
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeBatch() {
    if (!selectedPaths.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      await panelRequest(`/websites/${encodeURIComponent(websiteId)}/files/batch-delete`, {
        method: 'POST',
        body: {
          paths: selectedPaths,
          confirmation: `batch-delete:${websiteId}`,
        },
      });
      setBatchDeleteOpen(false);
      setSelectedPaths([]);
      await load(path);
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleFileUpload(event) {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of files) {
        const targetPath = path ? `${path}/${file.name}` : file.name;
        const arrayBuffer = await file.arrayBuffer();
        await uploadSiteFile(websiteId, targetPath, arrayBuffer);
      }
      await load(path);
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  if (!supported) {
    return (
      <Section title="Site dosyaları" description="Website dosya yöneticisi.">
        <div className="ws-section-body">
          <p className="ws-muted">Bu runtime türü için dosya yöneticisi desteklenmiyor.</p>
        </div>
      </Section>
    );
  }

  const entries = listing?.entries ?? [];
  const crumbs = breadcrumbSegments(path);
  const allSelected = entries.length > 0 && selectedPaths.length === entries.length;

  return (
    <>
      <input
        type="file"
        ref={fileInputRef}
        multiple
        style={{ display: 'none' }}
        onChange={handleFileUpload}
      />

      <Section
        title="Site Dosyaları"
        description="Website kök dizinindeki dosya ve klasörleri yönetin. İşlemler site kullanıcısı yetkileriyle izole yürütülür."
        actions={
          <div className="ws-actions">
            <Button
              variant="primary"
              icon="plus"
              disabled={busy}
              onClick={() => { setCreateType('file'); setCreateName(''); }}
            >
              Yeni Dosya
            </Button>
            <Button
              icon="folder"
              disabled={busy}
              onClick={() => { setCreateType('folder'); setCreateName(''); }}
            >
              Yeni Klasör
            </Button>
            <Button
              icon="upload"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
            >
              Dosya Yükle
            </Button>
            {selectedPaths.length > 0 && (
              <Button
                variant="danger"
                icon="trash"
                disabled={busy}
                onClick={() => setBatchDeleteOpen(true)}
              >
                Seçilenleri Sil ({selectedPaths.length})
              </Button>
            )}
            <Button
              icon="refresh"
              disabled={busy}
              onClick={() => load(path)}
            >
              Yenile
            </Button>
          </div>
        }
      >
        <ErrorNotice error={error} />

        <div className="ws-section-body" style={{ paddingBottom: 12, paddingTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div className="ws-breadcrumb" style={{ margin: 0, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Button
                disabled={busy}
                onClick={() => load('')}
                style={{ padding: '4px 8px', minHeight: 28, fontSize: 12 }}
              >
                <Icon name="folder" size={14} /> / (Kök Dizin)
              </Button>
              {crumbs.map((crumb, idx) => (
                <span key={crumb.path} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: 'var(--ws-muted)' }}>/</span>
                  {idx === crumbs.length - 1 ? (
                    <strong>{crumb.name}</strong>
                  ) : (
                    <Button
                      disabled={busy}
                      onClick={() => load(crumb.path)}
                      style={{ padding: '4px 8px', minHeight: 28, fontSize: 12 }}
                    >
                      {crumb.name}
                    </Button>
                  )}
                </span>
              ))}
            </div>

            {Boolean(path) && (
              <Button
                disabled={busy}
                onClick={() => load(parentPath(path))}
                style={{ minHeight: 28, fontSize: 12 }}
              >
                ↑ Üst Klasör
              </Button>
            )}
          </div>
        </div>

        {busy && !listing && (
          <div className="ws-loading" role="status">
            <span className="ws-spinner" /> Dosyalar yükleniyor…
          </div>
        )}

        {entries.length > 0 ? (
          <div className="ws-table-scroll">
            <table className="ws-table">
              <thead>
                <tr>
                  <th style={{ width: 38, textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      aria-label="Tümünü seç"
                    />
                  </th>
                  <th>Ad</th>
                  <th>Tür</th>
                  <th>Boyut</th>
                  <th>Değiştirilme</th>
                  <th>Yetki</th>
                  <th className="ws-row-end">İşlemler</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const isDir = entry.type === 'directory';
                  const isSelected = selectedPaths.includes(entry.path);
                  return (
                    <tr
                      key={entry.path}
                      style={{ background: isSelected ? 'var(--ws-accent-soft, #edf3ff)' : undefined }}
                    >
                      <td style={{ textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(entry.path)}
                          aria-label={`${entry.name} seç`}
                        />
                      </td>
                      <td>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          <Icon name={isDir ? 'folder' : 'file'} size={16} />
                          {isDir ? (
                            <button
                              type="button"
                              onClick={() => load(entry.path)}
                              disabled={busy}
                              style={{
                                background: 'none',
                                border: 'none',
                                padding: 0,
                                color: 'var(--ws-accent)',
                                cursor: 'pointer',
                                textAlign: 'left',
                                font: 'inherit',
                                textDecoration: 'underline',
                              }}
                            >
                              <strong>{entry.name}</strong>
                            </button>
                          ) : (
                            <strong>{entry.name}</strong>
                          )}
                        </div>
                      </td>
                      <td>{isDir ? 'Klasör' : entry.type === 'file' ? 'Dosya' : entry.type}</td>
                      <td>{isDir ? '—' : formatBytes(entry.size)}</td>
                      <td>{formatDate(entry.mtime)}</td>
                      <td><code>{entry.mode}</code></td>
                      <td className="ws-row-end">
                        <div className="ws-actions" style={{ justifyContent: 'flex-end' }}>
                          {isDir ? (
                            <Button disabled={busy} onClick={() => load(entry.path)}>
                              Aç
                            </Button>
                          ) : (
                            <>
                              <Button
                                disabled={busy}
                                icon="code"
                                onClick={() => openFile(entry)}
                              >
                                Düzenle
                              </Button>
                              <a
                                className="ws-button ws-button-secondary"
                                href={`/api/panel/websites/${encodeURIComponent(websiteId)}/files/download?path=${encodeURIComponent(entry.path)}`}
                                download={entry.name}
                              >
                                <Icon name="download" /> İndir
                              </a>
                            </>
                          )}
                          <Button
                            variant="danger"
                            icon="trash"
                            disabled={busy}
                            onClick={() => setDeleteTarget(entry)}
                          >
                            Sil
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          listing && (
            <EmptyState
              title="Dizin boş"
              detail="Bu klasörde henüz dosya veya alt klasör bulunmuyor. Yeni dosya veya klasör oluşturabilir ya da dosya yükleyebilirsiniz."
              icon="folder"
            />
          )
        )}
      </Section>

      {/* New File / Folder Modal */}
      {createType && (
        <Modal
          title={createType === 'folder' ? 'Yeni Klasör Oluştur' : 'Yeni Dosya Oluştur'}
          onClose={() => setCreateType(null)}
          busy={busy}
        >
          <form className="ws-form" onSubmit={handleCreateItem}>
            <label>
              {createType === 'folder' ? 'Klasör Adı' : 'Dosya Adı (uzantısıyla birlikte)'}
              <input
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder={createType === 'folder' ? 'örn: assets' : 'örn: index.html'}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                maxLength={255}
                required
              />
              <span className="ws-field-hint">
                Konum: <code>/{path || '(kök)'}</code>. Slaç (/) veya geçersiz karakter içeremez.
              </span>
            </label>
            <footer className="ws-modal-footer">
              <Button disabled={busy} onClick={() => setCreateType(null)}>
                Vazgeç
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={busy || !createName.trim() || createName.includes('/')}
              >
                {busy ? 'Oluşturuluyor…' : 'Oluştur'}
              </Button>
            </footer>
          </form>
        </Modal>
      )}

      {/* Editor Modal */}
      {editor && (
        <Modal
          title={`Dosya Düzenle: ${editor.name}`}
          onClose={() => setEditor(null)}
          busy={busy}
          wide
        >
          <form className="ws-form" onSubmit={saveEditor} style={{ padding: 0 }}>
            <ErrorNotice error={error} />
            <div style={{ color: 'var(--ws-muted)', fontSize: 12, marginBottom: 8 }}>
              Konum: <code>/{editor.path}</code> | Kaydetme sırasında dosyanın dışarıdan değişip değişmediği (SHA256) doğrulanır.
            </div>
            <label style={{ display: 'grid', gap: 6 }}>
              <span>İçerik</span>
              <textarea
                rows={22}
                value={editor.content}
                onChange={(e) => setEditor((cur) => (cur ? { ...cur, content: e.target.value } : null))}
                spellCheck={false}
                style={{
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                  fontSize: 13,
                  lineHeight: 1.5,
                  tabSize: 2,
                  whiteSpace: 'pre',
                  overflowX: 'auto',
                }}
              />
            </label>
            <footer className="ws-modal-footer">
              <Button disabled={busy} onClick={() => setEditor(null)}>
                Kapat
              </Button>
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? 'Kaydediliyor…' : 'Değişiklikleri Kaydet'}
              </Button>
            </footer>
          </form>
        </Modal>
      )}

      {/* Single Delete Confirm Dialog */}
      {deleteTarget && (
        <ConfirmDialog
          title={`${deleteTarget.name} silinsin mi?`}
          message={`${deleteTarget.type === 'directory' ? 'Klasör ve içeriği' : 'Dosya'} aktif release içinden kalıcı olarak silinecek.`}
          confirmation={deleteTarget.name}
          confirmLabel="Sil"
          busy={busy}
          error={error}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={removeSingle}
        />
      )}

      {/* Batch Delete Confirm Dialog */}
      {batchDeleteOpen && (
        <ConfirmDialog
          title={`Seçili ${selectedPaths.length} öge silinsin mi?`}
          message={`Seçilen ${selectedPaths.length} dosya/klasör kalıcı olarak silinecek: ${selectedPaths.slice(0, 5).join(', ')}${selectedPaths.length > 5 ? ` ve ${selectedPaths.length - 5} öge daha...` : ''}`}
          confirmation={`batch-delete:${websiteId}`}
          confirmLabel={`Seçilenleri Sil (${selectedPaths.length})`}
          busy={busy}
          error={error}
          onCancel={() => setBatchDeleteOpen(false)}
          onConfirm={removeBatch}
        />
      )}
    </>
  );
}
