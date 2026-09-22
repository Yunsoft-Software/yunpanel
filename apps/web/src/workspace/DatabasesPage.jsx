import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { createDatabase, createPhpMyAdminHandoff, deleteDatabase, getDatabases, waitForJob } from '../api.js';
import { Badge, Button, CollectionNotice, ConfirmDialog, EmptyState, ErrorNotice, Icon, KeyValues, LinkButton, Modal, PageHeading, Section } from './PanelKit.jsx';
import { useWorkspace } from './WorkspaceContext.jsx';
import { databaseInventoryView, formatDatabaseBytes, validDatabaseName } from './database-model.js';
import { openWebsitePhpMyAdmin } from './phpmyadmin-client.js';
import { databaseAccessView, filterConsoleDatabases, paginateConsoleItems } from './ui/console-model.js';

const SECURITY_REASON_LABELS = Object.freeze({
  database_security_inspection_unavailable: 'Güvenlik durumu okunamadı',
  database_native_socket_admin_auth_required: 'Yerel yönetici bağlantısı yapılandırılmalı',
  database_anonymous_accounts_present: 'Anonim hesap mevcut',
  database_remote_root_accounts_present: 'Uzak root hesabı mevcut',
  database_test_schema_present: 'Test veritabanı mevcut',
});

async function queueAndWait(queue, { observe, refreshJobs, updateJob }) {
  const queued = await queue();
  observe(queued);
  refreshJobs();
  const terminal = await waitForJob(queued.id);
  updateJob(terminal);
  return terminal;
}

