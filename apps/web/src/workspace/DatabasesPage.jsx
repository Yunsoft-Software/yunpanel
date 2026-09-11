import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createDatabase,
  deleteDatabase,
  getDatabases,
  inspectDatabases,
  waitForJob,
} from '../api.js';
import {
  Button,
  CollectionNotice,
  ConfirmDialog,
  EmptyState,
  ErrorNotice,
  KeyValues,
  PageHeading,
  Section,
} from './PanelKit.jsx';
import { useWorkspace } from './WorkspaceContext.jsx';
import { databaseInventoryView, formatDatabaseBytes, validDatabaseName } from './database-model.js';
import { formatDate } from './site-model.js';

async function queueAndWait(queue, { observe, refreshJobs, updateJob }) {
  const queued = await queue();
  observe(queued);
  refreshJobs();
  const terminal = await waitForJob(queued.id);
  updateJob(terminal);
  return terminal;
}

export default function DatabasesPage() {
  const { servers, jobs, observe, updateJob } = useWorkspace();
  const requestGeneration = useRef(0);
  const pending = useRef(false);
  const [status, setStatus] = useState('idle');
  const [inventory, setInventory] = useState(() => databaseInventoryView(null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [name, setName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);

  const server = servers.items.length === 1 ? servers.items[0] : null;

  const load = useCallback(async () => {
    if (!server) {
      setInventory(databaseInventoryView(null));
      setStatus('idle');
      return;
    }
    const generation = ++requestGeneration.current;
    setStatus((current) => current === 'ready' ? 'refreshing' : 'loading');
    setError(null);
    try {
      const data = await getDatabases(server.id);
      if (generation !== requestGeneration.current) return;
      setInventory(databaseInventoryView(data));
      setStatus('ready');
    } catch (failure) {
      if (generation !== requestGeneration.current || failure.name === 'AbortError') return;
      setError(failure.message);
      setStatus('error');
    }
  }, [server?.id]);

  useEffect(() => {
    setName('');
    setDeleteTarget(null);
    void load();
    return () => { requestGeneration.current += 1; };
  }, [load]);

  async function perform(queue) {
    if (!server || pending.current) return null;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const terminal = await queueAndWait(queue, { observe, refreshJobs: jobs.refresh, updateJob });
      await load();
      return terminal;
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
      return null;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function inspect() {
    await perform(() => inspectDatabases(server.id));
  }

  async function create(event) {
    event.preventDefault();
    if (!validDatabaseName(name)) {
      setError('Veritabanı adı 1-64 karakter olmalı ve yalnız harf, rakam veya alt çizgi içermelidir. Sistem veritabanı adları kullanılamaz.');
      return;
    }
    const createdName = name;
    const terminal = await perform(() => createDatabase(server.id, createdName));
    if (terminal) setName('');
  }

  async function remove() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    const terminal = await perform(() => deleteDatabase(server.id, target.name));
    if (terminal) setDeleteTarget(null);
  }

  const serverLabel = server?.displayName ?? server?.name ?? server?.hostname ?? 'Sunucu';
  const engineLabel = inventory.engine === 'mariadb' ? 'MariaDB' : inventory.engine === 'mysql' ? 'MySQL' : '—';

  return <>
    <PageHeading
      title="Veritabanları"
      description="MySQL/MariaDB veritabanlarını sunucu üzerinde Unix socket üzerinden yönetin. Kullanıcı/grant ve yedek/restore akışları sonraki aşamadadır."
      actions={<Button icon="refresh" disabled={!server || busy} onClick={load}>Kaydı yenile</Button>}
    />
    <CollectionNotice resource={servers} label="Yerel sunucu" />
    {!server && ['ready', 'stale'].includes(servers.status) && <Section title="Veritabanları"><EmptyState title="Yerel sunucu kullanılamıyor" detail="Panel yalnız çalıştığı sunucuyu yönetir; yerel sunucu kaydı doğrulanamadı." icon="database" /></Section>}

    {server && <>
      <Section
        title={`${serverLabel} · Veritabanı envanteri`}
        description={inventory.snapshot?.refreshedAt ? `Son doğrulama: ${formatDate(inventory.snapshot.refreshedAt)}` : 'Sunucudan henüz doğrulanmış veritabanı envanteri alınmadı.'}
        actions={<Button variant="primary" icon="refresh" disabled={busy} onClick={inspect}>{busy ? 'İşlem sürüyor…' : 'Sunucuyu tara'}</Button>}
      >
        <ErrorNotice error={error} />
        {status === 'loading' && <div className="ws-loading" role="status"><span className="ws-spinner" />Veritabanları yükleniyor…</div>}
        {status !== 'loading' && inventory.databases === null && <EmptyState title="Henüz veritabanı taraması yok" detail="MySQL/MariaDB engine, sürüm, veritabanı listesi ve boyutlarını görmek için sunucuyu tarayın." icon="database" action={<Button variant="primary" disabled={busy} onClick={inspect}>Veritabanlarını tara</Button>} />}
        {Array.isArray(inventory.databases) && <>
          <KeyValues items={[
            ['Engine', engineLabel],
            ['Sürüm', inventory.version ?? '—'],
            ['Toplam boyut', formatDatabaseBytes(inventory.totalBytes)],
            ['Veritabanı', inventory.databases.length],
          ]} />
          {inventory.databases.length === 0 ? <EmptyState title="Kullanıcı veritabanı yok" detail="Sistem şemaları güvenlik için listede gösterilmez. Yeni bir uygulama veritabanı oluşturabilirsiniz." icon="database" /> : <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Veritabanı</th><th>Boyut</th><th className="ws-row-end">İşlem</th></tr></thead><tbody>{inventory.databases.map((database) => <tr key={database.name}><td><strong>{database.name}</strong></td><td>{database.sizeLabel}</td><td className="ws-row-end"><Button variant="danger" disabled={busy} onClick={() => setDeleteTarget(database)}>Sil</Button></td></tr>)}</tbody></table></div>}
        </>}
      </Section>

      <Section title="Yeni veritabanı" description="Şimdilik yalnız veritabanı oluşturulur; uygulama kullanıcısı ve minimum grant akışı sonraki aşamada eklenecek.">
        <form className="ws-form" onSubmit={create}><label>Veritabanı adı<input value={name} onChange={(event) => setName(event.target.value)} placeholder="ornek_uygulama" maxLength={64} autoComplete="off" spellCheck={false} /></label><div className="ws-actions"><Button variant="primary" type="submit" disabled={busy || !validDatabaseName(name)}>{busy ? 'İşlem sürüyor…' : 'Veritabanı oluştur'}</Button></div></form>
      </Section>
    </>}

    {deleteTarget && <ConfirmDialog
      title={`${deleteTarget.name} silinsin mi?`}
      message="Bu işlem veritabanını DROP DATABASE ile siler. Kullanıcı/grant veya yedek otomasyonu henüz bağlı olmadığı için yalnız gerçekten silmek istediğiniz test/boş veritabanlarında kullanın."
      confirmation={deleteTarget.name}
      confirmLabel="Veritabanını sil"
      busy={busy}
      error={error}
      onCancel={() => { if (!busy) setDeleteTarget(null); }}
      onConfirm={remove}
    />}
  </>;
}
