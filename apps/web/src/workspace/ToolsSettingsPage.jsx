import { Link } from 'react-router';
import { Icon, PageHeading, Section } from './PanelKit.jsx';
import { TOOLS_SETTINGS_GROUPS } from './ui/ux-model.js';

const TOOL_DESCRIPTIONS = {
  '/servers': 'Sistem servisleri, kaynaklar ve kök terminal',
  '/firewall': 'Port kuralları, profiller ve CrowdSec engelleri',
  '/dashboard': 'Canlı CPU, bellek, disk ve özet göstergeler',
  '/settings?section=dns': 'Ad sunucuları, PowerDNS ve genel SSL politikaları',
  '/settings?section=updates': 'Panel sürümü ve paket güncellemeleri',
  '/docker': 'Konteyner projeleri, Compose yığınları ve hazır uygulamalar',
  '/settings/users': 'Panel hesapları, roller ve erişim profilleri',
  '/settings?section=account': 'Oturum güvenliği, parola ve MFA yönetimi',
  '/settings?section=license': 'Aktif paket, yetenekler ve lisans etkinleştirme',
  '/settings?section=ai': 'Model sağlayıcıları ve yardımcı asistan bağlantıları',
  '/settings?section=api': 'Otomasyon anahtarları ve yetki kapsamları',
  '/jobs': 'Arka plan görevleri ve uygulama kayıtları',
  '/audit': 'Yönetim hareketleri ve güvenlik denetim izi',
  '/logs': 'Sunucu ve web sitesi günlük kayıtları',
  '/servers#server-diagnostics': 'Kurulu bileşenler ve ortam doğrulaması',
  '/applications': 'Kayıtlı çalışma zamanı ve uygulama listesi',
  '/domains': 'Gelişmiş alan adı kayıtları ve sertifikalar',
};

const GROUP_DESCRIPTIONS = {
  server: 'Altyapı servisleri, güvenlik duvarı, ağ ve güncelleme kontrolleri',
  panel: 'Hesaplar, lisanslama, yapay zeka ve API entegrasyonları',
  diagnostics: 'İşlem geçmişi, denetim izleri ve sistem günlükleri',
};

export default function ToolsSettingsPage() {
  return <>
    <PageHeading title="Araçlar ve Ayarlar" description="Sunucu hizmetlerini, güvenlik duvarını ve panel ayarlarını yönetin." />
    {TOOLS_SETTINGS_GROUPS.map((group) => <Section key={group.id} title={group.label} description={GROUP_DESCRIPTIONS[group.id]} className="ws-tools-group-section">
      <div className="ws-console-quicklinks ws-tools-quicklinks">{group.items.map(([to, label, icon]) => (
        <Link className="ws-console-quicklink ws-tools-card" key={to} to={to}>
          <span className="ws-quicklink-icon" aria-hidden="true"><Icon name={icon} size={19} /></span>
          <span className="ws-quicklink-copy">
            <strong>{label}</strong>
            {TOOL_DESCRIPTIONS[to] && <small>{TOOL_DESCRIPTIONS[to]}</small>}
          </span>
          <span className="ws-quicklink-arrow" aria-hidden="true"><Icon name="arrow" size={15} /></span>
        </Link>
      ))}</div>
    </Section>)}
  </>;
}
