import { useEffect, useRef, useState } from 'react';
import { panelRequest } from '../api.js';
import { sessionGeneration } from '../session-client.js';
import { Badge, Button, EmptyState, ErrorNotice, Modal, Section } from './PanelKit.jsx';
import { useUnsavedChanges } from './UnsavedChanges.jsx';
import { createHostingAccountClient, hostingAccountMessage } from './hosting-account-client.js';

const LIMIT = 25;
const limitText = (value) => value === null ? 'Sınırsız' : String(value);
const emptyForm = () => ({ kind: 'customer', resellerId: null, maxCustomers: '', maxWebsites: '' });
const accountForm = (account) => account ? { kind: account.kind, resellerId: account.resellerId,
  maxCustomers: account.kind === 'reseller' ? (account.limits.maxCustomers === null ? null : String(account.limits.maxCustomers)) : '',
  maxWebsites: account.kind === 'reseller' ? (account.limits.maxWebsites === null ? null : String(account.limits.maxWebsites)) : '',
} : emptyForm();

function useHostingClient(onAccessLost) {
  const ref = useRef(null); const lost = useRef(onAccessLost); lost.current = onAccessLost;
  useEffect(() => {
    const client = createHostingAccountClient({ request: panelRequest, generation: sessionGeneration,
      onAccessLost: () => lost.current(),
    });
    ref.current = client;
    return () => { client.dispose(); if (ref.current === client) ref.current = null; };
  }, []);
  return ref;
}

export function HostingAccountsPanel({ refreshKey, locked, onOpen, onAccessLost }) {
  const client = useHostingClient(onAccessLost);
  const [kind, setKind] = useState('reseller'); const [offset, setOffset] = useState(0);
  const [retry, setRetry] = useState(0); const [page, setPage] = useState({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setPage({ status: 'loading' });
    client.current.list({ kind, offset, limit: LIMIT }).then((data) => {
      if (cancelled) return;
      if (offset && !data.accounts.length && offset >= data.total) { setOffset(Math.max(0, Math.ceil(data.total / LIMIT) - 1) * LIMIT); return; }
      setPage({ status: 'ready', data, kind, offset });
    }).catch((error) => { if (!cancelled && error.name !== 'AbortError') setPage({ status: 'error', error }); });
    return () => { cancelled = true; };
  }, [kind, offset, refreshKey, retry]);
  const visible = page.status === 'ready' && page.kind === kind && page.offset === offset ? page.data : null;
  function changeKind(next) { setKind(next); setOffset(0); }
  return <Section title="Bayi ve müşteri profilleri" description="Owner için hesap hazırlığı. Profil bağlamak henüz site erişimi veya bayi paneli açmaz." actions={<Button icon="refresh" disabled={locked || page.status === 'loading'} onClick={() => setRetry((value) => value + 1)}>Yenile</Button>}>
    <div className="ws-section-body">
      <div className="ws-actions" role="group" aria-label="Profil türü">
        <Button aria-pressed={kind === 'reseller'} disabled={locked} onClick={() => changeKind('reseller')}>Bayiler</Button>
        <Button aria-pressed={kind === 'customer'} disabled={locked} onClick={() => changeKind('customer')}>Müşteriler</Button>
      </div>
      <p className="ws-muted">Profil eklemek için üstteki kullanıcı listesinde site atanmamış bir Site Yöneticisi hesabının “Bayi / müşteri” işlemini açın. Yeni hesap gerekiyorsa önce “Kullanıcı ekle”yi kullanın.</p>
      <ErrorNotice error={page.status === 'error' ? hostingAccountMessage(page.error) : null} />
      {page.status !== 'error' && !visible && <p role="status">Profiller yükleniyor…</p>}
    </div>
    {visible && (visible.accounts.length ? <div className="ws-table-scroll"><table className="ws-table">
      <caption className="ws-muted">{kind === 'reseller' ? 'Bayi' : 'Müşteri'} profilleri — yalnız kayıtlı hesap ilişkileri</caption>
      <thead><tr><th scope="col">Hesap</th><th scope="col">{kind === 'reseller' ? 'Adet kullanımı / sınır' : 'Bağlı bayi'}</th><th scope="col">Giriş hesabı</th><th scope="col">İşlem</th></tr></thead>
      <tbody>{visible.accounts.map((account) => <tr key={account.id}>
        <th scope="row">{account.username}</th>
        <td>{kind === 'reseller' ? <>Müşteri: {account.usage.customers} / {limitText(account.limits.maxCustomers)}<br />Kayıtlı / ayrılmış site: {account.usage.websites} / {limitText(account.limits.maxWebsites)}</> : account.resellerId === null ? 'Doğrudan Owner' : <Button disabled={locked} aria-label={`${account.username} hesabının bağlı bayisini aç`} onClick={() => onOpen(account.resellerId)}>Bağlı bayiyi aç</Button>}</td>
        <td><Badge state={account.active ? 'active' : 'off'}>{account.active ? 'Etkin' : 'Kapalı'}</Badge></td>
        <td><Button disabled={locked} aria-label={`${account.username} profilini yönet`} onClick={() => onOpen(account.id)}>Profili yönet</Button></td>
      </tr>)}</tbody>
    </table></div> : <EmptyState title="Bu türde profil yok" detail="Üstteki kullanıcı listesinden mevcut uygun hesaba profil bağlayabilirsiniz." icon="user" />)}
    <footer className="ws-pagination"><span>{visible ? `${visible.total} profil` : 'Profil sayısı doğrulanıyor'}</span><div className="ws-actions">
      <Button disabled={locked || !visible || offset === 0} onClick={() => setOffset((value) => Math.max(0, value - LIMIT))}>Önceki</Button>
      <span aria-live="polite">Sayfa {Math.floor(offset / LIMIT) + 1}</span>
      <Button disabled={locked || !visible || offset + LIMIT >= visible.total} onClick={() => setOffset((value) => value + LIMIT)}>Sonraki</Button>
    </div></footer>
  </Section>;
}

