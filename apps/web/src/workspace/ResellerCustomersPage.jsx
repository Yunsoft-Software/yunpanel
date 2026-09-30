import { useEffect, useRef, useState } from 'react';
import { panelRequest } from '../api.js';
import { usePanelSession } from '../panel-session.jsx';
import { requestJson, sessionGeneration, setSession } from '../session-client.js';
import { Badge, Button, EmptyState, ErrorNotice, Modal, PageHeading, Section } from './PanelKit.jsx';
import { useUnsavedChanges } from './UnsavedChanges.jsx';
import { createHostingAccountClient, hostingAccountMessage } from './hosting-account-client.js';
import { useWorkspace } from './WorkspaceContext.jsx';

const LIMIT = 25;
const blankForm = () => ({ username: '', password: '' });
const editForm = (account) => ({ username: account?.username ?? '', password: '' });

function useResellerHostingClient(onAccessLost) {
  const ref = useRef(null);
  const lost = useRef(onAccessLost);
  lost.current = onAccessLost;
  useEffect(() => {
    const client = createHostingAccountClient({
      request: panelRequest,
      generation: sessionGeneration,
      onAccessLost: () => lost.current(),
    });
    ref.current = client;
    return () => {
      client.dispose();
      if (ref.current === client) ref.current = null;
    };
  }, []);
  return ref;
}

