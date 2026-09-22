import { Link } from 'react-router';
import { Icon } from '../PanelKit.jsx';
import { siteHref } from '../site-model.js';
import { groupSiteTabs } from './ux-model.js';

// These are real document links, not ARIA tabs or a second router. Domain IDs
// retain their existing route meaning; Website IDs are never substituted.
export default function SiteNavigation({ tabs, activeTab, domainId, query = '' }) {
  const groups = groupSiteTabs(tabs);
  const current = groups.find((group) => group.tabs.some(([key]) => key === activeTab));
  return <div className="ws-site-navigation">
    <nav className="ws-site-groups" aria-label="Site yönetimi">
      {groups.map((group) => {
        const active = group.id === current?.id;
        const destination = active ? activeTab : group.tabs[0][0];
        return <Link key={group.id} to={`${siteHref(domainId, destination)}${query}`} aria-current={active ? group.tabs.length === 1 ? 'page' : 'true' : undefined}><Icon name={group.icon} /><span>{group.label}</span></Link>;
      })}
    </nav>
    {current?.tabs.length > 1 && <nav className="ws-site-subnav" aria-label={`${current.label} bölümleri`}>
      {current.tabs.map(([key, label]) => <Link key={key} to={`${siteHref(domainId, key)}${query}`} aria-current={key === activeTab ? 'page' : undefined}>{key === 'resources' ? 'Veritabanı ve mail' : label}</Link>)}
    </nav>}
  </div>;
}