function LimitFields({ form, update }) {
  return <fieldset><legend>Adet sınırları</legend><div className="ws-form-grid">
    {[['maxCustomers', 'Toplam müşteri'], ['maxWebsites', 'Toplam site']].map(([key, label]) => <div key={key}>
      <label>{label}<input type="text" inputMode="numeric" pattern="[0-9]+" disabled={form[key] === null} value={form[key] ?? ''} onChange={(event) => update(key, event.target.value)} required={form[key] !== null} /></label>
      <label><input type="checkbox" checked={form[key] === null} onChange={(event) => update(key, event.target.checked ? null : '')} />{label}: Sınırsız</label>
    </div>)}
  </div><p className="ws-field-hint">Boş alan sınırsız değildir. 0 yeni kayıt eklenmesini engeller. Limiti düşürmek mevcut kayıtları silmez.</p></fieldset>;
}

function ResellerPicker({ client, value, onChange, disabled, customerId }) {
  const [offset, setOffset] = useState(0); const [retry, setRetry] = useState(0);
  const [page, setPage] = useState({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setPage({ status: 'loading' });
    client.current.list({ kind: 'reseller', offset, limit: LIMIT }, 'resellers').then((data) => {
      if (!cancelled) setPage({ status: 'ready', data, offset });
    }).catch((error) => { if (!cancelled && error.name !== 'AbortError') setPage({ status: 'error', error }); });
    return () => { cancelled = true; };
  }, [offset, retry]);
  const data = page.status === 'ready' && page.offset === offset ? page.data : null;
  return <fieldset disabled={disabled}><legend>Bağlanacak bayi</legend>
    <p className="ws-muted">{value ? `Seçili bayi kimliği: ${value}` : 'Etkin bir bayi seçin.'}</p>
    <ErrorNotice error={page.status === 'error' ? hostingAccountMessage(page.error) : null} />
    {page.status === 'error' && <Button onClick={() => setRetry((number) => number + 1)}>Bayileri yeniden yükle</Button>}
    {page.status !== 'error' && !data && <p role="status">Bayiler yükleniyor…</p>}
    {data && !data.accounts.length && <p>Bu sayfada bayi yok. Önce uygun hesaba bayi profili ekleyin veya doğrudan Owner'ı seçin.</p>}
    {data?.accounts.map((account) => <label key={account.id}>
      <input type="radio" name="hosting-reseller" checked={value === account.id} disabled={!account.active || account.id === customerId} onChange={() => onChange(account.id)} />
      {account.username}{!account.active ? ' — hesap kapalı' : ''}
    </label>)}
    <div className="ws-actions"><Button disabled={!data || offset === 0} onClick={() => setOffset((number) => Math.max(0, number - LIMIT))}>Önceki bayiler</Button>
      <span>Sayfa {Math.floor(offset / LIMIT) + 1}</span>
      <Button disabled={!data || offset + LIMIT >= data.total} onClick={() => setOffset((number) => number + LIMIT)}>Sonraki bayiler</Button>
    </div>
  </fieldset>;
}

export function HostingProfileDialog({ user = null, accountId, onClose, onSaved, onAccessLost }) {
  const client = useHostingClient(onAccessLost);
  const targetId = user?.id ?? accountId;
  const [loaded, setLoaded] = useState({ status: 'loading' });
  const [form, setForm] = useState(emptyForm); const baseline = useRef(emptyForm());
  const [retry, setRetry] = useState(0); const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false); const pending = useRef(false); const mounted = useRef(true);
  const [removing, setRemoving] = useState(false); const [confirmation, setConfirmation] = useState('');
  const [statusTarget, setStatusTarget] = useState(null);
  const [discard, setDiscard] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    setLoaded({ status: 'loading' });
    client.current.get(targetId).then((account) => {
      if (cancelled) return;
      if (!account && !user) { setLoaded({ status: 'error', error: { code: 'hosting_account_not_found' } }); return; }
      baseline.current = accountForm(account); setForm(baseline.current);
      setLoaded({ status: 'ready', account });
    }).catch((failure) => { if (!cancelled && failure.name !== 'AbortError') setLoaded({ status: 'error', error: failure }); });
    return () => { cancelled = true; };
  }, [targetId, retry]);
  const account = loaded.account;
  const ready = loaded.status === 'ready';
  const dirty = ready && (JSON.stringify(form) !== JSON.stringify(baseline.current)
    || confirmation.length > 0 || statusTarget !== null);
  useUnsavedChanges(dirty || busy);
  const reload = Boolean(error?.reconcile);
  const eligible = Boolean(account || (user?.role === 'site_manager' && Array.isArray(user.websiteIds) && user.websiteIds.length === 0));
  function close() {
    if (pending.current) return;
    if (dirty && !reload && !discard) setDiscard(true); else onClose();
  }
  function update(key, value) { setForm((current) => ({ ...current, [key]: value })); setError(null); }
  async function submit(event) {
    event.preventDefault();
    if (pending.current || !ready || !eligible || reload || (removing && confirmation !== account.username)) return;
    pending.current = true; setBusy(true); setError(null);
    const generation = sessionGeneration();
    try {
      const action = removing ? 'unregister' : account ? 'limits' : 'register';
      await client.current.mutate({ action, user, account, form });
      if (mounted.current && sessionGeneration() === generation) onSaved(removing
        ? 'Profil kaldırıldı. Giriş hesabı ve siteler silinmedi.'
        : account ? 'Adet sınırları kaydedildi. Mevcut kayıtlar korunuyor.' : 'Profil bağlandı. Bu işlem henüz site erişimi veya bayi paneli açmaz.');
    } catch (failure) { if (mounted.current && failure.name !== 'AbortError') setError(failure); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  async function changeStatus() {
    if (pending.current || !ready || !account || reload || typeof statusTarget !== 'boolean'
      || statusTarget === account.active) return;
    pending.current = true; setBusy(true); setError(null);
    const generation = sessionGeneration();
    try {
      const result = await client.current.mutate({
        action: 'status',
        account,
        form: { active: statusTarget },
      });
      if (mounted.current && sessionGeneration() === generation) {
        onSaved(result.account.active
          ? 'Giriş hesabı yeniden etkinleştirildi. Site ve host çalışma durumu değiştirilmedi.'
          : account.kind === 'reseller'
            ? 'Bayi hesabı askıya alındı. Bayi ve bağlı müşteri oturumları kapatıldı; siteler otomatik durdurulmadı.'
            : 'Müşteri hesabı askıya alındı. Oturumları kapatıldı; siteler otomatik durdurulmadı.');
      }
    } catch (failure) { if (mounted.current && failure.name !== 'AbortError') setError(failure); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  const canSubmit = ready && eligible && (removing ? confirmation === account.username
    : account ? account.kind === 'reseller' && dirty : form.kind !== 'customer' || form.resellerId !== '');
  return <Modal title="Bayi / müşteri profili" onClose={close} busy={busy}>
    {discard ? <><p>Kaydedilmemiş değişiklikler bırakılacak. Pencereyi kapatmak istiyor musunuz?</p><footer className="ws-modal-footer">
      <Button onClick={() => setDiscard(false)}>Düzenlemeye dön</Button><Button variant="danger" onClick={onClose}>Değişiklikleri bırak</Button>
    </footer></> : <form className="ws-form" onSubmit={submit}>
      <p><strong>{account?.username ?? user?.username ?? 'Seçili hesap'}</strong></p>
      <p className="ws-muted">Bu ekran Owner için profil ve limit yönetimidir. Yeni giriş hesabı, site yetkisi, paket veya abonelik oluşturmaz.</p>
      {loaded.status === 'loading' && <p role="status">Güncel profil doğrulanıyor…</p>}
      <ErrorNotice error={loaded.status === 'error' ? hostingAccountMessage(loaded.error) : error ? hostingAccountMessage(error) : null} />
      {loaded.status === 'error' && <Button onClick={() => setRetry((value) => value + 1)}>Profili yeniden yükle</Button>}
      {reload && <p role="alert">İşlemi yeniden göndermeyin. Pencereyi kapatıp güncel kullanıcı ve profil kaydını yeniden açın.</p>}
      {ready && !eligible && <p role="alert">Mevcut site yetkileri otomatik sahipliğe çevrilmez. Site atanmamış bir Site Yöneticisi hesabı kullanın.</p>}
      {ready && eligible && <fieldset disabled={busy || reload}>
        {statusTarget !== null ? <>
          <p><strong>{statusTarget ? 'Girişi yeniden etkinleştir' : 'Hesabı askıya al'}</strong></p>
          {statusTarget
            ? <p>Bu işlem yalnız giriş hesabını yeniden açar. Site, servis veya host çalışma durumu değiştirilmez.</p>
            : account.kind === 'reseller'
              ? <p>Bayi ve bu bayiye bağlı müşterilerin mevcut oturumları kapatılır. Müşteri kayıtları ve siteler silinmez veya otomatik durdurulmaz.</p>
              : <p>Bu hesabın mevcut oturumları kapatılır. Profil ve siteler korunur; siteler otomatik durdurulmaz.</p>}
        </> : removing ? <>
          <p>Yalnız profil bağlantısı kaldırılır; giriş hesabı ve siteler silinmez. Bağlı müşteri, site veya kontenjan varsa sunucu kaldırmayı engeller.</p>
          <label>Onaylamak için {account.username} yazın<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} required /></label>
        </> : <>
          {account ? <p>Profil: <strong>{account.kind === 'reseller' ? 'Bayi' : 'Müşteri'}</strong>. Tür ve sahiplik bu sürümde değiştirilemez.</p>
            : <label>Profil türü<select value={form.kind} onChange={(event) => update('kind', event.target.value)}><option value="customer">Müşteri</option><option value="reseller">Bayi</option></select></label>}
          {form.kind === 'reseller' && <LimitFields form={form} update={update} />}
          {account?.kind === 'reseller' && <p className="ws-muted">Müşteri adedi: {account.usage.customers}. Kayıtlı / ayrılmış site adedi: {account.usage.websites}. Bunlar çalışan site veya disk kullanım ölçümü değildir.</p>}
          {form.kind === 'customer' && (account ? <p>Bağlı bayi: {account.resellerId === null ? 'Doğrudan Owner' : account.resellerId}</p> : <>
            <label>Müşteri yönetimi<select value={form.resellerId === null ? 'direct' : 'reseller'} onChange={(event) => update('resellerId', event.target.value === 'direct' ? null : '')}>
              <option value="direct">Doğrudan Owner</option><option value="reseller">Bir bayiye bağla</option>
            </select></label>
            {form.resellerId !== null && <ResellerPicker client={client} value={form.resellerId} onChange={(value) => update('resellerId', value)} disabled={busy || reload} customerId={user.id} />}
          </>)}
          {account && <div className="ws-actions">
            <Button variant={account.active ? 'danger' : 'primary'} onClick={() => { setStatusTarget(!account.active); setError(null); }}>
              {account.active ? 'Hesabı askıya al' : 'Girişi yeniden etkinleştir'}
            </Button>
            <Button variant="danger" onClick={() => { setRemoving(true); setStatusTarget(null); setError(null); }}>Profili kaldır</Button>
          </div>}
        </>}
      </fieldset>}
      <footer className="ws-modal-footer">
        {statusTarget !== null && <Button disabled={busy || reload} onClick={() => { setStatusTarget(null); setError(null); }}>Profile dön</Button>}
        {removing && <Button disabled={busy || reload} onClick={() => { setRemoving(false); setConfirmation(''); setError(null); }}>Profile dön</Button>}
        <Button disabled={busy} onClick={close}>{reload ? 'Kapat ve listeyi yenile' : 'Kapat'}</Button>
        {statusTarget !== null && <Button type="button" variant={statusTarget ? 'primary' : 'danger'} disabled={busy || reload} onClick={changeStatus}>
          {busy ? 'Uygulanıyor…' : statusTarget ? 'Girişi etkinleştir' : 'Hesabı askıya al'}
        </Button>}
        {statusTarget === null && ready && eligible && (!account || account.kind === 'reseller' || removing) && <Button type="submit" variant={removing ? 'danger' : 'primary'} disabled={busy || reload || !canSubmit}>{busy ? 'Kaydediliyor…' : removing ? 'Profili kaldır' : account ? 'Sınırları kaydet' : 'Profili bağla'}</Button>}
      </footer>
    </form>}
  </Modal>;
}
