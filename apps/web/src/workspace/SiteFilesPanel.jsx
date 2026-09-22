import { useWorkspace } from './WorkspaceContext.jsx';
import FilesPanel from './FilesPanel.jsx';
import { Button, CollectionNotice, EmptyState, Section } from './PanelKit.jsx';
import { resolveSiteFilesAccess } from './site-files-access.js';

const MESSAGES = {
  forbidden: ['Dosya erişimi yetkiniz yok', 'Bu hesap için dosya yönetimi izni bulunmuyor.'],
  not_found: ['Site dosya alanı doğrulanamadı', 'Site kaydı kaldırılmış veya erişiminiz değişmiş olabilir. Başka bir sitenin dosyaları otomatik açılmaz.'],
  unbound: ['Site bağlantısı gerekli', 'Alan adının dosya alanına bağlantısı henüz kurulmamış. Site bağlantısını yöneticinizle kontrol edin.'],
  inconsistent: ['Site bağlantısı tutarsız', 'Alan adı ve dosya alanının sunucu ilişkisi doğrulanamadı. Dosya erişimi güvenlik için başlatılmadı.'],
  unsupported: ['Bu çalışma türünde dosya erişimi hazır değil', 'Dosya Yöneticisi kaldırılmadı. Bu çalışma türü için dosya alanı entegrasyonu henüz desteklenmiyor.'],
};

export default function SiteFilesPanel({ domainId, legacyRepair = null }) {
  const { domains, websites, canManage, refreshAll } = useWorkspace();
  const access = resolveSiteFilesAccess({ domainId, domains, websites, canManage });
  if (access.state === 'ready') return <FilesPanel key={access.website.id}
    serverId={access.website.serverId} websiteId={access.website.id} runtimeType={access.website.runtimeType} />;
  // Preserve the existing Owner-only migration flow, without guessing a binding.
  if (access.state === 'unbound' && legacyRepair) return legacyRepair;
  const busy = [domains.status, websites.status].some((status) => ['idle', 'loading', 'refreshing'].includes(status));
  const message = MESSAGES[access.state];
  return <Section title="Dosya Yöneticisi" actions={canManage && <Button icon="refresh" disabled={busy} onClick={refreshAll}>Yeniden dene</Button>}>
    <div className="ws-section-body">
      {access.state === 'unavailable' ? <>
        <CollectionNotice resource={domains} label="Alan adı" />
        <CollectionNotice resource={websites} label="Site dosya alanı" />
        <p role="status">{busy ? 'Site dosya alanı yükleniyor…' : 'Güncel site bilgisi doğrulanamadı. Dosya Yöneticisi burada kalır; bilgileri yenileyip yeniden deneyin.'}</p>
      </> : <EmptyState icon="folder" title={message?.[0] ?? 'Dosya erişimi doğrulanamadı'} detail={message?.[1]} />}
    </div>
  </Section>;
}
