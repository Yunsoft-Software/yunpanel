import { Navigate, useSearchParams } from 'react-router';
import { useWorkspace } from './WorkspaceContext.jsx';
import { CollectionNotice, EmptyState, LinkButton, PageHeading, Section } from './PanelKit.jsx';
import { resolveSiteToolEntry } from './site-tool-entry-model.js';

const TOOL_META = {
  mail: { title: 'Posta', icon: 'mail' },
  databases: { title: 'Veritabanları', icon: 'database' },
  statistics: { title: 'İstatistikler', icon: 'dashboard' },
  analytics: { title: 'İstatistikler', icon: 'dashboard' },
  cron: { title: 'Zamanlanmış Görevler', icon: 'clock' },
  'scheduled-tasks': { title: 'Zamanlanmış Görevler', icon: 'clock' },
  backup: { title: 'Yedekleme ve Geri Yükleme', icon: 'archive' },
  backups: { title: 'Yedekleme ve Geri Yükleme', icon: 'archive' },
  logs: { title: 'Günlükler', icon: 'file' },
  php: { title: 'PHP / WordPress', icon: 'code' },
  ssl: { title: 'SSL/TLS Sertifikaları', icon: 'shield' },
  access: { title: 'Erişim Hesapları', icon: 'shield' },
};

export default function SiteToolEntryPage({ tool }) {
  const { websites, domains, canManage } = useWorkspace();
  const [params] = useSearchParams();
  const meta = TOOL_META[tool] ?? { title: 'Araç', icon: 'box' };
  const title = meta.title;
  const icon = meta.icon;
  const entry = resolveSiteToolEntry({ tool, websites, domains, canManage,
    requestedSiteId: params.has('site') ? params.get('site') : null });
  const forwardParams = new URLSearchParams(params);
  forwardParams.delete('site');
  const forwardQuery = forwardParams.toString() ? `?${forwardParams.toString()}` : '';

  if (entry.state === 'ready') return forwardQuery ? <Navigate to={`${entry.target.href}${forwardQuery}`} replace /> : <Navigate to={entry.target.href} replace />;
  return <>
    <PageHeading title={title} description="Yönetmek istediğiniz web sitesini seçin." />
    {entry.state === 'unavailable' && <><CollectionNotice resource={websites} label="Web siteleri" /><CollectionNotice resource={domains} label="Alan adları" />{websites.status === 'ready' && domains.status === 'ready' && <EmptyState icon={icon} title="Site listesi doğrulanamadı" detail="Sunucu beklenen site envanterini döndürmedi. Sayfayı yenileyip tekrar deneyin." />}</>}
    {['forbidden', 'unsupported'].includes(entry.state) && <EmptyState icon="shield" title="Bu araca erişilemiyor" detail="Hesabınızın site yönetimi yetkisini kontrol edin." />}
    {entry.state === 'not_found' && <EmptyState icon={icon} title="İstenen siteye erişilemiyor" detail="Site kaldırılmış veya yetkiniz değişmiş olabilir. Başka bir site otomatik açılmaz." action={<LinkButton to={`/${tool}`}>Site seçimine dön</LinkButton>} />}
    {entry.state === 'empty' && <EmptyState icon={icon} title="Henüz erişilebilir site yok" detail="Bu araç yalnız yetkili olduğunuz siteler için açılır." action={<LinkButton to="/websites">Web sitelerine git</LinkButton>} />}
    {['choose', 'unbound'].includes(entry.state) && <Section title="Web siteleri ve alan adları"><div className="ws-table-scroll"><table className="ws-table">
      <thead><tr><th scope="col">Alan adı</th><th scope="col">{title}</th></tr></thead>
      <tbody>{entry.targets.map((target) => <tr key={target.id}><td><strong>{target.label}</strong></td><td>{target.href
        ? <LinkButton to={`${target.href}${forwardQuery}`} icon={icon}>{title}</LinkButton>
        : <p>Site ile alan adı bağlantısı doğrulanamadı. Yöneticiyle bağlantı kaydını kontrol edin.</p>}</td></tr>)}</tbody>
    </table></div></Section>}
  </>;
}
