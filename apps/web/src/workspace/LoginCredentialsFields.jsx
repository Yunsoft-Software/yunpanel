import { useId } from 'react';

export function LoginCredentialsFields({ email, password, onEmailChange, onPasswordChange }) {
  const identity = useId();
  return <div className="ws-form-grid ws-site-admin-fields" style={{ marginTop: 16, alignItems: 'start' }}>
    <label>Yönetici e-posta adresi
      <input type="email" name="adminEmail" aria-label="Yönetici e-posta adresi" autoComplete="email" required
        aria-describedby={`${identity}-email-hint`} placeholder="yonetici@example.com"
        autoCapitalize="none" spellCheck={false} value={email}
        onChange={event => onEmailChange(event.target.value)} />
      <span id={`${identity}-email-hint`} className="ws-field-hint">Panel girişi için kullanılır; posta kutusu hesabından ayrıdır.</span>
    </label>
    <label>Yönetici parolası
      <input type="password" name="adminPassword" aria-label="Yönetici parolası" autoComplete="new-password" required minLength={12}
        aria-describedby={`${identity}-password-hint`} placeholder="En az 12 karakter" value={password}
        onChange={event => onPasswordChange(event.target.value)} />
      <span id={`${identity}-password-hint`} className="ws-field-hint">En az 12 karakter ve güvenli bir parola seçin.</span>
    </label>
  </div>;
}
