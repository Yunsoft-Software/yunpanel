import { Link, useNavigate } from 'react-router';
import { Icon } from '../PanelKit.jsx';
import { siteHref } from '../site-model.js';
import { groupSiteTabs, tabKey } from './ux-model.js';
import './site-resource-workspace.css';
import './plesk-navigation.css';

const ICONS = { overview: 'dashboard', hosting: 'globe', files: 'folder', databases: 'database', mail: 'mail', ssl: 'shield', node: 'code', deploy: 'git', domains: 'globe', dns: 'globe', logs: 'file', analytics: 'dashboard', cron: 'clock', backup: 'archive', terminal: 'terminal', php: 'code', wordpress: 'code', access: 'shield', settings: 'settings', resources: 'box' };
const MOBILE_PRIMARY_KEYS = ['overview', 'files', 'ssl', 'backup', 'settings'];
const MOBILE_SHORT_LABELS = {
  overview: 'Genel Bakış',
  files: 'Dosyalar',
  ssl: 'SSL',
  backup: 'Yedekleme',
  settings: 'Ayarlar',
  databases: 'Veritabanı',
  mail: 'E-posta',
  dns: 'DNS',
  domains: 'Alan Adları',
};
const tabLabel = (tab) => (Array.isArray(tab) ? tab[1] : (tab?.label ?? tab?.title ?? tabKey(tab)));

export default function SiteNavigation({ tabs, activeTab, domainId, query = '' }) {
  const navigate = useNavigate();
  const groups = groupSiteTabs(tabs);
  // /resources is an old database entry. Its URL and engine remain supported.
  const activeKey = activeTab === 'resources' ? 'databases' : activeTab;
  const allTabs = groups.flatMap((group) => group.tabs);
  const keys = allTabs.map(tabKey);
  const mobilePrimaryTabs = [];
  for (const preferredKey of MOBILE_PRIMARY_KEYS) {
    const match = allTabs.find((tab) => tabKey(tab) === preferredKey);
    if (match) mobilePrimaryTabs.push(match);
  }
  for (const fallbackTab of allTabs) {
    if (mobilePrimaryTabs.length >= 4) break;
    if (!mobilePrimaryTabs.some((item) => tabKey(item) === tabKey(fallbackTab))) {
      mobilePrimaryTabs.push(fallbackTab);
    }
  }
  function choose(key) {
    if (keys.includes(key) && key !== activeKey) navigate(`${siteHref(domainId, key)}${query}`);
  }
  function keyboard(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const index = keys.indexOf(activeKey);
    if (index < 0) return;
    const next = { Home: 0, End: keys.length - 1, ArrowUp: Math.max(0, index - 1), ArrowDown: Math.min(keys.length - 1, index + 1) }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    choose(keys[next]);
  }
  return <nav className="ws-plesk-site-navigation" aria-label="Site araçları">
    <div className="ws-site-tool-mobile" data-mobile-site-nav="true">
      <div className="ws-site-tool-mobile-primary" role="group" aria-label="Öncelikli site araçları">
        {mobilePrimaryTabs.map((tab) => {
          const key = tabKey(tab);
          const label = MOBILE_SHORT_LABELS[key] ?? tabLabel(tab);
          return <Link key={key} to={`${siteHref(domainId, key)}${query}`} aria-current={activeKey === key ? 'page' : undefined}>
            <Icon name={ICONS[key] ?? 'box'} size={15} /><span>{label}</span>
          </Link>;
        })}
      </div>
      <label className="ws-site-tool-select">Diğer site araçları<select aria-label="Diğer site araçları" value={activeKey}
        onKeyDown={keyboard} onChange={event => choose(event.target.value)}>
        {groups.map(group => <optgroup key={group.id} label={group.label}>{group.tabs.map(tab => <option key={tabKey(tab)} value={tabKey(tab)}>{tabLabel(tab)}</option>)}</optgroup>)}
      </select></label>
    </div>
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
