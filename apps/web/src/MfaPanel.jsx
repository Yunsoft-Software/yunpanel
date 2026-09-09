import { useEffect, useState } from 'react';
import { authRequest } from './session-client.js';
import { authMessage } from './auth-message.js';

export default function MfaPanel({ onSessionChanged, onSignedOut, onBusyChange, onRecoveryVisibilityChange, disabled }) {
  const [status, setStatus] = useState(null);
  const [enrollment, setEnrollment] = useState(null);
  const [recoveryCodes, setRecoveryCodes] = useState(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [method, setMethod] = useState('totp');
  const [action, setAction] = useState('recovery');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    authRequest('mfa', { signal: controller.signal }).then(setStatus).catch((failure) => {
      if (!controller.signal.aborted) setError(authMessage(failure));
    });
    return () => controller.abort();
  }, []);
  useEffect(() => { onRecoveryVisibilityChange(Boolean(recoveryCodes)); }, [recoveryCodes, onRecoveryVisibilityChange]);

  async function perform(operation, body, changesSession = false) {
    setBusy(true); onBusyChange(true); setError('');
    try {
      const result = await authRequest(`mfa/${operation}`, { method: 'POST', body, changesSession });
      setPassword(''); setCode('');
      if (operation === 'enroll') setEnrollment(result);
      else if (operation === 'enroll/cancel') setEnrollment(null);
      else if (operation === 'disable') onSignedOut('İki aşamalı doğrulama kapatıldı. Yeniden giriş yapın ve yeni cihazınızı kurun.');
      else if (result?.session) {
        onSessionChanged(result.session);
        setEnrollment(null); setRecoveryCodes(result.recoveryCodes);
        setStatus((previous) => ({ ...previous, enabled: true, recoveryCodesRemaining: result.recoveryCodes.length }));
      }
    } catch (failure) {
      setError(authMessage(failure));
      if (failure.code === 'mfa_enrollment_expired') setEnrollment(null);
    } finally { setBusy(false); onBusyChange(false); }
  }

  return <section className="mfa-panel" aria-labelledby="mfa-heading">
    <h3 id="mfa-heading">İki aşamalı doğrulama</h3>
    {error && <p className="auth-error" role="alert">{error}</p>}
    {status === null ? <p role="status">{error ? 'MFA durumu yüklenemedi. Hesap penceresini yeniden açın.' : 'Yükleniyor…'}</p> : recoveryCodes ? <>
      <p className="auth-notice" role="status">Doğrulama ayarları kaydedildi. Diğer oturumlarınız kapatıldı.</p>
      <p className="auth-muted">Bu 10 kurtarma kodu yalnızca şimdi gösterilir. Her kod bir kez kullanılabilir. Güvenli bir yere kaydedin; Git’e, paylaşılan notlara veya destek mesajlarına koymayın.</p>
      <label>Kurtarma kodları<textarea readOnly rows={10} value={recoveryCodes.join('\n')} spellCheck={false} aria-label="Tek kullanımlık kurtarma kodları" /></label>
      <button className="auth-primary" type="button" onClick={() => setRecoveryCodes(null)}>Kodları güvenli yere kaydettim</button>
    </> : enrollment ? <>
      <p className="auth-muted">Doğrulayıcı uygulamanızda elle hesap ekleyin: hesap adı YunPanel, tür zaman tabanlı, 6 hane, 30 saniye. Ardından uygulamanın ürettiği kodu aşağıya girin.</p>
      <label>Kurulum anahtarı<input readOnly value={enrollment.secret} spellCheck={false} aria-label="Doğrulayıcı kurulum anahtarı" /></label>
      <p className="auth-help">Bu anahtarı yalnızca kendi doğrulayıcınıza ekleyin. Kurulum bitişi: {new Date(enrollment.expiresAt).toLocaleTimeString()}.</p>
      <form onSubmit={(event) => { event.preventDefault(); perform('confirm', { code }, true); }}>
        <fieldset disabled={busy || disabled}>
          <label>6 haneli doğrulama kodu<input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" inputMode="numeric" required pattern="[0-9]{6}" maxLength={6} /></label>
          <button className="auth-primary" type="submit">{busy ? 'Doğrulanıyor…' : 'Doğrula ve etkinleştir'}</button>
          <button className="mfa-secondary" type="button" onClick={() => perform('enroll/cancel')}>Kurulumu iptal et</button>
        </fieldset>
      </form>
    </> : <>
      <p className="auth-muted">{status.enabled ? `Etkin. ${status.recoveryCodesRemaining} kullanılmamış kurtarma kodunuz var.` : 'Kapalı. Etkinleştirdiğinizde girişte parolanızın ardından doğrulama kodu istenir.'}</p>
      {!status.keyConfigured && <p className="auth-notice">Sunucu yöneticisi şifreleme anahtarını yapılandırmalı. Eksik anahtarla yeni doğrulayıcı kurulamaz; mevcut kurtarma kodları hâlâ kullanılabilir.</p>}
      <form onSubmit={(event) => {
        event.preventDefault();
        perform(status.enabled ? action : 'enroll', { password, ...(status.enabled ? { code, method } : {}) }, status.enabled);
      }}>
        <fieldset disabled={busy || disabled || (!status.enabled && !status.keyConfigured)}>
          <label>Mevcut parola<input type="password" autoComplete="current-password" required maxLength={1024} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          {status.enabled && <>
            <label>Doğrulama yöntemi<select value={method} onChange={(e) => { setMethod(e.target.value); setCode(''); }}><option value="totp">Doğrulayıcı uygulaması</option><option value="recovery">Kurtarma kodu</option></select></label>
            <label>{method === 'totp' ? '6 haneli kod' : 'Kurtarma kodu'}<input value={code} onChange={(e) => setCode(e.target.value)} autoComplete={method === 'totp' ? 'one-time-code' : 'off'} inputMode={method === 'totp' ? 'numeric' : 'text'} required pattern={method === 'totp' ? '[0-9]{6}' : undefined} maxLength={method === 'totp' ? 6 : 64} spellCheck={false} /></label>
            <label>İşlem<select value={action} onChange={(e) => setAction(e.target.value)}><option value="recovery">Kurtarma kodlarını yenile</option><option value="disable">Doğrulayıcıyı kaldır ve çıkış yap</option></select></label>
            <p className="auth-help">{action === 'disable' ? 'Doğrulayıcınız ve tüm kurtarma kodları kaldırılır; tüm oturumlar kapanır. Cihaz değiştirmek için yeniden giriş yapıp yeni doğrulayıcıyı kurun.' : 'Eski kurtarma kodları iptal edilir, diğer oturumlar kapanır ve yeni kodlar bir kez gösterilir.'}</p>
          </>}
          <button className="auth-primary" type="submit">{busy ? 'İşleniyor…' : status.enabled ? action === 'disable' ? 'Doğrulayıcıyı kaldır ve çıkış yap' : 'Yeni kurtarma kodları oluştur' : 'Doğrulayıcı kurulumuna başla'}</button>
        </fieldset>
      </form>
    </>}
  </section>;
}
