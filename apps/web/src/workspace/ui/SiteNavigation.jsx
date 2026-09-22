import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { Icon } from '../PanelKit.jsx';
import { siteHref } from '../site-model.js';
import './site-resource-workspace.css';

const PRIMARY = ['overview', 'files', 'databases', 'mail', 'ssl', 'node'];
const ICONS = { overview: 'dashboard', files: 'folder', databases: 'database', mail: 'mail', ssl: 'shield', node: 'code', deploy: 'git', domains: 'globe', dns: 'globe', logs: 'file', terminal: 'terminal', settings: 'settings', resources: 'box' };
export default function SiteNavigation({ tabs, activeTab, domainId, query = '' }) {
  const more = useRef(null);
  const primary = PRIMARY.map((key) => tabs.find(([tab]) => tab === key)).filter(Boolean);
  const secondary = tabs.filter(([key]) => !PRIMARY.includes(key));
  useEffect(() => { if (more.current) more.current.open = false; }, [activeTab, domainId]);
  useEffect(() => {
    const outside = (event) => { if (more.current && !more.current.contains(event.target)) more.current.open = false; };
    const escape = (event) => { if (event.key === 'Escape' && more.current?.open) { event.preventDefault(); more.current.open = false; more.current.querySelector('summary')?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, []);
  const link = ([key, label]) => <Link key={key} to={`${siteHref(domainId, key)}${query}`} aria-current={activeTab === key ? 'page' : undefined}><Icon name={ICONS[key] ?? 'box'} size={16} />{label}</Link>;
  return <div className="ys-site-navigation"><nav className="ys-site-primary" aria-label="Website yönetimi">{primary.map(link)}</nav>{secondary.length > 0 && <details className="ys-site-more" ref={more}><summary className={secondary.some(([key]) => key === activeTab) ? 'is-active' : ''}>Diğer <Icon name="chevron" size={14} /></summary><nav aria-label="Diğer site araçları">{secondary.map(link)}</nav></details>}</div>;
}
