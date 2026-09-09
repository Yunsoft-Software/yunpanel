import { useCallback, useEffect, useRef, useState } from 'react';
import { authRequest, sessionTransitionPending, setSession } from './session-client.js';
import { endAuthenticatedSession, requireSession, sessionDeadline } from './auth-protocol.js';
import { authMessage } from './auth-message.js';
import LoginForm from './LoginForm.jsx';
import AccountDialog from './AccountDialog.jsx';
import OwnerEnrollment from './OwnerEnrollment.jsx';
import { ownerAccess } from './owner-access.js';
import './auth.css';
import './mfa.css';

export default function AuthGate({ children }) {
  const [state, update] = useState({ status: 'checking', session: null, setupRequired: false });
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [accountOpen, setAccountOpen] = useState(false);
  const [enrollmentOpen, setEnrollmentOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now);
  const activityAt = useRef(0);
  const requestVersion = useRef(0);
  const actionPending = useRef(false);

  const accept = useCallback((value) => {
    const session = requireSession(value);
    requestVersion.current += 1;
    setSession(session); setNow(Date.now());
    if (ownerAccess(session) === 'enrollment') { setEnrollmentOpen(true); setAccountOpen(false); }
    update({ status: 'ready', session, setupRequired: false });
    setActionError('');
  }, []);
  const signedOut = useCallback((text = 'Oturumunuz kapatıldı.') => {
    requestVersion.current += 1;
    setSession(null); setAccountOpen(false); setEnrollmentOpen(false); setNotice(text);
    update({ status: 'anonymous', session: null, setupRequired: false });
  }, []);
  const refresh = useCallback(async (signal, background = false) => {
    if (sessionTransitionPending()) return;
    const version = ++requestVersion.current;
    try {
      const session = await authRequest('session', { signal, notifyExpired: false });
      if (version === requestVersion.current && !signal?.aborted) accept(session);
    } catch (error) {
      if (error.name === 'AbortError' || signal?.aborted || version !== requestVersion.current) return;
      if (error.status === 401) {
        setSession(null); setAccountOpen(false); setEnrollmentOpen(false);
        update({ status: 'anonymous', session: null, setupRequired: error.setupRequired });
      } else if (background) setActionError(authMessage(error));
      else update({ status: 'error', session: null, setupRequired: false, error: authMessage(error) });
    }
  }, [accept]);

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal);
    const expired = () => signedOut('Oturumunuzun süresi doldu. Tekrar giriş yapın.');
    window.addEventListener('yunpanel:session-expired', expired);
    const restore = (event) => { if (event.persisted) refresh(controller.signal, true); };
    window.addEventListener('pageshow', restore);
    return () => { controller.abort(); window.removeEventListener('yunpanel:session-expired', expired); window.removeEventListener('pageshow', restore); };
  }, [refresh, signedOut]);

  useEffect(() => {
    if (state.status !== 'ready') return undefined;
    const controller = new AbortController();
    const timer = setInterval(() => refresh(controller.signal, true), 60_000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    const activity = (event) => {
      if (!event.isTrusted || document.visibilityState !== 'visible' || sessionTransitionPending() || Date.now() - activityAt.current < 60_000) return;
      activityAt.current = Date.now();
      const version = requestVersion.current;
      authRequest('keep-alive', { method: 'POST', signal: controller.signal }).then((session) => {
        if (version === requestVersion.current) accept(session);
      }).catch(() => {});
    };
    window.addEventListener('pointerdown', activity); window.addEventListener('keydown', activity);
    return () => { controller.abort(); clearInterval(timer); clearInterval(clock); window.removeEventListener('pointerdown', activity); window.removeEventListener('keydown', activity); };
  }, [state.status, accept, refresh]);

  useEffect(() => {
    if (state.status === 'ready' && sessionDeadline(state.session, now).expired && !sessionTransitionPending()) signedOut('Oturumunuzun süresi doldu. Tekrar giriş yapın.');
  }, [now, state, signedOut]);

  async function logout() {
    if (actionPending.current) return;
    actionPending.current = true; setBusy(true); setActionError('');
    try { await endAuthenticatedSession('logout'); signedOut(); }
    catch (error) { if (error.name !== 'AbortError') setActionError(authMessage(error)); }
    finally { actionPending.current = false; setBusy(false); }
  }
  async function extend() {
    if (actionPending.current || sessionTransitionPending()) return;
    actionPending.current = true; setBusy(true);
    try { accept(await authRequest('keep-alive', { method: 'POST' })); }
    catch (error) { if (error.name !== 'AbortError') setActionError(authMessage(error)); }
    finally { actionPending.current = false; setBusy(false); }
  }
  if (state.status === 'checking') return <div className="auth-loading" role="status">Oturum kontrol ediliyor…</div>;
  if (state.status === 'error') return <div className="auth-loading"><h1>Panele bağlanılamadı</h1><p role="alert">{state.error}</p><button className="auth-primary" onClick={() => refresh()}>Tekrar dene</button></div>;
  if (state.status === 'anonymous') return <LoginForm setupRequired={state.setupRequired} notice={notice} onLogin={(session) => { accept(session); setNotice(''); }} onSetup={() => { setNotice('Kurulum tamamlandı. Yeni hesabınızla giriş yapın.'); update({ status: 'anonymous', session: null, setupRequired: false }); }} />;
  const deadline = sessionDeadline(state.session, now);
  const access = ownerAccess(state.session);
  const showEnrollment = access === 'enrollment' || (access === 'management' && enrollmentOpen);
  return <div className="authenticated-panel">
    <div className="auth-sessionbar" aria-label="Hesap işlemleri">
      <span>YunPanel <span className="auth-separator">/</span> Yönetim</span>
      <div><span>{state.session.user.username}</span><span className="auth-role">{state.session.user.role === 'owner' ? 'Owner' : 'Read Only'}</span><button disabled={busy || showEnrollment} onClick={() => setAccountOpen(true)}>Hesabım</button><button disabled={busy} onClick={logout}>{busy ? 'İşleniyor…' : 'Çıkış yap'}</button></div>
    </div>
    {deadline.warning && <div className="auth-expiry" role="status"><span>{deadline.absolute ? 'Azami oturum süresi dolmak üzere. Yeniden giriş gerekecek.' : 'Oturumunuz hareketsizlik nedeniyle kapanmak üzere.'}</span>{!deadline.absolute && <button className="auth-secondary" disabled={busy} onClick={extend}>Oturumu uzat</button>}</div>}
    {actionError && <p className="auth-banner" role="alert">{actionError}</p>}
    {showEnrollment
      ? <OwnerEnrollment session={state.session} onSession={accept} onSignedOut={signedOut} onComplete={() => setEnrollmentOpen(false)} />
      : access === 'management'
        ? <div key={state.session.id}>{children}</div>
        : <main className="auth-loading"><h1>{access === 'unknown' ? 'Güvenlik durumu alınamadı' : 'Yönetim erişimi yok'}</h1><p role="alert">{access === 'unknown' ? 'Web arayüzü ve API sürümlerini kontrol edin. Yönetim ekranları güvenlik bilgisi doğrulanana kadar açılmaz.' : 'Bu hesap için sunucu yönetimi yetkisi tanımlı değil.'}</p><button className="auth-primary" onClick={() => refresh()}>Durumu yeniden kontrol et</button></main>}
    {accountOpen && <AccountDialog session={state.session} onClose={() => setAccountOpen(false)} onSession={accept} onSignedOut={signedOut} />}
  </div>;
}
