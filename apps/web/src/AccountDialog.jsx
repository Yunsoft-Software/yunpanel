import { useEffect, useRef, useState } from 'react';
import { authRequest } from './session-client.js';
import { endAuthenticatedSession, getRecoveryEmail, setRecoveryEmail } from './auth-protocol.js';
import { authMessage } from './auth-message.js';
import MfaSettings from './MfaSettings.jsx';

export default function AccountDialog({ session, onClose, onSession, onSignedOut }) {
  const dialog = useRef(null);
  const pending = useRef(null);
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mfaBusy, setMfaBusy] = useState(false);
  const [sensitive, setSensitive] = useState(false);
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '', confirmation: '' });
  const [recoveryEmail, setRecoveryEmailState] = useState(session.user?.email ?? '');
  const [recoveryNotice, setRecoveryNotice] = useState('');
  const isOwner = session.user?.role === 'owner';
  const locked = busy || mfaBusy || sensitive;

  useEffect(() => {
    const el = dialog.current;
    const previous = document.activeElement;
    if (el && !el.open) {
      if (typeof el.showModal === 'function') {
        try { el.showModal(); } catch {}
      } else {
        el.setAttribute('open', '');
      }
    }
    const focusable = el ? Array.from(el.querySelectorAll('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')) : [];
    const initial = el?.querySelector('[autofocus]') || focusable[0];
    if (initial && typeof initial.focus === 'function') {
      try { initial.focus(); } catch {}
    }
    return () => {
      pending.current?.abort();
      if (el && el.open) {
        if (typeof el.close === 'function') {
          try { el.close(); } catch {}
        } else {
          el.removeAttribute('open');
        }
      }
      if (previous && typeof previous.focus === 'function') {
        try { previous.focus({ preventScroll: true }); } catch {}
      }
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    authRequest('sessions', { signal: controller.signal }).then(setSessions).catch((failure) => { if (failure.name !== 'AbortError') setError(authMessage(failure)); });
    return () => controller.abort();
  }, [session.id]);

  useEffect(() => {
    if (!isOwner) return undefined;
    const controller = new AbortController();
    getRecoveryEmail(controller.signal)
      .then((data) => {
        if (data?.email) setRecoveryEmailState(data.email);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [session.id, isOwner]);

  function close(event) {
    if (locked) { event?.preventDefault(); return; }
    onClose();
  }

  async function execute(operation) {
    if (locked || pending.current) return;
    const controller = new AbortController(); pending.current = controller; setBusy(true); setError('');
    try { await operation(controller.signal); }
    catch (failure) { if (failure.name !== 'AbortError') setError(authMessage(failure)); }
    finally { if (pending.current === controller) pending.current = null; if (!controller.signal.aborted) setBusy(false); }
  }

  function changePassword(event) {
    event.preventDefault();
    if (passwords.newPassword !== passwords.confirmation) { setError('Yeni parolalar eşleşmiyor.'); return; }
    execute(async (signal) => {
      await endAuthenticatedSession('password', { currentPassword: passwords.currentPassword, newPassword: passwords.newPassword }, signal);
      setPasswords({ currentPassword: '', newPassword: '', confirmation: '' });
      onSignedOut('Parolanız değiştirildi. Yeni parolanızla giriş yapın.');
    });
  }

  function saveRecoveryEmail(event) {
    event.preventDefault();
    setRecoveryNotice('');
    execute(async (signal) => {
      const result = await setRecoveryEmail(recoveryEmail, signal);
      setRecoveryEmailState(result?.email ?? '');
      setRecoveryNotice(result?.email ? 'Kurtarma e-postası başarıyla güncellendi.' : 'Kurtarma e-postası kaldırıldı.');
      if (onSession) {
        onSession({
          ...session,
          user: {
            ...session.user,
            email: result?.email ?? null,
            emailVerified: result?.verified ?? false,
          },
        });
      }
    });
  }

  function revoke(target) {
    execute(async (signal) => {
      if (target.current) { await endAuthenticatedSession('logout', undefined, signal); onSignedOut(); }
      else {
        await authRequest(`sessions/${target.id}`, { method: 'DELETE', signal });
        setSessions(await authRequest('sessions', { signal }));
      }
    });
  }

  const handleKeyDown = (event) => {
    if (event.key === 'Escape') {
      if (locked) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Tab') {
      const el = dialog.current;
      if (!el) return;
      const focusable = Array.from(el.querySelectorAll('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'));
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      if (focusable.length === 1) {
        event.preventDefault();
        focusable[0].focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!el.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    }
  };

  return <dialog ref={dialog} className="auth-dialog" aria-modal="true" aria-labelledby="account-heading" onKeyDown={handleKeyDown} onCancel={close} onClose={close}>
    <header><h2 id="account-heading">Hesabım</h2><button type="button" disabled={locked} onClick={close}>Kapat</button></header>
    {error && <p className="auth-error" role="alert">{error}</p>}
    {sensitive && <p className="auth-notice" role="status">Pencereyi kapatmadan önce kurtarma kodlarını aşağıdan kaydedip onaylayın.</p>}
    <form onSubmit={changePassword}>
      <h3>Parolayı değiştir</h3><p className="auth-muted">Değişiklikten sonra tüm oturumlarınız kapatılır.</p>
      <fieldset disabled={locked}>
        {[['currentPassword', 'Mevcut parola'], ['newPassword', 'Yeni parola'], ['confirmation', 'Yeni parola tekrarı']].map(([key, label]) => <label key={key}>{label}<input type="password" required minLength={key === 'currentPassword' ? undefined : 12} maxLength={1024} autoComplete={key === 'currentPassword' ? 'current-password' : 'new-password'} value={passwords[key]} onChange={(event) => setPasswords((current) => ({ ...current, [key]: event.target.value }))} /></label>)}
        <button type="submit" className="auth-primary">{busy ? 'İşleniyor…' : 'Parolayı değiştir'}</button>
      </fieldset>
    </form>
    {isOwner && <form onSubmit={saveRecoveryEmail}>
      <h3>Kurtarma E-postası</h3>
      <p className="auth-muted">Owner parola sıfırlama bağlantıları bu adrese gönderilir. Bu adres ACME veya site e-postalarından bağımsızdır.</p>
      {recoveryNotice && <p className="auth-notice" role="status">{recoveryNotice}</p>}
      <fieldset disabled={locked}>
        <label>E-posta adresi
          <input
            type="email"
            value={recoveryEmail}
            onChange={(event) => setRecoveryEmailState(event.target.value)}
            placeholder="owner@example.com"
          />
        </label>
        <button type="submit" className="auth-primary">{busy ? 'İşleniyor…' : 'Kurtarma E-postasını Kaydet'}</button>
      </fieldset>
    </form>}
    <fieldset disabled={busy} className="mfa-container"><MfaSettings onSession={onSession} onSignedOut={onSignedOut} onBusy={setMfaBusy} onSensitive={setSensitive} /></fieldset>
    <section className="auth-sessions"><h3>Aktif oturumlar</h3>{sessions === null ? <p role="status">{error ? 'Oturumlar alınamadı.' : 'Yükleniyor…'}</p> : sessions.map((target) => <div key={target.id}><span>{target.current ? 'Bu oturum' : 'Diğer oturum'}<small>{new Date(target.createdAt).toLocaleString()}</small></span><button type="button" disabled={locked} onClick={() => revoke(target)}>Sonlandır</button></div>)}</section>
  </dialog>;
}
