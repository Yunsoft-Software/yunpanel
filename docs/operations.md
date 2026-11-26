# YunPanel — Operasyon ve kurtarma özeti

Bu belge çalışma talimatıdır; komutların yazılması çalıştırıldıkları veya dağıtımın onaylandığı anlamına gelmez. Mutating host işinden önce izin, doğru hedef, güncel sürüm, doğrulanmış backup ve rollback gerekir. [Güvenlik](security.md) ve [kabul](../todo.md).

## Host ve sürüm

Production API ve web systemd ile tek yerel hostta. Tipik state /var/lib/yunpanel/control-plane, private env /etc/yunpanel/control-plane, paket /usr/lib/yunpanel. Code Factory release aktif symlink ile çalışabilir; dpkg sürümü tek başına çalışan source SHA değildir. WorkingDirectory, gerçek symlink, release manifest, API/web kaynak ve served asset ayrı karşılaştırılır. .28 kontrolünde /usr/lib/yunpanel-codefactory-current kullanıldı; bu yol değişebilir.

Read-only tanılama: systemctl show/is-active, release manifest'in yalnız kimlik alanları, kaynak SHA-256, loopback health, nginx -t ve protected state'in yalnız gerekli public metadata projeksiyonu. Env/key/cookie/password bütünlüğünü genel çıktı üretmeden incele. .44 yasak.

## İlk Owner ve kurtarma

İlk setup yerel yönetici tarafından tek kullanımlık/süreli tokenla; default parola/public kayıt yok. Auth CLI ile API aynı YUNPANEL_AUTH_DB kullanır. Private auth dizini 0700, DB/sidecar 0600; root owner ve symlink kontrolü. Password minimum 12 karakter; password değişimi bütün ilgili oturumları sonlandırır. Password reset MFA enrollment'ını kendiliğinden kaldırmaz.

Yerel geliştirme: npm run dev; API workspace ile aynı env üzerinde npm run auth -- setup-token. Packaged CLI: /usr/local/bin/node /usr/lib/yunpanel/scripts/auth.mjs setup-token veya reset-password <username>. Parola gizli stdin/terminalden; argüman veya logdan verilmez. MFA recovery gerektiğinde ayrı açık reset-mfa işlemi ve kayıtlı politika kullanılır.

## Migration yedeği

Önce aktif işleri drain et; bağımsız console/SSH recovery erişimini koru. Backup script sabit allowlist'i kullanır: /etc/yunpanel, /var/lib/yunpanel, /etc/passwd ve /etc/group; varsa Nginx/Let's Encrypt/systemd. /etc/shadow alınmaz; passwd/group kimlik referansıdır, kör restore hedefi değildir.

- Oluştur: /usr/local/bin/node /usr/lib/yunpanel/scripts/local-migration-backup.mjs create --confirm.
- Doğrula: aynı script verify /var/backups/yunpanel/migration-<timestamp>.
- Önizle: aynı script preview /var/backups/yunpanel/migration-<timestamp>.
- Dış depodan indirilen kopya: `preflight <absolute-backup-directory> --expected-sha256 <sha256> --expected-server-id <uuid>`. Özeti ve kaynak kimliğini bağımsız kurtarma kaydından al. Çıktıyı aldıktan sonra private stage ayrı çalıştırılır.
- Private stage: aynı script stage /var/backups/yunpanel/migration-<timestamp> --confirm; canlı uygulama değildir.

Snapshot directory 0700, state.tar/manifest 0600; SHA-256/source allowlist/member graph/link escape/mode/ownership doğrulanır. Required missing source, symlink veya unsafe archive blocker'dır. ACL/xattr genişletilmiş metadata kabulü ayrıca gerekir. Preserve-current kaynaklar kayıp diye silinmez. Backup doğrulaması gerçek restore/DR kabulü değildir.

## Plesk pilotu

