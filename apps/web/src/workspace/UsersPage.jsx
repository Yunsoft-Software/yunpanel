import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { panelRequest } from '../api.js';
import { formatUserRoleLabel } from '../panel-session.jsx';
import { sessionGeneration, setSession } from '../session-client.js';
import { Badge, Button, EmptyState, ErrorNotice, LinkButton, Modal, ModalCloseButton, PageHeading, Section } from './PanelKit.jsx';
import { useUnsavedChanges } from './UnsavedChanges.jsx';
import { useWorkspace } from './WorkspaceContext.jsx';
import { HostingAccountsPanel, HostingProfileDialog } from './HostingAccountsPanel.jsx';
import { buildLicenseSettingsPath, resolveLicenseGateState } from './license-client.js';
import { createUserAdminClient, emptyUserPage, userAdminInput, userAdminMessage } from './user-admin-client.js';

const LIMIT = 25;
const initialForm = (user) => ({
  username: user?.username ?? '',
  password: '',
  role: user?.role ?? 'site_manager',
  active: user?.active ?? true,
  websiteIds: user?.websiteIds ?? [],
});
const mustReload = (error) => error?.reconcile || ['user_revision_conflict', 'user_not_found', 'invalid_revision'].includes(error?.code);

export default function UsersPage() {
  const { license } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = useState(emptyUserPage);
  const [number, setNumber] = useState(1);
  const [dialog, setDialog] = useState(null);
  const [premiumGateOpen, setPremiumGateOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [profileRevision, setProfileRevision] = useState(0);
  const client = useRef(null);
  const usersGateState = resolveLicenseGateState(license, 'perSiteIsolatedUsers');
  const isolatedUsersPremiumRequired = usersGateState === 'premium_required';
  const usersLicensePendingOrError = usersGateState === 'loading' || usersGateState === 'error';
  const usersLicensePath = buildLicenseSettingsPath({ returnTo: '/users?action=create', feature: 'site_user' });
  useEffect(() => {
    const instance = createUserAdminClient({ request: panelRequest, generation: sessionGeneration, onPage: setPage,
      onAccessLost() {
        setDialog(null); setPremiumGateOpen(false); setNotice(''); setSession(null);
        window.dispatchEvent(new Event('yunpanel:session-expired'));
      },
    });
    client.current = instance;
    return () => { instance.dispose(); if (client.current === instance) client.current = null; };
  }, []);
  useEffect(() => { client.current?.load({ offset: (number - 1) * LIMIT, limit: LIMIT }); }, [number]);
  const totalPages = page.data ? Math.max(1, Math.ceil(page.data.total / LIMIT)) : number;
  useEffect(() => { if (page.status === 'ready' && number > totalPages) setNumber(totalPages); }, [number, page.status, totalPages]);
  useEffect(() => {
    if (searchParams.get('action') !== 'create') return;
    if (usersGateState === 'loading' || usersGateState === 'error') return;
    if (usersGateState === 'allowed') {
      setNotice('');
      setDialog({ type: 'create' });
    }
    const next = new URLSearchParams(searchParams);
    next.delete('action');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, usersGateState]);
  function refresh() { return client.current?.load({ offset: (number - 1) * LIMIT, limit: LIMIT }); }
  function closeDialog() { setDialog(null); setProfileRevision((value) => value + 1); refresh(); }
  function hostingAccessLost() {
    setDialog(null); setPremiumGateOpen(false); setNotice(''); setSession(null);
    window.dispatchEvent(new Event('yunpanel:session-expired'));
  }
  async function save(method, user, body) {
    const instance = client.current; const started = sessionGeneration();
    if (!instance) { const error = new Error('Closed page'); error.name = 'AbortError'; throw error; }
    const result = await instance.mutate({ method, id: user?.id, body });
    if (result.sessionRevoked || instance !== client.current || started !== sessionGeneration()) return;
    setDialog(null);
    setProfileRevision((value) => value + 1);
    setNotice(method === 'POST' ? 'Hesap oluşturuldu. Sunucu Yöneticisi, ilk HTTPS girişinde MFA kurulumunu tamamlamalıdır.'
      : method === 'DELETE' ? 'Kullanıcı hesabı silindi. Web siteleri ve uygulamalar değiştirilmedi.'
        : 'Hesap kaydedildi. Değişiklik yapıldıysa kullanıcının mevcut oturumları kapatıldı.');
    refresh();
  }
  const ready = page.status === 'ready' && page.data?.offset === (number - 1) * LIMIT;
  const visible = ready ? page.data : null;
  const locked = dialog !== null || premiumGateOpen || !ready;
  return <>
    <nav className="ws-breadcrumb" aria-label="Sayfa yolu"><Link to="/settings">Ayarlar</Link><span>/ Kullanıcılar</span></nav>
    <PageHeading title="Kullanıcılar" description="Panel hesaplarını ve yönetim erişimini yönetin." actions={<>
      <Button className="ws-icon-btn" icon="refresh" aria-label="Yenile" title="Yenile" onClick={refresh} disabled={dialog !== null || premiumGateOpen || page.status === 'loading'} />
      <Button icon="plus" variant="primary" disabled={locked || usersLicensePendingOrError} onClick={() => { setNotice(''); if (usersGateState === 'allowed') setDialog({ type: 'create' }); else if (usersGateState === 'premium_required') setPremiumGateOpen(true); }}><span>Kullanıcı ekle</span>{isolatedUsersPremiumRequired && <Badge state="unknown">Premium</Badge>}</Button>
    </>} />
    {usersGateState === 'loading' && (
      <p className="ws-notice" role="status" data-license-gate-state="loading">Lisans durumu doğrulanıyor…</p>
    )}
    {usersGateState === 'error' && (
      <div className="ws-notice ws-notice-warn" role="alert" data-license-gate-state="error">
        <div>
          <strong>Lisans durumu okunamadı</strong>
          <p>Lisans durumu okunamadı. Yeni kullanıcı oluşturma işlemi lisans doğrulanana kadar beklemede.</p>
        </div>
        <Button icon="refresh" onClick={() => license?.refresh?.()}>Lisans durumunu yeniden dene</Button>
      </div>
    )}
    {isolatedUsersPremiumRequired && (
      <div className="ws-notice ws-notice-warn" role="status" data-premium-notice="users">
        <div>
          <strong>Ek panel kullanıcısı eklemek için YunPanel Premium gerekiyor</strong>
          <p>Ücretsiz sürümde mevcut kullanıcılar görüntülenebilir ve yönetim hesabınızla sınırsız site kurmaya devam edebilirsiniz. Ayrı müşteri veya site yöneticisi hesapları oluşturmak için Premium lisansınızı etkinleştirin.</p>
        </div>
        <LinkButton variant="primary" to={usersLicensePath}>Lisans yönetimine git</LinkButton>
      </div>
    )}
    {notice && <div className="ws-notice" role="status">{notice}</div>}
    <Section title="Hesaplar" description="Panel kullanıcı hesapları, roller ve iki adımlı doğrulama durumları.">
      {(page.status === 'loading' || (page.status === 'ready' && !ready)) && <div className="ws-loading" role="status"><span className="ws-spinner" />Hesaplar doğrulanıyor…</div>}
      {page.status === 'error' && <div className="ws-section-body"><ErrorNotice error={userAdminMessage(page.error)} /><Button disabled={dialog !== null} onClick={refresh}>Listeyi yeniden yükle</Button></div>}
      {ready && (visible.users.length ? <div className="ws-table-scroll"><table className="ws-table ws-users-table">
        <caption className="ws-muted">Panel kullanıcıları; her sayfada en fazla {LIMIT} hesap.</caption>
        <thead><tr><th scope="col">Kullanıcı adı</th><th scope="col">Rol</th><th scope="col">Durum</th><th scope="col">MFA</th><th scope="col" className="ws-row-end">İşlemler</th></tr></thead>
        <tbody>{visible.users.map((user) => <tr key={user.id}>
          <th scope="row" style={{ overflowWrap: 'anywhere' }}>{user.username}</th>
          <td className="ws-col-nowrap">{formatUserRoleLabel(user)}</td>
          <td className="ws-col-nowrap"><Badge state={user.active ? 'active' : 'off'}>{user.active ? 'Aktif' : 'Devre dışı'}</Badge></td>
          <td className="ws-col-nowrap"><Badge state={user.mfaEnabled ? 'active' : 'warning'}>{user.mfaEnabled ? 'Kurulu' : 'Kurulu değil'}</Badge></td>
          <td className="ws-row-end ws-col-nowrap"><div className="ws-actions ws-actions-nowrap" style={{ justifyContent: 'flex-end' }}><Button disabled={locked} aria-label={`${user.username} hesabını düzenle`} onClick={() => { setNotice(''); setDialog({ type: 'edit', user }); }}>Düzenle</Button>
            {user.role === 'site_manager' && <Button disabled={locked} aria-label={`${user.username} bayi veya müşteri profilini yönet`} onClick={() => { setNotice(''); setDialog({ type: 'hosting', user }); }}>Bayi / müşteri</Button>}
            <Button disabled={locked} variant="danger" aria-label={`${user.username} hesabını sil`} onClick={() => { setNotice(''); setDialog({ type: 'delete', user }); }}>Sil</Button></div></td>
        </tr>)}</tbody>
      </table></div> : <EmptyState title="Bu sayfada hesap yok" detail="Önceki sayfaya dönün veya listeyi yenileyin." icon="user" />)}
      <footer className="ws-pagination"><span>{visible ? `${visible.total} hesap` : 'Hesap sayısı doğrulanıyor'}</span><div className="ws-actions">
        <Button disabled={locked || number <= 1} onClick={() => setNumber((value) => value - 1)}>Önceki</Button><span aria-live="polite">Sayfa {number}{visible ? ` / ${totalPages}` : ''}</span>
        <Button disabled={locked || !visible || number >= totalPages} onClick={() => setNumber((value) => value + 1)}>Sonraki</Button>
      </div></footer>
    </Section>
    <HostingAccountsPanel refreshKey={profileRevision} locked={dialog !== null || premiumGateOpen} onAccessLost={hostingAccessLost}
      onOpen={(accountId) => { setNotice(''); setDialog({ type: 'hosting', accountId }); }} />
    {premiumGateOpen && (
      <Modal title="Kullanıcı eklemek için YunPanel Premium gerekiyor" onClose={() => setPremiumGateOpen(false)}>
        <div className="ws-form" data-premium-gate-dialog="users">
          <p>Yeni müşteri, site yöneticisi veya ek panel hesabı oluşturmak için aktif bir YunPanel Premium lisansı gerekir.</p>
          <p className="ws-muted">Ücretsiz sürümde mevcut hesaplar görüntülenmeye ve kendi siteleriniz çalışmaya devam eder.</p>
          <footer className="ws-modal-footer">
            <Button onClick={() => setPremiumGateOpen(false)}>Vazgeç</Button>
            <LinkButton variant="primary" to={usersLicensePath}>Lisans yönetimine git</LinkButton>
          </footer>
        </div>
      </Modal>
    )}
    {dialog?.type === 'hosting' ? <HostingProfileDialog key={dialog.user?.id ?? dialog.accountId} user={dialog.user} accountId={dialog.accountId}
      onClose={closeDialog} onSaved={(message) => { setNotice(message); closeDialog(); }} onAccessLost={hostingAccessLost} />
      : dialog && <UserDialog key={`${dialog.type}:${dialog.user?.id ?? 'new'}`} mode={dialog.type} user={dialog.user} licensePath={usersLicensePath} onClose={closeDialog} onSave={save} />}
  </>;
}

function UserDialog({ mode, user, licensePath, onClose, onSave }) {
  const { websites } = useWorkspace();
  const [form, setForm] = useState(() => initialForm(user));
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pending = useRef(false); const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const deleting = mode === 'delete';
  const baseline = initialForm(user);
  const dirty = deleting ? confirmation.length > 0 : Object.keys(form).some((key) => {
    if (key === 'websiteIds') return JSON.stringify(form[key]?.slice().sort()) !== JSON.stringify(baseline[key]?.slice().sort());
    return form[key] !== baseline[key];
  });
  useUnsavedChanges(dirty || busy);
  const reload = mustReload(error);
  function close() {
    if (pending.current) return;
    onClose();
  }
  function update(key, value) { setForm((current) => ({ ...current, [key]: value })); if (!reload) setError(null); }
  async function submit(event) {
    event.preventDefault();
    if (pending.current || reload || (deleting && confirmation !== user.username)) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const body = deleting ? { revision: user.revision } : userAdminInput(form, user);
      await onSave(deleting ? 'DELETE' : user ? 'PATCH' : 'POST', user, body);
    } catch (failure) { if (mounted.current && failure.name !== 'AbortError') setError(failure); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return <Modal title={deleting ? 'Kullanıcıyı sil' : user ? 'Kullanıcıyı düzenle' : 'Kullanıcı ekle'} onClose={close} busy={busy} dirty={dirty && !reload}>
    <form className="ws-form" onSubmit={submit}>
      <ErrorNotice error={error ? userAdminMessage(error) : null} />
      {error?.code === 'premium_license_required' && licensePath && (
        <div className="ws-notice ws-notice-warn" role="status">
          <div>
            <strong>YunPanel Premium lisansı gerekiyor</strong>
            <p>Lisansınızı etkinleştirdikten sonra bu ekrana geri dönebilirsiniz.</p>
          </div>
          <LinkButton variant="primary" to={licensePath}>Lisans yönetimine git</LinkButton>
        </div>
      )}
      {reload && <p role="alert">İşlemi yeniden göndermeyin. Formu kapatıp listeyi kontrol edin; gerekiyorsa güncel kaydı yeniden açın.</p>}
      <fieldset disabled={busy || reload}>
        {deleting ? <>
          <p><strong>{user.username}</strong> hesabı, oturumları ve MFA bilgileri kalıcı olarak silinecek. Web siteleri ve uygulamalar silinmez. Son aktif Sunucu Yöneticisi silinemez.</p>
          <label>Onaylamak için {user.username} yazın<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} required /></label>
        </> : <>
          <div className="ws-form-grid"><label>Kullanıcı adı<input name="username" value={form.username} onChange={(event) => update('username', event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={128} required /><span className="ws-field-hint">3–128 karakter; harf, rakam ve . _ @ + - kullanılabilir.</span></label>
            {!user && <label>İlk parola<input type="password" name="new-password" value={form.password} onChange={(event) => update('password', event.target.value)} autoComplete="new-password" minLength={12} required /><span className="ws-field-hint">En az 12 karakter. Parola daha sonra listelenmez; güvenli bir kanaldan paylaşın.</span></label>}
            <label>Rol<select value={form.role} onChange={(event) => update('role', event.target.value)}>
              <option value="owner">Sunucu Yöneticisi — tam yönetim</option>
              <option value="site_manager">Site Yöneticisi — seçili siteler</option>
              <option value="read_only">Salt Okunur — yalnız görüntüleme</option>
            </select></label>
            <label>Hesap durumu<select value={String(form.active)} onChange={(event) => update('active', event.target.value === 'true')}><option value="true">Aktif</option><option value="false">Devre dışı</option></select></label>
          </div>
          {user && form.role === 'site_manager' && <p className="ws-muted">Bayi/müşteri profiline bağlı hesaplarda rol, durum ve site yetkileri bu formdan değiştirilemez. Profil işlemleri için kullanıcı listesindeki Bayi / müşteri düğmesini kullanın.</p>}
          {form.role === 'site_manager' && (
            <div style={{ marginTop: '12px', padding: '12px', background: 'var(--ws-surface-subtle)', borderRadius: '8px', border: '1px solid var(--ws-border)' }}>
              <p style={{ margin: '0 0 8px', fontWeight: 600, fontSize: '13px' }}>Yönetilecek Web Siteleri</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '140px', overflowY: 'auto' }}>
                {websites.items.length === 0 && <p className="ws-muted">Henüz kayıtlı web sitesi yok.</p>}
                {websites.items.map((site) => (
                  <label key={site.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px' }}>
                    <input
                      type="checkbox"
                      checked={form.websiteIds?.includes(site.id) ?? false}
                      onChange={(event) => {
                        const current = new Set(form.websiteIds ?? []);
                        if (event.target.checked) current.add(site.id);
                        else current.delete(site.id);
                        update('websiteIds', [...current]);
                      }}
                    />
                    <span>{site.name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <p className="ws-muted">{user ? 'Kullanıcı adı, rol veya durum değişirse bu hesabın bütün oturumları ve bekleyen giriş doğrulamaları iptal edilir. Kendi hesabınızı değiştirirseniz yeniden giriş gerekir.' : 'Yeni Sunucu Yöneticisi hesabı, ilk HTTPS girişinde iki adımlı doğrulamayı kurmadan yönetim ekranlarına erişemez.'}</p>
        </>}
      </fieldset>
      <footer className="ws-modal-footer"><ModalCloseButton disabled={busy}>{reload ? 'Kapat ve listeyi yenile' : 'Vazgeç'}</ModalCloseButton>
        <Button type="submit" variant={deleting ? 'danger' : 'primary'} disabled={busy || reload || (deleting ? confirmation !== user.username : !dirty)}>{busy ? 'İşleniyor…' : deleting ? 'Hesabı sil' : user ? 'Değişiklikleri kaydet' : 'Hesap oluştur'}</Button>
      </footer>
    </form>
  </Modal>;
}
