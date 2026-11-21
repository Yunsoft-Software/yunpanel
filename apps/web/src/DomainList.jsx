import { useMemo, useState } from 'react';
import { domainTreeRows } from './domain-tree.js';
import './domain-tree.css';

const DOMAIN_STATE_LABELS = Object.freeze({
  active: 'Aktif',
  staged: 'Hazırlandı',
  draft: 'Taslak',
  suspended: 'Askıda',
  error: 'Hata',
  pending: 'Bekliyor',
});

const HTTPS_MODE_LABELS = Object.freeze({
  managed: 'Yönetilen',
  off: 'Kapalı',
});

function shortServerId(serverId) {
  if (typeof serverId !== 'string') return 'Bilinmiyor';
  return serverId.length > 12 ? `${serverId.slice(0, 8)}…` : serverId;
}

function targetDescription(domain) {
  if (domain.targetType === 'static') return domain.target?.spaFallback === false ? 'Statik dosyalar' : 'Statik uygulama';
  if (domain.targetType === 'proxy') return `127.0.0.1:${domain.target?.upstreamPort ?? '—'}`;
  if (domain.targetType === 'redirect') return `→ ${domain.target?.url ?? '—'}`;
  return 'Hedef doğrulanmadı';
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
        <strong>{checking ? 'Alan adları yükleniyor…' : failed ? 'Alan adı listesi alınamadı' : 'Henüz yönetilen alan adı yok'}</strong>
        <span>{checking ? 'Alan adı envanteri okunuyor.' : failed ? 'Alan adı envanteri yüklenemedi. Bağlantınızı ve erişim yetkinizi kontrol edin.' : 'Aşağıdan yeni bir alan adı oluşturabilirsiniz. DNS kayıtları ayrı yönetilir.'}</span>
      </div>
    );
  }

  return (
    <div className="domain-tree">
      {access !== 'ready' && <p role="status" className="domain-tree-warning">Son yüklenen envanter gösteriliyor. Bağlantı düzelene kadar işlemler devre dışıdır.</p>}
      <div className="domain-toolbar">
        <label>Alan adı veya alias ara<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Alan adı veya alt alan adı ara" /></label>
        <span role="status">{rows.length} görünen / {domains.length} toplam alan adı</span>
        <button className="secondary-button" type="button" onClick={() => setCollapsed(new Set())}>Tümünü genişlet</button>
        <button className="secondary-button" type="button" disabled={Boolean(query.trim())} onClick={() => setCollapsed(new Set(domains.map((domain) => domain.id)))}>Tümünü daralt</button>
      </div>
      {!rows.length && <div className="domain-empty" role="status"><strong>Eşleşen alan adı bulunamadı</strong><span>Farklı bir alan adı veya alias deneyin.</span></div>}
      <div className="domain-list">
        {rows.map(({ domain, depth, childCount, expanded, warning }) => (
          <article className="domain-row" key={domain.id} style={{ '--domain-depth': Math.min(depth, 4) }}>
            <div className="domain-primary">
              {childCount > 0
                ? <button type="button" className="domain-disclosure" aria-label={`${domain.primaryDomain} alt alan adlarını ${expanded ? 'daralt' : 'genişlet'}`} aria-expanded={expanded} disabled={Boolean(query.trim())} onClick={() => toggle(domain.id)}>{expanded ? '−' : '+'}</button>
                : <span className="domain-disclosure-space" aria-hidden="true" />}
              <span className={`status-dot ${domain.state === 'active' ? 'online' : domain.state === 'error' ? 'failed' : 'pending'}`} />
              <div className="domain-name">
                <strong>{domain.primaryDomain}</strong>
                <span>{domain.parentDomainId ? 'Alt alan adı' : 'Alan adı'}{childCount > 0 ? ` · ${childCount} alt alan adı` : ''}</span>
                <span>{domain.aliases?.length ? `Aliaslar: ${domain.aliases.join(', ')}` : 'Alias yok'}</span>
                {warning && <span className="domain-tree-warning">{warning}</span>}
              </div>
            </div>
            <div className="domain-cell"><span>Hedef</span><strong>{targetDescription(domain)}</strong></div>
            <div className="domain-cell"><span>Sunucu</span><strong>{shortServerId(domain.serverId)}</strong></div>
            <div className="domain-cell"><span>HTTPS</span><strong>{HTTPS_MODE_LABELS[domain.httpsMode] ?? 'Kapalı'}</strong></div>
            <div className={`domain-state ${domain.state}`}>{DOMAIN_STATE_LABELS[domain.state] ?? domain.state}</div>
            {(onAction || onIssue || onAddSubdomain) && (
              <div className="row-actions">
                {onAddSubdomain && <button className="secondary-button" type="button" disabled={busy || Boolean(warning)} onClick={() => onAddSubdomain(domain)}>Alt alan adı ekle</button>}
                {onAction && <button className="secondary-button" type="button" disabled={busy} onClick={() => onAction(domain, 'stage')}>Hazırla</button>}
                {onAction && domain.stagedRevision === domain.desiredRevision && <button className="secondary-button" type="button" disabled={busy} onClick={() => onAction(domain, 'activate')}>Yayınla</button>}
                {onIssue && !domain.certificateId && <button className="secondary-button" type="button" disabled={busy} onClick={() => onIssue(domain, true)}>ACME doğrula</button>}
                {onIssue && !domain.certificateId && <button className="primary-button" type="button" disabled={busy} onClick={() => onIssue(domain, false)}>Sertifika oluştur</button>}
                {onIssue && Boolean(domain.certificateId) && <button className="secondary-button" type="button" disabled={busy} onClick={() => onIssue(domain, false)}>Sertifikayı yenile</button>}
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
