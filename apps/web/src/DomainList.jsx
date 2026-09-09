import { useMemo, useState } from 'react';
import { domainTreeRows } from './domain-tree.js';
import './domain-tree.css';

function shortServerId(serverId) {
  if (typeof serverId !== 'string') return 'unknown';
  return serverId.length > 12 ? `${serverId.slice(0, 8)}…` : serverId;
}

function targetDescription(domain) {
  if (domain.targetType === 'static') return domain.target?.spaFallback === false ? 'Static files' : 'Static SPA';
  if (domain.targetType === 'proxy') return `127.0.0.1:${domain.target?.upstreamPort ?? '—'}`;
  return 'Unknown target';
}

export default function DomainList({ domains, access, busyId = null, onAction = null, onIssue = null, onAddSubdomain = null }) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(() => new Set());
  const rows = useMemo(() => domainTreeRows(domains, { query, collapsed }), [domains, query, collapsed]);
  const busy = busyId !== null || access !== 'ready';

  function toggle(id) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (!domains.length) {
    const checking = access === 'checking';
    const failed = !checking && access !== 'ready';
    return (
      <div className="domain-empty" role={failed ? 'alert' : 'status'}>
        <strong>{checking ? 'Loading domains…' : failed ? 'Domain inventory unavailable' : 'No managed domain yet'}</strong>
        <span>{checking ? 'Reading domain inventory.' : failed ? 'The inventory could not be loaded. Check the connection and your access.' : 'Create a domain below. DNS records are managed separately.'}</span>
      </div>
    );
  }

  return (
    <div className="domain-tree">
      {access !== 'ready' && <p role="status" className="domain-tree-warning">Showing the last loaded inventory. Actions are disabled until the connection recovers.</p>}
      <div className="domain-toolbar">
        <label>Search domains and aliases<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a domain or subdomain" /></label>
        <span role="status">{rows.length} visible / {domains.length} domains</span>
        <button className="secondary-button" type="button" onClick={() => setCollapsed(new Set())}>Expand all</button>
        <button className="secondary-button" type="button" disabled={Boolean(query.trim())} onClick={() => setCollapsed(new Set(domains.map((domain) => domain.id)))}>Collapse all</button>
      </div>
      {!rows.length && <div className="domain-empty" role="status"><strong>No matching domains</strong><span>Try a different domain name or alias.</span></div>}
      <div className="domain-list">
        {rows.map(({ domain, depth, childCount, expanded, warning }) => (
          <article className="domain-row" key={domain.id} style={{ '--domain-depth': Math.min(depth, 4) }}>
            <div className="domain-primary">
              {childCount > 0
                ? <button type="button" className="domain-disclosure" aria-label={`${expanded ? 'Collapse' : 'Expand'} subdomains of ${domain.primaryDomain}`} aria-expanded={expanded} disabled={Boolean(query.trim())} onClick={() => toggle(domain.id)}>{expanded ? '−' : '+'}</button>
                : <span className="domain-disclosure-space" aria-hidden="true" />}
              <span className={`status-dot ${domain.state === 'active' ? 'online' : domain.state === 'error' ? 'failed' : 'pending'}`} />
              <div className="domain-name">
                <strong>{domain.primaryDomain}</strong>
                <span>{domain.parentDomainId ? 'Subdomain' : 'Domain'}{childCount > 0 ? ` · ${childCount} subdomains` : ''}</span>
                <span>{domain.aliases?.length ? `Aliases: ${domain.aliases.join(', ')}` : 'No aliases'}</span>
                {warning && <span className="domain-tree-warning">{warning}</span>}
              </div>
            </div>
            <div className="domain-cell"><span>Target</span><strong>{targetDescription(domain)}</strong></div>
            <div className="domain-cell"><span>Server</span><strong>{shortServerId(domain.serverId)}</strong></div>
            <div className="domain-cell"><span>HTTPS</span><strong>{domain.httpsMode ?? 'off'}</strong></div>
            <div className={`domain-state ${domain.state}`}>{domain.state}</div>
            {(onAction || onIssue || onAddSubdomain) && (
              <div className="row-actions">
                {onAddSubdomain && <button className="secondary-button" type="button" disabled={busy || Boolean(warning)} onClick={() => onAddSubdomain(domain)}>Add subdomain</button>}
                {onAction && <button className="secondary-button" type="button" disabled={busy} onClick={() => onAction(domain, 'stage')}>Stage</button>}
                {onAction && domain.stagedRevision === domain.desiredRevision && <button className="secondary-button" type="button" disabled={busy} onClick={() => onAction(domain, 'activate')}>Activate</button>}
                {onIssue && domain.httpsMode === 'managed' && domain.state === 'active' && !domain.certificateId && <button className="secondary-button" type="button" disabled={busy} onClick={() => onIssue(domain, true)}>Validate ACME</button>}
                {onIssue && domain.httpsMode === 'managed' && domain.state === 'active' && !domain.certificateId && <button className="primary-button" type="button" disabled={busy} onClick={() => onIssue(domain, false)}>Issue certificate</button>}
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
