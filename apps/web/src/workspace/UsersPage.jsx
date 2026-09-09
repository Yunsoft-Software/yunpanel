import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { panelRequest } from '../api.js';
import { sessionGeneration, setSession } from '../session-client.js';
import { Badge, Button, EmptyState, ErrorNotice, Modal, PageHeading, Section } from './PanelKit.jsx';
import { useUnsavedChanges } from './UnsavedChanges.jsx';
import { createUserAdminClient, emptyUserPage, userAdminInput, userAdminMessage } from './user-admin-client.js';

const LIMIT = 25;
const initialForm = (user) => ({ username: user?.username ?? '', password: '', role: user?.role ?? 'owner', active: user?.active ?? true });
const mustReload = (error) => error?.reconcile || ['user_revision_conflict', 'user_not_found', 'invalid_revision'].includes(error?.code);

export default function UsersPage() {
  const [page, setPage] = useState(emptyUserPage);
  const [number, setNumber] = useState(1);
  const [dialog, setDialog] = useState(null);
  const [notice, setNotice] = useState('');
  const client = useRef(null);
  useEffect(() => {
    const instance = createUserAdminClient({ request: panelRequest, generation: sessionGeneration, onPage: setPage,
      onAccessLost() {
        setDialog(null); setNotice(''); setSession(null);
        window.dispatchEvent(new Event('yunpanel:session-expired'));
      },
    });
    client.current = instance;
    return () => { instance.dispose(); if (client.current === instance) client.current = null; };
  }, []);
  useEffect(() => { client.current?.load({ offset: (number - 1) * LIMIT, limit: LIMIT }); }, [number]);
  const totalPages = page.data ? Math.max(1, Math.ceil(page.data.total / LIMIT)) : number;
  useEffect(() => { if (page.status === 'ready' && number > totalPages) setNumber(totalPages); }, [number, page.status, totalPages]);
  function refresh() { return client.current?.load({ offset: (number - 1) * LIMIT, limit: LIMIT }); }
  function closeDialog() { setDialog(null); refresh(); }
  async function save(method, user, body) {
    const instance = client.current; const started = sessionGeneration();
    if (!instance) { const error = new Error('Closed page'); error.name = 'AbortError'; throw error; }
    const result = await instance.mutate({ method, id: user?.id, body });
    if (result.sessionRevoked || instance !== client.current || started !== sessionGeneration()) return;
    setDialog(null);
    setNotice(method === 'POST' ? 'Hesap oluşturuldu. Owner, ilk HTTPS girişinde MFA kurulumunu tamamlamalıdır.'
      : method === 'DELETE' ? 'Kullanıcı hesabı silindi. Web siteleri ve uygulamalar değiştirilmedi.'
        : 'Hesap kaydedildi. Değişiklik yapıldıysa kullanıcının mevcut oturumları kapatıldı.');
    refresh();
  }
  const locked = dialog !== null || page.status !== 'ready';
  return <>
    <nav className="ws-breadcrumb" aria-label="Sayfa yolu"><Link to="/settings">Ayarlar</Link><span>/ Kullanıcılar</span></nav>
    <PageHeading title="Kullanıcılar" description="Panel hesaplarını ve yönetim erişimini yönetin." actions={<>
      <Button icon="refresh" onClick={refresh} disabled={dialog !== null || page.status === 'loading'}>Yenile</Button>
      <Button icon="plus" variant="primary" disabled={locked} onClick={() => { setNotice(''); setDialog({ type: 'create' }); }}>Kullanıcı ekle</Button>
    </>} />
    {notice && <div className="ws-notice" role="status">{notice}</div>}
    <Section title="Hesaplar" description="Owner tüm mevcut yönetim işlemlerine erişir. Read Only hesapları şu an yalnız kendi hesap ayarlarına erişebilir; kaynak görüntüleme izinleri henüz uygulanmadı.">
      {page.status === 'loading' && <div className="ws-loading" role="status"><span className="ws-spinner" />Hesaplar doğrulanıyor…</div>}
      {page.status === 'error' && <div className="ws-section-body"><ErrorNotice error={userAdminMessage(page.error)} /><Button disabled={dialog !== null} onClick={refresh}>Listeyi yeniden yükle</Button></div>}
      {page.status === 'ready' && (page.data.users.length ? <div className="ws-table-scroll"><table className="ws-table">
        <caption className="ws-muted">Panel kullanıcıları; her sayfada en fazla {LIMIT} hesap.</caption>
        <thead><tr><th scope="col">Kullanıcı adı</th><th scope="col">Rol</th><th scope="col">Durum</th><th scope="col">MFA</th><th scope="col">İşlemler</th></tr></thead>
        <tbody>{page.data.users.map((user) => <tr key={user.id}>
          <th scope="row" style={{ overflowWrap: 'anywhere' }}>{user.username}</th>
          <td>{user.role === 'owner' ? 'Owner' : 'Read Only'}</td>
          <td><Badge state={user.active ? 'active' : 'off'}>{user.active ? 'Aktif' : 'Devre dışı'}</Badge></td>
          <td><Badge state={user.mfaEnabled ? 'active' : 'warning'}>{user.mfaEnabled ? 'Kurulu' : 'Kurulu değil'}</Badge></td>
          <td><div className="ws-actions"><Button disabled={locked} aria-label={`${user.username} hesabını düzenle`} onClick={() => { setNotice(''); setDialog({ type: 'edit', user }); }}>Düzenle</Button>
            <Button disabled={locked} variant="danger" aria-label={`${user.username} hesabını sil`} onClick={() => { setNotice(''); setDialog({ type: 'delete', user }); }}>Sil</Button></div></td>
        </tr>)}</tbody>
      </table></div> : <EmptyState title="Bu sayfada hesap yok" detail="Önceki sayfaya dönün veya listeyi yenileyin." icon="user" />)}
      <footer className="ws-pagination"><span>{page.data ? `${page.data.total} hesap` : 'Hesap sayısı doğrulanıyor'}</span><div className="ws-actions">
        <Button disabled={locked || number <= 1} onClick={() => setNumber((value) => value - 1)}>Önceki</Button><span aria-live="polite">Sayfa {number}{page.data ? ` / ${totalPages}` : ''}</span>
        <Button disabled={locked || !page.data || number >= totalPages} onClick={() => setNumber((value) => value + 1)}>Sonraki</Button>
      </div></footer>
    </Section>
    {dialog && <UserDialog key={`${dialog.type}:${dialog.user?.id ?? 'new'}`} mode={dialog.type} user={dialog.user} onClose={closeDialog} onSave={save} />}
  </>;
}

