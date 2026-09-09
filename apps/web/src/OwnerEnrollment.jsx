import { useState } from 'react';
import MfaSettings from './MfaSettings.jsx';
import { enrollmentCanContinue } from './owner-access.js';
import './owner-enrollment.css';

export default function OwnerEnrollment({ session, onSession, onSignedOut, onComplete }) {
  const [busy, setBusy] = useState(false);
  const [sensitive, setSensitive] = useState(false);
  const canContinue = enrollmentCanContinue({ session, busy, sensitive });

  return <main className="owner-enrollment" aria-labelledby="owner-enrollment-heading">
    <section className="owner-enrollment-card">
      <p className="auth-eyebrow">HESAP GÜVENLİĞİ</p>
      <h1 id="owner-enrollment-heading">Sunucuyu yönetmeden önce hesabınızı koruyun</h1>
      <p className="auth-muted">Parolanız doğrulandı. Site ve sunucu işlemlerine erişmek için doğrulayıcınızı kurun ve kurtarma kodlarınızı saklayın. Bu kurulum tamamlandıktan sonra her işlem için ayrıca izin vermeniz gerekmez.</p>
      <MfaSettings onSession={onSession} onSignedOut={onSignedOut} onBusy={setBusy} onSensitive={setSensitive} />
      <div className="owner-enrollment-footer">
        <p className="auth-muted" role="status">{sensitive ? 'Devam etmeden önce kurtarma kodlarını güvenle kaydedip onaylayın.' : canContinue ? 'Doğrulayıcınız etkin. Yönetim paneline geçebilirsiniz.' : 'Kurulum tamamlanana kadar yönetim verileri ve işlemleri kapalıdır.'}</p>
        <button className="auth-primary" type="button" disabled={!canContinue} onClick={() => { if (canContinue) onComplete(); }}>Yönetim paneline geç</button>
      </div>
    </section>
  </main>;
}
