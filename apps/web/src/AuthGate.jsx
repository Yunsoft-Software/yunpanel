import { useCallback, useEffect, useRef, useState } from 'react';
import { authRequest, setSession } from './session-client.js';
import './auth.css';

function message(error) {
  const messages = {
    invalid_credentials: 'Kullanıcı adı, parola veya kurulum anahtarı geçersiz.',
    rate_limited: 'Çok fazla deneme yapıldı. Bir süre sonra tekrar deneyin.',
    auth_busy: 'Giriş hizmeti meşgul. Tekrar deneyin.',
    invalid_password: 'Parolanız en az 12 karakter olmalıdır.',
    already_configured: 'İlk kurulum tamamlanmış. Sayfayı yenileyip giriş yapın.',
    origin_forbidden: 'Panel adresi sunucu ayarıyla eşleşmiyor. Yöneticiniz public origin ayarını kontrol etmeli.',
    csrf_invalid: 'Oturum doğrulanamadı. Sayfayı yenileyin.',
  };
  return messages[error.code] ?? (error instanceof TypeError ? 'Sunucuya ulaşılamadı. Bağlantınızı kontrol edin.' : error.message);
}

export default function AuthGate({ children }) {
  const [state, update] = useState({ status: 'checking', session: null, setupRequired: false });
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [accountOpen, setAccountOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const activityAt = useRef(0);
  const requestVersion = useRef(0);

  const accept = useCallback((session) => {
    setSession(session);
    update({ status: 'ready', session, setupRequired: false });
    setActionError('');
  }, []);
  const signedOut = useCallback((text = 'Oturumunuz kapatıldı.') => {
    requestVersion.current += 1;
    setSession(null);
    setAccountOpen(false);
    setNotice(text);
    update({ status: 'anonymous', session: null, setupRequired: false });
  }, []);
  const refresh = useCallback(async (signal) => {
    const version = ++requestVersion.current;
    try {
      const session = await authRequest('session', { signal, notifyExpired: false });
      if (version === requestVersion.current && !signal?.aborted) accept(session);
    } catch (error) {
      if (signal?.aborted || version !== requestVersion.current) return;
      setSession(null);
      update(error.status === 401
        ? { status: 'anonymous', session: null, setupRequired: error.setupRequired }
        : { status: 'error', session: null, setupRequired: false, error: message(error) });
    }
  }, [accept]);

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal);
    const expired = () => signedOut('Oturumunuzun süresi doldu. Tekrar giriş yapın.');
    window.addEventListener('yunpanel:session-expired', expired);
    return () => { controller.abort(); window.removeEventListener('yunpanel:session-expired', expired); };
  }, [refresh, signedOut]);

  useEffect(() => {
    if (state.status !== 'ready') return undefined;
    const controller = new AbortController();
    const timer = setInterval(() => refresh(controller.signal), 60_000);
    const activity = (event) => {
      if (!event.isTrusted || document.visibilityState !== 'visible' || Date.now() - activityAt.current < 60_000) return;
      activityAt.current = Date.now();
      authRequest('keep-alive', { method: 'POST', signal: controller.signal }).catch(() => {});
    };
    window.addEventListener('pointerdown', activity);
    window.addEventListener('keydown', activity);
    return () => {
      controller.abort(); clearInterval(timer);
      window.removeEventListener('pointerdown', activity); window.removeEventListener('keydown', activity);
    };
  }, [state.status, refresh]);

  async function logout() {
    setBusy(true); setActionError('');
    try { await authRequest('logout', { method: 'POST' }); signedOut(); }
    catch (error) { setActionError(message(error)); }
    finally { setBusy(false); }
  }

  if (state.status === 'checking') return <div className="auth-loading" role="status">Oturum kontrol ediliyor…</div>;
  if (state.status === 'error') return <div className="auth-loading"><h1>Panele bağlanılamadı</h1><p role="alert">{state.error}</p><button className="auth-primary" onClick={() => refresh()}>Tekrar dene</button></div>;
  if (state.status === 'anonymous') return <LoginForm setupRequired={state.setupRequired} notice={notice} onLogin={(session) => { requestVersion.current += 1; accept(session); setNotice(''); }} onSetup={() => { setNotice('Kurulum tamamlandı. Yeni hesabınızla giriş yapın.'); update({ status: 'anonymous', session: null, setupRequired: false }); }} />;

  return <div className="authenticated-panel">
    <div className="auth-sessionbar" aria-label="Hesap işlemleri">
      <span>YunPanel <span className="auth-separator">/</span> Yönetim</span>
      <div><span>{state.session.user.username}</span><span className="auth-role">{state.session.user.role === 'owner' ? 'Owner' : 'Read Only'}</span><button onClick={() => setAccountOpen(true)}>Hesabım</button><button disabled={busy} onClick={logout}>{busy ? 'Çıkılıyor…' : 'Çıkış yap'}</button></div>
    </div>
    {actionError && <p className="auth-banner" role="alert">{actionError}</p>}
    {children}
    {accountOpen && <AccountDialog onClose={() => setAccountOpen(false)} onSignedOut={signedOut} />}
  </div>;
}

