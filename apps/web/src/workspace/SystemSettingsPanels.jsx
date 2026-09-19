import { useEffect, useState } from 'react';
import { Badge, Button, ErrorNotice, KeyValues, Section } from './PanelKit.jsx';
import { getPanelSettings } from './system-settings-client.js';

function formatUptime(seconds) {
  if (!seconds || seconds < 0) return '—';
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d} gün`);
  if (h > 0) parts.push(`${h} saat`);
  parts.push(`${m} dk`);
  return parts.join(' ');
}

export default function SystemSettingsPanels({ canManage = true }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getPanelSettings();
      setData(res?.data ?? null);
    } catch (err) {
      setError(err?.message ?? 'Ayar bilgileri yüklenemedi.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (loading) {
    return <div className="ws-loading" role="status"><span className="ws-spinner" />Sistem ayarları yükleniyor…</div>;
  }

  if (error) {
    return (
      <Section title="Sistem ayarları">
        <ErrorNotice error={error} />
        <Button onClick={load} icon="refresh">Yeniden dene</Button>
      </Section>
    );
  }

  if (!data) return null;

  const {
    panel,
    websiteDefaults,
    dnsSsl,
    mail,
    database,
    cache,
    backup,
    security,
    observability,
    managedServices,
  } = data;

  return (
    <>
      <Section
        title="Panel ve sunucu"
        description="Sunucu kimliği, çalışma modu ve panel yazılım bilgisi."
        actions={<Button onClick={load} icon="refresh" variant="secondary">Yenile</Button>}
      >
        <KeyValues items={[
          ['Panel sürümü', `YunPanel v${panel.version}`],
          ['Node.js sürümü', panel.nodeVersion],
          ['Platform ve mimari', `${panel.platform} (${panel.arch})`],
          ['Sunucu adı (Hostname)', panel.hostname],
          ['Sunucu görünen adı', panel.displayName ?? '—'],
          ['Yerel sunucu kimliği', panel.localServerId ?? '—'],
          ['Çalışma modu', panel.executionMode === 'local' ? 'Yerel yönetim (Agentless Root)' : panel.executionMode],
          ['Çalışma süresi', formatUptime(panel.uptimeSeconds)],
        ]} />
      </Section>

      <Section
        title="Site varsayılanları ve izolasyon"
        description="Yeni oluşturulan web siteleri için uygulanan varsayılan çalışma zamanı ve Unix kullanıcı izolasyonu."
      >
        <KeyValues items={[
          ['Varsayılan çalışma zamanı', websiteDefaults.defaultRuntime === 'node' ? 'Node.js (Passenger)' : websiteDefaults.defaultRuntime === 'php' ? 'PHP-FPM' : 'Statik web'],
          ['Varsayılan Node.js sürümü', `Node.js ${websiteDefaults.defaultNodeMajor}`],
          ['Varsayılan PHP sürümü', `PHP ${websiteDefaults.defaultPhpVersion}`],
          ['Belge kök şablonu', websiteDefaults.defaultDocumentRootPattern],
          ['Dosya izin maskesi (UMask)', websiteDefaults.defaultUmask],
          ['Unix kimlik izolasyonu', `${websiteDefaults.isolationUserPrefix}* (Site başına bağımsız Unix kullanıcısı ve grubu)`],
        ]} />
      </Section>

      <Section
        title="DNS ve SSL politikası"
        description="Alan adı yetkili DNS yönetimi ve Let's Encrypt SSL/TLS sertifika yaşam döngüsü."
      >
        <KeyValues items={[
          ['Yetkili DNS motoru', dnsSsl.authoritativeProvider === 'powerdns' ? 'PowerDNS Authoritative' : dnsSsl.authoritativeProvider],
          ['ACME sağlayıcısı', dnsSsl.acmeProvider === 'letsencrypt' ? "Let's Encrypt (HTTP-01 & DNS-01)" : dnsSsl.acmeProvider],
          ['ACME iletişim e-postası', dnsSsl.acmeEmail ?? 'Tanımlanmadı (YUNPANEL_ACME_EMAIL)'],
          ['Otomatik yenileme döngüsü', `Süresi dolmaya ${dnsSsl.autoRenewDaysBeforeExpiry} gün kala günlük denetim`],
          ['Özel sertifika deposu', dnsSsl.customCertificatesRoot],
        ]} />
      </Section>

      <Section
        title="Mail ve Webmail mimarisi"
        description="SQLite tabanlı sanal posta altyapısı ve paylaşımlı Roundcube webmail arayüzü."
      >
        <KeyValues items={[
          ['Mail motoru', mail.engine],
          ['Kimlik doğrulama ve depolama', `${mail.authStorage.toUpperCase()} (${mail.authDatabasePath})`],
          ['Posta kutusu dizini', mail.maildirRoot],
          ['Webmail dağıtımı', `${mail.webmail.engine.toUpperCase()} (${mail.webmail.deployment})`],
          ['Webmail adres şablonu', mail.webmail.subdomainPattern],
        ]} />
      </Section>

      <Section
        title="Veritabanı ve önbellek (Cache)"
        description="MariaDB veritabanı, phpMyAdmin güvenli erişim köprüsü ve site izolasyonlu Redis/Memcached politikası."
      >
        <KeyValues items={[
          ['Veritabanı motoru', database.engine === 'mariadb' ? 'MariaDB / MySQL' : database.engine],
          ['Veritabanı yöneticisi', `${database.client.engine} (${database.client.deployment} / ${database.client.access})`],
          ['Redis izolasyonu', `${cache.redis.isolation} (Kullanıcı: ${cache.redis.userPattern}, Kapsam: ${cache.redis.keyPrefix})`],
          ['Redis güvenlik kısıtları', cache.redis.dangerousCommandsRestricted ? 'Tehlikeli komutlar yasak (-@dangerous -@admin -FLUSHALL -CONFIG)' : 'Standart'],
          ['Memcached izolasyonu', `${cache.memcached.isolation} (Önek: ${cache.memcached.keyPrefix})`],
        ]} />
      </Section>

      <Section
        title="Yedekleme ve depolama"
        description="restic ile şifreli, tekilleştirilmiş (deduplicated) anlık görüntü yedekleme ve rclone uzak depolama."
      >
        <KeyValues items={[
          ['Yedekleme motoru', `${backup.engine} (Durable snapshot & retention)`],
          ['Uzak depolama motoru', `${backup.remoteEngine} (S3, B2, Google Cloud, SFTP desteği)`],
          ['Yerel yedek deposu', backup.localBackupRoot],
          ['Varsayılan saklama politikası', `Günlük: ${backup.retentionDefaults.retentionDaily}, Haftalık: ${backup.retentionDefaults.retentionWeekly}, Aylık: ${backup.retentionDefaults.retentionMonthly}`],
        ]} />
      </Section>

      <Section
        title="Güvenlik ve güvenlik duvarı"
        description="Kullanıcı kimlik doğrulama, SFTP chroot sınırları ve nftables/CrowdSec koruması."
      >
        <KeyValues items={[
          ['Parola hash algoritması', security.authHash.toUpperCase()],
          ['İki adımlı doğrulama (MFA)', security.mfa.toUpperCase()],
          ['SFTP erişim motoru', security.sftp.engine],
          ['SFTP izolasyon sınırı', security.sftp.chrootPattern],
          ['SFTP yetkili anahtar yolu', security.sftp.authorizedKeysRoot],
          ['Güvenlik duvarı motoru', `${security.firewall.engine} + ${security.firewall.bouncer}`],
        ]} />
      </Section>

      <Section
        title="İzleme ve log analizi"
        description="Gerçek zamanlı sunucu kaynak tüketimi ve site bazlı erişim log analizörleri."
      >
        <KeyValues items={[
          ['Sistem metrikleri', `${observability.metrics.engine} (${observability.metrics.mode})`],
          ['Erişim log analizi', `${observability.logs.engine} (${observability.logs.mode})`],
        ]} />
      </Section>

      {managedServices?.services && managedServices.services.length > 0 && (
        <Section
          title="Yönetilen servisler ve durumlar"
          description="Sunucu üzerindeki temel hosting ve altyapı servislerinin anlık durumu."
        >
          <div className="ws-table-container">
            <table className="ws-table">
              <thead>
                <tr>
                  <th>Servis</th>
                  <th>Durum</th>
                  <th>Kurulu Paket</th>
                  <th>Sistem Servisi (Unit)</th>
                </tr>
              </thead>
              <tbody>
                {managedServices.services.map((svc) => (
                  <tr key={svc.id}>
                    <td><strong>{svc.id}</strong></td>
                    <td>
                      <Badge state={svc.state === 'active' ? 'active' : svc.state === 'failed' ? 'failed' : 'offline'}>
                        {svc.state ?? 'bilinmiyor'}
                      </Badge>
                    </td>
                    <td>{svc.installed ? 'Kurulu' : 'Kurulu değil'}</td>
                    <td><code>{svc.units?.join(', ') || '—'}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </>
  );
}