1. Operatörün yetkili dışa aktarımından özel bir dizin hazırla. `plesk.json` bir PHP sürümü ve bir MySQL veya MariaDB veritabanı içermeli. `site/` altında dışa aktarımdaki göreli document root ve site dosyaları, `database.sql` içinde kaynak veritabanının tek şema dökümü yer alır. Dosyalar aktarım kullanıcısına ait olmalı. Geçici verileri `0700` dizinde tut.
2. Boş, aynı kullanıcıya ait bir hedef dizin oluştur. `node scripts/plesk-transfer.mjs --help` ile alanları kontrol et. Paketteki karşılığı `/usr/lib/yunpanel/scripts/plesk-transfer.mjs` yoludur. Aynı kaynak ve hedef alan adı, DB adı ve hedef sunucu UUID’siyle önce önizlemeyi al ve SHA-256 değerini kaydet.
3. Aynı argümanlarla `stage` eylemini ve `--expect <sha256>` değerini kullan. `transfer.json` içindeki `bundleDirectory` kopyayı gösterir. Kopya PHP çalıştırmaz ve SQL uygulamaz. Pilot, kopyalanan dosyaları normal panel kurulumuyla açılan geçici siteye ve SQL’i yalnız o sitenin boş veritabanına taşıyarak sürer.
4. DNS değişikliğinden önce HTTP, giriş ve SQL’i eski ve yeni ortamda karşılaştır. Posta varsa iki IMAP eşitlemesinden sonra klasör, ileti ve teslimatı doğrula. Geçiş sonrasında yeni yazıları da koruyan geri dönüşü pilotta dene. [Canlı kabul](../todo.md#linux-hosting-pilotu-ve-plesk-geçişi).

## WAF hazırlığı (gözlem, uygulama ve geri dönüş)

WAF şablonları iki açık sağlayıcıyı destekler (`packages/config-templates/src/waf-policy.js`): Cloudflare Managed WAF (`cloudflare_managed`) ve doğrudan barındırılan sitelerde yerel Nginx + CrowdSec AppSec (`crowdsec_appsec`).

1. **Gözlemle başla (`observe`).** İlk etkinleştirmede her iki sağlayıcı da engelleme yapmayan modda açılır: Cloudflare `log`, CrowdSec AppSec ise `appsec_failure_action passthrough;` ve `simulation: true`. Varsayılan güvenli yol istisnaları (`/wp-login.php`, `/wp-admin/async-upload.php`, `/wp-json/wp/v2/media`, `/api/auth/`) korunur; ek yollar katı karakter doğrulamasından geçer.
2. **Uygulamaya geçiş (`enforce`).** Normal giriş, dosya yükleme ve API istekleri gözlem loglarında yanlış pozitif vermeden doğrulanmadan `enforce` açılmaz. Geçişten önce geri dönüş özetini kaydetmek zorunludur: CrowdSec AppSec için önceki gözlem politikasının `previousPolicySha256` değeri, Cloudflare için `previousRulesetVersion` ve `previousRulesetSha256`.
3. **Geri dönüş (`disabled`).** Yanlış pozitifte CrowdSec AppSec için üretilen `disabled` Nginx parçası (`/etc/nginx/yunpanel-waf/<domain>.conf`) ve pasif acquisition dosyası yazılıp `nginx -t` + reload uygulanır; Cloudflare’da kural geçersiz kılma `log`/`off` durumuna çekilir ve önceki kural kümesi sürümü geri yüklenir.

## WordPress staging’den canlıya seçici aktarım hazırlığı

Staging’den canlıya aktarım planlayıcısı (`apps/api/src/wordpress/wordpress-selective-transfer.js`) canlı sipariş, üyelik ve çalışma zamanı yapılandırmasını varsayılan olarak korur.

1. **Dosya kapsamı:** Yalnızca seçilen göreli kapsamlar (`themes`, `plugins`, `mu-plugins` ve doğrulanmış `wp-content/` özel yolları) aktarılır. `wp-config.php`, `.htaccess`, `.user.ini` her zaman; `wp-content/uploads/**` ise açıkça istenmedikçe korunur. Sembolik link ve yol kaçışı reddedilir.
2. **Tablo koruması:** WooCommerce sipariş/ödeme/oturum tabloları, `users`/`usermeta`, `comments`/`commentmeta` ve Action Scheduler kuyruk tabloları varsayılan olarak aktarılmaz. Canlıda `shop_order` / `shop_subscription` / `shop_order_refund` kayıtları varsa paylaşılan `posts` ve `postmeta` tabloları kör tam yazmaya kapatılır.
3. **Önkoşul ve doğrulama:** Uygulama öncesi doğrulanmış canlı yedek ve değişmemiş `planSha256` zorunludur. Aktarım sonrasında staging bayrakları geri çevrilir (`blog_public = 1`, `WP_ENVIRONMENT_TYPE = 'production'`, `DISABLE_WP_CRON` kaldırılır) ve WP/DB/HTTP sağlık denetimi doğrulanır.

## İş kurtarma

Packaged job-recovery.mjs status ile exact job/operation ve host evidence incelenir. reconcile/recover-* komutu yalnız desteklediği operation ve aynı server/job kimliğiyle, gerekli açık onaydan sonra çalışır. Generic force-success yok. Job kayıtları/attempt budget/evidence silinmez. Unknown/lost-ack önce inspect; kör replay yok. Background backup recovery'nin startup'a bağlı olduğu varsayılmaz; 9 Ekim audit'inde açık bulundu.

Local identity kontrolü: local-runtime.mjs validate <server-uuid>. Create/migration öncesi doğrulanmış backup zorunlu; create --backup-dir /var/backups/yunpanel/migration-<timestamp> --confirm. Legacy ownership veya host ID canlı kayıtta tahmin edilmez. Passenger cutover health-gated; direct-systemd rollback kabul edilmeden kaldırılmaz.

## Secret anahtarı ve servisler

Master-key rotation offline yapılır: API durur; eski key ayrı protected secret store'da tutulur; rotate-secret-master-key.mjs ile tüm encrypted stores preflight/rewrap, manifest ve rollback snapshot. Yalnız env key değiştirmek mevcut secrets'ı okunamaz yapar. Recovery sonrası decrypt/login/TOTP/env/DNS/mail ve bağlı tüm secret yüzeyleri doğrulanır; gerçek sürüm CLI help'i izlenir. Key değerini argüman/log/chat'e yazma.

Deploy/package/update: candidate kaynak+build doğrulama, exact .28 hedef, backup/checksum, guarded install, dpkg/Nginx/systemd/HTTP/API/web eşleşmesi, gerçek rol görevleri ve rollback. Test edilmemiş migration veya eski deploy bugünkü kabul değildir. Panel durduğunda hosted Nginx/runtime/mail çalışmayı sürdürmelidir.