function LoginForm({ setupRequired, notice, onLogin, onSetup }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault(); setError('');
    if (setupRequired && password !== confirmation) { setError('Parolalar eşleşmiyor.'); return; }
    setBusy(true);
    try {
      const result = await authRequest(setupRequired ? 'setup' : 'login', { method: 'POST', body: { username, password, ...(setupRequired ? { setupToken } : {}) }, notifyExpired: false });
      setPassword(''); setConfirmation(''); setSetupToken('');
      if (setupRequired) onSetup(); else onLogin(result);
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  return <main className="auth-page">
    <section className="auth-intro" aria-label="YunPanel">
      <div className="auth-brand"><span>Y</span> YunPanel</div>
      <div><p className="auth-eyebrow">YUNSOFT · SUNUCU YÖNETİMİ</p><h1>Kontrol sizde.</h1><p>Web sitelerinizi ve sunucu işlemlerinizi kendi yönetim panelinizden takip edin.</p></div>
      <small>Yalnızca yetkilendirilmiş kullanıcılar içindir.</small>
    </section>
    <section className="auth-form-panel">
      <form className="auth-form" onSubmit={submit} aria-labelledby="auth-heading">
        <p className="auth-eyebrow">{setupRequired ? 'İLK KURULUM' : 'GÜVENLİ ERİŞİM'}</p>
        <h2 id="auth-heading">{setupRequired ? 'Owner hesabını oluşturun' : 'YunPanel’e giriş yapın'}</h2>
        <p className="auth-muted">{setupRequired ? 'Sunucu yöneticisinin yerel komutla ürettiği, 10 dakika geçerli kurulum anahtarı gereklidir.' : 'Devam etmek için yönetici hesabınızı kullanın.'}</p>
        {notice && <p className="auth-notice" role="status">{notice}</p>}
        {error && <p className="auth-error" role="alert" id="auth-error">{error}</p>}
        <fieldset disabled={busy}>
          {setupRequired && <label>Kurulum anahtarı<input type="password" value={setupToken} onChange={(e) => setSetupToken(e.target.value)} required autoComplete="off" maxLength={128} /></label>}
          <label>Kullanıcı adı<input name="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="username" autoCapitalize="none" spellCheck={false} minLength={3} maxLength={128} /></label>
          <label>Parola<input name="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete={setupRequired ? 'new-password' : 'current-password'} minLength={setupRequired ? 12 : undefined} maxLength={1024} aria-describedby={error ? 'auth-error' : undefined} /></label>
          {setupRequired && <label>Parolayı tekrar girin<input type="password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} required autoComplete="new-password" minLength={12} maxLength={1024} /></label>}
          <button className="auth-primary" type="submit">{busy ? 'İşleniyor…' : setupRequired ? 'Owner hesabını oluştur' : 'Giriş yap'}</button>
        </fieldset>
        <p className="auth-help">Parolanızı unuttuysanız sunucu yöneticiniz yerel kurtarma komutuyla sıfırlayabilir.</p>
      </form>
    </section>
  </main>;
}

function AccountDialog({ onClose, onSignedOut }) {
  const dialog = useRef(null);
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '', confirmation: '' });
  useEffect(() => {
    const controller = new AbortController();
    if (!dialog.current.open) dialog.current.showModal();
    authRequest('sessions', { signal: controller.signal }).then(setSessions).catch((failure) => { if (!controller.signal.aborted) setError(message(failure)); });
    return () => controller.abort();
  }, []);
  async function changePassword(event) {
    event.preventDefault(); setError('');
    if (passwords.newPassword !== passwords.confirmation) { setError('Yeni parolalar eşleşmiyor.'); return; }
    setBusy(true);
    try { await authRequest('password', { method: 'POST', body: { currentPassword: passwords.currentPassword, newPassword: passwords.newPassword } }); onSignedOut('Parolanız değiştirildi. Yeni parolanızla giriş yapın.'); }
    catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  async function revoke(session) {
    setBusy(true); setError('');
    try {
      await authRequest(`sessions/${session.id}`, { method: 'DELETE' });
      if (session.current) onSignedOut(); else setSessions(await authRequest('sessions'));
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="auth-dialog" aria-labelledby="account-heading" onCancel={onClose} onClose={onClose}>
    <header><h2 id="account-heading">Hesabım</h2><button type="button" onClick={onClose} aria-label="Hesap penceresini kapat">Kapat</button></header>
    {error && <p className="auth-error" role="alert">{error}</p>}
    <form onSubmit={changePassword}>
      <h3>Parolayı değiştir</h3><p className="auth-muted">Değişiklikten sonra tüm oturumlarınız kapatılır.</p>
      <fieldset disabled={busy}>
        {[['currentPassword', 'Mevcut parola'], ['newPassword', 'Yeni parola'], ['confirmation', 'Yeni parola tekrarı']].map(([key, label]) => <label key={key}>{label}<input type="password" required minLength={key === 'currentPassword' ? undefined : 12} maxLength={1024} autoComplete={key === 'currentPassword' ? 'current-password' : 'new-password'} value={passwords[key]} onChange={(e) => setPasswords({ ...passwords, [key]: e.target.value })} /></label>)}
        <button type="submit" className="auth-primary">{busy ? 'İşleniyor…' : 'Parolayı değiştir'}</button>
      </fieldset>
    </form>
    <section className="auth-sessions"><h3>Aktif oturumlar</h3>{sessions === null ? <p role="status">Yükleniyor…</p> : sessions.map((session) => <div key={session.id}><span>{session.current ? 'Bu oturum' : 'Diğer oturum'}<small>{new Date(session.createdAt).toLocaleString()}</small></span><button type="button" disabled={busy} onClick={() => revoke(session)}>Sonlandır</button></div>)}</section>
  </dialog>;
}
