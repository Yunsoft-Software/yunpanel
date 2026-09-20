# Website Backup Set İlerlemesi (2026-09-20)

## 1. Kapsam ve Ürün Hedefi

`AGENTS.md` ve `docs/architecture.md` uyarınca, YunPanel site merkezli bir yönetim ve entegrasyon ürünüdür. Yedekleme düzleminde her Website bağımsız bir yedekleme kümesine (backup set) sahiptir. Bu küme sitenin tüm bileşenlerini tutarlı ve deterministik olarak bir araya getirir.

`plan.md` P1.2 (Backup/restore) kapsamındaki üçüncü alt madde tamamlandı:
- **Website backup set: files/data/env metadata/DB dump/mail/DNS/Nginx/Compose hooks**:
  - `apps/api/src/website-backup-set.js`:
    - `createWebsiteBackupSetProvider`: Website, Domain, DatabaseBinding, MailDomain, Application, ApplicationEnvironment ve DockerComposeProject kayıt defterlerini birleştirerek tekil bir Website için tam ve deterministik bir `WebsiteBackupSet` üretir.
    - **files**: Document root, releases directory, current release symlink, static publish root, compose project directory; dahil etme kuralları (`**`) ve hariç tutma kuralları (`.git`, `node_modules/.cache`, `tmp`).
    - **data**: Kalıcı veri dizini (`/var/lib/yunpanel/data/<applicationId>`), log dizini (`logs`), geçici dizin (`tmp` hariç tutulan olarak işaretlenir); veri hariç tutma kuralları (`**/tmp/**`, `**/*.sock`, `**/*.pid`).
    - **env metadata**: Kaydedilmiş ve uygulanmış revizyonlar, atanmış release ID, değişken adları listesi ve sayısı (gizli değerler sızdırılmaz), evreleme meta dosyası yolu (`/var/lib/yunpanel/backups/resources/website/<websiteId>/env-metadata.json`).
    - **DB dump**: Siteye bağlı veritabanları (`databaseBindingRegistry`) için dump hook tanımları (`mariadb-dump`/`mysqldump`, `--single-transaction --quick --routines --events --triggers --hex-blob --databases <name>`, ve evrelenen dump dosya yolu).
    - **mail**: Siteye bağlı alan adlarına ait yerel/harici posta alan adları (`managementMode`, `status`, `/var/vmail/<domain>` depolama yolu ve sanal posta DB anlık görüntü yolu).
    - **DNS**: Bağlı alan adlarının DNS modları (`local` veya `external`), zone adları ve evrelenen bölge dosyası yolu.
    - **Nginx**: Aktif Nginx vhost konfigürasyon yolları (`/etc/nginx/sites-available/yunpanel-<domainId>.conf`), uygulanan revizyon ve evrelenen konfigürasyon yolu.
    - **Compose hooks**: Managed Compose siteleri için `enabled: true`, proje dizini, compose dosyası, `preHook` (pause), `postHook` (unpause) ve birim/bağlantı (named volume / bind mount) depolama tanımları.
    - **targetPaths**: Restic anlık görüntüsüne dahil edilecek konsolide, sıralı ve tekilleştirilmiş dosya/dizin yolları.
    - **excludePatterns**: Restic anlık görüntüsünde hariç tutulacak kalıplar.
    - **tags**: Deterministik etiketler (`website:<id>`, `server:<id>`, `domain:<name>`, `runtime:<type>`).
    - **digest**: Yedekleme kümesi tanımının SHA-256 parmak izi.
    - `normalizeWebsiteBackupSet`: Şema doğrulaması ve özet parmak izi bütünlük denetimi.
  - `apps/api/src/website-backup-http.js`:
    - `GET /api/websites/:websiteId/backup-set` rotası; panel kimlik doğrulaması (`requirePanelRouteAccess`) ve yerel sunucu denetimi ile korunur.
    - `isWebsiteBackupHttpError` hata yakalama yardımcısı.
  - `apps/api/src/app.js`:
    - `createWebsiteBackupSetProvider` ve `mountWebsiteBackupRoutes` entegrasyonu.

## 2. Doğrulama
- `node --test apps/api/test/website-backup-set.test.js`: 6 test geçti (Node, Static, Managed Compose, Docker proxy senaryoları, hata durumları ve özet doğrulama).
- `node --test apps/api/test/website-backup-http.test.js`: 4 test geçti (200 başarılı yanıt, 404 bulunamadı, 400 geçersiz kimlik, 401 yetkisiz erişim).
- Tüm mevcut yedekleme testleri (115 test) hatasız geçti.
