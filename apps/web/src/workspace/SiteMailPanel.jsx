import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useWorkspace } from './WorkspaceContext.jsx';
import { listMailDomains, listMailboxes, listMailAliases } from './mail-client.js';
import MailboxesPanel from './MailboxesPanel.jsx';
import MailAliasesPanel from './MailAliasesPanel.jsx';
import MailConfigurationPanel from './MailConfigurationPanel.jsx';
import MailDkimDiagnosticsPanel from './MailDkimDiagnosticsPanel.jsx';
import MailWebmailPanel from './MailWebmailPanel.jsx';
import SiteWebmailAccess from './SiteWebmailAccess.jsx';
import SiteMailApplyPanel from './SiteMailApplyPanel.jsx';
import { Badge, Button, EmptyState, ErrorNotice, Icon, Section } from './PanelKit.jsx';
import { siteMailDomains, mailSection } from './ui/site-resource-model.js';
import './ui/site-resource-workspace.css';

// Keep the Website/Domain distinction. Never select a mail domain from its name.
export default function SiteMailPanel(props) {
  return <SiteMailWorkspace key={props.website?.id ?? props.domain.id} {...props} />;
}
function SiteMailWorkspace({ domain, website }) {
  const { domains, isOwner, canManage } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const [state, setState] = useState({ items: [], loaded: false, busy: true, error: null });
  const generation = useRef(0);
  const knownDomains = useMemo(() => {
    const source = ['ready', 'stale'].includes(domains.status) ? domains.items : [];
    return source.some((item) => item.id === domain.id) ? source : [...source, domain];
  }, [domains.items, domains.status, domain]);
  const load = useCallback(async () => {
    if (!website?.id) { setState({ items: [], loaded: true, busy: false, error: null }); return; }
    const current = ++generation.current;
    setState((value) => ({ ...value, busy: true, error: null }));
    try {
      // The API restricts a site-manager's collection before this UI projection.
      const values = await listMailDomains();
      const items = siteMailDomains(values, knownDomains, website.id);
      if (current === generation.current) setState({ items, loaded: true, busy: false, error: null });
    } catch (failure) {
      if (current === generation.current && failure.name !== 'AbortError') setState((value) => ({ ...value, busy: false, error: failure.message }));
    }
  }, [website?.id, knownDomains]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  const selected = state.items.find((item) => item.id === params.get('mailDomain')) ?? state.items[0];
  const choose = (id) => setParams((current) => {
    const next = new URLSearchParams(current); next.set('mailDomain', id); next.delete('mailTab'); return next;
  });
  return <div className="ys-resources ys-mail-workspace">
    <header className="ys-resource-heading"><span className="ys-resource-symbol"><Icon name="mail" size={23} /></span><div><h2>E-posta</h2><p>{domain.primaryDomain} · Bu siteye bağlı posta hesapları</p></div><Button icon="refresh" disabled={state.busy} onClick={load} aria-label="Site e-postasını yenile" /></header>
    <ErrorNotice error={state.error} />
    {state.busy && !state.loaded && <div className="ws-loading" role="status"><span className="ws-spinner" />Posta alan adları yükleniyor…</div>}
    {state.items.length > 1 && <label className="ys-mail-domain-select">Posta alan adı<select value={selected?.id ?? ''} onChange={(event) => choose(event.target.value)}>{state.items.map((item) => <option value={item.id} key={item.id}>{item.domainName}</option>)}</select></label>}
    {state.loaded && !selected && <Section title="Posta hizmeti"><EmptyState icon="mail" title="Bu siteye bağlı e-posta hizmeti yok" detail="Site için yerel posta veya harici sağlayıcı henüz yapılandırılmamış. Sunucu yöneticisi bu siteye posta hizmeti bağladıktan sonra hesaplarınızı burada yönetebilirsiniz." /></Section>}
    {selected && <fieldset className="ys-mail-domain-panels" disabled={!canManage || state.busy || Boolean(state.error)}><SiteMailDomain key={selected.id} domain={selected} isOwner={isOwner} /></fieldset>}
  </div>;
}
function SiteMailDomain({ domain, isOwner }) {
  const [params, setParams] = useSearchParams();
  const active = mailSection(params.get('mailTab'), isOwner);
  const [visited, setVisited] = useState(() => new Set([active]));
  const [state, setState] = useState({ mailboxes: [], aliases: [], busy: true, loaded: false, error: null });
  const generation = useRef(0);
  const local = domain.managementMode === 'local';
  const load = useCallback(async () => {
    const current = ++generation.current;
    if (!local) { setState({ mailboxes: [], aliases: [], busy: false, loaded: true, error: null }); return; }
    setState((value) => ({ ...value, busy: true, error: null }));
    try {
      const [mailboxes, aliases] = await Promise.all([listMailboxes(domain.id), listMailAliases(domain.id)]);
      if (!Array.isArray(mailboxes) || !Array.isArray(aliases) || [...mailboxes, ...aliases].some((item) => item.mailDomainId !== domain.id)) throw new Error('Posta kaynakları bu alan adıyla eşleşmiyor.');
      if (current === generation.current) setState({ mailboxes, aliases, busy: false, loaded: true, error: null });
    } catch (failure) {
      if (current === generation.current && failure.name !== 'AbortError') setState((value) => ({ ...value, busy: false, error: failure.message }));
    }
  }, [domain.id, local]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  useEffect(() => { setVisited((value) => new Set([...value, active])); }, [active]);
  const choose = (value) => setParams((current) => { const next = new URLSearchParams(current); next.set('mailTab', value); return next; });
  const tabs = [
    ['mailboxes', 'Posta kutuları', 'mail'], ['aliases', 'Yönlendirmeler', 'arrow'], ['webmail', 'Webmail', 'external'],
    ['configuration', 'Değişiklikleri uygula', 'settings'],
    ...(isOwner ? [['dns', 'DNS / DKIM', 'shield']] : []),
  ];
  if (!local) return <Section title={domain.domainName}><div className="ws-section-body"><Badge state="off">Harici posta sağlayıcısı</Badge><p className="ws-muted">Bu alan adının e-postası başka bir sağlayıcıda yönetiliyor. Yerel posta kutusu veya webmail hazırmış gibi gösterilmez.</p></div></Section>;
  const surfaces = {
    mailboxes: <MailboxesPanel domain={domain} mailboxes={state.mailboxes} onChanged={load} />,
    aliases: <MailAliasesPanel domain={domain} aliases={state.aliases} onChanged={load} />,
    webmail: isOwner ? <MailWebmailPanel domain={domain} onChanged={load} /> : <SiteWebmailAccess domain={domain} />,
    dns: isOwner ? <MailDkimDiagnosticsPanel domain={domain} onChanged={load} /> : null,
    configuration: isOwner ? <MailConfigurationPanel domain={domain} onChanged={load} /> : <SiteMailApplyPanel domain={domain} onChanged={load} />,
  };
  return <>
    <div className="ys-mail-summary"><strong>{domain.domainName}</strong><span>{state.loaded ? state.mailboxes.length : '—'} posta kutusu</span><span>{state.loaded ? state.aliases.length : '—'} yönlendirme</span><Badge state={domain.status === 'enabled' ? 'active' : domain.status === 'disabled' ? 'off' : 'unknown'}>{domain.status === 'enabled' ? 'Etkin' : domain.status === 'disabled' ? 'Devre dışı' : 'Durum doğrulanmadı'}</Badge></div>
    <nav className="ys-resource-tabs" aria-label="Site e-posta bölümleri">{tabs.map(([key, label, icon]) => <button type="button" key={key} aria-current={active === key ? 'page' : undefined} onClick={() => choose(key)}><Icon name={icon} size={16} />{label}</button>)}</nav>
    <ErrorNotice error={state.error} />
    {state.error && <Button icon="refresh" onClick={load}>Yeniden dene</Button>}
    {state.busy && !state.loaded && <div className="ws-loading" role="status"><span className="ws-spinner" />Posta kutuları yükleniyor…</div>}
    {state.loaded && tabs.map(([key]) => (visited.has(key) || active === key) && <div key={key} hidden={active !== key}><fieldset disabled={state.busy || Boolean(state.error)}>{surfaces[key]}</fieldset></div>)}
  </>;
}
