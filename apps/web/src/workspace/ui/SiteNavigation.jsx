import { Link } from 'react-router';
import { Icon } from '../PanelKit.jsx';
import { siteHref } from '../site-model.js';
import { groupSiteTabs } from './ux-model.js';

// These are real document links, not ARIA tabs or a second router. Domain IDs
// retain their existing route meaning; Website IDs are never substituted.
export default function SiteNavigation({ tabs, activeTab, domainId, query = '' }) {
  return (
    <nav className="ws-tabs ws-site-navigation" aria-label="Website yönetimi">
      {tabs.map(([key, label]) => (
        <Link
          key={key}
          to={`${siteHref(domainId, key)}${query}`}
          aria-current={key === activeTab ? 'page' : undefined}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
