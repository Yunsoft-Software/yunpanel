import { Badge, Button, EmptyState, KeyValues, LinkButton, Section } from './PanelKit.jsx';
import { siteHref } from './site-model.js';
import WebsiteIsolationPanel from './WebsiteIsolationPanel.jsx';

export default function SiteAccessPanel({ domain, website, server, isOwner, canManage, onChanged }) {
  if (!website) {
    return <Section title="Erişim hesapları">
      <EmptyState
        icon="shield"
        title="Site bağlantısı gerekli"
        detail="Erişim hesapları ve SFTP/SSH bağlantı parametreleri için alan adının doğrulanmış bir web sitesine bağlı olması gerekir."
        action={<LinkButton to={siteHref(domain.id, 'overview')}>Siteye dön</LinkButton>}
      />
    </Section>;
  }

  const serverHost = server?.displayName ?? server?.hostname ?? server?.name ?? '127.0.0.1';
  const unixUser = website?.unixUser ?? (domain?.websiteId ? 'Site kullanıcısı hazırlanıyor' : 'Bağlı site yok');
  const docRoot = domain.targetType === 'static'
    ? (domain.target?.root || '—')
    : (website?.applicationId ? `/var/lib/yunpanel/data/${website.applicationId}` : '—');
  const isolationLevel = website.unixUser ? 'Dedicated Unix kullanıcısı (İzole)' : 'Standart Unix ortamı';

  return <>
    <Section
      title="Erişim hesapları"
      description={`${domain.primaryDomain} · SFTP, SSH ve sistem kullanıcısı erişim parametreleri.`}
      actions={<div className="ws-actions">
        <LinkButton to={siteHref(domain.id, 'terminal')} icon="terminal">Site terminali</LinkButton>
        <LinkButton to={siteHref(domain.id, 'files')} icon="folder">Dosya Yöneticisi</LinkButton>
      </div>}
    >
      <div className="ws-section-body">
        <div className="ws-actions">
          <Badge state={website.unixUser ? 'active' : 'warning'}>{isolationLevel}</Badge>
          <LinkButton to={siteHref(domain.id, 'overview')} icon="arrow">Genel bakışa dön</LinkButton>
        </div>
      </div>
      <KeyValues items={[
        ['Protokol', 'SFTP / SSH'],
        ['Sunucu adresi', serverHost],
        ['Bağlantı noktası (Port)', '22'],
        ['Kullanıcı adı', unixUser],
        ['Belge kök dizini (Docroot)', docRoot],
        ['İzolasyon durumu', isolationLevel],
        ['Uygulama çalışma türü', website.runtimeType ?? 'Standart'],
      ]} />
      <div className="ws-section-body">
        <p className="ws-muted">
          Bu web sitesine ait dosyalara SFTP istemciniz veya SSH üzerinden yukarıdaki kullanıcıyla bağlanabilirsiniz.
          Site dosyaları yalnız bu sitenin sistem kullanıcısıyla çalıştırılır; diğer sitelerden izoledir.
        </p>
      </div>
    </Section>

    {isOwner ? (
      <WebsiteIsolationPanel websiteId={website.id} onChanged={onChanged} />
    ) : (
      <Section title="Sistem izolasyonu">
        <div className="ws-section-body">
          <p className="ws-muted">
            Unix kimlik doğrulama ve sunucu güvenlik izolasyonu sunucu yöneticisi tarafından denetlenmektedir.
            Yetkili olduğunuz site araçlarına yukarıdaki bağlantılardan erişebilirsiniz.
          </p>
        </div>
      </Section>
    )}
  </>;
}
