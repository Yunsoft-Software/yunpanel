import { Link, useNavigate } from 'react-router';
import { Icon } from '../PanelKit.jsx';
import { siteHref } from '../site-model.js';
import { groupSiteTabs, tabKey } from './ux-model.js';
import './site-resource-workspace.css';
import './plesk-navigation.css';

const ICONS = { overview: 'dashboard', hosting: 'globe', files: 'folder', databases: 'database', mail: 'mail', ssl: 'shield', node: 'code', deploy: 'git', domains: 'globe', dns: 'globe', logs: 'file', analytics: 'dashboard', cron: 'clock', backup: 'archive', terminal: 'terminal', php: 'code', wordpress: 'code', access: 'shield', settings: 'settings', resources: 'box' };
const tabLabel = (tab) => (Array.isArray(tab) ? tab[1] : (tab?.label ?? tab?.title ?? tabKey(tab)));

export default function SiteNavigation({ tabs, activeTab, domainId, query = '' }) {
  const navigate = useNavigate();
  const groups = groupSiteTabs(tabs);
  // /resources is an old database entry. Its URL and engine remain supported.
  const activeKey = activeTab === 'resources' ? 'databases' : activeTab;
  return <nav className="ws-plesk-site-navigation" aria-label="Site araçları">
    <label className="ws-site-tool-select">Site aracı<select aria-label="Site aracı" value={activeKey}
      onChange={event => {
        const key = event.target.value;
        if (groups.some(group => group.tabs.some(tab => tabKey(tab) === key))) navigate(`${siteHref(domainId, key)}${query}`);
      }}>
      {groups.map(group => <optgroup key={group.id} label={group.label}>{group.tabs.map(tab => <option key={tabKey(tab)} value={tabKey(tab)}>{tabLabel(tab)}</option>)}</optgroup>)}
    </select></label>
    {groups.map((group) => <div key={group.id} className="ws-site-tool-group ws-site-tool-desktop">
      <span className="ws-site-tool-group-label">{group.label}</span>
      <div className="ws-tabs ws-plesk-task-tools">
      {group.tabs.map((tab) => {
        const key = tabKey(tab);
        const label = tabLabel(tab);
        return <Link key={key} to={`${siteHref(domainId, key)}${query}`} aria-current={activeKey === key ? 'page' : undefined}>
          <Icon name={ICONS[key] ?? 'box'} size={16} />{label}
        </Link>;
      })}
      </div>
    </div>)}
  </nav>;
}
