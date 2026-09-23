import { useId } from 'react';
import { Link } from 'react-router';
import { Badge, Button, Icon, LinkButton } from './PanelKit.jsx';
import { certificateState, externalSiteUrl, siteHref } from './site-model.js';

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
  const { domain, depth, childCount, expanded, warning, contextOnly } = row;
  const ssl = certificateState(domain, tasks.domainReady && certificates?.status === 'ready' ? certificates.items : null);
  const url = tasks.domainReady ? externalSiteUrl(domain) : null;
  return <article className="ws-website-task-card" aria-labelledby={`${id}-title`} style={{ '--ws-card-depth': Math.min(depth, 3) }}>
    <header className="ws-website-task-header">
      <div className="ws-website-task-title">
        <h3 id={`${id}-title`}><Link to={siteHref(domain.id)}>{domain.primaryDomain}</Link></h3>
        <p>{domain.parentDomainId ? 'Alt alan adı' : 'Ana alan adı'} · {tasks.runtimeLabel}</p>
        {contextOnly && <small>Filtrelenen alt alan adının üst kaydı</small>}
      </div>
      <div className="ws-website-task-status" aria-label="Kayıt ve sertifika durumu">
        <Badge state={tasks.domainReady ? domain.state : 'unknown'} />
        <Badge state={ssl.state}>{ssl.label}</Badge>
      </div>
      {url && <a href={url} target="_blank" rel="noopener noreferrer" className="ws-button" aria-label={`${domain.primaryDomain} sitesini yeni sekmede aç`}><Icon name="external" />Siteyi aç</a>}
    </header>
    {warning && <p className="ws-website-task-warning"><Icon name="alert" />Üst alan adı bağlantısını kontrol edin.</p>}
    <nav className="ws-website-task-grid" aria-label={`${domain.primaryDomain} site araçları`}>
      {tasks.tools.map((tool) => <TaskLink key={tool.key} tool={tool} domainName={domain.primaryDomain} id={id} />)}
    </nav>
    <nav className="ws-website-task-secondary" aria-label={`${domain.primaryDomain} barındırma ve uygulama araçları`}>
      {tasks.secondaryTools.map((tool) => <TaskLink key={tool.key} tool={tool} domainName={domain.primaryDomain} id={id} />)}
    </nav>
    <footer className="ws-website-task-footer">
      <div className="ws-actions">
        <LinkButton to={siteHref(domain.id)} icon="arrow" aria-label={`${domain.primaryDomain} site genel bakışını aç`}>Site genel bakışı</LinkButton>
        {tasks.createSubdomainHref && <LinkButton to={tasks.createSubdomainHref} icon="plus" aria-label={`${domain.primaryDomain} altında alan adı ekle`}>Alt alan adı ekle</LinkButton>}
        {childCount > 0 && <Button disabled={filtering} icon="chevron" aria-expanded={expanded} aria-label={`${domain.primaryDomain} alt alan adlarını ${expanded ? 'daralt' : 'genişlet'}`} onClick={() => onToggle(domain.id)}>{childCount} alt alan adı · {expanded ? 'Daralt' : 'Göster'}</Button>}
      </div>
      <details className="ws-website-task-details"><summary>Alan adı bilgileri</summary>
        <dl><div><dt>Aliaslar</dt><dd>{domain.aliases?.length ? domain.aliases.join(', ') : 'Yok'}</dd></div>
          {tasks.applicationName && <div><dt>Bağlı uygulama</dt><dd>{tasks.applicationName}</dd></div>}
        </dl>
      </details>
    </footer>
  </article>;
}
