import { AuthError } from './auth-error.js';
import { TenantBoundaryError, extractActorTenant } from './tenant-boundary.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

export class ResellerBrandingDeferredError extends AuthError {
  constructor(message = 'Reseller branding is deferred to the next phase and must not pollute current tenant models.') {
    super('reseller_branding_deferred', message, 403);
    this.name = 'ResellerBrandingDeferredError';
  }
}

export class CapabilityRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'CapabilityRegistryError';
    this.code = code;
    this.status = status;
  }
}

export const TASK_GROUPS = Object.freeze({
  GROUP_B: 'B',
  GROUP_C: 'C',
  GROUP_D: 'D',
  GROUP_E: 'E',
});

export const FORBIDDEN_BRANDING_KEYS = Object.freeze([
  'brand',
  'branding',
  'whiteLabel',
  'whitelabel',
  'customLogo',
  'customTheme',
  'logoUrl',
  'brandName',
  'brandDomain',
  'brandColors',
  'brandAssets',
  'vanityUrl',
  'resellerLogo',
  'resellerTheme',
  'resellerBranding',
]);

function createCap(id, category, title, status, sourceModules, apiEndpoints, serviceAdapters, groupCrossConnects, rolesAllowed, scopeLevel) {
  return Object.freeze({
    id,
    category,
    title,
    status,
    sourceModules: Object.freeze([...sourceModules]),
    apiEndpoints: Object.freeze([...apiEndpoints]),
    serviceAdapters,
    groupCrossConnects: Object.freeze([...groupCrossConnects]),
    rolesAllowed: Object.freeze([...rolesAllowed]),
    scopeLevel,
    reimplementationPrevented: true,
  });
}

const G_B = TASK_GROUPS.GROUP_B;
const G_C = TASK_GROUPS.GROUP_C;
const G_D = TASK_GROUPS.GROUP_D;
const G_E = TASK_GROUPS.GROUP_E;

