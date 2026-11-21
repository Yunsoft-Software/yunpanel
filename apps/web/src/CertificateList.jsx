const CERT_STATE_LABELS = Object.freeze({
  active: 'Aktif',
  validated: 'Doğrulandı',
  pending: 'Bekliyor',
  error: 'Hata',
  expired: 'Süresi doldu',
  draft: 'Taslak',
});

function formatExpiry(certificate) {
  if (!certificate || typeof certificate !== 'object') return 'Bilinmiyor';
  if (certificate.staging && certificate.state === 'validated') return 'Doğrulama başarılı';
  if (!certificate.validTo) return certificate.staging ? 'Kayıtlı sertifika yok' : 'Sertifika bekleniyor';
  const date = new Date(certificate.validTo);
  if (Number.isNaN(date.getTime())) return 'Süre bilgisi yok';
  const days = Math.ceil((date.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  if (days < 0) return `${Math.abs(days)} gün önce doldu`;
  return `${days} gün kaldı`;
}

export default function CertificateList({ certificates, access, busyId = null, onRenew = null }) {
  const list = Array.isArray(certificates) ? certificates : [];
  if (!list.length) {
    return (
      <div className="domain-empty">
        <strong>{access === 'protected' ? 'Sertifika listesi korumalı' : 'Henüz yönetilen sertifika yok'}</strong>
        <span>
          {access === 'protected'
            ? 'Yetkili erişim doğrulandıktan sonra sertifika durumu burada görünür.'
            : 'ACME doğrulama ve yönetilen HTTPS sertifika kayıtları burada görünür.'}
        </span>
      </div>
    );
  }

  return (
    <div className="domain-list">
      {list.map((certificate, index) => {
        if (!certificate || typeof certificate !== 'object') return null;
        const certId = certificate.id ?? `cert-${index}`;
        return (
          <article className="domain-row" key={certId}>
            <div className="domain-primary">
              <span className={`status-dot ${certificate.state === 'active' || certificate.state === 'validated' ? 'online' : certificate.state === 'error' ? 'failed' : 'pending'}`} />
              <div>
                <strong>{certificate.certName ?? '—'}</strong>
                <span>{certificate.staging ? 'ACME deneme doğrulaması' : 'Canlı ACME sertifikası'}</span>
              </div>
            </div>
            <div className="domain-cell">
              <span>Durum</span>
              <strong>{CERT_STATE_LABELS[certificate.state] ?? 'Bilinmiyor'}</strong>
            </div>
            <div className="domain-cell">
              <span>{certificate.staging ? 'Doğrulama' : 'Geçerlilik'}</span>
              <strong>{formatExpiry(certificate)}</strong>
            </div>
            <div className="domain-cell">
              <span>Alan adları</span>
              <strong>{Array.isArray(certificate.domains) ? certificate.domains.length : 0}</strong>
            </div>
            <div className={`domain-state ${certificate.state === 'active' || certificate.state === 'validated' ? 'active' : certificate.state === 'error' ? 'error' : 'draft'}`}>
              {certificate.staging ? 'Doğrulama' : 'Yönetilen'}
            </div>
            {onRenew && !certificate.staging && certificate.state === 'active' && (
              <div className="row-actions">
                <button className="secondary-button" type="button" disabled={busyId === certificate.id} onClick={() => onRenew(certificate)}>Yenileme testi</button>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
