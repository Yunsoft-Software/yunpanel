import { useEffect, useState } from 'react';
import { authRequest } from './session-client.js';
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

  useEffect(() => {
    if (!challenge) return undefined;
    const timer = setTimeout(() => {
      setChallenge(null); setCode('');
      setError('Doğrulama süresi doldu. Yeniden giriş yapın.');
    }, Math.max(0, challenge.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [challenge]);

  async function submit(event) {
    event.preventDefault(); setError('');
    if (setupRequired && password !== confirmation) { setError('Parolalar eşleşmiyor.'); return; }
    setBusy(true);
    try {
      if (challenge) {
        const session = await authRequest('mfa/verify', { method: 'POST', body: { code, method }, notifyExpired: false, changesSession: true });
        setCode(''); onLogin(session); return;
      }
      const result = await authRequest(setupRequired ? 'setup' : 'login', {
        method: 'POST', body: { username, password, ...(setupRequired ? { setupToken } : {}) },
        notifyExpired: false, changesSession: !setupRequired,
      });
      setPassword(''); setConfirmation(''); setSetupToken('');
      if (setupRequired) onSetup();
      else if (result.mfaRequired) { setChallenge({ expiresAt: result.expiresAt }); setMethod('totp'); }
      else onLogin(result);
    } catch (failure) {
      setError(authMessage(failure));
      if (failure.code === 'mfa_challenge_expired') { setChallenge(null); setCode(''); }
    } finally { setBusy(false); }
  }
  async function cancelChallenge() {
    setBusy(true); setError('');
    try { await authRequest('mfa/cancel', { method: 'POST', notifyExpired: false }); setChallenge(null); setCode(''); }
    catch (failure) { setError(authMessage(failure)); }
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
        <p className="auth-eyebrow">{setupRequired ? 'İLK KURULUM' : challenge ? 'İKİ AŞAMALI DOĞRULAMA' : 'GÜVENLİ ERİŞİM'}</p>
        <h2 id="auth-heading">{setupRequired ? 'Owner hesabını oluşturun' : challenge ? 'Girişinizi doğrulayın' : 'YunPanel’e giriş yapın'}</h2>
        <p className="auth-muted">{setupRequired ? 'Sunucu yöneticisinin yerel komutla ürettiği, 10 dakika geçerli kurulum anahtarı gereklidir.' : challenge ? 'Doğrulayıcı uygulamanızdaki kodu veya sakladığınız kurtarma kodlarından birini kullanın.' : 'Devam etmek için yönetici hesabınızı kullanın.'}</p>
        {notice && <p className="auth-notice" role="status">{notice}</p>}
        {error && <p className="auth-error" role="alert" id="auth-error">{error}</p>}
        <fieldset disabled={busy}>
          {challenge ? <>
            <label>Doğrulama yöntemi<select value={method} onChange={(e) => { setMethod(e.target.value); setCode(''); }}><option value="totp">Doğrulayıcı uygulaması</option><option value="recovery">Kurtarma kodu</option></select></label>
            <label>{method === 'totp' ? '6 haneli doğrulama kodu' : 'Kullanılmamış kurtarma kodu'}<input key={method} value={code} onChange={(e) => setCode(e.target.value)} type="text" inputMode={method === 'totp' ? 'numeric' : 'text'} autoComplete={method === 'totp' ? 'one-time-code' : 'off'} required pattern={method === 'totp' ? '[0-9]{6}' : undefined} maxLength={method === 'totp' ? 6 : 64} spellCheck={false} autoCapitalize="none" /></label>
            <button className="auth-primary" type="submit">{busy ? 'Doğrulanıyor…' : 'Doğrula ve giriş yap'}</button>
            <button className="mfa-secondary" type="button" onClick={cancelChallenge}>Giriş ekranına dön</button>
          </> : <>
            {setupRequired && <label>Kurulum anahtarı<input type="password" value={setupToken} onChange={(e) => setSetupToken(e.target.value)} required autoComplete="off" maxLength={128} /></label>}
            <label>Kullanıcı adı<input name="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="username" autoCapitalize="none" spellCheck={false} minLength={3} maxLength={128} /></label>
            <label>Parola<input name="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete={setupRequired ? 'new-password' : 'current-password'} minLength={setupRequired ? 12 : undefined} maxLength={1024} aria-describedby={error ? 'auth-error' : undefined} /></label>
            {setupRequired && <label>Parolayı tekrar girin<input type="password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} required autoComplete="new-password" minLength={12} maxLength={1024} /></label>}
            <button className="auth-primary" type="submit">{busy ? 'İşleniyor…' : setupRequired ? 'Owner hesabını oluştur' : 'Giriş yap'}</button>
          </>}
        </fieldset>
        <p className="auth-help">{challenge ? 'Telefonunuza ve kurtarma kodlarına erişiminiz yoksa sunucu yöneticiniz yerel MFA kurtarma komutunu kullanabilir.' : 'Parolanızı unuttuysanız sunucu yöneticiniz yerel kurtarma komutuyla sıfırlayabilir.'}</p>
      </form>
    </section>
  </main>;
}