export default function DatabasesPage() {
  const { servers, domains, jobs, observe, updateJob } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const requestGeneration = useRef(0);
  const scopeGeneration = useRef(0);
  const pending = useRef(false);
  const [status, setStatus] = useState('idle');
  const [inventory, setInventory] = useState(() => databaseInventoryView(null));
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [error, setError] = useState(null);
  const [name, setName] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [createdName, setCreatedName] = useState('');
  const [accessTarget, setAccessTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const server = servers.items.length === 1 ? servers.items[0] : null;
  const canAct = Boolean(server && servers.status === 'ready' && status === 'ready' && !busy);
  const query = params.get('q') ?? '';
  const access = ['ready', 'attention'].includes(params.get('access')) ? params.get('access') : 'all';

  const load = useCallback(async () => {
    const generation = ++requestGeneration.current;
    if (!server) {
      setInventory(databaseInventoryView(null)); setStatus('idle'); return;
    }
    setStatus((current) => ['ready', 'refreshing', 'stale'].includes(current) ? 'refreshing' : 'loading');
    setLoadError(null);
    try {
      const data = await getDatabases(server.id);
      if (generation !== requestGeneration.current) return;
      setInventory(databaseInventoryView(data)); setStatus('ready');
    } catch (failure) {
      if (generation !== requestGeneration.current || failure.name === 'AbortError') return;
      setLoadError(failure.message); setStatus('stale');
    }
  }, [server?.id]);

  useEffect(() => {
    scopeGeneration.current += 1;
    setName(''); setError(null); setCreatedName(''); setCreateOpen(false);
    setDeleteTarget(null); setAccessTarget(null); setBusy(false); pending.current = false;
    setInventory(databaseInventoryView(null));
    void load();
    return () => { requestGeneration.current += 1; scopeGeneration.current += 1; };
  }, [load]);

  function filter(key, value) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value && value !== 'all') next.set(key, value); else next.delete(key);
      if (key !== 'page') next.delete('page');
      return next;
    }, { replace: key === 'q' });
  }
  function clearFilters() {
    setParams((current) => {
      const next = new URLSearchParams(current);
      ['q', 'access', 'page'].forEach((key) => next.delete(key));
      return next;
    });
  }
  async function perform(queue) {
    if (!canAct || pending.current) return null;
    const scope = scopeGeneration.current;
    pending.current = true; setBusy(true); setError(null);
    try {
      const terminal = await queueAndWait(queue, { observe, refreshJobs: jobs.refresh, updateJob });
      if (scope !== scopeGeneration.current) return null;
      if (terminal?.status !== 'succeeded') {
        setError(terminal?.status === 'cancelled' ? 'İşlem iptal edildi. Formunuz korunuyor.' : 'İşlem başarısız oldu. İşlem merkezinden ayrıntıları inceleyin.');
        return null;
      }
      await load();
      return scope === scopeGeneration.current ? terminal : null;
    } catch (failure) {
      if (scope === scopeGeneration.current && failure.name !== 'AbortError') setError(failure.message);
      return null;
    } finally {
      if (scope === scopeGeneration.current) { pending.current = false; setBusy(false); }
    }
  }
  async function create(event) {
    event.preventDefault();
    if (!validDatabaseName(name)) { setError('1–64 karakter kullanın: harf, rakam veya alt çizgi. Sistem adları kullanılamaz.'); return; }
    const requestedName = name;
    const terminal = await perform(() => createDatabase(server.id, requestedName));
    if (terminal) { setName(''); setCreateOpen(false); setCreatedName(requestedName); }
  }
  async function remove() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    const terminal = await perform(() => deleteDatabase(server.id, target.name));
    if (terminal) setDeleteTarget(null);
  }
  async function openPhpMyAdmin(ownership) {
    if (!canAct || !ownership?.websiteId || !ownership?.credential?.id || pending.current) return;
    const scope = scopeGeneration.current;
    pending.current = true; setBusy(true); setError(null);
    try {
      await openWebsitePhpMyAdmin({
        serverId: server.id, websiteId: ownership.websiteId,
        credentialId: ownership.credential.id, issueHandoff: createPhpMyAdminHandoff,
      });
    } catch (failure) {
      if (scope === scopeGeneration.current && failure.name !== 'AbortError') setError(failure.message);
    } finally {
      if (scope === scopeGeneration.current) { pending.current = false; setBusy(false); }
    }
  }

  const hasInventory = Array.isArray(inventory.databases);
  const page = paginateConsoleItems(filterConsoleDatabases(inventory.databases, { query, access, domains }), params.get('page'));
  const engineLabel = inventory.engine === 'mariadb' ? 'MariaDB' : inventory.engine === 'mysql' ? 'MySQL' : '—';
  const securityLabel = inventory.health?.ready ? 'Hazır' : inventory.health?.available === false ? 'Doğrulanamadı' : inventory.health ? 'Aksiyon gerekli' : '—';
  const adminAuthLabel = inventory.health?.connection ? `${inventory.health.connection.adminAccount} · ${inventory.health.connection.authPlugin || '—'}` : '—';
  const securityReasonLabel = inventory.health?.reason ? SECURITY_REASON_LABELS[inventory.health.reason] ?? 'Bilinmeyen güvenlik durumu' : '—';
  const startCreate = () => { setError(null); setCreateOpen(true); };

  return <>
    <PageHeading title="Veritabanları" description="Veritabanlarınıza ve phpMyAdmin’e tek yerden erişin."
      actions={<><Button icon="refresh" disabled={!server || busy || ['loading', 'refreshing'].includes(status)} onClick={load}>Yenile</Button><Button variant="primary" icon="plus" disabled={!canAct} onClick={startCreate}>Veritabanı oluştur</Button></>} />
    <CollectionNotice resource={servers} label="Yerel sunucu" />
    {server && <CollectionNotice resource={domains} label="Site bağlantıları" />}
    <ErrorNotice error={loadError} />
    {!createOpen && !deleteTarget && <ErrorNotice error={error} />}
    {createdName && <div className="ws-notice" role="status"><div><strong>{createdName} oluşturuldu.</strong><p>Erişim için sitenin Kaynaklar bölümünden veritabanını bağlayıp kullanıcı oluşturun.</p></div><LinkButton to="/websites">Site seç</LinkButton><Button icon="close" aria-label="Bildirimi kapat" onClick={() => setCreatedName('')} /></div>}
    {!server && ['ready', 'stale'].includes(servers.status) && <Section title="Veritabanları"><EmptyState title="Yerel sunucu kullanılamıyor" detail="Yerel sunucu bağlantısı doğrulanamadı." icon="database" /></Section>}
    {server && <>
      <Section title="Veritabanı listesi" className="ws-database-inventory" actions={<span className="ws-muted" role="status">{status === 'refreshing' ? 'Güncelleniyor…' : hasInventory ? `${inventory.databases.length} veritabanı` : 'Bağlantı bekleniyor'}</span>}>
        <div className="ws-filters"><label className="ws-filter-search">Veritabanı ara<input type="search" value={query} onChange={(event) => filter('q', event.target.value)} placeholder="Veritabanı, site veya kullanıcı" /></label><label>Erişim<select aria-label="Erişim" value={access} onChange={(event) => filter('access', event.target.value)}><option value="all">Tüm veritabanları</option><option value="ready">Kullanıcı tanımlı</option><option value="attention">Yapılandırma gerekli</option></select></label></div>
        {status === 'loading' && <div className="ws-loading" role="status"><span className="ws-spinner" />Veritabanları yükleniyor…</div>}
        {status === 'stale' && <div className="ws-notice ws-notice-warn"><div>Güncel liste alınamadı. Son alınan kayıtlar varsa gösteriliyor; değişiklikler ve phpMyAdmin erişimi kapalı.</div><Button onClick={load}>Yeniden dene</Button></div>}
        {status !== 'loading' && !hasInventory && <EmptyState title="Canlı veritabanı envanteri kullanılamıyor" detail="Servis ve yerel bağlantı hazır olduğunda liste burada görünür." icon="database" />}
        {hasInventory && status !== 'loading' && (page.count ? <>
          <div className="ws-table-scroll"><table className="ws-table ws-db-table" role="table" aria-label="Veritabanları"><thead><tr><th scope="col">Veritabanı</th><th scope="col">Site / Kullanıcı</th><th scope="col">Boyut</th><th scope="col">Erişim</th><th scope="col" className="ws-row-end">İşlem</th></tr></thead><tbody>{page.items.map((database) => {
            const view = databaseAccessView(database, domains);
            return <tr key={database.name} role="row"><td role="cell"><div className="ws-db-name"><Icon name="database" size={20} /><div><strong>{database.name}</strong><small>{engineLabel}</small></div></div></td>
              <td role="cell" data-label="Site / Kullanıcı"><strong>{view.siteLabel}</strong><small>{database.ownership?.credential?.username ?? 'Kullanıcı tanımlanmamış'}</small></td>
              <td role="cell" data-label="Boyut">{database.sizeLabel}</td>
              <td role="cell"><div className="ws-db-access">{view.canOpen ? <Button icon="external" disabled={!canAct} onClick={() => openPhpMyAdmin(database.ownership)} aria-label={`${database.name}: phpMyAdmin aç`}>phpMyAdmin</Button> : view.siteHref ? <LinkButton to={view.siteHref} icon="settings">Erişimi yapılandır</LinkButton> : <Button icon="settings" onClick={() => setAccessTarget(database)}>Siteye bağla</Button>}{!view.canOpen && <small>{view.detail}</small>}</div></td>
              <td role="cell" className="ws-row-end"><Button icon="trash" disabled={!canAct} aria-label={`${database.name} veritabanını sil`} title="Veritabanını sil" onClick={() => { setError(null); setDeleteTarget(database); }}><span className="ws-sr-only">Sil</span></Button></td></tr>;
          })}</tbody></table></div>
          <footer className="ws-pagination"><span>{page.count} sonuç · {engineLabel} · {formatDatabaseBytes(inventory.totalBytes)}</span><div className="ws-actions"><Button disabled={page.page <= 1} onClick={() => filter('page', String(page.page - 1))}>Önceki</Button><span>{page.page} / {page.pages}</span><Button disabled={page.page >= page.pages} onClick={() => filter('page', String(page.page + 1))}>Sonraki</Button></div></footer>
        </> : <EmptyState title={inventory.databases.length ? 'Eşleşen veritabanı yok' : 'Kullanıcı veritabanı yok'} detail={inventory.databases.length ? 'Aramayı veya erişim filtresini değiştirin.' : 'Yeni bir uygulama veritabanı oluşturarak başlayın.'} icon="database" action={inventory.databases.length ? <Button onClick={clearFilters}>Filtreleri temizle</Button> : <Button variant="primary" disabled={!canAct} onClick={startCreate}>Veritabanı oluştur</Button>} />)}
      </Section>
      <details className="ws-section ws-disclosure ws-database-diagnostics"><summary>Sunucu ve güvenlik ayrıntıları <Badge state={inventory.health?.ready ? 'active' : inventory.health ? 'warning' : 'unknown'}>{securityLabel}</Badge></summary>
        <p className="ws-muted ws-section-body">Yerel sunucunun canlı Unix socket envanteri. Teknik alanlar günlük veritabanı listesinden ayrıdır.</p>
        <KeyValues items={[
          ['Engine', engineLabel], ['Sürüm', inventory.version ?? '—'],
          ['Toplam boyut', hasInventory ? formatDatabaseBytes(inventory.totalBytes) : '—'], ['Veritabanı', hasInventory ? inventory.databases.length : '—'],
          ['DB güvenlik baseline', securityLabel], ['Admin socket auth', adminAuthLabel], ['Güvenlik tanısı', securityReasonLabel],
          ...(inventory.ownership ? [['Website bağı', inventory.ownership.bindingCount], ['Credential', inventory.ownership.credentialCount], ['Eksik schema bağı', inventory.ownership.missingDatabaseBindingCount]] : []),
        ]} />
      </details>
    </>}
    {createOpen && <Modal title="Veritabanı oluştur" busy={busy} onClose={() => { if (!busy) setCreateOpen(false); }}><ErrorNotice error={error} /><form className="ws-form" onSubmit={create}><label>Veritabanı adı<input value={name} onChange={(event) => setName(event.target.value)} placeholder="ornek_uygulama" maxLength={64} autoComplete="off" autoCapitalize="none" spellCheck={false} required autoFocus /><span className="ws-field-hint">Harf, rakam ve alt çizgi kullanın.</span></label><p className="ws-muted">Site bağlantısı ve veritabanı kullanıcısı, sitenin Kaynaklar bölümünden yönetilir.</p><footer className="ws-modal-footer"><Button disabled={busy} onClick={() => setCreateOpen(false)}>Vazgeç</Button><Button variant="primary" type="submit" disabled={!canAct || !validDatabaseName(name)}>{busy ? 'Oluşturuluyor…' : 'Veritabanı oluştur'}</Button></footer></form></Modal>}
    {accessTarget && <Modal title={`${accessTarget.name} · Erişim kurulumu`} onClose={() => setAccessTarget(null)}><p className="ws-muted">Bu veritabanı için kullanılabilir site bağlantısı bulunamadı. İlgili sitenin Kaynaklar bölümünü açıp veritabanını bağlayın ve kullanıcı oluşturun. phpMyAdmin yalnız o sitenin kullanıcısıyla açılır.</p><footer className="ws-modal-footer"><Button onClick={() => setAccessTarget(null)}>Kapat</Button><LinkButton to="/websites" variant="primary">Site seç</LinkButton></footer></Modal>}
    {deleteTarget && <ConfirmDialog title={`${deleteTarget.name} silinsin mi?`} message="Veritabanı kalıcı olarak silinir. Website bağı varsa backend işlemi engeller. Devam etmeden önce güncel bir yedeğiniz olduğundan emin olun." confirmation={deleteTarget.name} confirmLabel="Veritabanını sil" busy={busy} error={error} onCancel={() => { if (!busy) setDeleteTarget(null); }} onConfirm={remove} />}
  </>;
}