function UserDialog({ mode, user, onClose, onSave }) {
  const [form, setForm] = useState(() => initialForm(user));
  const [confirmation, setConfirmation] = useState('');
  const [discard, setDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pending = useRef(false); const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const deleting = mode === 'delete';
  const baseline = initialForm(user);
  const dirty = deleting ? confirmation.length > 0 : Object.keys(form).some((key) => form[key] !== baseline[key]);
  useUnsavedChanges(dirty || busy);
  const reload = mustReload(error);
  function close() {
    if (pending.current) return;
    if (discard) setDiscard(false);
    else if (dirty && !reload) setDiscard(true);
    else onClose();
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
  return <Modal title={deleting ? 'Kullanıcıyı sil' : user ? 'Kullanıcıyı düzenle' : 'Kullanıcı ekle'} onClose={close} busy={busy}>
    {discard ? <><p>Kaydedilmemiş değişiklikleriniz silinecek. Formu kapatmak istiyor musunuz?</p><footer className="ws-modal-footer">
      <Button onClick={() => setDiscard(false)}>Düzenlemeye dön</Button><Button variant="danger" onClick={onClose}>Değişiklikleri bırak</Button>
    </footer></> : <form className="ws-form" onSubmit={submit}>
      <ErrorNotice error={error ? userAdminMessage(error) : null} />
      {reload && <p role="alert">İşlemi yeniden göndermeyin. Formu kapatıp listeyi kontrol edin; gerekiyorsa güncel kaydı yeniden açın.</p>}
      <fieldset disabled={busy || reload}>
        {deleting ? <>
          <p><strong>{user.username}</strong> hesabı, oturumları ve MFA bilgileri kalıcı olarak silinecek. Web siteleri ve uygulamalar silinmez. Son aktif Owner silinemez.</p>
          <label>Onaylamak için {user.username} yazın<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} required /></label>
        </> : <>
          <div className="ws-form-grid"><label>Kullanıcı adı<input name="username" value={form.username} onChange={(event) => update('username', event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={128} required /><span className="ws-field-hint">3–128 karakter; harf, rakam ve . _ @ + - kullanılabilir.</span></label>
            {!user && <label>İlk parola<input type="password" name="new-password" value={form.password} onChange={(event) => update('password', event.target.value)} autoComplete="new-password" minLength={12} required /><span className="ws-field-hint">En az 12 karakter. Parola daha sonra listelenmez; güvenli bir kanaldan paylaşın.</span></label>}
            <label>Rol<select value={form.role} onChange={(event) => update('role', event.target.value)}><option value="owner">Owner — tam yönetim</option><option value="read_only">Read Only — yalnız kendi hesabı</option></select></label>
            <label>Hesap durumu<select value={String(form.active)} onChange={(event) => update('active', event.target.value === 'true')}><option value="true">Aktif</option><option value="false">Devre dışı</option></select></label>
          </div>
          <p className="ws-muted">{user ? 'Kullanıcı adı, rol veya durum değişirse bu hesabın bütün oturumları ve bekleyen giriş doğrulamaları iptal edilir. Kendi hesabınızı değiştirirseniz yeniden giriş gerekir.' : 'Yeni Owner hesabı, ilk HTTPS girişinde iki adımlı doğrulamayı kurmadan yönetim ekranlarına erişemez.'}</p>
          {form.role === 'read_only' && <p className="ws-muted">Read Only bu sürümde site, sunucu, log veya kullanıcı listesini görüntüleyemez. Kaynak bazlı izinler henüz uygulanmadı.</p>}
        </>}
      </fieldset>
      <footer className="ws-modal-footer"><Button disabled={busy} onClick={close}>{reload ? 'Kapat ve listeyi yenile' : 'Vazgeç'}</Button>
        <Button type="submit" variant={deleting ? 'danger' : 'primary'} disabled={busy || reload || (deleting ? confirmation !== user.username : !dirty)}>{busy ? 'İşleniyor…' : deleting ? 'Hesabı sil' : user ? 'Değişiklikleri kaydet' : 'Hesap oluştur'}</Button>
      </footer>
    </form>}
  </Modal>;
}
