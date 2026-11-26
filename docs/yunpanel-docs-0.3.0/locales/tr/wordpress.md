# WordPress Yönetimi

> **Sürüm:** YunPanel `0.3.0` · **Doğrulanmış kaynak revizyonu:** `c1a84a51` (`c1a84a5159add2f2f87fd6e21725f7c657cf98ec`) · **Doğrulanmış Linux `.deb` paket tabanı:** `0.3.0-2026112301` (`f13b2b78`) · **Arayüz dili:** Türkçe (`tr`)

PHP-FPM çalışma zamanına sahip tüm web siteleri ve alt alan adları için site detayında **WordPress** (`/websites/<id>/wordpress`) yönetim sekmesi açılır. Tüm WordPress komutları paketle birlikte gelen sabitlenmiş **WP-CLI** (`/usr/lib/yunpanel/vendor/wp-cli/wp`) üzerinden ve sitenin kendi yalıtılmış Linux kullanıcısıyla yürütülür.

![PHP sitesinde WordPress araç girişi ve site genel bakışı](assets/tr/06-site-overview.png)

> **Ortam notu:** WordPress kurulumu, WP-CLI çekirdek/eklenti işlemleri ve canlı geri alma akışları Linux sunucuda PHP-FPM ve MariaDB servisleriyle çalışır (`.deb` paketi `0.3.0-2026112301` / `f13b2b78` üzerinde gerçek Linux ve tarayıcı testleriyle doğrulanmıştır).

## WordPress kurulumu

1. PHP çalışma zamanlı bir web sitesi veya alt alan adı açın ve **WordPress** sekmesine geçin.
2. Site başlığı, yönetici kullanıcı adı, güçlü yönetici parolası, yönetici e-postası ve kurulum dilini (ör. `tr_TR` veya `en_US`) belirleyin.
3. Mevcut bir MariaDB veritabanı bağını seçin veya kurulum öncesinde [Veritabanı Yönetimi](doc:databases) ekranından siteye yeni veritabanı bağlayın.
4. İşlem kalıcı iş kuyruğunda yürütülür; kurulum öncesinde otomatik ön-yedek alınır, `wp-config.php` `0640` izinleriyle sitenin kendi kullanıcısına yazılır ve WP-CLI checksum + veritabanı doğrulaması yapılır.

## Güncelleme, eklenti ve tema yönetimi

- **Çekirdek, eklenti ve tema yönetimi:** Kurulu WordPress sürümü, eklentiler ve temalar listelenir; güncelleme ve doğrulama işlemleri kalıcı iş makbuzuyla kaydedilir.
- **PHP ayarları entegrasyonu:** Aynı sitedeki **PHP Ayarları** (`/websites/<id>/php`) sekmesinden PHP-FPM sürümü, bellek sınırı ve çalışma zamanı parametreleri yönetilebilir.

## Staging kopyalama ve canlıya seçici aktarım

YunPanel, üretim sitesinin sipariş, üyelik ve yapılandırma verilerini koruyarak staging ortamından canlıya seçici dosya aktarımı sağlar:

1. **Kapsam seçimi:** Yalnızca seçilen göreli dizinler (`themes`, `plugins`, `mu-plugins` ve doğrulanmış `wp-content/` yolları) aktarılır.
2. **Korunan dosya ve tablolar:** `wp-config.php`, `.htaccess`, `.user.ini` ve `wp-content/uploads/**` dosyaları ile WooCommerce sipariş/üyelik, kullanıcı ve yorum tabloları varsayılan olarak korunur.
3. **Önizleme ve açık onay:** Aktarım öncesinde oluşturulacak/üzerine yazılacak dosyaların özeti (`planSha256`) gösterilir ve açık onay diyalogu (**Dosya aktarımını onayla**) istenir. Önizleme sonrasında dosya değişirse işlem güvenli biçimde durdurulur.
4. **Otomatik geri alma (rollback):** Aktarım sonrasında hedef sitede HTTP 503 veya sağlık hatası algılanırsa sistem kalıcı kurtarma günlüğü (`/var/lib/yunpanel/recovery/wordpress-selective`) üzerinden önceki sağlıklı dosya durumuna otomatik olarak geri döner ve eşzamanlı yeni yazıları korur.

## WordPress kaldırma

**WordPress'i kaldır** işlemi açık onay sonrasında Restic ön-yedeği alır, WordPress çekirdek dosyalarını, `wp-config.php` dosyasını ve bağlı WordPress tablolarını temizler; sitenin kendi alan adı, sertifikası ve WordPress dışı dosyaları bozulmadan çalışmaya devam eder.

## İlgili kılavuzlar

- Veritabanı bağlama için [Veritabanı Yönetimi](doc:databases)
- Site dosyalarını incelemek için [Dosya Yönetimi](doc:files)
- Ön-yedek ve geri yükleme ayrıntıları için [Yedekleme ve Kurtarma](doc:backups-and-recovery)
