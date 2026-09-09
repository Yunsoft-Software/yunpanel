import { useEffect, useRef, useState } from 'react';
import { authRequest } from './session-client.js';
import { endAuthenticatedSession } from './auth-protocol.js';
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
  const locked = busy || mfaBusy || sensitive;
  useEffect(() => {
    if (!dialog.current.open) dialog.current.showModal();
    return () => pending.current?.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    authRequest('sessions', { signal: controller.signal }).then(setSessions).catch((failure) => { if (failure.name !== 'AbortError') setError(authMessage(failure)); });
    return () => controller.abort();
  }, [session.id]);
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
  function revoke(target) {
    execute(async (signal) => {
      if (target.current) { await endAuthenticatedSession('logout', undefined, signal); onSignedOut(); }
      else {
        await authRequest(`sessions/${target.id}`, { method: 'DELETE', signal });
        setSessions(await authRequest('sessions', { signal }));
      }
    });
  }
  return <dialog ref={dialog} className="auth-dialog" aria-labelledby="account-heading" onCancel={close} onClose={close}>
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
    <fieldset disabled={busy} className="mfa-container"><MfaSettings onSession={onSession} onSignedOut={onSignedOut} onBusy={setMfaBusy} onSensitive={setSensitive} /></fieldset>
    <section className="auth-sessions"><h3>Aktif oturumlar</h3>{sessions === null ? <p role="status">{error ? 'Oturumlar alınamadı.' : 'Yükleniyor…'}</p> : sessions.map((target) => <div key={target.id}><span>{target.current ? 'Bu oturum' : 'Diğer oturum'}<small>{new Date(target.createdAt).toLocaleString()}</small></span><button type="button" disabled={locked} onClick={() => revoke(target)}>Sonlandır</button></div>)}</section>
  </dialog>;
}
