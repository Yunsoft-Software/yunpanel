function formatExpiry(value) {
  if (!value) return 'Waiting for certificate';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown expiry';
  const days = Math.ceil((date.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  if (days < 0) return `Expired ${Math.abs(days)}d ago`;
  return `${days}d remaining`;
}

export default function CertificateList({ certificates, access }) {
  if (!certificates.length) {
    return (
      <div className="domain-empty">
        <strong>{access === 'protected' ? 'Certificate inventory protected' : 'No managed certificate yet'}</strong>
        <span>
          {access === 'protected'
            ? 'Certificate state will appear after authenticated control-plane access is enabled.'
            : 'Managed HTTPS certificates will appear after an active HTTP domain completes ACME issuance.'}
        </span>
      </div>
    );
  }

  return (
    <div className="domain-list">
      {certificates.map((certificate) => (
        <article className="domain-row" key={certificate.id}>
          <div className="domain-primary">
            <span className={`status-dot ${certificate.state === 'active' ? 'online' : certificate.state === 'error' ? 'failed' : 'pending'}`} />
            <div>
              <strong>{certificate.certName}</strong>
              <span>{certificate.staging ? 'Let’s Encrypt staging' : 'Production ACME'}</span>
            </div>
          </div>
          <div className="domain-cell">
            <span>State</span>
            <strong>{certificate.state}</strong>
          </div>
          <div className="domain-cell">
            <span>Expiry</span>
            <strong>{formatExpiry(certificate.validTo)}</strong>
          </div>
          <div className="domain-cell">
            <span>Domains</span>
            <strong>{certificate.domains?.length ?? 0}</strong>
          </div>
          <div className={`domain-state ${certificate.state === 'active' ? 'active' : certificate.state === 'error' ? 'error' : 'draft'}`}>
            {certificate.staging ? 'staging' : 'managed'}
          </div>
        </article>
      ))}
    </div>
  );
}
