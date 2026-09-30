import { Link } from 'react-router';
import { Icon } from '../PanelKit.jsx';
import { siteHref } from '../site-model.js';
import { groupSiteTabs, tabKey } from './ux-model.js';
import './site-resource-workspace.css';
import './plesk-navigation.css';

const ICONS = { overview: 'dashboard', hosting: 'globe', files: 'folder', databases: 'database', mail: 'mail', ssl: 'shield', node: 'code', deploy: 'git', domains: 'globe', dns: 'globe', logs: 'file', analytics: 'dashboard', cron: 'clock', backup: 'archive', terminal: 'terminal', settings: 'settings', resources: 'box' };
const LANDINGS = { dashboard: 'overview', hosting: 'hosting', mail: 'mail' };
const tabLabel = (tab) => (Array.isArray(tab) ? tab[1] : (tab?.label ?? tab?.title ?? tabKey(tab)));

export default function SiteNavigation({ tabs, activeTab, domainId, query = '' }) {
  const groups = groupSiteTabs(tabs);
  // /resources is an old database entry. Its URL and engine remain supported.
  const activeKey = activeTab === 'resources' ? 'databases' : activeTab;
  const activeGroup = groups.find((group) => group.keys.includes(activeKey)) ?? groups[0];
  const landing = (group) => {
    const item = group?.tabs?.find((tab) => tabKey(tab) === LANDINGS[group.id]) ?? group?.tabs?.[0];
    return tabKey(item);
  };
  const tools = activeGroup?.tabs.filter((tab) => tabKey(tab) !== landing(activeGroup)) ?? [];
  return <div className="ws-plesk-site-navigation">
    <nav className="ws-tabs ws-plesk-task-groups" aria-label="Site görev grupları">
      {groups.map((group) => <Link key={group.id} to={`${siteHref(domainId, landing(group))}${query}`}
        aria-current={activeGroup?.id === group.id ? (activeKey === landing(group) ? 'page' : 'location') : undefined}>
        <Icon name={group.icon} size={16} />{group.label}
      </Link>)}
    </nav>
    {tools.length > 0 && <nav className="ws-tabs ws-plesk-task-tools" aria-label={`${activeGroup.label} araçları`}>
      {tools.map((tab) => {
        const key = tabKey(tab);
        const label = tabLabel(tab);
        return <Link key={key} to={`${siteHref(domainId, key)}${query}`} aria-current={activeKey === key ? 'page' : undefined}>
          <Icon name={ICONS[key] ?? 'box'} size={16} />{label}
        </Link>;
      })}
    </nav>}
  </div>;
}
