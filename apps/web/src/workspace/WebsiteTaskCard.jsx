import { useId, useState } from 'react';
import { Link } from 'react-router';
import { Badge, Button, FileRootBadge, Icon, LinkButton } from './PanelKit.jsx';
import { certificateState, externalSiteUrl, siteHref } from './site-model.js';

function resolveCardFileRoot(domain) {
  const host = String(domain?.primaryDomain ?? '').trim().toLowerCase();
  if (!host) return null;
  if (domain?.parentDomainId) {
    const parts = host.split('.').filter(Boolean);
    if (parts.length >= 3) {
      const subPrefix = parts[0];
      const parentHost = parts.slice(1).join('.');
      return `/var/www/vhosts/${parentHost}/subdomains/${subPrefix}`;
    }
    return `/var/www/vhosts/${host}/subdomains/sub`;
  }
  return `/var/www/vhosts/${host}/httpdocs`;
}

function TaskLink({ tool, domainName, id }) {
  return <div className="ws-website-task">
    {tool.href
      ? <LinkButton to={tool.href} icon={tool.icon} aria-label={`${domainName} · ${tool.label}`}>{tool.label}</LinkButton>
      : <Button disabled icon={tool.icon} aria-label={`${domainName} · ${tool.label}`} aria-describedby={`${id}-${tool.key}`}>{tool.label}</Button>}
    {tool.reason && <small id={`${id}-${tool.key}`}>{tool.reason}</small>}
  </div>;
}

export default function WebsiteTaskCard({ row, tasks, certificates, filtering, onToggle }) {
  const id = useId();
  const [toolsOpen, setToolsOpen] = useState(false);
  const { domain, depth, childCount, expanded, warning, contextOnly } = row;
  const ssl = certificateState(domain, tasks.domainReady && certificates?.status === 'ready' ? certificates.items : null);
  const url = tasks.domainReady ? externalSiteUrl(domain) : null;
  const isSubdomain = Boolean(domain.parentDomainId);
  const fileRootPath = resolveCardFileRoot(domain);
  const cardClasses = [
    'ws-website-task-card',
    'yp-spotlight-card',
    !isSubdomain && childCount > 0 ? 'yp-domain-tree-card' : '',
    isSubdomain ? 'yp-subdomain-task-card' : '',
  ].filter(Boolean).join(' ');
  return <article className={cardClasses} aria-labelledby={`${id}-title`} style={{ '--ws-card-depth': Math.min(depth, 3) }}>
    <header className="ws-website-task-header">
      <div className="ws-website-task-title">
        <h3 id={`${id}-title`}>
          {isSubdomain && <span className="yp-tree-connector" aria-hidden="true">├─ </span>}
          <Link to={siteHref(domain.id)}>{domain.primaryDomain}</Link>
        </h3>
        <p>{isSubdomain ? 'Alt alan adı (Subdomain)' : 'Ana alan adı (Root Domain)'} · {tasks.runtimeLabel}</p>
        {fileRootPath && <div style={{ marginTop: '6px' }}><FileRootBadge path={fileRootPath} shared={isSubdomain} /></div>}
        {contextOnly && <small>Filtrelenen alt alan adının üst kaydı</small>}
      </div>
      <div className="ws-website-task-status" aria-label="Kayıt ve sertifika durumu">
        <Badge state={tasks.domainReady ? domain.state : 'unknown'} />
        <Badge state={ssl.state}>{ssl.label}</Badge>
      </div>
      {url && <a href={url} target="_blank" rel="noopener noreferrer" className="ws-button" aria-label={`${domain.primaryDomain} sitesini yeni sekmede aç`}><Icon name="external" />Siteyi aç</a>}
    </header>
    {warning && <p className="ws-website-task-warning"><Icon name="alert" />Üst alan adı bağlantısını kontrol edin.</p>}
    <nav className="ws-website-task-quick" aria-label={`${domain.primaryDomain} hızlı araçlar`}>
      {tasks.tools.filter((tool) => ['files', 'databases', 'ssl', 'wordpress'].includes(tool.key)).map((tool) => <TaskLink key={tool.key} tool={tool} domainName={domain.primaryDomain} id={id} />)}
      <Button icon="chevron" aria-expanded={toolsOpen} aria-controls={`${id}-tools`} onClick={() => setToolsOpen(!toolsOpen)}>{toolsOpen ? 'Araçları daralt' : 'Tüm araçlar'}</Button>
    </nav>
    <div id={`${id}-tools`} hidden={!toolsOpen}>
      <nav className="ws-website-task-grid" aria-label={`${domain.primaryDomain} site araçları`}>
        {tasks.tools.filter((tool) => !['files', 'databases', 'ssl', 'wordpress'].includes(tool.key)).map((tool) => <TaskLink key={tool.key} tool={tool} domainName={domain.primaryDomain} id={id} />)}
        {tasks.secondaryTools.map((tool) => <TaskLink key={tool.key} tool={tool} domainName={domain.primaryDomain} id={id} />)}
      </nav>
    <footer className="ws-website-task-footer">
      <div className="ws-actions">
        <LinkButton to={siteHref(domain.id)} icon="arrow" aria-label={`${domain.primaryDomain} site genel bakışını aç`}>Site genel bakışı</LinkButton>
        {tasks.createSubdomainHref && <LinkButton to={tasks.createSubdomainHref} icon="plus" aria-label={`${domain.primaryDomain} altında alan adı ekle`}>Alt alan adı ekle</LinkButton>}
        {tasks.manageAliasesHref && <LinkButton to={tasks.manageAliasesHref} icon="plus" aria-label={`${domain.primaryDomain} için alias ekle veya yönet`}>Alias ekle</LinkButton>}
        {tasks.removeHref && <LinkButton to={tasks.removeHref} icon="trash" aria-label={`${domain.primaryDomain} sitesini sil`}>Siteyi sil</LinkButton>}
        {childCount > 0 && <Button disabled={filtering} icon="chevron" aria-expanded={expanded} aria-label={`${domain.primaryDomain} alt alan adlarını ${expanded ? 'daralt' : 'genişlet'}`} onClick={() => onToggle(domain.id)}>{childCount} alt alan adı · {expanded ? 'Daralt' : 'Göster'}</Button>}
      </div>
      <details className="ws-website-task-details"><summary>Alan adı bilgileri</summary>
        <dl><div><dt>Aliaslar</dt><dd>{domain.aliases?.length ? domain.aliases.join(', ') : 'Yok'}{tasks.manageAliasesHref && <> · <Link to={tasks.manageAliasesHref}>Alias yönetimi</Link></>}</dd></div>
          {tasks.applicationName && <div><dt>Bağlı uygulama</dt><dd>{tasks.applicationName}</dd></div>}
        </dl>
      </details>
    </footer>
    </div>
    {childCount > 0 && !toolsOpen && <div className="ws-website-task-children"><Button disabled={filtering} icon="chevron" aria-expanded={expanded} onClick={() => onToggle(domain.id)}>{childCount} alt alan adı · {expanded ? 'Daralt' : 'Göster'}</Button></div>}
  </article>;
}