export default function ResellerCustomersPage() {
  const { session, isReseller } = usePanelSession();
  const { servers } = useWorkspace();
  const [offset, setOffset] = useState(0);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState({ status: 'loading' });
  const [dialog, setDialog] = useState(null);
  const [notice, setNotice] = useState('');
  const onAccessLost = () => {
    setDialog(null);
    setNotice('');
    setSession(null);
    window.dispatchEvent(new Event('yunpanel:session-expired'));
  };
  const client = useResellerHostingClient(onAccessLost);

  useEffect(() => {
    if (!isReseller || !session?.user?.id) return undefined;
    let cancelled = false;
    const generation = sessionGeneration();
    setState({ status: 'loading' });
    Promise.all([
      client.current.get(session.user.id),
      client.current.list({ kind: 'customer', resellerId: session.user.id, offset, limit: LIMIT }),
    ]).then(([reseller, page]) => {
      if (cancelled || generation !== sessionGeneration()) return;
      if (!reseller || reseller.kind !== 'reseller' || reseller.id !== session.user.id) {
        setState({ status: 'error', error: { code: 'hosting_result_invalid' } });
        return;
      }
      if (offset && !page.accounts.length && offset >= page.total) {
        setOffset(Math.max(0, Math.ceil(page.total / LIMIT) - 1) * LIMIT);
        return;
      }
      setState({ status: 'ready', reseller, page, offset });
    }).catch((error) => {
      if (!cancelled && error.name !== 'AbortError') setState({ status: 'error', error });
    });
    return () => { cancelled = true; };
  }, [isReseller, session?.user?.id, offset, retry]);

  const ready = state.status === 'ready' && state.offset === offset;
  const reseller = ready ? state.reseller : null;
  const page = ready ? state.page : null;
  const locked = dialog !== null || state.status === 'loading';
  const refresh = () => setRetry((value) => value + 1);
  const saved = (message) => {
    setDialog(null);
    setNotice(message);
    refresh();
  };

  return <>
    <PageHeading
      eyebrow="Bayi yönetimi"
      title="Müşterilerim"
      description="Yalnız size bağlı müşteri giriş hesaplarını yönetin. Site yetkileri ve sunucu kaynakları bu ekrandan verilmez."
      actions={<>
        <Button icon="refresh" disabled={locked} onClick={refresh}>Yenile</Button>
        <Button icon="plus" variant="primary" disabled={locked || !reseller?.active} onClick={() => { setNotice(''); setDialog({ type: 'create' }); }}>Müşteri ekle</Button>
      </>}
    />
    {notice && <div className="ws-notice" role="status">{notice}</div>}
    <Section
      title="Müşteri hesapları"
      description={reseller ? 'Kayıtlı müşteri: ' + reseller.usage.customers + ' / ' + (reseller.limits.maxCustomers === null ? 'Sınırsız' : reseller.limits.maxCustomers) + ' · Web sitesi: ' + reseller.usage.websites + ' / ' + (reseller.limits.maxWebsites === null ? 'Sınırsız' : reseller.limits.maxWebsites) : 'Güncel bayi profili doğrulanıyor.'}
    >
      <div className="ws-section-body">
        <ErrorNotice error={state.status === 'error' ? hostingAccountMessage(state.error) : null} />
        {state.status === 'error' && <Button onClick={refresh}>Listeyi yeniden yükle</Button>}
        {state.status !== 'error' && !page && <p role="status">Müşteriler yükleniyor…</p>}
        <p className="ws-muted">Bu ekran paket, abonelik, sahiplik transferi veya site grant'i oluşturmaz. Hesabı askıya almak Website süreçlerini durdurmaz.</p>
      </div>
      {page && (page.accounts.length ? <div className="ws-table-scroll"><table className="ws-table">
        <caption className="ws-muted">Yalnız mevcut bayi profilinize bağlı müşteri hesapları</caption>
        <thead><tr><th scope="col">Kullanıcı adı</th><th scope="col">Giriş durumu</th><th scope="col">Site erişimi</th><th scope="col">İşlemler</th></tr></thead>
        <tbody>{page.accounts.map((account) => <tr key={account.id}>
          <th scope="row">{account.username}</th>
          <td><Badge state={account.active ? 'active' : 'off'}>{account.active ? 'Etkin' : 'Askıda'}</Badge></td>
          <td><Badge state="pending">Ayrı site akışı</Badge></td>
          <td><div className="ws-actions">
            <Button disabled={locked || !account.active} onClick={() => { setNotice(''); setDialog({ type: 'allocate', account }); }}>Site tahsis et</Button>
            <Button disabled={locked} onClick={() => { setNotice(''); setDialog({ type: 'edit', account }); }}>Girişi düzenle</Button>
            <Button variant={account.active ? 'danger' : 'primary'} disabled={locked} onClick={() => { setNotice(''); setDialog({ type: 'status', account, active: !account.active }); }}>
              {account.active ? 'Askıya al' : 'Yeniden aç'}
            </Button>
          </div></td>
        </tr>)}</tbody>
      </table></div> : <EmptyState title="Henüz müşteri yok" detail="Yeni müşteri yalnız sizin bayi profilinize bağlanır; site erişimi ayrıca hazırlanır." icon="user" />)}
      <footer className="ws-pagination"><span>{page ? page.total + ' müşteri' : 'Müşteri sayısı doğrulanıyor'}</span><div className="ws-actions">
        <Button disabled={locked || !page || offset === 0} onClick={() => setOffset((value) => Math.max(0, value - LIMIT))}>Önceki</Button>
        <span aria-live="polite">Sayfa {Math.floor(offset / LIMIT) + 1}</span>
        <Button disabled={locked || !page || offset + LIMIT >= page.total} onClick={() => setOffset((value) => value + LIMIT)}>Sonraki</Button>
      </div></footer>
    </Section>
    {dialog && reseller && (dialog.type === 'allocate' ? <AllocateSiteDialog
      key={`allocate:${dialog.account?.id}`}
      account={dialog.account}
      reseller={reseller}
      servers={servers}
      onClose={() => { setDialog(null); refresh(); }}
      onSaved={saved}
    /> : <CustomerDialog
      key={dialog.type + ':' + (dialog.account?.id ?? 'new')}
      mode={dialog.type}
      account={dialog.account ?? null}
      statusTarget={dialog.active}
      reseller={reseller}
      client={client}
      onClose={() => { setDialog(null); refresh(); }}
      onSaved={saved}
    />)}
  </>;
}

