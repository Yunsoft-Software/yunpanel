import { useEffect, useRef, useState } from 'react';
import { authRequest } from './session-client.js';
import { endAuthenticatedSession, proofInput, rotateMfa } from './auth-protocol.js';
import { authMessage } from './auth-message.js';

export default function MfaSettings({ onSession, onSignedOut, onBusy, onSensitive }) {
  const [status, setStatus] = useState(null);
  const [enrollment, setEnrollment] = useState(null);
  const [codes, setCodes] = useState(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [method, setMethod] = useState('totp');
  const [action, setAction] = useState('recovery');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const active = useRef(null);
  const confirmInput = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    authRequest('mfa', { signal: controller.signal }).then(setStatus).catch((failure) => { if (failure.name !== 'AbortError') setError(authMessage(failure)); });
    return () => { controller.abort(); active.current?.abort(); };
  }, []);
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  useEffect(() => { onSensitive(Boolean(codes)); return () => onSensitive(false); }, [codes, onSensitive]);
  useEffect(() => { if (enrollment) confirmInput.current?.focus(); }, [enrollment]);

  async function execute(operation) {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setError(''); setCopied(false);
    try { await operation(controller.signal); }
    catch (failure) { if (failure.name !== 'AbortError') setError(authMessage(failure)); }
    finally {
      setPassword(''); setCode('');
      if (active.current === controller) active.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  function start(event) {
    event.preventDefault();
    execute(async (signal) => {
      const result = await authRequest('mfa/enroll', { method: 'POST', body: { password }, signal });
      if (typeof result?.secret !== 'string' || !/^[A-Z2-7]+$/.test(result.secret) || !Number.isFinite(result.expiresAt)) throw new Error('Kurulum anahtarı alınamadı.');
      // Do not retain the OTP URI or send secrets to external QR/image services.
      setEnrollment({ secret: result.secret, expiresAt: result.expiresAt });
    });
  }
  function confirm(event) {
    event.preventDefault();
    execute(async (signal) => {
      const result = await rotateMfa('mfa/confirm', proofInput(code), signal);
      onSession(result.session);
      setEnrollment(null); setCodes(result.recoveryCodes);
      setStatus({ enabled: true, keyConfigured: true, recoveryCodesRemaining: result.recoveryCodes.length });
    });
  }
  function change(event) {
    event.preventDefault();
    execute(async (signal) => {
      const body = { password, ...proofInput(code, method) };
      if (action === 'disable') {
        await endAuthenticatedSession('mfa/disable', body, signal);
        onSignedOut('İki adımlı doğrulama kapatıldı. Yeniden giriş yapın.');
      } else {
        const result = await rotateMfa('mfa/recovery', body, signal);
        onSession(result.session); setCodes(result.recoveryCodes);
        setStatus((current) => ({ ...current, recoveryCodesRemaining: result.recoveryCodes.length }));
      }
    });
  }
  function cancelEnrollment() {
    execute(async (signal) => {
      await authRequest('mfa/enroll/cancel', { method: 'POST', signal });
      setEnrollment(null);
    });
  }
  async function copySecret() {
    try { await navigator.clipboard.writeText(enrollment.secret); setCopied(true); }
    catch { setError('Otomatik kopyalanamadı. Anahtarı seçip elle kopyalayabilirsiniz.'); }
  }

  return <section className="mfa-settings" aria-labelledby="mfa-heading">
    <h3 id="mfa-heading">İki adımlı doğrulama</h3>
    {error && <p className="auth-error" role="alert">{error}</p>}
    {codes ? <div className="mfa-recovery">
      <h4>Kurtarma kodlarını saklayın</h4>
      <p className="auth-muted">Bu kodlar yalnızca şimdi gösterilir. Güvenli bir parola yöneticisine kaydedin. Her kod bir kez kullanılabilir; önceki kodlar artık geçersizdir.</p>
      <textarea aria-label="Tek kullanımlık kurtarma kodları" readOnly rows={10} value={codes.join('\n')} spellCheck={false} />
      <button type="button" className="auth-primary" onClick={() => setCodes(null)}>Kodları güvenle kaydettim</button>
    </div> : !status ? <>
      {!error && <p role="status">Doğrulama durumu yükleniyor…</p>}
      {error && <button className="auth-secondary" disabled={busy} onClick={() => execute(async (signal) => setStatus(await authRequest('mfa', { signal })))}>Tekrar dene</button>}
    </> : enrollment ? <form onSubmit={confirm}>
      <p className="auth-muted">Doğrulayıcı uygulamanıza yeni hesap ekleyin. Anahtar türü: zamana dayalı (TOTP), 6 hane, 30 saniye. Sonra uygulamanın ürettiği kodu girin.</p>
      <label>Kurulum anahtarı<input className="mfa-secret" type="text" value={enrollment.secret} readOnly autoComplete="off" spellCheck={false} /></label>
      <button type="button" className="auth-secondary" onClick={copySecret}>{copied ? 'Kopyalandı' : 'Anahtarı kopyala'}</button>
      <p className="auth-muted">Kurulum sonu: {new Date(enrollment.expiresAt).toLocaleTimeString()}. Anahtarı kimseyle paylaşmayın.</p>
      <fieldset disabled={busy}>
        <label>Uygulama kodu<input ref={confirmInput} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value)} required /></label>
        <button type="submit" className="auth-primary">Doğrula ve etkinleştir</button>
        <button type="button" className="auth-secondary" onClick={cancelEnrollment}>Kurulumu iptal et</button>
      </fieldset>
    </form> : !status.enabled ? <form onSubmit={start}>
      <p className="auth-muted">Girişte parolanıza ek olarak uygulamanızdaki tek kullanımlık kod sorulur.</p>
      {!status.keyConfigured && <p className="auth-notice">Sunucuda MFA şifreleme anahtarı yapılandırılmalı. Yerel yönetici ayarı tamamlanana kadar etkinleştirme kapalıdır.</p>}
      <fieldset disabled={busy || !status.keyConfigured}>
        <label>Mevcut parola<input type="password" autoComplete="current-password" maxLength={1024} value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        <button className="auth-primary" type="submit">Doğrulayıcı ekle</button>
      </fieldset>
    </form> : <form onSubmit={change}>
      <p className="auth-notice">Etkin · {status.recoveryCodesRemaining} kullanılmamış kurtarma kodu</p>
      <fieldset disabled={busy}>
        <label>İşlem<select value={action} onChange={(event) => { setAction(event.target.value); setCode(''); }}><option value="recovery">Yeni kurtarma kodları üret</option><option value="disable">İki adımlı doğrulamayı kapat</option></select></label>
        <p className="auth-muted">{action === 'disable' ? 'Doğrulayıcıyı değiştirmek için önce kapatın, yeniden giriş yapıp yeni doğrulayıcı ekleyin. Bu işlem tüm oturumları kapatır.' : 'Önceki kurtarma kodları ve diğer oturumlar iptal edilir.'}</p>
        <label>Mevcut parola<input type="password" autoComplete="current-password" maxLength={1024} value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        <label>Doğrulama yöntemi<select value={method} onChange={(event) => { setMethod(event.target.value); setCode(''); }}><option value="totp">Doğrulayıcı uygulama</option><option value="recovery">Kurtarma kodu</option></select></label>
        <label>{method === 'totp' ? '6 haneli kod' : 'Kurtarma kodu'}<input type="text" autoComplete="one-time-code" inputMode={method === 'totp' ? 'numeric' : 'text'} maxLength={method === 'totp' ? 6 : 64} pattern={method === 'totp' ? '[0-9]{6}' : undefined} value={code} onChange={(event) => setCode(event.target.value)} required /></label>
        <button className="auth-primary" type="submit">{busy ? 'İşleniyor…' : action === 'disable' ? 'Doğrulamayı kapat ve çıkış yap' : 'Yeni kodları oluştur'}</button>
      </fieldset>
    </form>}
  </section>;
}
