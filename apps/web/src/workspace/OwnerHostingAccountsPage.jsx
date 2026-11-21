import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { panelRequest } from '../api.js';
import { sessionGeneration, setSession } from '../session-client.js';
import { Badge, Button, EmptyState, ErrorNotice, LinkButton, Modal, PageHeading, Section } from './PanelKit.jsx';
import { HostingProfileDialog } from './HostingAccountsPanel.jsx';
import { createHostingAccountClient, hostingAccountMessage } from './hosting-account-client.js';
import { buildLicenseSettingsPath, resolveLicenseGateState } from './license-client.js';
import { buildResellerAccountQuotaMetrics } from './quota-model.js';
import { useUnsavedChanges } from './UnsavedChanges.jsx';
import { useWorkspace } from './WorkspaceContext.jsx';

const LIMIT = 25;
export default function OwnerHostingAccountsPage({ kind }) {
  return <AccountsWorkspace key={kind} kind={kind} />;
}
function AccountsWorkspace({ kind }) {
  const { license, hostingAccountDrafts, saveHostingAccountDraft, clearHostingAccountDraft } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const client = useRef(null), [page, setPage] = useState(null), [error, setError] = useState(null);
  const [loading, setLoading] = useState(true), [offset, setOffset] = useState(0), [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState(null), [notice, setNotice] = useState(null);
  const label = kind === 'reseller' ? 'Bayi' : 'Müşteri';
  const requiredCapability = kind === 'reseller' ? 'resellerAccounts' : 'perSiteIsolatedUsers';
  const gateState = resolveLicenseGateState(license, requiredCapability);
  const premiumRequired = gateState === 'premium_required';
  const licensePendingOrError = gateState === 'loading' || gateState === 'error';
  const licensePath = buildLicenseSettingsPath({
    returnTo: kind === 'reseller' ? '/resellers?action=create' : '/customers?action=create',
    feature: kind,
  });
  function accessLost() { setDialog(null); setSession(null); window.dispatchEvent(new Event('yunpanel:session-expired')); }
  useEffect(() => {
    const instance = createHostingAccountClient({ request: panelRequest, generation: sessionGeneration, onAccessLost: accessLost });
    client.current = instance;
    return () => { instance.dispose(); client.current = null; };
  }, []);
  useEffect(() => {
    let active = true; setLoading(true); setError(null);
    client.current.list({ kind, offset, limit: LIMIT }).then(result => {
      if (!active) return;
      if (offset && offset >= result.total) { setOffset(Math.max(0, Math.ceil(result.total / LIMIT) - 1) * LIMIT); return; }
      setPage(result);
    }).catch(failure => { if (active && failure.name !== 'AbortError') setError(hostingAccountMessage(failure)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [kind, offset, revision]);
  useEffect(() => {
    if (searchParams.get('action') !== 'create') return;
    if (gateState === 'loading' || gateState === 'error') return;
    if (gateState === 'allowed') {
      setDialog({ type: 'create' });
    }
    const next = new URLSearchParams(searchParams);
    next.delete('action');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, gateState]);
  const refresh = () => setRevision(value => value + 1);
  const close = () => { setDialog(null); refresh(); };
  const saved = message => { clearHostingAccountDraft?.(kind); setNotice(message); close(); };
  return <>
    <PageHeading title={kind === 'reseller' ? 'Bayiler' : 'Müşteriler'} description={kind === 'reseller' ? 'Bayilerinizin müşterilerini, site sınırlarını ve panel erişimini yönetin.' : 'Müşteri hesaplarını ve onlara ait web sitelerini yönetin.'}
      actions={<><Button icon="refresh" disabled={loading || Boolean(dialog)} onClick={refresh}>Yenile</Button><Button variant="primary" icon="plus" disabled={loading || Boolean(dialog) || licensePendingOrError} onClick={() => { if (gateState === 'allowed') setDialog({ type: 'create' }); else if (gateState === 'premium_required') setDialog({ type: 'premium_gate' }); }}><span>{label} ekle</span>{premiumRequired && <Badge state="unknown">Premium</Badge>}</Button></>} />
    {gateState === 'loading' && (
      <p className="ws-notice" role="status" data-license-gate-state="loading">Lisans durumu doğrulanıyor…</p>
    )}
    {gateState === 'error' && (
      <div className="ws-notice ws-notice-warn" role="alert" data-license-gate-state="error">
        <div>
          <strong>Lisans durumu okunamadı</strong>
          <p>
            {kind === 'reseller'
              ? 'Lisans durumu okunamadı. Yeni bayi oluşturma işlemi lisans doğrulanana kadar beklemede.'
              : 'Lisans durumu okunamadı. Yeni müşteri oluşturma işlemi lisans doğrulanana kadar beklemede.'}
          </p>
        </div>
        <Button icon="refresh" onClick={() => license?.refresh?.()}>Lisans durumunu yeniden dene</Button>
      </div>
    )}
    {premiumRequired && (
      <div className="ws-notice ws-notice-warn" role="status" data-premium-notice={kind}>
        <div>
          <strong>
            {kind === 'reseller'
              ? 'Bayi hesabı oluşturmak ve yönetmek için YunPanel Premium gerekiyor'
              : 'Müşteri hesabı oluşturmak ve yönetmek için YunPanel Premium gerekiyor'}
          </strong>
          <p>
            Ücretsiz sürümde mevcut siteleriniz ve kayıtlı hesaplarınız çalışmaya devam eder.
            {kind === 'reseller'
              ? ' Yeni bayi eklemek veya bayi sınırlarını yönetmek için Premium lisansınızı etkinleştirin.'
              : ' Yeni müşteri hesabı oluşturmak veya müşteri erişimi vermek için Premium lisansınızı etkinleştirin.'}
          </p>
        </div>
        <LinkButton variant="primary" to={licensePath}>Lisans yönetimine git</LinkButton>
      </div>
    )}
    {notice && <p className="ws-notice" role="status">{notice}</p>}
    <Section title={`${label} hesapları`}>
      <div className="ws-section-body"><ErrorNotice error={error} />{loading && <p role="status">Hesaplar yükleniyor…</p>}</div>
      {!loading && !error && page && (page.accounts.length ? <div className="ws-table-wrap"><table className="ws-table">
        <thead><tr><th scope="col">Hesap</th><th scope="col">Durum</th><th scope="col">Web siteleri</th>{kind === 'reseller' && <th scope="col">Müşteriler</th>}<th scope="col">İşlemler</th></tr></thead>
        <tbody>{page.accounts.map(account => {
          const metrics = buildResellerAccountQuotaMetrics(account);
          return <tr key={account.id}><th scope="row">{account.username}</th><td><Badge state={account.active ? 'active' : 'off'}>{account.active ? 'Etkin' : 'Giriş kapalı'}</Badge></td>
            <td>
              <span>{metrics.websites.measured ? metrics.websites.summaryText : metrics.websites.usageText}</span>
              {metrics.websites.reservedCount > 0 && <span className="ws-field-hint" style={{ display: 'block' }}>{metrics.websites.reservedCount} bekleyen tahsis dahil</span>}
              {metrics.websites.reservedCount === 0 && metrics.websites.includesReservations && <span className="ws-field-hint" style={{ display: 'block' }}>Bekleyen tahsisler dahil</span>}
              {metrics.websites.isFull && <span className="ws-field-hint" style={{ color: 'var(--ws-warning)', display: 'block' }}>Kota doldu</span>}
            </td>
            {kind === 'reseller' && <td>
              <span>{metrics.customers.measured ? metrics.customers.summaryText : metrics.customers.usageText}</span>
              {metrics.customers.isFull && <span className="ws-field-hint" style={{ color: 'var(--ws-warning)', display: 'block' }}>Kota doldu</span>}
            </td>}
            <td><div className="ws-actions"><Button disabled={Boolean(dialog)} onClick={() => setDialog({ type: 'profile', account })}>Hesabı yönet</Button>
              {kind === 'customer' && <><Link className="ws-button" to={`/websites?customer=${encodeURIComponent(account.id)}`}>Web siteleri</Link>{account.active && <Link className="ws-button" to={`/websites/new?customer=${encodeURIComponent(account.id)}`}>Site ekle</Link>}</>}</div></td>
          </tr>;
        })}</tbody></table></div> : <EmptyState title={`Henüz ${label.toLocaleLowerCase('tr')} yok`} detail={gateState === 'loading' ? 'Lisans durumu doğrulanıyor…' : gateState === 'error' ? 'Yeni hesap oluşturmak için önce lisans durumunu yeniden deneyin.' : premiumRequired ? `Yeni ${label.toLocaleLowerCase('tr')} hesabı açmak için önce YunPanel Premium lisansını etkinleştirin.` : 'Yeni hesabı oluşturduktan sonra site ekleyebilirsiniz.'} icon="user" />)}
      <footer className="ws-pagination"><span>{page ? `${page.total} hesap` : 'Hesap sayısı bekleniyor'}</span><div className="ws-actions">
        <Button disabled={loading || Boolean(dialog) || offset === 0} onClick={() => setOffset(value => Math.max(0, value - LIMIT))}>Önceki</Button>
        <span>Sayfa {Math.floor(offset / LIMIT) + 1}</span><Button disabled={loading || Boolean(dialog) || !page || offset + LIMIT >= page.total} onClick={() => setOffset(value => value + LIMIT)}>Sonraki</Button>
      </div></footer>
    </Section>
    {dialog?.type === 'premium_gate' && (
      <Modal title={`${label} eklemek için YunPanel Premium gerekiyor`} onClose={() => setDialog(null)}>
        <div className="ws-form" data-premium-gate-dialog={kind}>
          <p>
            {kind === 'reseller'
              ? 'Yeni bayi hesabı oluşturmak ve bayi sınırlarını yönetmek için aktif bir YunPanel Premium lisansı gerekir.'
              : 'Yeni müşteri hesabı oluşturmak ve ayrı panel girişi tanımlamak için aktif bir YunPanel Premium lisansı gerekir.'}
          </p>
          <p className="ws-muted">Ücretsiz sürümde mevcut siteleriniz, kayıtlı hesaplarınız ve sunucu yönetim araçlarınız normal şekilde çalışmaya devam eder.</p>
          <footer className="ws-modal-footer">
            <Button onClick={() => setDialog(null)}>Vazgeç</Button>
            <LinkButton variant="primary" to={licensePath}>Lisans yönetimine git</LinkButton>
          </footer>
        </div>
      </Modal>
    )}
    {dialog?.type === 'create' && <AccountCreateDialog kind={kind} client={client} initialDraft={hostingAccountDrafts?.[kind] ?? null} licensePath={licensePath} onSaveDraft={draft => saveHostingAccountDraft?.(kind, draft)} onClose={close} onSaved={saved} />}
    {dialog?.type === 'profile' && <HostingProfileDialog accountId={dialog.account.id} onClose={close} onSaved={saved} onAccessLost={accessLost} />}
  </>;
}

function AccountCreateDialog({ kind, client, initialDraft = null, licensePath, onSaveDraft, onClose, onSaved }) {
  const [form, setForm] = useState({
    kind,
    username: '',
    password: '',
    resellerId: typeof initialDraft?.resellerId === 'string' ? initialDraft.resellerId : '',
    maxCustomers: typeof initialDraft?.maxCustomers === 'string' ? initialDraft.maxCustomers : '10',
    maxWebsites: typeof initialDraft?.maxWebsites === 'string' ? initialDraft.maxWebsites : '25',
  });
  const [parents, setParents] = useState([]), [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const mounted = useRef(true), pending = useRef(false);
  useUnsavedChanges(Boolean(form.username || form.password));
  useEffect(() => {
    mounted.current = true;
    if (kind === 'customer') client.current.list({ kind: 'reseller', limit: 100 }, 'create-parent').then(page => {
      if (mounted.current) setParents(page.accounts.filter(account => account.active));
    }).catch(failure => { if (mounted.current) setError(failure); });
    return () => { mounted.current = false; };
  }, [kind]);
  function change(key, value) { setForm(previous => ({ ...previous, [key]: value })); if (!error?.reconcile) setError(null); }
  async function submit(event) {
    event.preventDefault(); if (pending.current || error?.reconcile) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const account = await client.current.createLogin(form);
      if (mounted.current) { setForm(previous => ({ ...previous, password: '' })); onSaved(`${account.username} hesabı oluşturuldu.`); }
    } catch (failure) {
      if (mounted.current && failure.name !== 'AbortError') {
        if (failure?.code === 'premium_license_required') {
          onSaveDraft?.(form);
          setForm(previous => ({ ...previous, password: '' }));
        }
        setError(failure);
      }
    }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return <Modal title={kind === 'reseller' ? 'Bayi ekle' : 'Müşteri ekle'} busy={busy} onClose={onClose}>
    <form className="ws-form" onSubmit={submit}><ErrorNotice error={error ? hostingAccountMessage(error) : null} />
      {error?.code === 'premium_license_required' && (
        <div className="ws-notice ws-notice-warn" role="status">
          <div>
            <strong>YunPanel Premium lisansı gerekiyor</strong>
            <p>Lisansınızı etkinleştirdikten sonra bu ekrana geri dönebilirsiniz.</p>
          </div>
          <LinkButton variant="primary" to={licensePath}>Lisans yönetimine git</LinkButton>
        </div>
      )}
      {error?.reconcile && <p role="alert">Sonuç alınamadı. Yeni hesap açmadan önce pencereyi kapatıp listeyi yenileyin.</p>}
      <fieldset disabled={busy || Boolean(error?.reconcile)}>
        <label>Kullanıcı adı<input required value={form.username} onChange={event => change('username', event.target.value)} minLength={3} maxLength={128} autoComplete="off" autoCapitalize="none" spellCheck={false} /></label>
        <label>İlk parola<input type="password" required value={form.password} onChange={event => change('password', event.target.value)} minLength={12} autoComplete="new-password" /></label>
        {kind === 'customer' && <label>Bağlı bayi<select value={form.resellerId} onChange={event => change('resellerId', event.target.value)}><option value="">Doğrudan yönetim</option>{parents.map(parent => <option key={parent.id} value={parent.id}>{parent.username}</option>)}</select></label>}
        {kind === 'reseller' && <div className="ws-form-grid"><label>En fazla müşteri<input type="number" min="0" required value={form.maxCustomers} onChange={event => change('maxCustomers', event.target.value)} /></label><label>En fazla web sitesi<input type="number" min="0" required value={form.maxWebsites} onChange={event => change('maxWebsites', event.target.value)} /></label></div>}
      </fieldset>
      <footer className="ws-modal-footer"><Button onClick={onClose} disabled={busy}>Vazgeç</Button><Button type="submit" variant="primary" disabled={busy || Boolean(error?.reconcile)}>{busy ? 'Hesap oluşturuluyor…' : 'Hesabı oluştur'}</Button></footer>
    </form>
  </Modal>;
}