function CustomerDialog({ mode, account, statusTarget, reseller, client, onClose, onSaved }) {
  const [form, setForm] = useState(() => mode === 'create' ? blankForm() : editForm(account));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [discard, setDiscard] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const editing = mode === 'edit';
  const creating = mode === 'create';
  const status = mode === 'status';
  const dirty = status || (creating ? Boolean(form.username || form.password) : form.username !== account.username || Boolean(form.password));
  const reconcile = Boolean(error?.reconcile);
  useUnsavedChanges(dirty || busy);

  function close() {
    if (pending.current) return;
    if (!status && dirty && !reconcile && !discard) setDiscard(true);
    else onClose();
  }
  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
    if (!reconcile) setError(null);
  }
  async function submit(event) {
    event.preventDefault();
    if (pending.current || reconcile || (!creating && !account)) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      if (creating) {
        const result = await client.current.mutate({ action: 'createCustomer', account: reseller, form });
        if (mounted.current) onSaved(result.account.username + ' müşteri hesabı oluşturuldu. Site erişimi henüz verilmedi.');
      } else if (editing) {
        const result = await client.current.mutate({ action: 'login', account, form });
        if (mounted.current) onSaved(result.account.username + ' giriş bilgileri güncellendi; mevcut oturumları kapatıldı.');
      } else {
        const result = await client.current.mutate({ action: 'status', account, form: { active: statusTarget } });
        if (mounted.current) onSaved(result.account.active
          ? result.account.username + ' giriş hesabı yeniden açıldı. Website çalışma durumu değiştirilmedi.'
          : result.account.username + ' giriş hesabı askıya alındı. Website çalışma durumu değiştirilmedi.');
      }
    } catch (failure) {
      if (mounted.current && failure.name !== 'AbortError') setError(failure);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const title = creating ? 'Müşteri ekle' : editing ? 'Müşteri girişini düzenle' : statusTarget ? 'Müşteriyi yeniden aç' : 'Müşteriyi askıya al';
  return <Modal title={title} onClose={close} busy={busy}>
    {discard ? <>
      <p>Kaydedilmemiş giriş bilgileri bırakılacak. Pencereyi kapatmak istiyor musunuz?</p>
      <footer className="ws-modal-footer"><Button onClick={() => setDiscard(false)}>Düzenlemeye dön</Button><Button variant="danger" onClick={onClose}>Değişiklikleri bırak</Button></footer>
    </> : <form className="ws-form" onSubmit={submit}>
      <ErrorNotice error={error ? hostingAccountMessage(error) : null} />
      {reconcile && <p role="alert">Sonuç kesin doğrulanamadı. İşlemi tekrar göndermeyin; pencereyi kapatıp güncel müşteri listesini yeniden okuyun.</p>}
      <fieldset disabled={busy || reconcile}>
        {status ? <>
          <p><strong>{account.username}</strong> hesabının panel girişini {statusTarget ? 'yeniden açmak' : 'askıya almak'} üzeresiniz.</p>
          <p className="ws-muted">Bu işlem müşteri profilini, Website kaydını, dosyaları, posta hesaplarını veya host süreçlerini silmez ve durdurmaz.</p>
        </> : <>
          <label>Kullanıcı adı<input value={form.username} onChange={(event) => update('username', event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={128} required /></label>
          <label>{creating ? 'İlk parola' : 'Yeni parola (değişmeyecekse boş bırakın)'}<input type="password" value={form.password} onChange={(event) => update('password', event.target.value)} autoComplete="new-password" minLength={12} required={creating} /></label>
          <p className="ws-field-hint">Kullanıcı adı ve parola yalnız giriş hesabını yönetir. Rol, bayi ilişkisi ve site yetkileri bu formdan değiştirilemez.</p>
        </>}
      </fieldset>
      <footer className="ws-modal-footer">
        <Button disabled={busy} onClick={close}>{reconcile ? 'Kapat ve listeyi yenile' : 'Vazgeç'}</Button>
        <Button type="submit" variant={status && !statusTarget ? 'danger' : 'primary'} disabled={busy || reconcile || (!status && !dirty)}>
          {busy ? 'İşleniyor…' : creating ? 'Müşteriyi oluştur' : editing ? 'Girişi kaydet' : statusTarget ? 'Girişi yeniden aç' : 'Hesabı askıya al'}
        </Button>
      </footer>
    </form>}
  </Modal>;
}

function AllocateSiteDialog({ account, reseller, servers, onClose, onSaved }) {
  const [form, setForm] = useState({
    primaryDomain: '',
    runtime: 'new_static',
    wwwMode: 'alias',
  });
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [discard, setDiscard] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const dirty = Boolean(form.primaryDomain.trim());
  useUnsavedChanges(dirty || busy);

  const serverId = servers?.items?.[0]?.id ?? null;

  function close() {
    if (pending.current) return;
    if (dirty && !discard) setDiscard(true);
    else onClose();
  }

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
    setPreview(null);
    setError(null);
  }

  async function handlePreview(event) {
    event.preventDefault();
    if (pending.current || !serverId) return;
    const cleanDomain = form.primaryDomain.trim().toLowerCase();
    if (!cleanDomain) {
      setError(new Error('Alan adı boş bırakılamaz.'));
      return;
    }
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const input = {
        operationId: crypto.randomUUID(),
        serverId,
        displayName: cleanDomain,
        primaryDomain: cleanDomain,
        parentDomainId: null,
        wwwMode: form.wwwMode,
        aliases: [],
        httpsMode: 'managed',
        dnsMode: 'local',
        mailMode: 'local',
        source: { kind: form.runtime },
      };
      const result = await requestJson('/api/sites/hosted/create-preview', {
        method: 'POST',
        body: { customerId: account.id, input },
      });
      if (mounted.current) {
        setPreview({ input, ...result });
      }
    } catch (failure) {
      if (mounted.current && failure.name !== 'AbortError') setError(failure);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function handleApply() {
    if (pending.current || !preview) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await requestJson('/api/sites/hosted', {
        method: 'POST',
        body: {
          customerId: account.id,
          input: preview.input,
          previewDigest: preview.previewDigest,
          confirmation: preview.confirmation,
        },
      });
      if (mounted.current) {
        onSaved(`${preview.input.primaryDomain} sitesi ${account.username} müşterisine başarıyla tahsis edildi.`);
      }
    } catch (failure) {
      if (mounted.current && failure.name !== 'AbortError') setError(failure);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <Modal title={`${account.username} · Site Tahsis Et`} onClose={close} busy={busy}>
      {discard ? (
        <>
          <p>Kaydedilmemiş site tahsis bilgileri bırakılacak. Pencereyi kapatmak istiyor musunuz?</p>
          <footer className="ws-modal-footer">
            <Button onClick={() => setDiscard(false)}>Forma dön</Button>
            <Button variant="danger" onClick={onClose}>Değişiklikleri bırak</Button>
          </footer>
        </>
      ) : (
        <div className="ws-form">
          <ErrorNotice error={error ? (hostingAccountMessage(error) || error.message) : null} />
          {!preview ? (
            <form onSubmit={handlePreview}>
              <fieldset disabled={busy || !serverId}>
                <p><strong>{account.username}</strong> müşterisine yeni bir web sitesi tahsis edin. Bu işlem bayi kotanızdan düşülür.</p>
                {!serverId && <p className="ws-muted">Yerel sunucu bilgisi yükleniyor…</p>}
                <label>
                  Alan adı (Domain)
                  <input
                    value={form.primaryDomain}
                    onChange={(event) => update('primaryDomain', event.target.value)}
                    placeholder="ornekalanadi.com"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    required
                  />
                </label>
                <label>
                  Çalışma ortamı (Runtime)
                  <select value={form.runtime} onChange={(event) => update('runtime', event.target.value)}>
                    <option value="new_static">Statik Site (HTML / JS / CSS)</option>
                    <option value="new_node">Node.js Uygulaması</option>
                    <option value="new_php">PHP / WordPress</option>
                  </select>
                </label>
                <label>
                  WWW Yönlendirmesi
                  <select value={form.wwwMode} onChange={(event) => update('wwwMode', event.target.value)}>
                    <option value="alias">www alias ekle (Önerilen)</option>
                    <option value="none">Sadece ana alan adı</option>
                  </select>
                </label>
              </fieldset>
              <footer className="ws-modal-footer">
                <Button disabled={busy} onClick={close}>Vazgeç</Button>
                <Button type="submit" variant="primary" disabled={busy || !dirty || !serverId}>
                  {busy ? 'Doğrulanıyor…' : 'Planı Önizle'}
                </Button>
              </footer>
            </form>
          ) : (
            <div>
              <p>Site tahsis planı doğrulandı. İşlemi onayladığınızda site oluşturulacak ve müşteri hesabına bağlanacaktır.</p>
              <div className="ws-section-body">
                <p><strong>Alan adı:</strong> {preview.input?.primaryDomain}</p>
                <p><strong>Müşteri:</strong> {account.username}</p>
                <p><strong>Çalışma türü:</strong> {form.runtime === 'new_node' ? 'Node.js' : form.runtime === 'new_php' ? 'PHP' : 'Statik'}</p>
              </div>
              <footer className="ws-modal-footer">
                <Button disabled={busy} onClick={() => setPreview(null)}>Geri dön</Button>
                <Button variant="primary" disabled={busy} onClick={handleApply}>
                  {busy ? 'Site tahsis ediliyor…' : 'Siteyi Tahsis Et'}
                </Button>
              </footer>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
