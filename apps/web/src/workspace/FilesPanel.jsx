import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { createElFinderHandoff, downloadSiteFile, panelRequest, uploadSiteFile } from '../api.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { useFileWorkspaceSession } from './FileWorkspaceSession.jsx';
import { formatBytes, formatDate } from './site-model.js';
import { Button, ConfirmDialog, EmptyState, ErrorNotice, Icon, Modal, Section } from './PanelKit.jsx';
import {
  availableFileActions, checkItemConflict, fileChild, fileCrumbs, fileKind,
  fileListing, fileParent, formatPermissions, isArchiveFile, paginateFiles,
  parsePermissions, toggleVisibleSelection, validFileName, validRelativePath, validateDestinationPath,
  validateSafePermissions, visibleFiles,
} from './ui/file-workspace-model.js';
import { packZip, unpackZip } from './ui/zip-util.js';
import './ui/file-workspace.css';

// A changed Website must discard caches, selection, in-flight reads and editor state.
export default function FilesPanel({ websiteId, serverId, runtimeType }) {
  return <FileWorkspace key={`${websiteId}:${serverId}:${runtimeType}`} websiteId={websiteId} serverId={serverId} runtimeType={runtimeType} />;
}
function FileWorkspace({ websiteId, serverId, runtimeType }) {
  const { canManage } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const supported = ['static', 'node', 'php', 'python'].includes(runtimeType);
  const base = `/websites/${encodeURIComponent(websiteId)}/files`;
  const { initialPath, editor, setEditor, rememberPath } = useFileWorkspaceSession({ websiteId, runtimeType });
  const urlPath = searchParams.get('path');
  const validUrlPath = urlPath && validRelativePath(urlPath) ? urlPath : null;
  const effectiveInitialPath = validUrlPath ?? initialPath;
  const [view, setView] = useState({ path: effectiveInitialPath, entries: [], loading: true, loaded: false, error: null });
  const lastLoadedPath = useRef(effectiveInitialPath);
  const autoOpenedRef = useRef(false);
  const [folders, setFolders] = useState({});
  const [expanded, setExpanded] = useState(() => new Set(['']));
  const [treeLoading, setTreeLoading] = useState(() => new Set());
  const [treeError, setTreeError] = useState(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const [query, setQuery] = useState(() => searchParams.get('q') ?? searchParams.get('search') ?? '');
  const [hidden, setHidden] = useState(() => searchParams.get('hidden') !== 'false');
  const [sort, setSort] = useState(() => ['name', 'size', 'modified'].includes(searchParams.get('sort')) ? searchParams.get('sort') : 'name');
  const [layout, setLayout] = useState('list');
  const [selected, setSelected] = useState([]);
  const [dialog, setDialog] = useState(null);
  const [discard, setDiscard] = useState(false);
  const [editorLoading, setEditorLoading] = useState(false);
  const [upload, setUpload] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const [dragging, setDragging] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const alive = useRef(true), generation = useRef(0), pending = useRef(false), read = useRef(null);
  const requests = useRef(new Set()), uploadInput = useRef(null), allBox = useRef(null), lineNumbers = useRef(null);
  const treePending = useRef(new Set());
  const locked = busy || view.loading || editorLoading;
  const mutable = canManage && !locked && view.loaded && !view.error;
  const entries = useMemo(() => visibleFiles(view.entries, { query, hidden, sort }), [view.entries, query, hidden, sort]);
  const paginated = useMemo(() => paginateFiles(entries, { page, pageSize }), [entries, page, pageSize]);
  const visibleEntries = paginated.paginatedItems;
  const allSelected = entries.length > 0 && entries.every((entry) => selected.includes(entry.path));
  const someSelected = entries.some((entry) => selected.includes(entry.path));
  useEffect(() => { if (allBox.current) allBox.current.indeterminate = someSelected && !allSelected; }, [someSelected, allSelected]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; generation.current++; read.current?.abort(); for (const controller of requests.current) controller.abort(); };
  }, []);
  const request = useCallback(async (url, options = {}) => {
    const controller = new AbortController(); requests.current.add(controller);
    try { return await panelRequest(url, { ...options, signal: controller.signal }); }
    finally { requests.current.delete(controller); }
  }, []);
  const cacheFolders = useCallback((path, items) => setFolders((current) => ({
    ...current, [path]: items.filter((entry) => entry.type === 'directory'),
  })), []);
  const load = useCallback(async (nextPath = '') => {
    lastLoadedPath.current = nextPath;
    const current = ++generation.current;
    read.current?.abort(); const controller = new AbortController(); read.current = controller;
    setView((value) => ({ ...value, loading: true, error: null }));
    try {
      const result = await panelRequest(`${base}?path=${encodeURIComponent(nextPath)}`, { signal: controller.signal });
      const items = fileListing(result, nextPath);
      if (!alive.current || current !== generation.current) return;
      setView({ path: nextPath, entries: items, loading: false, loaded: true, error: null });
      rememberPath(nextPath);
      setSelected([]); cacheFolders(nextPath, items);
      setExpanded((value) => new Set([...value, '', ...fileCrumbs(nextPath).map((crumb) => crumb.path)]));
      setPage(1);
    } catch (failure) {
      if (alive.current && current === generation.current && failure.name !== 'AbortError') {
        setView((value) => ({ ...value, loading: false, error: failure.message }));
      }
    }
  }, [base, cacheFolders, rememberPath]);
  useEffect(() => { if (supported && websiteId) void load(effectiveInitialPath); }, [supported, websiteId, load, effectiveInitialPath]);
  const currentParamPath = searchParams.get('path') ?? '';
  useEffect(() => {
    const targetPath = validRelativePath(currentParamPath) ? currentParamPath : '';
    if (targetPath !== lastLoadedPath.current) {
      void load(targetPath);
    }
  }, [currentParamPath, load]);
  async function expand(path) {
    if (expanded.has(path)) { setExpanded((value) => { const next = new Set(value); next.delete(path); return next; }); return; }
    setTreeError(null);
    if (!folders[path]) {
      if (treePending.current.has(path)) return;
      treePending.current.add(path); setTreeLoading((value) => new Set([...value, path]));
      try { const result = await request(`${base}?path=${encodeURIComponent(path)}`); if (!alive.current) return; cacheFolders(path, fileListing(result, path)); }
      catch (failure) { if (alive.current && failure.name !== 'AbortError') setTreeError(failure.message); return; }
      finally { treePending.current.delete(path); if (alive.current) setTreeLoading((value) => { const next = new Set(value); next.delete(path); return next; }); }
    }
    if (alive.current) setExpanded((value) => new Set([...value, path]));
  }
  function navigate(path) {
    if (locked) return;
    if (editor && editor.content !== editor.saved) {
      setDiscard(true);
      return;
    }
    if (editor && editor.content === editor.saved) {
      setEditor(null);
      setError(null);
    }
    lastLoadedPath.current = path;
    setQuery('');
    setTreeOpen(false);
    setPage(1);
    autoOpenedRef.current = false;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (path) next.set('path', path);
      else next.delete('path');
      next.delete('file');
      next.delete('q');
      next.delete('search');
      return next;
    });
    void load(path);
  }
  function handleQueryChange(value) {
    setQuery(value);
    setPage(1);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set('q', value);
      else { next.delete('q'); next.delete('search'); }
      return next;
    }, { replace: true });
  }
  function handleSortChange(value) {
    setSort(value);
    setPage(1);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value && value !== 'name') next.set('sort', value);
      else next.delete('sort');
      return next;
    }, { replace: true });
  }
  function handleHiddenChange(checked) {
    setHidden(checked);
    setPage(1);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (!checked) next.set('hidden', 'false');
      else next.delete('hidden');
      return next;
    }, { replace: true });
  }
  function openDialog(value) { setError(null); setNotice(''); setDialog(value); }
  async function operate(action, success) {
    if (pending.current || !canManage) return;
    pending.current = true; setBusy(true); setError(null); setNotice('');
    try { await action(); if (alive.current) { success?.(); await load(view.path); } }
    catch (failure) { if (alive.current && failure.name !== 'AbortError') setError(failure.message); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  async function createOrRename(event) {
    event.preventDefault(); if (!dialog || !validFileName(dialog.name)) return;
    const value = dialog;
    await operate(() => request(`${base}/${value.kind === 'rename' ? 'rename' : value.kind === 'folder' ? 'mkdir' : 'file'}`, {
      method: 'POST', body: value.kind === 'rename'
        ? { path: value.entry.path, destination: fileChild(fileParent(value.entry.path), value.name) }
        : { path: fileChild(value.parent, value.name) },
    }), () => { setDialog(null); setNotice(value.kind === 'rename' ? 'Ad değiştirildi.' : 'Oluşturuldu.'); });
  }
  async function remove() {
    const paths = dialog?.paths; if (!paths?.length) return;
    await operate(() => paths.length === 1
      ? request(base, { method: 'DELETE', body: { path: paths[0], confirmation: `delete:${websiteId}:${paths[0]}` } })
      : request(`${base}/batch-delete`, { method: 'POST', body: { paths, confirmation: `batch-delete:${websiteId}` } }),
    () => { setDialog(null); setSelected([]); setFolders({}); setExpanded(new Set([''])); setNotice('Seçilen öğeler silindi.'); });
    // Refresh the root tree after removals without moving the current directory.
    if (alive.current) { try { const root = await request(`${base}?path=`); if (alive.current) cacheFolders('', fileListing(root, '')); } catch { /* Content listing carries the operation result; the tree can be refreshed separately. */ } }
  }
  async function moveItems(event) {
    event?.preventDefault();
    if (!dialog?.paths?.length) return;
    const targetDir = dialog.destination ?? view.path;
    try { validateDestinationPath(dialog.paths, targetDir); }
    catch (err) { setError(err.message); return; }
    await operate(async () => {
      for (const p of dialog.paths) {
        const name = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
        const dest = fileChild(targetDir, name);
        await request(`${base}/rename`, { method: 'POST', body: { path: p, destination: dest } });
      }
    }, () => { setDialog(null); setSelected([]); setNotice(`${dialog.paths.length} öğe taşındı.`); });
  }
  async function copyItems(event) {
    event?.preventDefault();
    if (!dialog?.paths?.length) return;
    const targetDir = dialog.destination ?? view.path;
    try { validateDestinationPath(dialog.paths, targetDir); }
    catch (err) { setError(err.message); return; }
    await operate(async () => {
      async function copyEntry(srcPath, destPath, isDir) {
        if (isDir) {
          await request(`${base}/mkdir`, { method: 'POST', body: { path: destPath } }).catch(() => null);
          const listRes = await request(`${base}?path=${encodeURIComponent(srcPath)}`);
          const children = fileListing(listRes, srcPath);
          for (const child of children) {
            await copyEntry(child.path, fileChild(destPath, child.name), child.type === 'directory');
          }
        } else {
          const data = await downloadSiteFile(websiteId, srcPath);
          await uploadSiteFile(websiteId, destPath, data);
        }
      }

      for (const p of dialog.paths) {
        const name = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
        const dest = fileChild(targetDir, name);
        const entry = view.entries.find((e) => e.path === p);
        const isDir = entry ? entry.type === 'directory' : false;
        await copyEntry(p, dest, isDir);
      }
    }, () => { setDialog(null); setNotice(`${dialog.paths.length} öğe kopyalandı.`); });
  }
  async function archiveItems(event) {
    event?.preventDefault();
    if (!dialog || !validFileName(dialog.name)) return;
    const archiveName = dialog.name;
    const dest = fileChild(view.path, archiveName);
    await operate(async () => {
      const filesToArchive = [];

      async function collectEntries(p, relPrefix = '') {
        const entry = view.entries.find((e) => e.path === p);
        const name = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
        const entryRel = relPrefix ? `${relPrefix}/${name}` : name;

        if (entry?.type === 'directory') {
          filesToArchive.push({ path: entryRel, isDir: true });
          const listRes = await request(`${base}?path=${encodeURIComponent(p)}`);
          const children = fileListing(listRes, p);
          for (const child of children) {
            await collectEntries(child.path, entryRel);
          }
        } else {
          const data = await downloadSiteFile(websiteId, p);
          filesToArchive.push({ path: entryRel, data, isDir: false });
        }
      }

      for (const p of dialog.paths) {
        await collectEntries(p);
      }

      const zipData = packZip(filesToArchive);
      await uploadSiteFile(websiteId, dest, zipData);
    }, () => { setDialog(null); setNotice(`Arşiv oluşturuldu: ${archiveName}`); });
  }
  async function extractArchive(event) {
    event?.preventDefault();
    if (!dialog?.entry) return;
    const targetDir = dialog.destination ?? view.path;
    try { validateDestinationPath([dialog.entry.path], targetDir); }
    catch (err) { setError(err.message); return; }
    await operate(async () => {
      const zipBytes = await downloadSiteFile(websiteId, dialog.entry.path);
      const entries = await unpackZip(zipBytes);
      if (!entries.length) throw new Error('Arşiv boş veya geçerli dosya içermiyor.');

      const createdDirs = new Set(['', targetDir]);

      for (const item of entries) {
        const destPath = fileChild(targetDir, item.path);
        if (item.isDir) {
          if (!createdDirs.has(destPath)) {
            await request(`${base}/mkdir`, { method: 'POST', body: { path: destPath } }).catch(() => null);
            createdDirs.add(destPath);
          }
        } else {
          const parent = fileParent(destPath);
          if (parent && !createdDirs.has(parent)) {
            const parts = parent.split('/');
            let current = '';
            for (const part of parts) {
              current = current ? `${current}/${part}` : part;
              if (!createdDirs.has(current)) {
                await request(`${base}/mkdir`, { method: 'POST', body: { path: current } }).catch(() => null);
                createdDirs.add(current);
              }
            }
          }
          await uploadSiteFile(websiteId, destPath, item.data);
        }
      }
    }, () => { setDialog(null); setNotice(`${dialog.entry.name} arşivi çıkartıldı.`); });
  }
  async function savePermissions(event) {
    event?.preventDefault();
    if (!dialog?.entry) return;
    const octal = dialog.octal ?? '0640';
    try { validateSafePermissions(octal, { isDirectory: dialog.entry.type === 'directory' }); }
    catch (err) { setError(err.message); return; }
    await operate(async () => {
      await request(`${base}/permissions`, {
        method: 'POST',
        body: { path: dialog.entry.path, mode: octal },
      });
    }, () => { setDialog(null); setNotice(`İzinler güncellendi: ${dialog.entry.name} (${octal})`); });
  }
  async function launchElFinder() {
    if (!canManage || locked) return;
    setError(null); setNotice('');
    try {
      if (!serverId) throw new Error('elFinder için aktif sunucu kimliği gerekli.');
      setNotice('elFinder oturumu hazırlanıyor…');
      const handoff = await createElFinderHandoff(serverId, websiteId);
      if (handoff?.capability) {
        await fetch('/tools/elfinder/__yunpanel/handoff', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ capability: handoff.capability }),
        }).catch(() => null);
        window.open('/tools/elfinder/', '_blank');
        setNotice('elFinder dosya yöneticisi yeni pencerede açıldı.');
      }
    } catch (err) { setError(err.message ?? 'elFinder oturumu açılamadı.'); }
  }
  async function openFile(entry) {
    if (locked || entry.type !== 'file' || !canManage) return;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('file', entry.name);
      return next;
    }, { replace: true });
    setEditorLoading(true); setError(null); setNotice('');
    try {
      const result = await request(`${base}/text?path=${encodeURIComponent(entry.path)}`);
      if (alive.current) setEditor({ ...entry, content: result.content, saved: result.content, sha256: result.sha256 });
    } catch (failure) { if (alive.current && failure.name !== 'AbortError') setError(failure.message); }
    finally { if (alive.current) setEditorLoading(false); }
  }
  useEffect(() => {
    const fileParam = searchParams.get('file');
    if (!fileParam) {
      if (editor && !discard) {
        setEditor(null);
        setError(null);
        autoOpenedRef.current = false;
      }
      return;
    }
    if (autoOpenedRef.current || !view.loaded || view.loading || !canManage) return;
    const match = view.entries.find((e) => e.type === 'file' && (e.name === fileParam || e.path === fileParam));
    if (match) {
      autoOpenedRef.current = true;
      if (editor && (editor.name === match.name || editor.path === match.path)) {
        return;
      }
      void openFile(match);
    }
  }, [searchParams, view.loaded, view.loading, view.entries, canManage, editor, discard]);
  async function saveEditor(event) {
    event?.preventDefault(); if (!editor || pending.current || editor.content === editor.saved) return;
    const current = editor;
    await operate(async () => {
      const result = await request(`${base}/text`, { method: 'PUT', body: { path: current.path, content: current.content, expectedSha256: current.sha256 } });
      if (alive.current) setEditor((value) => value?.path === current.path ? { ...value, sha256: result.sha256, saved: current.content } : value);
    }, () => setNotice('Dosya kaydedildi.'));
  }
  function closeEditor() {
    if (busy) return;
    if (editor && editor.content !== editor.saved) setDiscard(true);
    else {
      autoOpenedRef.current = false;
      setEditor(null);
      setError(null);
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete('file');
        return next;
      }, { replace: true });
    }
  }
  function chooseUpload(files) {
    if (!mutable || !files.length || dialog || editor || upload) return;
    setError(null); setNotice('');
    setUpload({ parent: view.path, items: files.map((file) => ({ file, state: 'queued' })) });
  }
  async function startUpload() {
    if (!upload || pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    const target = upload;
    try {
      for (let index = 0; index < target.items.length; index++) {
        if (target.items[index].state === 'uploaded') continue;
        const file = target.items[index].file;
        if (!alive.current) return;
        const body = await file.arrayBuffer();
        if (!alive.current) return;
        await uploadSiteFile(websiteId, fileChild(target.parent, file.name), body);
        if (!alive.current) return;
        setUpload((value) => value ? { ...value, items: value.items.map((item, i) => i === index ? { ...item, state: 'uploaded' } : item) } : value);
      }
      if (alive.current) { setUpload(null); setNotice(`${target.items.length} dosya yüklendi.`); await load(view.path); }
    } catch (failure) { if (alive.current) setError(`${failure.message} Tamamlanan dosyalar korundu; yeniden deneme yalnız kalan dosyaları yükler.`); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  function select(path) { setSelected((value) => value.includes(path) ? value.filter((item) => item !== path) : [...value, path]); }
  function folderNodes(path = '', depth = 0) {
    if (depth > 12 || !expanded.has(path)) return null;
    return <ul>{(folders[path] ?? []).filter((item) => hidden || !item.name.startsWith('.')).map((folder) => <li key={folder.path}>
      <div className={`yf-tree-row ${view.path === folder.path ? 'is-current' : ''}`}>
        <button type="button" className="yf-tree-toggle" disabled={locked || treeLoading.has(folder.path)} aria-label={`${folder.name} alt klasörleri`} aria-expanded={expanded.has(folder.path)} onClick={() => expand(folder.path)}><Icon name={treeLoading.has(folder.path) ? 'clock' : 'chevron'} size={14} /></button>
        <button type="button" className="yf-tree-name" title={folder.path} disabled={locked} aria-current={view.path === folder.path ? 'location' : undefined} onClick={() => navigate(folder.path)}><Icon name="folder" size={17} /><span>{folder.name}</span></button>
      </div>{folderNodes(folder.path, depth + 1)}
    </li>)}</ul>;
  }
  const tree = <nav className="yf-tree" aria-label="Site klasörleri"><div className="yf-tree-caption">ÇALIŞMA ALANI</div><button type="button" className={`yf-root ${!view.path ? 'is-current' : ''}`} disabled={locked} onClick={() => navigate('')} aria-current={!view.path ? 'location' : undefined}><Icon name="folder" /><span>Site kökü</span></button>{folderNodes()}<p className="yf-tree-note"><Icon name="shield" size={15} /> Yalnız bu sitenin dosyaları</p>{treeError && <ErrorNotice error={treeError} />}</nav>;
  function actions(entry) {
    const isArchive = isArchiveFile(entry);
    return <div className="yf-row-actions">
      {entry.type === 'file' && <><Button icon="code" disabled={!mutable} title="Düzenle" aria-label={`${entry.name} düzenle`} onClick={() => openFile(entry)} /><a className="ws-button" aria-label={`${entry.name} indir`} title="İndir" href={`/api/panel/websites/${encodeURIComponent(websiteId)}/files/download?path=${encodeURIComponent(entry.path)}`} download={entry.name}><Icon name="download" /></a></>}
      {isArchive && <Button icon="folder" disabled={!mutable} title="Arşivi Çıkart" aria-label={`${entry.name} arşivi çıkart`} onClick={() => openDialog({ kind: 'extract', entry, destination: view.path })} />}
      <Button icon="settings" title="Dosya işlemleri" aria-label={`${entry.name} işlemleri`} disabled={locked} onClick={() => openDialog({ kind: 'details', entry })} />
    </div>;
  }
  if (!supported || !websiteId) return <Section title="Dosya yöneticisi"><EmptyState icon="folder" title="Bu site için dosya erişimi kullanılamıyor" detail="Dosya yönetimi için desteklenen bir site çalışma alanı gerekir." /></Section>;
  return <>
    <section className="yf-browser" aria-label="Site dosya yöneticisi" onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); if (mutable) setDragging(true); } }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); chooseUpload(Array.from(event.dataTransfer.files)); }}>
      <header className="yf-header"><div><h2>Dosya yöneticisi</h2><p>Plesk uyumlu site dosya sistemi ve yayın dizini yönetimi.</p></div><div className="yf-main-actions"><Button icon="file" disabled={!mutable} onClick={() => openDialog({ kind: 'file', name: '', parent: view.path })}>Yeni Dosya</Button><Button icon="folder" disabled={!mutable} onClick={() => openDialog({ kind: 'folder', name: '', parent: view.path })}>Yeni Klasör</Button><Button icon="upload" variant="primary" disabled={!mutable} onClick={() => uploadInput.current?.click()}>Yükle</Button>{serverId && <Button icon="terminal" disabled={!canManage || locked} title="elFinder dosya yöneticisi oturumu aç" onClick={launchElFinder}>elFinder ile Aç</Button>}<input ref={uploadInput} type="file" multiple hidden onChange={(event) => { chooseUpload(Array.from(event.target.files ?? [])); event.target.value = ''; }} /></div></header>
      <div className="yf-location"><Button className="yf-up" icon="arrow" disabled={locked || !view.path} onClick={() => navigate(fileParent(view.path))} aria-label="Üst klasöre git" /><nav aria-label="Dosya konumu"><button type="button" disabled={locked} onClick={() => navigate('')} aria-current={!view.path ? 'location' : undefined}>Site kökü</button>{fileCrumbs(view.path).map((crumb) => <span key={crumb.path}>/<button type="button" disabled={locked} onClick={() => navigate(crumb.path)} aria-current={view.path === crumb.path ? 'location' : undefined}>{crumb.name}</button></span>)}</nav><Button icon="refresh" disabled={locked} onClick={() => load(view.path)} aria-label="Dosya listesini yenile" /></div>
      {!dialog && !upload && !editor && <ErrorNotice error={error} />}
      {notice && !editor && <div className="yf-feedback" role="status"><Icon name="check" size={16} />{notice}</div>}
      <div className="yf-body"><aside className="yf-folders">{tree}</aside><div className="yf-content">
        <div className="yf-tools"><Button className="yf-mobile-folders" icon="folder" onClick={() => setTreeOpen(true)}>Klasörler</Button><label className="yf-search"><Icon name="search" size={17} /><span className="ws-sr-only">Bu klasörde ara</span><input type="search" placeholder="Bu klasörde ara…" value={query} onChange={(event) => handleQueryChange(event.target.value)} /></label><label className="yf-sort"><span className="ws-sr-only">Dosya sıralaması</span><select value={sort} onChange={(event) => handleSortChange(event.target.value)}><option value="name">Ada göre</option><option value="modified">Son değişen</option><option value="size">Boyuta göre</option></select></label><div className="yf-view" aria-label="Dosya görünümü"><Button icon="jobs" aria-label="Liste görünümü" aria-pressed={layout === 'list'} onClick={() => setLayout('list')} /><Button icon="dashboard" aria-label="Izgara görünümü" aria-pressed={layout === 'grid'} onClick={() => setLayout('grid')} /></div></div>
        <div className="yf-selection"><label><input ref={allBox} aria-label="Görünen öğeleri seç" type="checkbox" checked={allSelected} disabled={!entries.length || locked} onChange={() => setSelected((value) => toggleVisibleSelection(value, entries))} /><span>{selected.length ? `${selected.length} öğe seçili` : `${entries.length} öğe`}</span></label>{selected.length > 0 ? <div className="yf-selection-actions"><Button disabled={!mutable} icon="trash" onClick={() => openDialog({ kind: 'delete', paths: [...selected] })}>Seçilenleri Sil</Button><Button disabled={!mutable} icon="file" onClick={() => openDialog({ kind: 'copy', paths: [...selected], destination: view.path })}>Kopyala</Button><Button disabled={!mutable} icon="arrow" onClick={() => openDialog({ kind: 'move', paths: [...selected], destination: view.path })}>Taşı</Button><Button disabled={!mutable} icon="folder" onClick={() => openDialog({ kind: 'archive', paths: [...selected], name: `${view.path ? view.path.split('/').at(-1) : 'arsiv'}.zip`, format: 'zip' })}>Arşivle</Button><Button disabled={locked} onClick={() => setSelected([])}>Seçimi kaldır</Button></div> : <label className="yf-hidden"><input type="checkbox" checked={hidden} onChange={(event) => handleHiddenChange(event.target.checked)} /><span>Gizli dosyalar</span></label>}</div>
        {view.error && <div className="yf-list-error"><ErrorNotice error={view.error} /><Button onClick={() => load(view.path)} disabled={locked}>Yeniden dene</Button><p>Son liste korunuyor; güncel veri alınana kadar değişiklik yapılamaz.</p></div>}
        <div className="yf-results" aria-busy={view.loading || editorLoading}>
          {(view.loading || editorLoading) && <div className="yf-busy" role="status"><span className="ws-spinner" />{editorLoading ? 'Dosya açılıyor…' : 'Dosyalar yükleniyor…'}</div>}
          {view.loaded && !view.loading && entries.length === 0 && <EmptyState icon={query ? 'search' : 'folder'} title={query ? 'Eşleşen dosya yok' : 'Bu klasör boş'} detail={query ? 'Başka bir dosya adı arayın.' : 'Dosyalarınızı sürükleyin veya Yükle düğmesini kullanın.'} />}
          {entries.length > 0 && (layout === 'list' ? <div className="ws-table-scroll"><table className="yf-table" role="table" aria-label="Site dosyaları"><thead><tr><th scope="col"><span className="ws-sr-only">Seçim</span></th><th scope="col">Ad</th><th scope="col">Boyut</th><th scope="col">İzinler</th><th scope="col">Son değişiklik</th><th scope="col"><span className="ws-sr-only">İşlemler</span></th></tr></thead><tbody>{visibleEntries.map((entry) => <tr key={entry.path} role="row" className={selected.includes(entry.path) ? 'is-selected' : ''}><td role="cell"><input type="checkbox" disabled={locked} checked={selected.includes(entry.path)} onChange={() => select(entry.path)} aria-label={`${entry.name} seç`} /></td><td role="cell"><button type="button" className={`yf-entry ${entry.type === 'directory' ? 'is-folder' : ''}`} disabled={locked || !['directory', 'file'].includes(entry.type)} onClick={() => entry.type === 'directory' ? navigate(entry.path) : openFile(entry)}><span className="yf-file-icon"><Icon name={entry.type === 'directory' ? 'folder' : isArchiveFile(entry) ? 'folder' : 'file'} size={21} /></span><span><strong>{entry.name}</strong><small>{fileKind(entry)}</small></span></button></td><td role="cell" className="yf-size">{entry.type === 'directory' ? '—' : formatBytes(entry.size)}</td><td role="cell" className="yf-size"><span className="yf-perm">{entry.mode ?? (entry.type === 'directory' ? '0750' : '0640')}</span></td><td role="cell" className="yf-date">{formatDate(entry.mtime)}</td><td role="cell">{actions(entry)}</td></tr>)}</tbody></table></div> : <div className="yf-grid">{visibleEntries.map((entry) => <article key={entry.path} className={selected.includes(entry.path) ? 'is-selected' : ''}><input type="checkbox" aria-label={`${entry.name} seç`} checked={selected.includes(entry.path)} disabled={locked} onChange={() => select(entry.path)} /><button type="button" className={`yf-tile ${entry.type === 'directory' ? 'is-folder' : ''}`} disabled={locked || !['directory', 'file'].includes(entry.type)} onClick={() => entry.type === 'directory' ? navigate(entry.path) : openFile(entry)}><Icon name={entry.type === 'directory' ? 'folder' : isArchiveFile(entry) ? 'folder' : 'file'} size={38} /><strong>{entry.name}</strong><small>{entry.type === 'directory' ? 'Klasör' : formatBytes(entry.size)}</small></button>{actions(entry)}</article>)}</div>)}
        </div>
        {entries.length > 25 && <div className="yf-pagination">
          <div className="yf-pagination-controls">
            <Button disabled={paginated.page <= 1 || locked} onClick={() => setPage((p) => Math.max(1, p - 1))}>Önceki</Button>
            <span className="yf-pagination-pages">Sayfa {paginated.page} / {paginated.totalPages} ({paginated.startItem} - {paginated.endItem} / {paginated.totalItems} öğe)</span>
            <Button disabled={paginated.page >= paginated.totalPages || locked} onClick={() => setPage((p) => Math.min(paginated.totalPages, p + 1))}>Sonraki</Button>
          </div>
          <div className="yf-page-size">
            <label htmlFor="yf-pagesize-select">Sayfa:</label>
            <select id="yf-pagesize-select" value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value) || 0); setPage(1); }}>
              <option value={25}>25 / sayfa</option>
              <option value={50}>50 / sayfa</option>
              <option value={100}>100 / sayfa</option>
              <option value={0}>Tümü</option>
            </select>
          </div>
        </div>}
        <footer className="yf-status"><span>{view.entries.length} öğe · {view.entries.filter((item) => item.type === 'directory').length} klasör · {view.entries.filter((item) => item.type === 'file').length} dosya</span><span className="yf-badge"><Icon name="shield" size={14} /> Site kullanıcısı izolasyonu · Root kilitli</span></footer>
      </div></div>{dragging && <div className="yf-drop"><Icon name="upload" size={36} /><strong>Bu klasöre yüklemek için bırakın</strong><span>Yüklemeden önce dosyaları onaylayacaksınız.</span></div>}
    </section>
    {treeOpen && <Modal title="Site klasörleri" onClose={() => setTreeOpen(false)}>{tree}</Modal>}
    {dialog && ['file', 'folder', 'rename'].includes(dialog.kind) && <Modal title={dialog.kind === 'rename' ? 'Yeniden adlandır' : dialog.kind === 'folder' ? 'Yeni klasör' : 'Yeni dosya'} busy={busy} onClose={() => setDialog(null)}><ErrorNotice error={error} />{checkItemConflict(view.entries, dialog.name) && <div className="yf-conflict-warning"><Icon name="clock" size={15} /><span>Dikkat: Bu klasörde aynı adda bir öğe zaten mevcut. İşlem üzerine yazacaktır.</span></div>}<form onSubmit={createOrRename} className="ws-form"><label>Ad<input autoFocus autoComplete="off" spellCheck={false} value={dialog.name} maxLength={255} onChange={(event) => setDialog({ ...dialog, name: event.target.value })} required /></label><p className="ws-muted">Konum: Site kökü / {dialog.parent ?? fileParent(dialog.entry.path)}</p><footer className="ws-modal-footer"><Button disabled={busy} onClick={() => setDialog(null)}>Vazgeç</Button><Button type="submit" variant="primary" disabled={busy || !validFileName(dialog.name)}>{busy ? 'Kaydediliyor…' : dialog.kind === 'rename' ? 'Adı değiştir' : 'Oluştur'}</Button></footer></form></Modal>}
    {dialog?.kind === 'copy' && <Modal title="Kopyala" busy={busy} onClose={() => setDialog(null)}><ErrorNotice error={error} /><form onSubmit={copyItems} className="ws-form"><p className="ws-muted">Kopyalanacak {dialog.paths.length} öğe: {dialog.paths.join(', ')}</p><label>Hedef Klasör (Site köküne göre bağıl yol)<input autoFocus value={dialog.destination} onChange={(event) => setDialog({ ...dialog, destination: event.target.value })} placeholder="Klasör yolu (boşluk site köküdür)" /></label><footer className="ws-modal-footer"><Button disabled={busy} onClick={() => setDialog(null)}>Vazgeç</Button><Button type="submit" variant="primary" disabled={busy}>Kopyala</Button></footer></form></Modal>}
    {dialog?.kind === 'move' && <Modal title="Taşı" busy={busy} onClose={() => setDialog(null)}><ErrorNotice error={error} /><form onSubmit={moveItems} className="ws-form"><p className="ws-muted">Taşınacak {dialog.paths.length} öğe: {dialog.paths.join(', ')}</p><label>Hedef Klasör (Site köküne göre bağıl yol)<input autoFocus value={dialog.destination} onChange={(event) => setDialog({ ...dialog, destination: event.target.value })} placeholder="Klasör yolu (boşluk site köküdür)" /></label><footer className="ws-modal-footer"><Button disabled={busy} onClick={() => setDialog(null)}>Vazgeç</Button><Button type="submit" variant="primary" disabled={busy}>Taşı</Button></footer></form></Modal>}
    {dialog?.kind === 'archive' && <Modal title="Arşivle (ZIP)" busy={busy} onClose={() => setDialog(null)}><ErrorNotice error={error} />{checkItemConflict(view.entries, dialog.name) && <div className="yf-conflict-warning"><Icon name="clock" size={15} /><span>Dikkat: Bu adda bir arşiv zaten var.</span></div>}<form onSubmit={archiveItems} className="ws-form"><p className="ws-muted">Arşivlenecek {dialog.paths.length} öğe: {dialog.paths.join(', ')}</p><label>Arşiv Adı<input autoFocus value={dialog.name} maxLength={255} onChange={(event) => setDialog({ ...dialog, name: event.target.value })} required /></label><p className="ws-muted">Konum: Site kökü / {view.path}</p><footer className="ws-modal-footer"><Button disabled={busy} onClick={() => setDialog(null)}>Vazgeç</Button><Button type="submit" variant="primary" disabled={busy || !validFileName(dialog.name)}>Arşivle</Button></footer></form></Modal>}
    {dialog?.kind === 'extract' && <Modal title="Arşivi Çıkart" busy={busy} onClose={() => setDialog(null)}><ErrorNotice error={error} /><form onSubmit={extractArchive} className="ws-form"><p className="ws-muted">Çıkartılacak arşiv: {dialog.entry.path}</p><div className="yf-conflict-warning"><Icon name="clock" size={15} /><span>Hedef klasördeki aynı adlı dosyaların üzerine yazılabilir.</span></div><label>Hedef Klasör (Site köküne göre bağıl yol)<input autoFocus value={dialog.destination} onChange={(event) => setDialog({ ...dialog, destination: event.target.value })} placeholder="Klasör yolu (boşluk site köküdür)" /></label><footer className="ws-modal-footer"><Button disabled={busy} onClick={() => setDialog(null)}>Vazgeç</Button><Button type="submit" variant="primary" disabled={busy}>Arşivi Çıkart</Button></footer></form></Modal>}
    {dialog?.kind === 'permissions' && <Modal title={`İzinler: ${dialog.entry.name}`} busy={busy} onClose={() => setDialog(null)}><ErrorNotice error={error} /><form onSubmit={savePermissions} className="ws-form"><p className="ws-muted">Konum: /{dialog.entry.path} ({dialog.entry.type === 'directory' ? 'Klasör' : 'Dosya'})</p><table className="yf-permissions-grid" role="table" aria-label="Dosya izinleri"><thead><tr role="row"><th scope="col">Kullanıcı</th><th scope="col">Okuma (r)</th><th scope="col">Yazma (w)</th><th scope="col">Çalıştırma (x)</th></tr></thead><tbody><tr><td>Sahip</td><td><input type="checkbox" checked={dialog.permissions?.user?.read ?? true} onChange={(e) => { const next = { ...dialog.permissions, user: { ...dialog.permissions.user, read: e.target.checked } }; setDialog({ ...dialog, permissions: next, octal: formatPermissions(next) }); }} /></td><td><input type="checkbox" checked={dialog.permissions?.user?.write ?? true} onChange={(e) => { const next = { ...dialog.permissions, user: { ...dialog.permissions.user, write: e.target.checked } }; setDialog({ ...dialog, permissions: next, octal: formatPermissions(next) }); }} /></td><td><input type="checkbox" checked={dialog.permissions?.user?.execute ?? (dialog.entry.type === 'directory')} onChange={(e) => { const next = { ...dialog.permissions, user: { ...dialog.permissions.user, execute: e.target.checked } }; setDialog({ ...dialog, permissions: next, octal: formatPermissions(next) }); }} /></td></tr><tr><td>Grup</td><td><input type="checkbox" checked={dialog.permissions?.group?.read ?? true} onChange={(e) => { const next = { ...dialog.permissions, group: { ...dialog.permissions.group, read: e.target.checked } }; setDialog({ ...dialog, permissions: next, octal: formatPermissions(next) }); }} /></td><td><input type="checkbox" checked={dialog.permissions?.group?.write ?? false} onChange={(e) => { const next = { ...dialog.permissions, group: { ...dialog.permissions.group, write: e.target.checked } }; setDialog({ ...dialog, permissions: next, octal: formatPermissions(next) }); }} /></td><td><input type="checkbox" checked={dialog.permissions?.group?.execute ?? (dialog.entry.type === 'directory')} onChange={(e) => { const next = { ...dialog.permissions, group: { ...dialog.permissions.group, execute: e.target.checked } }; setDialog({ ...dialog, permissions: next, octal: formatPermissions(next) }); }} /></td></tr><tr><td>Diğer</td><td><input type="checkbox" checked={dialog.permissions?.others?.read ?? false} onChange={(e) => { const next = { ...dialog.permissions, others: { ...dialog.permissions.others, read: e.target.checked } }; setDialog({ ...dialog, permissions: next, octal: formatPermissions(next) }); }} /></td><td><input type="checkbox" checked={false} disabled title="Başkalarına yazma izni (world-writable) güvenlik gerekçesiyle yasaktır" /></td><td><input type="checkbox" checked={dialog.permissions?.others?.execute ?? false} onChange={(e) => { const next = { ...dialog.permissions, others: { ...dialog.permissions.others, execute: e.target.checked } }; setDialog({ ...dialog, permissions: next, octal: formatPermissions(next) }); }} /></td></tr></tbody></table><div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}><label>Sekizli (Octal): <code className="yf-permissions-octal">{dialog.octal ?? '0640'}</code></label></div><p className="ws-muted"><Icon name="shield" size={13} /> İzinler ayrılmış site Unix kullanıcısı yetkileriyle sınırlandırılmıştır; sunucu root yetkileri açılamaz.</p><footer className="ws-modal-footer"><Button disabled={busy} onClick={() => setDialog(null)}>Vazgeç</Button><Button type="submit" variant="primary" disabled={busy}>İzinleri Kaydet</Button></footer></form></Modal>}
    {dialog?.kind === 'details' && <Modal title={dialog.entry.name} onClose={() => setDialog(null)}><dl className="yf-properties"><dt>Konum</dt><dd>/{dialog.entry.path}</dd><dt>Tür</dt><dd>{fileKind(dialog.entry)}</dd><dt>Boyut</dt><dd>{formatBytes(dialog.entry.size)}</dd><dt>Değişiklik</dt><dd>{formatDate(dialog.entry.mtime)}</dd><dt>İzinler</dt><dd><code>{dialog.entry.mode ?? (dialog.entry.type === 'directory' ? '0750' : '0640')}</code></dd></dl><footer className="ws-modal-footer">{dialog.entry.type === 'file' && <a className="ws-button" href={`/api/panel/websites/${encodeURIComponent(websiteId)}/files/download?path=${encodeURIComponent(dialog.entry.path)}`} download={dialog.entry.name}><Icon name="download" />İndir</a>}{dialog.entry.type === 'file' && <Button disabled={!mutable} onClick={() => { setDialog(null); void openFile(dialog.entry); }}>Düzenle</Button>}{isArchiveFile(dialog.entry) && <Button disabled={!mutable} onClick={() => openDialog({ kind: 'extract', entry: dialog.entry, destination: view.path })}>Arşivi Çıkart</Button>}<Button disabled={!mutable} onClick={() => openDialog({ kind: 'copy', paths: [dialog.entry.path], destination: view.path })}>Kopyala</Button><Button disabled={!mutable} onClick={() => openDialog({ kind: 'move', paths: [dialog.entry.path], destination: view.path })}>Taşı</Button><Button disabled={!mutable} onClick={() => openDialog({ kind: 'permissions', entry: dialog.entry, permissions: parsePermissions(dialog.entry.mode), octal: dialog.entry.mode ?? (dialog.entry.type === 'directory' ? '0750' : '0640') })}>İzinler</Button><Button disabled={!mutable} onClick={() => openDialog({ kind: 'rename', entry: dialog.entry, name: dialog.entry.name })}>Yeniden adlandır</Button><Button variant="danger" disabled={!mutable} onClick={() => openDialog({ kind: 'delete', paths: [dialog.entry.path] })}>Sil…</Button></footer></Modal>}
    {dialog?.kind === 'delete' && <ConfirmDialog title={`${dialog.paths.length} öğe silinsin mi?`} message={`Kalıcı olarak silinecek: ${dialog.paths.join(', ')}. Klasörlerin içeriği de etkilenebilir. Bu işlem geri alınamaz.`} confirmation={dialog.paths.length === 1 ? dialog.paths[0] : 'SİL'} confirmLabel="Kalıcı olarak sil" busy={busy} error={error} onCancel={() => setDialog(null)} onConfirm={remove} />}
    {upload && <Modal title="Dosya yükle" busy={busy} onClose={() => setUpload(null)}><p className="ws-muted">Hedef: Site kökü / {upload.parent}. Aynı adlı dosyalar değiştirilebilir.</p><ul className="yf-upload-list">{upload.items.map((item, i) => <li key={i}><Icon name={item.state === 'uploaded' ? 'check' : 'file'} /><span>{item.file.name}<small>{formatBytes(item.file.size)}</small></span><strong>{item.state === 'uploaded' ? 'Yüklendi' : 'Bekliyor'}</strong></li>)}</ul><ErrorNotice error={error} /><p role="status" className="ws-muted">{upload.items.filter((item) => item.state === 'uploaded').length} / {upload.items.length} tamamlandı</p><footer className="ws-modal-footer"><Button disabled={busy} onClick={() => { setUpload(null); void load(view.path); }}>Kapat</Button><Button variant="primary" disabled={busy} onClick={startUpload}>{busy ? 'Yükleniyor…' : 'Yüklemeyi başlat'}</Button></footer></Modal>}
    {editor && <Modal title={editor.name} wide busy={busy} onClose={closeEditor}><div className="yf-editor-meta"><code>/{editor.path}</code><span>{editor.content === editor.saved ? 'Kaydedildi' : 'Kaydedilmemiş değişiklikler'}</span></div><ErrorNotice error={error} /><form onSubmit={saveEditor} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveEditor(); } }}><div className="yf-editor"><pre ref={lineNumbers} aria-hidden="true">{editor.content.split('\n').map((_, i) => i + 1).join('\n')}</pre><textarea aria-label={`${editor.name} içeriği`} value={editor.content} readOnly={busy} spellCheck={false} autoCapitalize="none" wrap="off" onScroll={(event) => { if (lineNumbers.current) lineNumbers.current.scrollTop = event.target.scrollTop; }} onChange={(event) => setEditor({ ...editor, content: event.target.value })} /></div><footer className="ws-modal-footer"><span className="yf-editor-hint">Ctrl / ⌘ S · Sunucudaki sürüm değişirse üzerine yazılmaz.</span><Button disabled={busy} onClick={closeEditor}>Kapat</Button><Button variant="primary" type="submit" disabled={busy || editor.content === editor.saved}>{busy ? 'Kaydediliyor…' : 'Kaydet'}</Button></footer></form></Modal>}
    {discard && <ConfirmDialog title="Değişiklikler bırakılsın mı?" message="Dosyada kaydedilmemiş değişiklikler var." confirmLabel="Değişiklikleri bırak" onCancel={() => setDiscard(false)} onConfirm={() => { setDiscard(false); setEditor(null); setError(null); autoOpenedRef.current = false; setSearchParams((prev) => { const next = new URLSearchParams(prev); next.delete('file'); return next; }, { replace: true }); }} />}
  </>;
}