const RAW_CAPABILITIES = [
  // DNS
  createCap('DNS-01', 'dns', 'Domain zone ve RR CRUD (A, AAAA, CNAME vb.)', 'completed', ['apps/api/src/powerdns-http.js', 'apps/api/src/dns-requirements-service.js'], ['/api/dns/zones', '/api/dns/zones/:zoneId/records'], 'PowerDNS / BIND', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('DNS-02', 'dns', 'TTL, SOA ve zone şablonları', 'completed', ['apps/api/src/powerdns-http.js', 'apps/api/src/dns-zone-template-registry.js'], ['/api/dns/zones/:zoneId/soa'], 'PowerDNS', [G_C, G_D], ['owner', 'reseller'], 'management_scoped'),
  createCap('DNS-03', 'dns', 'Master/secondary, DNS aç/kapat', 'completed', ['apps/api/src/dns-hosting-registry.js', 'apps/api/src/powerdns-http.js'], ['/api/dns/zones/:zoneId/status'], 'PowerDNS / Harici sağlayıcı', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('DNS-04', 'dns', 'DNSSEC anahtar/DS/rollover', 'partial', ['apps/api/src/powerdns-http.js', 'apps/api/src/dns-zone-dnssec-http.js'], ['/api/dns/zones/:zoneId/dnssec'], 'PowerDNS', [G_C, G_D], ['owner'], 'owner_only'),
  createCap('DNS-05', 'dns', 'Zone transfer yetkileri (AXFR)', 'completed', ['apps/api/src/powerdns-http.js'], ['/api/dns/zones/:zoneId/axfr-acl'], 'PowerDNS', [G_C, G_D], ['owner'], 'owner_only'),
  createCap('DNS-06', 'dns', 'Cloudflare entegrasyonu & yayılım', 'completed', ['apps/api/src/dns-requirements-service.js', 'apps/api/src/dns-provider-credential-registry.js'], ['/api/dns/providers/cloudflare'], 'Cloudflare / Harici DNS', [G_C, G_D, G_E], ['owner', 'reseller'], 'management_scoped'),

  // Mail
  createCap('EML-01', 'mail', 'Mailbox CRUD, parola ve kota', 'completed', ['apps/api/src/mailbox-http.js', 'apps/api/src/mailbox-quota-http.js', 'apps/api/src/mailbox-registry.js'], ['/api/mailboxes', '/api/mailboxes/:id', '/api/mailboxes/:id/quota'], 'Postfix / Dovecot', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('EML-02', 'mail', 'Alias, forwarding ve yerel kopya', 'completed', ['apps/api/src/mail-alias-http.js', 'apps/api/src/mailbox-forwarding-http.js'], ['/api/mail-aliases', '/api/mailboxes/:id/forwarding'], 'Postfix', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('EML-03', 'mail', 'Otomatik yanıt / tatil mesajları', 'partial', ['apps/api/src/mail-configuration-http.js'], ['/api/mailboxes/:id/autoresponder'], 'Dovecot Sieve', [G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('EML-04', 'mail', 'Spam filtre, allow/deny list', 'partial', ['apps/api/src/mail-configuration-http.js'], ['/api/mail/spam-filter'], 'Rspamd', [G_C, G_D], ['owner', 'reseller', 'site_manager'], 'site_scoped'),
  createCap('EML-05', 'mail', 'Mailing list (Mailman)', 'deferred', [], [], 'Mailman', [G_D], ['owner'], 'owner_only'),
  createCap('EML-06', 'mail', 'Domain mail aç/kapat, catch-all', 'completed', ['apps/api/src/mail-configuration-http.js', 'apps/api/src/mail-domain-registry.js'], ['/api/mail-domains', '/api/mail-domains/:id/status'], 'Postfix', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('EML-07', 'mail', 'Webmail (Roundcube) & istemci ayarları', 'completed', ['apps/api/src/roundcube-configuration-http.js', 'apps/api/src/roundcube-domain-mapping-registry.js'], ['/api/roundcube/configuration', '/api/roundcube/mappings'], 'Roundcube / Nginx', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('EML-08', 'mail', 'SMTP/IMAP/POP3 port politikası', 'completed', ['apps/api/src/mail-delivery-diagnostics-service.js'], ['/api/mail/diagnostics/ports'], 'Postfix / Dovecot', [G_C, G_D, G_E], ['owner', 'reseller', 'site_manager'], 'site_scoped'),
  createCap('EML-09', 'mail', 'SPF/DKIM/DMARC ve relay güvenliği', 'completed', ['apps/api/src/mail-dkim-http.js', 'apps/api/src/dns-requirements-service.js'], ['/api/mail-domains/:id/dkim'], 'BIND / PowerDNS / Cloudflare', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('EML-10', 'mail', 'Posta kuyruğu & teslimat tanılama', 'completed', ['apps/api/src/mail-delivery-diagnostics-service.js', 'apps/api/src/mail-diagnostics-http.js'], ['/api/mail/diagnostics/test-delivery', '/api/mail/queue'], 'Postfix', [G_C, G_D], ['owner', 'reseller', 'site_manager'], 'site_scoped'),
  createCap('EML-11', 'mail', 'Mail servisi sertifikası & SNI', 'completed', ['apps/api/src/mail-service-identity-http.js', 'apps/api/src/certificate-http.js'], ['/api/mail/service-identities'], 'Dovecot / Postfix', [G_C, G_D], ['owner'], 'owner_only'),

  // Database
  createCap('DB-01', 'database', 'MySQL/MariaDB CRUD, site bağı, boyut', 'completed', ['apps/api/src/database-http.js', 'apps/api/src/website-database-delete-http.js', 'apps/api/src/database-binding-http.js'], ['/api/servers/:id/databases', '/api/websites/:id/databases'], 'MariaDB 10.x / MySQL 8.0', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('DB-02', 'database', 'DB kullanıcıları, roller ve grant', 'completed', ['apps/api/src/database-credential-http.js', 'apps/api/src/database-credential-registry.js'], ['/api/servers/:id/databases/:db/credentials'], 'MariaDB / MySQL', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('DB-03', 'database', 'Uzak erişim & bağlantı bilgisi', 'completed', ['apps/api/src/database-credential-http.js'], ['/api/servers/:id/databases/:db/credentials/:cred/access'], 'MariaDB', [G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('DB-04', 'database', 'phpMyAdmin geçişi & yetki izolasyonu', 'completed', ['apps/api/src/phpmyadmin-handoff-http.js', 'apps/api/src/phpmyadmin-handoff-service.js'], ['/api/servers/:id/websites/:websiteId/phpmyadmin-handoffs'], 'phpMyAdmin / Nginx', [G_B, G_C, G_D, G_E], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('DB-05', 'database', 'Dump import/export, kopyalama', 'completed', ['apps/api/src/website-database-data-http.js'], ['/api/servers/:id/websites/:websiteId/databases/:db/export'], 'MariaDB / gzip', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('DB-06', 'database', 'Veritabanı denetimi ve onarımı', 'completed', ['apps/api/src/database-http.js'], ['/api/servers/:id/databases/:db/repair'], 'InnoDB / MyISAM', [G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('DB-07', 'database', 'Abonelikler arası DB taşıma', 'deferred', [], [], 'MariaDB', [G_D], ['owner'], 'owner_only'),
  createCap('DB-08', 'database', 'PostgreSQL desteği', 'separate_track', [], [], 'PostgreSQL (Ayrı Adaptör)', [G_D], ['owner'], 'owner_only'),
  createCap('DB-09', 'database', 'Uzak DB sunucusu kaydı', 'partial', ['apps/api/src/server-registry.js'], ['/api/servers/:id/databases'], 'Harici MySQL Cluster', [G_C, G_D], ['owner'], 'owner_only'),

  // Runtime
  createCap('RUN-01', 'runtime', 'Docroot, sistem kullanıcısı ve hosting', 'completed', ['apps/api/src/site-create.js', 'apps/api/src/website-provisioning-runtime.js'], ['/api/sites', '/api/sites/hosted'], 'Ubuntu Linux / Useradd / Nginx', [G_B, G_C, G_D, G_E], ['owner', 'reseller'], 'management_scoped'),
  createCap('RUN-02', 'runtime', 'PHP sürümü, php.ini, PHP-FPM', 'completed', ['apps/api/src/website-php-tools-http.js', 'apps/api/src/website-php-tools-service.js'], ['/api/websites/:id/php-tools/status', '/api/websites/:id/php-tools/config'], 'PHP-FPM (7.4, 8.1, 8.2, 8.3)', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('RUN-03', 'runtime', 'Apache/Nginx ek direktifler', 'completed', ['apps/api/src/domain-http.js'], ['/api/domains/:id/nginx-directives'], 'Nginx reverse proxy', [G_C, G_D], ['owner'], 'owner_only'),
  createCap('RUN-04', 'runtime', 'MIME, index, hata sayfaları, basic auth', 'completed', ['apps/api/src/domain-http.js'], ['/api/websites/:id/http-auth'], 'Nginx', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('RUN-05', 'runtime', 'Node.js sürümü, app root, environment', 'completed', ['apps/api/src/node-runtime-http.js', 'apps/api/src/application-configuration-http.js'], ['/api/applications/:id/environment', '/api/applications/:id/configuration'], 'Node.js / Systemd / Passenger', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('RUN-06', 'runtime', 'Node script, restart ve canlı loglar', 'completed', ['apps/api/src/application-process-http.js', 'apps/api/src/application-deploy-queue.js'], ['/api/applications/:id/process', '/api/applications/:id/logs'], 'npm / yarn / pnpm / systemd', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('RUN-07', 'runtime', 'Composer bağımlılık yönetimi', 'completed', ['apps/api/src/website-php-tool-action.js', 'apps/api/src/website-php-tool-action-service.js'], ['/api/websites/:id/php-tools/actions/queue'], 'Composer / PHP CLI', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('RUN-08', 'runtime', 'Dil/runtime eklentileri (Python, Docker)', 'completed', ['apps/api/src/application-operations-http.js', 'apps/api/src/docker-workload-http.js'], ['/api/applications/:id/python', '/api/docker/workloads'], 'Python / Docker (Ürün Uzantısı)', [G_B, G_C, G_D, G_E], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),

  // Docker
  createCap('DKR-01', 'docker', 'Registry/image arama ve yönetim', 'completed', ['apps/api/src/docker-workload-http.js', 'apps/api/src/docker-workload-registry.js'], ['/api/docker/images', '/api/docker/workloads'], 'Docker Engine / Linux', [G_C, G_D], ['owner', 'reseller', 'customer'], 'management_scoped'),
  createCap('DKR-02', 'docker', 'Container CRUD ve süreç kontrolü', 'completed', ['apps/api/src/docker-workload-http.js'], ['/api/docker/workloads/:id/process'], 'Docker daemon', [G_C, G_D], ['owner'], 'owner_only'),
  createCap('DKR-03', 'docker', 'Port, environment, volume politikası', 'completed', ['apps/api/src/docker-workload-http.js'], ['/api/docker/workloads/:id/config'], 'Docker / Bridge', [G_C, G_D], ['owner'], 'owner_only'),
  createCap('DKR-04', 'docker', 'Reverse proxy bağlantısı ve loglar', 'completed', ['apps/api/src/docker-workload-http.js', 'apps/api/src/domain-http.js'], ['/api/docker/workloads/:id/proxy', '/api/docker/workloads/:id/logs'], 'Nginx upstream', [G_B, G_C, G_D], ['owner', 'reseller', 'site_manager'], 'site_scoped'),
  createCap('DKR-05', 'docker', 'Compose stack oluşturma (up/down)', 'completed', ['apps/api/src/docker-workload-http.js'], ['/api/docker/compose'], 'Linux / docker-compose', [G_C, G_D], ['owner'], 'owner_only'),
  createCap('DKR-06', 'docker', 'Yapılandırma yedeği ile volume ayrımı', 'completed', ['apps/api/src/backup-resource-provider.js'], ['/api/backups'], 'Restic / Docker', [G_C, G_D], ['owner'], 'owner_only'),

  // Git & Framework
  createCap('DEV-01', 'git', 'Uzak/yerel Git repository', 'completed', ['apps/api/src/application-operations-http.js'], ['/api/applications/:id/git'], 'Git CLI / SSH', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('DEV-02', 'git', 'Branch, deploy path, manuel/otomatik deploy', 'completed', ['apps/api/src/application-deploy-queue.js', 'apps/api/src/application-operations-http.js'], ['/api/applications/:id/deploy'], 'Git / Bash', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('DEV-03', 'git', 'Deploy key, webhook ve sonuç takibi', 'completed', ['apps/api/src/application-operations-http.js', 'apps/api/src/github-webhook-http.js'], ['/api/applications/:id/webhook', '/api/applications/:id/deploy-key'], 'Webhook HMAC / SSH keygen', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('DEV-04', 'git', 'Laravel oluşturma & tarama', 'partial', ['apps/api/src/website-php-tools-service.js'], ['/api/websites/:id/framework/laravel'], 'Composer / Laravel', [G_B, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('DEV-05', 'git', 'Laravel environment, Artisan, Composer', 'completed', ['apps/api/src/website-php-tool-action.js', 'apps/api/src/application-configuration-http.js'], ['/api/websites/:id/php-tools/actions/queue'], 'Artisan / Composer', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('DEV-06', 'git', 'Laravel scheduled task & logs', 'completed', ['apps/api/src/website-cron-http.js', 'apps/api/src/application-operations-http.js'], ['/api/websites/:id/cron'], 'Linux Crontab (artisan schedule:run)', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),

  // WordPress
  createCap('WP-01', 'wordpress', 'WordPress kurma, tarama, admin girişi', 'completed', ['apps/api/src/website-php-tools-service.js'], ['/api/websites/:id/wordpress'], 'WP-CLI / PHP', [G_B, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('WP-02', 'wordpress', 'Core/plugin/theme güncelleme', 'completed', ['apps/api/src/website-php-tool-action.js', 'apps/api/src/website-php-tool-action-service.js'], ['/api/websites/:id/php-tools/actions/queue'], 'WP-CLI / PHP', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('WP-03', 'wordpress', 'Toplu yönetim ve setler', 'deferred', [], [], 'Linux Shell / WP-CLI', [G_D], ['owner'], 'owner_only'),
  createCap('WP-04', 'wordpress', 'Klonlama, staging ve veri senkronizasyonu', 'partial', ['apps/api/src/website-restore-service.js'], ['/api/websites/:id/restore/preview'], 'Linux / Restic', [G_B, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('WP-05', 'wordpress', 'Yedek/restore, bakım modu', 'completed', ['apps/api/src/website-backup-operation-service.js', 'apps/api/src/website-restore-http.js'], ['/api/websites/:id/backups', '/api/websites/:id/maintenance'], 'Linux / Restic / WP Maintenance', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('WP-06', 'wordpress', 'Güvenlik denetimi ve sıkılaştırma', 'completed', ['apps/api/src/website-php-tools-service.js'], ['/api/websites/:id/wordpress/security'], 'Linux / PHP', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('WP-07', 'wordpress', 'Otomatik/smart update ve test', 'deferred', [], [], 'Harici AI/SaaS', [G_D], ['owner'], 'owner_only'),

  // Backup & Restore
  createCap('BAK-01', 'backup', 'Sunucu ve site düzeyinde yedekleme', 'completed', ['apps/api/src/backup-http.js', 'apps/api/src/website-backup-http.js'], ['/api/backups', '/api/websites/:id/backups'], 'Linux / Restic', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('BAK-02', 'backup', 'Kapsam seçimi (6 temel kurtarma alanı)', 'completed', ['apps/api/src/backup-manifest.js', 'apps/api/src/backup-resource-provider.js'], ['/api/backups/preview', '/api/websites/:id/backups/preview'], 'Restic (6 alan)', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('BAK-03', 'backup', 'Tam ve artımlı yedekleme (Deduplication)', 'completed', ['apps/api/src/backup-production-runtime.js'], ['/api/backups/jobs'], 'Restic', [G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('BAK-04', 'backup', 'Zamanlama, rotasyon ve saklama bütçesi', 'completed', ['apps/api/src/website-backup-operation-service.js'], ['/api/websites/:id/backups/plan'], 'Linux / Restic retention', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('BAK-05', 'backup', 'Uzak depolar (S3, SFTP, Object Storage)', 'completed', ['apps/api/src/rclone-remote-registry.js', 'apps/api/src/restic-repository-registry.js'], ['/api/backups/remotes'], 'AWS S3 / Wasabi / B2 / SFTP', [G_C, G_D], ['owner'], 'owner_only'),
  createCap('BAK-06', 'backup', 'Seçici geri yükleme & parola koruması', 'completed', ['apps/api/src/website-restore-http.js'], ['/api/websites/:id/restore/preview'], 'Restic restore', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('BAK-07', 'backup', 'Çoklu takvim ve çoklu hedef', 'partial', ['apps/api/src/website-backup-operation-service.js'], ['/api/websites/:id/backups/plans'], 'Restic', [G_C, G_D], ['owner'], 'owner_only'),
  createCap('BAK-08', 'backup', 'Gerçek kurtarma, RPO/RTO ölçümü', 'completed', ['apps/api/src/backup-plan.js', 'apps/api/src/database-restore-job-result.js'], ['/api/backups/recovery-evidence'], 'Linux / HTTP 200 health check', [G_C, G_D, G_E], ['owner'], 'owner_only'),

  // Security & Server
  createCap('SEC-01', 'security', 'Firewall, portlar, güvenli geri dönüş', 'completed', ['apps/api/src/firewall-service.js'], ['/api/firewall/preview', '/api/firewall/apply'], 'Linux nftables / systemd', [G_C, G_D], ['owner'], 'owner_only'),
  createCap('SEC-02', 'security', 'IP erişim kısıtları, brute-force & ban', 'completed', ['apps/api/src/firewall-service.js'], ['/api/firewall/bans'], 'Linux / CrowdSec', [G_C, G_D], ['owner'], 'owner_only'),
  createCap('SEC-03', 'security', 'ModSecurity / WAF politikaları', 'partial', ['apps/api/src/domain-http.js'], ['/api/websites/:id/waf'], 'Nginx / ModSecurity', [G_C, G_D], ['owner'], 'owner_only'),
  createCap('SEC-04', 'security', 'Oturum/MFA/parola politikası & API sınırı', 'completed', ['apps/api/src/auth-store.js', 'apps/api/src/panel-access.js'], ['/api/auth/reset-password', '/api/auth/mfa'], 'Linux / SQLite / Argon2id', [G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'all_authenticated'),
  createCap('SYS-01', 'security', 'IP havuzu, IPv4/IPv6, shared/dedicated', 'partial', ['apps/api/src/server-registry.js'], ['/api/servers/:id/network'], 'Linux sysfs', [G_C], ['owner'], 'owner_only'),
  createCap('SYS-02', 'security', 'Sistem servisleri yönetimi (systemd)', 'completed', ['apps/api/src/managed-service-http.js'], ['/api/system/services/:name/:action'], 'systemd (Ubuntu Linux)', [G_C, G_D], ['owner'], 'owner_only'),
  createCap('SYS-03', 'security', 'Hostname, saat dilimi ve ayarlar', 'completed', ['apps/api/src/panel-settings-http.js', 'apps/api/src/server-registry.js'], ['/api/settings/panel'], 'Linux system settings', [G_C], ['owner'], 'owner_only'),
  createCap('SYS-04', 'security', 'Sistem/PHP/panel güncellemeleri', 'completed', ['apps/api/src/managed-service-http.js'], ['/api/system/packages'], 'Ubuntu apt', [G_C, G_D], ['owner'], 'owner_only'),
  createCap('SYS-05', 'security', 'Yönetici terminali, watchdog & onarım', 'completed', ['apps/api/src/system-watchdog-service.js', 'apps/api/src/ttyd-session-http.js'], ['/api/system/watchdog', '/api/ttyd/session'], 'Linux PAM / systemd', [G_C, G_D, G_E], ['owner'], 'owner_only'),
  createCap('SYS-06', 'security', 'Cron/scheduled tasks; zamanlama', 'completed', ['apps/api/src/website-cron-http.js', 'apps/api/src/website-cron-apply-service.js'], ['/api/websites/:id/cron'], 'Linux cron', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),

  // API & CLI
  createCap('API-01', 'api', 'REST API ve yetkili API anahtarı', 'completed', ['apps/api/src/app.js', 'apps/api/src/panel-access.js'], ['/api/*'], 'REST / JSON', [G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager', 'read_only'], 'all_authenticated'),
  createCap('API-02', 'api', 'XML API uyumluluğu', 'out_of_scope', [], [], 'JSON REST (Standart)', [G_C], ['owner'], 'owner_only'),
  createCap('API-03', 'api', 'CLI ve otomatik provisioning', 'completed', ['apps/api/src/website-provisioning-orchestrator.js'], ['CLI'], 'Linux Shell / agy CLI', [G_C, G_D, G_E], ['owner'], 'owner_only'),
  createCap('API-04', 'api', 'Tek kullanımlık oturum/SSO & audit', 'completed', ['apps/api/src/phpmyadmin-handoff-service.js', 'apps/api/src/audit-store.js'], ['/api/servers/:id/websites/:websiteId/phpmyadmin-handoffs', '/api/audit'], 'Kriptografik token', [G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('API-05', 'api', 'WHMCS/ödeme/faturalama bağlantısı', 'deferred', [], [], 'Harici Ticari', [G_D], ['owner'], 'owner_only'),
  createCap('API-06', 'api', 'Paket/abonelik ticari senkronizasyonu', 'deferred', [], [], 'Harici Ticari', [G_D], ['owner'], 'owner_only'),
  createCap('API-07', 'api', 'Domain/sertifika registrar bayiliği', 'deferred', [], [], 'Harici Registrar', [G_D], ['owner'], 'owner_only'),

  // Migration
  createCap('MIG-01', 'migration', 'Plesk\'ten kaynakları içe aktarma', 'completed', ['apps/api/src/plesk-importer.js', 'apps/api/src/plesk-importer-http.js'], ['/api/importer/plesk/import'], 'Plesk XML/ZIP', [G_C, G_D], ['owner'], 'owner_only'),
  createCap('MIG-02', 'migration', 'cPanel/DirectAdmin taşıma', 'partial', ['apps/api/src/plesk-importer.js'], ['/api/importer/cpanel'], 'cPanel / DirectAdmin', [G_C, G_D], ['owner'], 'owner_only'),
  createCap('MIG-03', 'migration', 'Site/mail/DB/DNS/SSL veri eşleme', 'completed', ['apps/api/src/website-migration-create.js', 'apps/api/src/website-migration-bind.js'], ['/api/migration/websites/bind'], 'Linux', [G_C, G_D], ['owner'], 'owner_only'),
  createCap('MIG-04', 'migration', 'Ön kontrol, senkronizasyon & rollback', 'completed', ['apps/api/src/website-migration-preview.js', 'apps/api/src/website-migration-ledger.js'], ['/api/migration/websites/preview', '/api/migration/websites/rollback'], 'SQLite / Ledger', [G_C, G_D], ['owner'], 'owner_only'),
  createCap('MIG-05', 'migration', 'Import kısıtları ve veri kaybı uyarısı', 'completed', ['apps/api/src/website-migration-preview.js'], ['/api/migration/impact-report'], 'JSON etki raporu', [G_C, G_D], ['owner'], 'owner_only'),
  createCap('MIG-06', 'migration', 'Panel güncellemesi, OS migration, rollback', 'completed', ['apps/api/src/hosting-account-schema.js', 'apps/api/src/production-exit-gate.js'], ['/api/system/schema'], 'Ubuntu Linux / SQLite', [G_C, G_D, G_E], ['owner'], 'owner_only'),

  // Monitoring
  createCap('MON-01', 'monitoring', 'CPU/RAM/disk/ağ ölçümleri', 'completed', ['apps/api/src/server-registry.js', 'apps/web/src/workspace/DashboardPage.jsx'], ['/api/servers/:id/metrics', '/api/websites/:websiteId/consumption'], 'Linux procfs / sysfs', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('MON-02', 'monitoring', 'Eşik/bildirim tercihleri & teslimat', 'completed', ['apps/api/src/operational-notification-service.js', 'apps/api/src/operational-notification-http.js'], ['/api/notifications/preferences', '/api/notifications/test'], 'Linux / SMTP', [G_C, G_D], ['owner'], 'owner_only'),
  createCap('MON-03', 'monitoring', 'Web istatistikleri (GoAccess)', 'completed', ['apps/api/src/website-analytics-http.js'], ['/api/websites/:id/analytics'], 'GoAccess CLI', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('MON-04', 'monitoring', 'Web/mail/sistem log görüntüleme', 'completed', ['apps/api/src/log-http.js'], ['/api/websites/:id/logs', '/api/system/logs'], 'systemd journald', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('MON-05', 'monitoring', 'Servis watchdog/otomatik kurtarma', 'completed', ['apps/api/src/system-watchdog-service.js', 'apps/api/src/local-api-health.js'], ['/api/system/watchdog/status', '/api/system/watchdog/recover'], 'systemd / Linux', [G_C, G_D, G_E], ['owner'], 'owner_only'),
  createCap('MON-06', 'monitoring', 'Harici uptime izleme servisi', 'deferred', [], [], 'Harici SaaS', [G_D], ['owner'], 'owner_only'),

  // Extensions
  createCap('EKL-01', 'extensions', 'Uygulama kataloğu (Node, PHP, Static, Python, Docker)', 'completed', ['apps/api/src/application-registry.js', 'apps/api/src/application-operations-http.js'], ['/api/applications/catalog'], 'Linux / Systemd / Passenger', [G_B, G_C, G_D], ['owner', 'reseller', 'customer', 'site_manager'], 'site_scoped'),
  createCap('EKL-02', 'extensions', 'Eklenti yönetimi ve bağımlılıklar', 'partial', ['apps/api/src/managed-service-http.js'], ['/api/system/packages'], 'Linux / apt', [G_C, G_D], ['owner'], 'owner_only'),
  createCap('EKL-03', 'extensions', 'Sitejet/site-builder eşdeğeri', 'deferred', [], [], 'Harici Vendor', [G_D], ['owner'], 'owner_only'),
  createCap('EKL-04', 'extensions', 'Güvenlik/antivirüs premium entegrasyonlar', 'partial', ['apps/api/src/firewall-service.js'], ['/api/firewall'], 'CrowdSec / nftables', [G_C, G_D], ['owner'], 'owner_only'),
  createCap('EKL-05', 'extensions', 'Cloud backup, DNS/CDN connector\'ları', 'completed', ['apps/api/src/rclone-remote-registry.js', 'apps/api/src/dns-requirements-service.js'], ['/api/backups/remotes', '/api/dns/providers'], 'Multi-cloud (S3/Wasabi/B2/Drive) / Cloudflare', [G_C, G_D], ['owner'], 'owner_only'),
  createCap('EKL-06', 'extensions', 'Eklenti lisans/sağlık envanteri', 'partial', ['apps/api/src/ai-tool-catalog.js', 'apps/api/src/server-registry.js'], ['/api/system/health', '/api/ai/tools'], 'Linux / AI tool catalog', [G_C, G_D], ['owner'], 'owner_only'),
  createCap('EKL-07', 'extensions', 'Marketplace tüm ürünleri araştırması', 'open_research', ['docs/plesk-feature-parity.md'], [], 'Marketplace Araştırması (Açık Tutuldu)', [G_D, G_E], ['owner', 'reseller', 'customer'], 'all_authenticated'),
];

export const NON_RESELLER_INVENTORY = Object.freeze(
  Object.fromEntries(RAW_CAPABILITIES.map((c) => [c.id, c]))
);

export function assertNoResellerBrandingPollution(payload, context = 'payload') {
  if (!payload || typeof payload !== 'object') return;
  const keys = Object.keys(payload);
  for (const key of keys) {
    if (FORBIDDEN_BRANDING_KEYS.includes(key) || FORBIDDEN_BRANDING_KEYS.some((fb) => key.toLowerCase().includes(fb.toLowerCase()))) {
      throw new ResellerBrandingDeferredError(
        `Reseller branding property '${key}' is deferred to the next phase and must not pollute tenant models (${context}).`,
      );
    }
    if (payload[key] && typeof payload[key] === 'object' && !Array.isArray(payload[key])) {
      assertNoResellerBrandingPollution(payload[key], `${context}.${key}`);
    }
  }
}

export function assertTenantBoundaryForCapability({
  actor,
  capabilityId,
  targetSiteId = null,
  targetCustomerId = null,
} = {}) {
  const actorTenant = extractActorTenant(actor);

  if (!actorTenant.active) {
    throw new TenantBoundaryError('tenant_actor_inactive', 'Inactive account cannot access capabilities.', 403);
  }

  const cap = NON_RESELLER_INVENTORY[capabilityId];
  if (!cap) {
    throw new CapabilityRegistryError('capability_not_found', `Capability ${capabilityId} not found in inventory.`, 404);
  }

  if (actorTenant.isOwner) {
    return { authorized: true, role: 'owner', capabilityId };
  }

  if (cap.scopeLevel === 'owner_only') {
    throw new TenantBoundaryError('tenant_boundary_forbidden', `Capability ${capabilityId} is restricted to server Owner.`, 403);
  }

  const actorWebsiteIds = (Array.isArray(actorTenant.websiteIds) && actorTenant.websiteIds.length > 0)
    ? actorTenant.websiteIds
    : (Array.isArray(actorTenant.hosting?.websiteIds) ? actorTenant.hosting.websiteIds : []);

  if (actorTenant.isReseller) {
    if (cap.scopeLevel === 'management_scoped' && !cap.rolesAllowed.includes('reseller')) {
      throw new TenantBoundaryError('tenant_boundary_forbidden', `Capability ${capabilityId} is outside Reseller scope.`, 403);
    }
    if (targetSiteId && actorWebsiteIds.length > 0) {
      if (!actorWebsiteIds.includes(targetSiteId)) {
        throw new TenantBoundaryError('tenant_boundary_forbidden', `Site ${targetSiteId} is outside Reseller tenant boundary.`, 403);
      }
    }
    return { authorized: true, role: 'reseller', capabilityId };
  }

  if (actorTenant.isCustomer) {
    if (cap.scopeLevel === 'management_scoped' || cap.scopeLevel === 'owner_only' || !cap.rolesAllowed.includes('customer')) {
      throw new TenantBoundaryError('tenant_boundary_forbidden', `Capability ${capabilityId} is outside Customer scope.`, 403);
    }
    if (targetCustomerId && targetCustomerId !== actorTenant.actorId) {
      throw new TenantBoundaryError('tenant_boundary_forbidden', 'Cannot access foreign customer resources.', 403);
    }
    if (targetSiteId) {
      if (!actorWebsiteIds.includes(targetSiteId)) {
        throw new TenantBoundaryError('site_scope_forbidden', `Site ${targetSiteId} is not assigned to this Customer.`, 403);
      }
    }
    return { authorized: true, role: 'customer', capabilityId };
  }

  if (actorTenant.isLegacySiteManager) {
    if (!cap.rolesAllowed.includes('site_manager')) {
      throw new TenantBoundaryError('tenant_boundary_forbidden', `Capability ${capabilityId} is restricted.`, 403);
    }
    if (targetSiteId && !actorWebsiteIds.includes(targetSiteId)) {
      throw new TenantBoundaryError('site_scope_forbidden', `Site ${targetSiteId} is not assigned to this site manager.`, 403);
    }
    return { authorized: true, role: 'site_manager', capabilityId };
  }

  if (actorTenant.isReadOnly) {
    if (!cap.rolesAllowed.includes('read_only')) {
      throw new TenantBoundaryError('tenant_boundary_forbidden', `Capability ${capabilityId} is outside Read Only scope.`, 403);
    }
    return { authorized: true, role: 'read_only', capabilityId };
  }

  throw new TenantBoundaryError('tenant_boundary_forbidden', 'Unauthorized tenant role.', 403);
}

export function getCapabilityById(id) {
  return NON_RESELLER_INVENTORY[id] ?? null;
}

export function listCapabilities({ category = null, status = null, group = null, role = null } = {}) {
  let items = Object.values(NON_RESELLER_INVENTORY);
  if (category) items = items.filter((c) => c.category === category);
  if (status) items = items.filter((c) => c.status === status);
  if (group) items = items.filter((c) => c.groupCrossConnects.includes(group));
  if (role) items = items.filter((c) => c.rolesAllowed.includes(role));
  return items;
}

export function mountNonResellerCapabilitiesRoutes(app, {
  capabilitiesInventory = NON_RESELLER_INVENTORY,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('Express application is required');
  }

  app.get('/api/system/capabilities', requirePanelRouteAccess, async (req, res, next) => {
    try {
      const auth = req.auth;
      const actorTenant = extractActorTenant(auth);
      if (!actorTenant.active) {
        return res.status(403).json({
          error: { code: 'tenant_actor_inactive', message: 'Inactive account cannot access capabilities.' },
        });
      }

      const { category, status, group } = req.query ?? {};
      let items = Object.values(capabilitiesInventory);

      if (category && typeof category === 'string') {
        items = items.filter((c) => c.category === category);
      }
      if (status && typeof status === 'string') {
        items = items.filter((c) => c.status === status);
      }
      if (group && typeof group === 'string') {
        items = items.filter((c) => c.groupCrossConnects.includes(group.toUpperCase()));
      }

      if (actorTenant.isCustomer) {
        items = items.filter((c) => c.rolesAllowed.includes('customer'));
      } else if (actorTenant.isReseller) {
        items = items.filter((c) => c.rolesAllowed.includes('reseller'));
      } else if (actorTenant.isLegacySiteManager) {
        items = items.filter((c) => c.rolesAllowed.includes('site_manager'));
      }

      return res.json({
        data: {
          capabilities: items,
          total: items.length,
          actorRole: actorTenant.role,
          resellerBrandingStatus: 'deferred_to_next_phase',
        },
      });
    } catch (err) {
      return next(err);
    }
  });

  app.get('/api/system/capabilities/:id', requirePanelRouteAccess, async (req, res, next) => {
    try {
      const auth = req.auth;
      const actorTenant = extractActorTenant(auth);
      if (!actorTenant.active) {
        return res.status(403).json({
          error: { code: 'tenant_actor_inactive', message: 'Inactive account cannot access capabilities.' },
        });
      }

      const id = req.params.id?.toUpperCase();
      if (!/^[A-Z]{2,4}-\d{2}$/.test(id)) {
        return res.status(400).json({
          error: { code: 'invalid_capability_id', message: 'Capability ID format must be e.g. DNS-01, EML-01, DB-01.' },
        });
      }

      const capability = capabilitiesInventory[id];
      if (!capability) {
        return res.status(404).json({
          error: { code: 'capability_not_found', message: `Capability ${id} not found.` },
        });
      }

      try {
        assertTenantBoundaryForCapability({ actor: auth, capabilityId: id });
      } catch (boundaryErr) {
        return res.status(boundaryErr.status || 403).json({
          error: { code: boundaryErr.code || 'tenant_boundary_forbidden', message: boundaryErr.message },
        });
      }

      return res.json({ data: capability });
    } catch (err) {
      return next(err);
    }
  });

  app.post('/api/system/capabilities/validate-branding', requirePanelRouteAccess, async (req, res, next) => {
    try {
      const auth = req.auth;
      const actorTenant = extractActorTenant(auth);
      if (!actorTenant.active) {
        return res.status(403).json({
          error: { code: 'tenant_actor_inactive', message: 'Inactive account cannot perform validation.' },
        });
      }

      const body = req.body ?? {};
      assertNoResellerBrandingPollution(body, 'request.body');

      return res.json({
        data: {
          valid: true,
          brandingDeferred: true,
          message: 'Payload verified clean of premature reseller branding.',
        },
      });
    } catch (err) {
      if (err instanceof ResellerBrandingDeferredError) {
        return res.status(err.status || 403).json({
          error: { code: err.code, message: err.message },
        });
      }
      return next(err);
    }
  });
}
