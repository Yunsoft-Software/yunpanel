function shortServerId(serverId) {
  if (typeof serverId !== 'string') return 'unknown';
  return serverId.length > 12 ? `${serverId.slice(0, 8)}…` : serverId;
}

function targetDescription(domain) {
  if (domain.targetType === 'static') {
    return domain.target?.spaFallback === false ? 'Static files' : 'Static SPA';
  }
  if (domain.targetType === 'proxy') {
    return `127.0.0.1:${domain.target?.upstreamPort ?? '—'}`;
  }
  return 'Unknown target';
}

export default function DomainList({ domains, access, busyId = null, onAction = null, onIssue = null }) {
  if (!domains.length) {
    return (
      <div className="domain-empty">
        <strong>{access === 'protected' ? 'Domain inventory protected' : 'No managed domain yet'}</strong>
        <span>
          {access === 'protected'
            ? 'Production domains will appear after user authentication is enabled.'
            : 'Create a draft domain through the control API to start Nginx staging.'}
        </span>
      </div>
    );
  }

  return (
    <div className="domain-list">
      {domains.map((domain) => (
        <article className="domain-row" key={domain.id}>
          <div className="domain-primary">
            <span className={`status-dot ${domain.state === 'active' ? 'online' : domain.state === 'error' ? 'failed' : 'pending'}`} />
            <div>
              <strong>{domain.primaryDomain}</strong>
              <span>{domain.aliases?.length ? domain.aliases.join(', ') : 'No aliases'}</span>
            </div>
          </div>
          <div className="domain-cell">
            <span>Target</span>
            <strong>{targetDescription(domain)}</strong>
          </div>
          <div className="domain-cell">
            <span>Server</span>
            <strong>{shortServerId(domain.serverId)}</strong>
          </div>
          <div className="domain-cell">
            <span>HTTPS</span>
            <strong>{domain.httpsMode ?? 'off'}</strong>
          </div>
          <div className={`domain-state ${domain.state}`}>{domain.state}</div>
          {(onAction || onIssue) && (
            <div className="row-actions">
              {onAction && <button className="secondary-button" type="button" disabled={busyId === domain.id} onClick={() => onAction(domain, 'stage')}>Stage</button>}
              {onAction && domain.stagedRevision === domain.desiredRevision && <button className="secondary-button" type="button" disabled={busyId === domain.id} onClick={() => onAction(domain, 'activate')}>Activate</button>}
              {onIssue && domain.httpsMode === 'managed' && domain.state === 'active' && !domain.certificateId && <button className="secondary-button" type="button" disabled={busyId === domain.id} onClick={() => onIssue(domain, true)}>Validate ACME</button>}
              {onIssue && domain.httpsMode === 'managed' && domain.state === 'active' && !domain.certificateId && <button className="primary-button" type="button" disabled={busyId === domain.id} onClick={() => onIssue(domain, false)}>Issue certificate</button>}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
