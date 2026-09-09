function formatExpiry(certificate) {
  if (certificate.staging && certificate.state === 'validated') return 'Validation passed';
  if (!certificate.validTo) return certificate.staging ? 'No certificate saved' : 'Waiting for certificate';
  const date = new Date(certificate.validTo);
  if (Number.isNaN(date.getTime())) return 'Unknown expiry';
  const days = Math.ceil((date.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  if (days < 0) return `Expired ${Math.abs(days)}d ago`;
  return `${days}d remaining`;
}

export default function CertificateList({ certificates, access, busyId = null, onRenew = null }) {
  if (!certificates.length) {
    return (
      <div className="domain-empty">
        <strong>{access === 'protected' ? 'Certificate inventory protected' : 'No managed certificate yet'}</strong>
        <span>
          {access === 'protected'
            ? 'Certificate state will appear after authenticated control-plane access is enabled.'
            : 'ACME validation and managed HTTPS certificate records will appear here.'}
        </span>
      </div>
    );
  }

  return (
    <div className="domain-list">
      {certificates.map((certificate) => (
        <article className="domain-row" key={certificate.id}>
          <div className="domain-primary">
            <span className={`status-dot ${certificate.state === 'active' || certificate.state === 'validated' ? 'online' : certificate.state === 'error' ? 'failed' : 'pending'}`} />
            <div>
              <strong>{certificate.certName}</strong>
              <span>{certificate.staging ? 'ACME dry-run validation' : 'Production ACME certificate'}</span>
            </div>
          </div>
          <div className="domain-cell">
            <span>State</span>
            <strong>{certificate.state}</strong>
          </div>
          <div className="domain-cell">
            <span>{certificate.staging ? 'Validation' : 'Expiry'}</span>
            <strong>{formatExpiry(certificate)}</strong>
          </div>
          <div className="domain-cell">
            <span>Domains</span>
            <strong>{certificate.domains?.length ?? 0}</strong>
          </div>
          <div className={`domain-state ${certificate.state === 'active' || certificate.state === 'validated' ? 'active' : certificate.state === 'error' ? 'error' : 'draft'}`}>
            {certificate.staging ? 'validation' : 'managed'}
          </div>
          {onRenew && !certificate.staging && certificate.state === 'active' && (
            <div className="row-actions">
              <button className="secondary-button" type="button" disabled={busyId === certificate.id} onClick={() => onRenew(certificate)}>Renewal dry-run</button>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
