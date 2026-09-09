import { useEffect, useRef, useState } from 'react';
import { authRequest } from './session-client.js';
import { passwordLogin, verifyMfa } from './auth-protocol.js';
import { authMessage } from './auth-message.js';

export default function LoginForm({ setupRequired, notice, onLogin, onSetup }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [challenge, setChallenge] = useState(null);
  const [code, setCode] = useState('');
  const [method, setMethod] = useState('totp');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now);
  const pending = useRef(null);
  const codeInput = useRef(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (!challenge) return undefined;
    codeInput.current?.focus();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [challenge]);

  async function submit(event) {
    event.preventDefault();
    if (pending.current) return;
    setError('');
    if (setupRequired && password !== confirmation) { setError('Parolalar eşleşmiyor.'); return; }
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    try {
      if (challenge) {
        const session = await verifyMfa(code, method, controller.signal);
        setCode('');
        onLogin(session);
      } else if (setupRequired) {
        await authRequest('setup', { method: 'POST', body: { username, password, setupToken }, signal: controller.signal, notifyExpired: false });
        setPassword(''); setConfirmation(''); setSetupToken('');
        onSetup();
      } else {
        const outcome = await passwordLogin(username, password, controller.signal);
        setPassword('');
        if (outcome.status === 'mfa') { setNow(Date.now()); setChallenge(outcome); }
        else onLogin(outcome.session);
      }
    } catch (failure) {
      if (failure.name !== 'AbortError') {
        setError(authMessage(failure));
        if (challenge) setCode('');
        if (failure.code === 'mfa_challenge_expired') setChallenge(null);
      }
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function cancel() {
    if (pending.current) return;
    const controller = new AbortController(); pending.current = controller; setBusy(true);
    try {
      await authRequest('mfa/cancel', { method: 'POST', signal: controller.signal, notifyExpired: false });
      setChallenge(null); setCode(''); setMethod('totp'); setError('');
    } catch (failure) { if (failure.name !== 'AbortError') setError(authMessage(failure)); }
    finally { if (pending.current === controller) pending.current = null; if (!controller.signal.aborted) setBusy(false); }
  }
  const expired = challenge && challenge.expiresAt <= now;
  return <main className="auth-page">
    <section className="auth-intro" aria-label="YunPanel">
      <div className="auth-brand"><span>Y</span> YunPanel</div>
      <div><p className="auth-eyebrow">YUNSOFT · SUNUCU YÖNETİMİ</p><h1>Kontrol sizde.</h1><p>Web sitelerinizi ve sunucu işlemlerinizi kendi yönetim panelinizden takip edin.</p></div>
      <small>Yalnızca yetkilendirilmiş kullanıcılar içindir.</small>
    </section>
    <section className="auth-form-panel">
      <form className="auth-form" onSubmit={submit} aria-labelledby="auth-heading">
        <p className="auth-eyebrow">{challenge ? 'İKİ ADIMLI DOĞRULAMA' : setupRequired ? 'İLK KURULUM' : 'GÜVENLİ ERİŞİM'}</p>
        <h2 id="auth-heading">{challenge ? 'Girişinizi doğrulayın' : setupRequired ? 'Owner hesabını oluşturun' : 'YunPanel’e giriş yapın'}</h2>
        <p className="auth-muted">{challenge ? 'Parolanız doğrulandı. Hesabınıza erişmek için ikinci adımı tamamlayın.' : setupRequired ? 'Sunucu yöneticisinin ürettiği, 10 dakika geçerli kurulum anahtarı gereklidir.' : 'Devam etmek için yönetici hesabınızı kullanın.'}</p>
        {notice && <p className="auth-notice" role="status">{notice}</p>}
        {error && <p className="auth-error" role="alert" id="auth-error">{error}</p>}
        {expired && <p className="auth-error" role="alert">Doğrulama süresi doldu. Girişe dönüp yeniden başlayın.</p>}
        <fieldset disabled={busy}>
          {challenge ? <>
            <label>Doğrulama yöntemi<select value={method} onChange={(event) => { setMethod(event.target.value); setCode(''); setError(''); }}><option value="totp">Doğrulayıcı uygulama</option><option value="recovery">Kurtarma kodu</option></select></label>
            <label>{method === 'totp' ? '6 haneli kod' : 'Tek kullanımlık kurtarma kodu'}<input ref={codeInput} type="text" inputMode={method === 'totp' ? 'numeric' : 'text'} autoComplete="one-time-code" autoCapitalize="none" spellCheck={false} maxLength={method === 'totp' ? 6 : 64} pattern={method === 'totp' ? '[0-9]{6}' : undefined} value={code} onChange={(event) => setCode(event.target.value)} required /></label>
            <button className="auth-primary" disabled={expired} type="submit">{busy ? 'Doğrulanıyor…' : 'Doğrula ve giriş yap'}</button>
            <button type="button" className="auth-secondary" onClick={cancel}>Girişe dön</button>
          </> : <>
            {setupRequired && <label>Kurulum anahtarı<input type="password" value={setupToken} onChange={(event) => setSetupToken(event.target.value)} required autoComplete="off" maxLength={128} /></label>}
            <label>Kullanıcı adı<input name="username" value={username} onChange={(event) => setUsername(event.target.value)} required autoComplete="username" autoCapitalize="none" spellCheck={false} minLength={3} maxLength={128} /></label>
            <label>Parola<input name="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete={setupRequired ? 'new-password' : 'current-password'} minLength={setupRequired ? 12 : undefined} maxLength={1024} aria-describedby={error ? 'auth-error' : undefined} /></label>
            {setupRequired && <label>Parolayı tekrar girin<input type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required autoComplete="new-password" minLength={12} maxLength={1024} /></label>}
            <button className="auth-primary" type="submit">{busy ? 'İşleniyor…' : setupRequired ? 'Owner hesabını oluştur' : 'Giriş yap'}</button>
          </>}
        </fieldset>
        <p className="auth-help">Hesabınıza erişemiyorsanız sunucu yöneticiniz yerel kurtarma komutlarını kullanabilir.</p>
      </form>
    </section>
  </main>;
}
