import { Link } from 'react-router';
import { Icon, PageHeading, Section } from './PanelKit.jsx';
import { TOOLS_SETTINGS_GROUPS } from './ui/ux-model.js';

export default function ToolsSettingsPage() {
  return <>
    <PageHeading title="Araçlar ve Ayarlar" description="Yerel sunucunun hizmetlerini ve panel ayarlarını yönetin. Siteye özel işlemler Web Siteleri ve Alan Adları içindedir." />
    {TOOLS_SETTINGS_GROUPS.map((group) => <Section key={group.id} title={group.label}>
      <div className="ws-console-quicklinks">{group.items.map(([to, label, icon]) => <Link className="ws-console-quicklink" key={to} to={to}><Icon name={icon} size={22} /><span>{label}</span></Link>)}</div>
    </Section>)}
  </>;
}
