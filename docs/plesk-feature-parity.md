# YunPanel — Plesk özellik eşdeğerliği

9 Ekim 2026. 21 grup / 162 özellik ID'si eksiksiz korunur. Hedef Plesk Obsidian görev ve işlev eşdeğerliği; katalog/adapter varlığı veya önceki Tamamlandı etiketi kabul değildir. 10 Ekim kullanıcı [plan.md](../plan.md) uygulamasını onayladı; geliştirme sürüyor.

Durum: **Kritik açık** = bu tur doğrulanan hata; **Kısmi / kabul açık** = bazı kaynak yolları incelendi, tüm görev doğrulanmadı; **İnceleme/kabul açık** = bu tur eksiksiz kontrol edilmedi; **Sonraki faz** = sade reseller ilk sürümünde ertelenmiş; **Ayrı hat** = OS/vendor/koşullu bağımlılık. Hiçbiri otomatik tamamlandı değildir.

İlk sürüm Owner → isteğe bağlı tek Reseller → Customer → mevcut Website; site işlemleri paket/abonelik şartına bağlanmaz. Alt bayi zinciri, reseller paket motoru, add-on/sync/lock/customization/overselling, otomatik expiry/fatura, branding, customer↔reseller dönüşümü/toplu transfer/login-as şimdi uygulanmaz. Gerçek disk/CPU/RAM/site limitleri korunur. Tam Plesk hedefinde bu özellikler kaybolmaz.

Her ID için uygulamada gerçek kaynak+mount edilmiş endpoint, kullanıcı akışı, host/OS/vendor koşulu ve normal/hata/rol/restart kanıtı kaydedilir. Marketplace alt ürünleri henüz eksiksiz taranmadı; 162 ID her ticari eklentinin bütün seçeneklerinin bitmiş envanteri değildir. Ubuntu ve Windows ayrı kabul; .44 erişimi yasak.


## 01 — Paneller, roller ve erişim [S01, S02]

| ID | Hedef özellik | Güncel durum |
| --- | --- | --- |
| ROL-01 | Yönetici Service Provider görünümü. | Kısmi / kabul açık |
| ROL-02 | Yönetici Power User görünümü ve görünüm değiştirme. | Sonraki faz |
| ROL-03 | Reseller paneli ve kendi kaynak/kullanıcı sınırı. | Kısmi / kabul açık |
| ROL-04 | Müşteri paneli ve abonelik/site seçimi. | Kısmi / kabul açık |
| ROL-05 | Ek kullanıcılar, roller ve izin matrisi. | Kısmi / kabul açık |
| ROL-06 | Ek yönetici hesapları ve yönetim yetkileri. | Kısmi / kabul açık |
| ROL-07 | Profil, iletişim bilgisi, parola, oturum ve MFA. | Kısmi / kabul açık |
| ROL-08 | Yetkili müşteri/reseller bağlamına geçiş ve yöneticiliğe dönüş; audit zorunlu. | Sonraki faz |

## 02 — Müşteri ve bayi yaşam döngüsü [S02, S03]

| ID | Hedef özellik | Güncel durum |
| --- | --- | --- |
| HSP-01 | Müşteri oluştur/düzenle/askıya al/etkinleştir/sil. | Kısmi / kabul açık |
| HSP-02 | Reseller oluştur/düzenle/askıya al/etkinleştir/sil. | Kısmi / kabul açık |
| HSP-03 | İletişim, şirket, açıklama ve hesap erişim bilgileri. | Kısmi / kabul açık |
| HSP-04 | Hesap altında domain, müşteri ve abonelik listeleri. | İnceleme/kabul açık |
| HSP-05 | Müşteriyi başka reseller/yöneticiye taşıma. | Sonraki faz |
| HSP-06 | Müşteri↔reseller dönüşümü ve kaynak etki önizlemesi. | Sonraki faz |
| HSP-07 | Toplu hesap işlemleri ve sahiplik değişiminde izin iptali. | Sonraki faz |
| HSP-08 | Reseller'ın kendi hosting abonelikleri ve müşteri abonelikleri. | Sonraki faz |

## 03 — Hizmet paketleri ve abonelikler [S03, S04]

| ID | Hedef özellik | Güncel durum |
| --- | --- | --- |
| PLN-01 | Hosting hizmet paketi oluşturma, klonlama, düzenleme, silme. | Sonraki faz |
| PLN-02 | Hosting add-on paketleri ve aboneliğe ekleme. | Sonraki faz |
| PLN-03 | Reseller paketleri ve reseller kaynak aboneliği. | Sonraki faz |
| PLN-04 | Müşteriye paketli veya özel abonelik oluşturma. | Sonraki faz |
| PLN-05 | Abonelik değiştirme, süre/askıya alma/etkinleştirme/silme. | Sonraki faz |
| PLN-06 | Paket senkronizasyonu, kilitleme, özelleştirme ve sync hataları. | Sonraki faz |
| PLN-07 | Aboneliği başka müşteriye taşıma ve bağlı kaynakları koruma. | Sonraki faz |
| PLN-08 | Disk, trafik, domain, mailbox, DB ve kullanıcı adet limitleri. | İnceleme/kabul açık |
| PLN-09 | Kaynak aşımı politikası, bildirimler ve reseller overselling izinleri. | Sonraki faz |
| PLN-10 | Paket bazlı PHP/hosting/mail/DNS/backup izinleri. | Sonraki faz |

## 04 — Siteler ve domainler [S05, S06]

| ID | Hedef özellik | Güncel durum |
| --- | --- | --- |
| WEB-01 | Domain ekleme ve amaca göre site oluşturma sihirbazı. | Kısmi / kabul açık |
| WEB-02 | Subdomain ve ayrı document root. | Kısmi / kabul açık |
| WEB-03 | Domain alias; web/mail/DNS ve yönlendirme tercihleri. | Kısmi / kabul açık |
| WEB-04 | Hosting, forwarding ve hosting olmadan domain davranışı. | İnceleme/kabul açık |
| WEB-05 | Tercih edilen domain, HTTP→HTTPS ve yönlendirmeler. | Kısmi / kabul açık |
| WEB-06 | Domain askıya alma, kapatma, etkinleştirme ve güvenli silme. | Kısmi / kabul açık |
| WEB-07 | Domain kartı/liste, arama, filtre ve doğru araç grupları. | Kısmi / kabul açık |
| WEB-08 | Önizleme, geçici domain ve site açma bağlantıları. | İnceleme/kabul açık |
| WEB-09 | Siteyi aboneliğe/müşteriye bağlama ve taşıma. | Sonraki faz |

## 05 — Dosyalar ve erişim [S07, S08]

| ID | Hedef özellik | Güncel durum |
| --- | --- | --- |
| DOS-01 | Global Files ve domain File Manager girişleri. | Kısmi / kabul açık |
| DOS-02 | Klasör ağacı, yol, liste, seçim, sıralama ve arama. | İnceleme/kabul açık |
| DOS-03 | Dosya/klasör oluşturma, yeniden adlandırma ve silme. | İnceleme/kabul açık |
| DOS-04 | Tekli/çoklu dosya ve klasör yükleme; sürükle/bırak. | İnceleme/kabul açık |
| DOS-05 | Dosya indirme ve URL'den içe aktarma; SSRF koruması. | İnceleme/kabul açık |
| DOS-06 | Kopyalama ve taşıma; çakışma/onay davranışı. | İnceleme/kabul açık |
| DOS-07 | Arşiv oluşturma/açma ve güvenli overwrite. | İnceleme/kabul açık |
| DOS-08 | Kod/metin/HTML düzenleme, kaydetme ve değişiklik uyarısı. | İnceleme/kabul açık |
| DOS-09 | Dosya adı/içerik araması, gizli dosyalar, izinler. | İnceleme/kabul açık |
| DOS-10 | FTP/FTPS hesapları, dizin kapsamı ve kota. | İnceleme/kabul açık |
| DOS-11 | SSH/SFTP/shell erişimi ve anahtarlar; kullanıcı izolasyonu. | Kısmi / kabul açık |

## 06 — Hosting ve çalışma ortamları [S05, S09, S10]

| ID | Hedef özellik | Güncel durum |
| --- | --- | --- |
| RUN-01 | Document root, sistem kullanıcısı ve hosting ayarları. | Kısmi / kabul açık |
| RUN-02 | PHP sürümü/handler, php.ini ve PHP-FPM ayarları. | Kritik açık |
| RUN-03 | Apache/Nginx ayarları, ek direktifler ve testli uygulama. | İnceleme/kabul açık |
| RUN-04 | MIME, index, hata sayfaları ve parola korumalı dizinler. | İnceleme/kabul açık |
| RUN-05 | Node.js sürümü, app root, startup dosyası ve environment. | Kısmi / kabul açık |
| RUN-06 | Node paket kurulumu, script, restart ve loglar. | Kısmi / kabul açık |
| RUN-07 | Composer bağımlılık yönetimi. | İnceleme/kabul açık |
| RUN-08 | Dil/runtime eklentilerinin kurulum ve erişim politikası. | İnceleme/kabul açık |

## 07 — Git ve framework araçları [S10, S11]

| ID | Hedef özellik | Güncel durum |
| --- | --- | --- |
| DEV-01 | Uzak Git repository ve yerel Git repository. | İnceleme/kabul açık |
| DEV-02 | Branch, deployment path, manuel/otomatik deployment. | İnceleme/kabul açık |
| DEV-03 | Deploy anahtarı/webhook/ek komut ve işlem sonucu. | İnceleme/kabul açık |
| DEV-04 | Laravel oluşturma, repository'den kurma ve mevcut app tarama. | İnceleme/kabul açık |
| DEV-05 | Laravel environment, Artisan, Composer ve Node komutları. | İnceleme/kabul açık |
| DEV-06 | Laravel scheduled task, log ve deployment senaryosu. | İnceleme/kabul açık |

## 08 — Docker [S12]

| ID | Hedef özellik | Güncel durum |
| --- | --- | --- |
| DKR-01 | Registry/image arama, indirme ve image yönetimi. | İnceleme/kabul açık |
| DKR-02 | Container oluşturma, başlatma, durdurma, yeniden oluşturma/silme. | İnceleme/kabul açık |
| DKR-03 | Port, environment, volume ve restart politikası. | İnceleme/kabul açık |
| DKR-04 | Domain reverse-proxy bağlantısı ve container log/terminal. | İnceleme/kabul açık |
| DKR-05 | Compose stack oluşturma/yükleme/güncelleme/up/stop/down. | İnceleme/kabul açık |
| DKR-06 | Container yapılandırma yedeği ile volume verisi yedeğinin ayrımı. | İnceleme/kabul açık |

## 09 — DNS [S13]

| ID | Hedef özellik | Güncel durum |
| --- | --- | --- |
| DNS-01 | Domain zone ve DNS kayıt CRUD; desteklenen RR türleri matrisi. | İnceleme/kabul açık |
| DNS-02 | TTL, SOA, zone şablonu ve şablon değişimini uygulama. | İnceleme/kabul açık |
| DNS-03 | Master/secondary, DNS aç/kapat ve harici DNS davranışı. | İnceleme/kabul açık |
| DNS-04 | DNSSEC anahtar/DS/rollover ve güvenli kapatma. | İnceleme/kabul açık |
| DNS-05 | Zone transfer yetkileri ve secondary doğrulama. | İnceleme/kabul açık |
| DNS-06 | Harici sağlayıcı entegrasyonları ve kayıt yayılım tanılaması. | İnceleme/kabul açık |

## 10 — Sertifikalar ve TLS [S14]

| ID | Hedef özellik | Güncel durum |
| --- | --- | --- |
| TLS-01 | Ücretsiz ACME issue, renew ve otomatik yenileme. | Kritik açık |
| TLS-02 | Wildcard/DNS-01, SAN ve www/mail/webmail kapsamı. | İnceleme/kabul açık |
| TLS-03 | Sertifika/anahtar/chain yükleme, CSR ve envanter. | İnceleme/kabul açık |
| TLS-04 | Panel, website ve mail servisine doğru sertifika atama. | İnceleme/kabul açık |
| TLS-05 | HTTPS yönlendirme, HSTS ve desteklenen TLS seçenekleri. | İnceleme/kabul açık |
| TLS-06 | Geçerlilik, gerçek sunulan sertifika, durum ve uyarılar. | Kritik açık |
| TLS-07 | Ticari sertifika sağlayıcıları; ayrı sözleşme/lisans bağımlılığı. | Ayrı hat |

## 11 — E-posta [S15]

| ID | Hedef özellik | Güncel durum |
| --- | --- | --- |
| EML-01 | Mailbox oluşturma/düzenleme/silme, parola ve kota. | İnceleme/kabul açık |
| EML-02 | Alias, forwarding ve yerel kopya tercihleri. | İnceleme/kabul açık |
| EML-03 | Otomatik yanıt/tatil mesajları. | İnceleme/kabul açık |
| EML-04 | Spam filtre, allow/deny list ve antivirüs politikası. | İnceleme/kabul açık |
| EML-05 | Mailing list ve üyelik yönetimi; OS/eklenti matrisi. | İnceleme/kabul açık |
| EML-06 | Domain mail aç/kapat, harici mail ve bulunmayan alıcı politikası. | İnceleme/kabul açık |
| EML-07 | Webmail, mail istemci ayarları ve otomatik yapılandırma. | İnceleme/kabul açık |
| EML-08 | SMTP/IMAP/POP3 ve TLS port politikası; kurulum bileşenine göre. | İnceleme/kabul açık |
| EML-09 | SPF/DKIM/DMARC ve relay/kimlik doğrulama güvenliği. | İnceleme/kabul açık |
| EML-10 | Giden posta limitleri, kuyruk ve teslimat tanılama. | İnceleme/kabul açık |
| EML-11 | Mail servisi sertifikası ve hostname/SNI davranışı. | İnceleme/kabul açık |

## 12 — Veritabanları [S16]

| ID | Hedef özellik | Güncel durum |
| --- | --- | --- |
| DB-01 | MySQL/MariaDB oluşturma, silme, site ilişkisi ve boyut. | Kritik açık |
| DB-02 | DB kullanıcıları, parolalar, roller ve grant yönetimi. | Kritik açık |
| DB-03 | Uzak erişim, izinli kaynaklar ve bağlantı bilgileri. | Kritik açık |
| DB-04 | phpMyAdmin geçişi ve oturum/yetki izolasyonu. | Kısmi / kabul açık |
| DB-05 | Dump import/export, kopyalama ve backup/restore. | Kısmi / kabul açık |
| DB-06 | Veritabanı denetimi/onarımı; desteklenen engine sınırı. | Kısmi / kabul açık |
| DB-07 | Abonelikler arası DB taşıma ve siteye yeniden bağlama. | Sonraki faz |
| DB-08 | PostgreSQL; Linux/kurulum/edition koşulları ayrı kabul edilir. | Ayrı hat |
| DB-09 | Uzak DB sunucusu kaydı ve engine/default server seçimi. | Ayrı hat |

## 13 — Yedek ve kurtarma [S17]

| ID | Hedef özellik | Güncel durum |
| --- | --- | --- |
| BAK-01 | Server, reseller/customer, subscription ve site düzeyleri. | Kısmi / kabul açık |
| BAK-02 | Yapılandırma/içerik, dosya/mail/DB kapsam seçimi. | Kısmi / kabul açık |
| BAK-03 | Tam ve artımlı yedekleme. | Kısmi / kabul açık |
| BAK-04 | Zamanlama, rotasyon, saklama ve hariç tutmalar. | İnceleme/kabul açık |
| BAK-05 | Yerel ve uzak FTP/cloud/object storage hedefleri. | İnceleme/kabul açık |
| BAK-06 | Seçici geri yükleme, indir/yükle ve parola koruması. | Kısmi / kabul açık |
| BAK-07 | Çoklu takvim/çoklu hedef gibi premium eşdeğer davranışlar. | Ayrı hat |
| BAK-08 | Gerçek kurtarma, hata bildirimi ve yedek sahipliği. | Kritik açık |

## 14 — Güvenlik ve sunucu [S18, S19]

| ID | Hedef özellik | Güncel durum |
| --- | --- | --- |
| SEC-01 | Firewall aç/kapat, kurallar, portlar ve güvenli geri dönüş. | İnceleme/kabul açık |
| SEC-02 | IP erişim kısıtları, brute-force koruması ve ban/unban. | İnceleme/kabul açık |
| SEC-03 | ModSecurity/WAF policy, ruleset ve domain istisnaları. | İnceleme/kabul açık |
| SEC-04 | Oturum/MFA/parola politikası ve API erişim sınırı. | Kısmi / kabul açık |
| SYS-01 | IP havuzu, IPv4/IPv6, shared/dedicated ve remap. | İnceleme/kabul açık |
| SYS-02 | Sistem servislerini kurma/başlatma/durdurma/yeniden başlatma. | İnceleme/kabul açık |
| SYS-03 | Hostname, saat/saat dilimi ve sistem ayarları. | İnceleme/kabul açık |
| SYS-04 | Sistem/PHP/panel güncellemeleri ve bileşen yönetimi. | İnceleme/kabul açık |
| SYS-05 | Yönetici terminali, olay tetikleyicileri ve onarım araçları. | Kısmi / kabul açık |
| SYS-06 | Cron/scheduled tasks; kullanıcı, zamanlama ve çıktı bildirimi. | İnceleme/kabul açık |

## 15 — İzleme, log ve istatistik [S20]

| ID | Hedef özellik | Güncel durum |
| --- | --- | --- |
| MON-01 | CPU/RAM/disk/ağ/servis ölçümleri ve geçmiş grafikler. | İnceleme/kabul açık |
| MON-02 | Eşik/teslim alıcısı/bildirim tercihleri ve teslim kanıtı. | İnceleme/kabul açık |
| MON-03 | Domain web istatistikleri, trafik ve kullanım raporları. | Kısmi / kabul açık |
| MON-04 | Web/mail/sistem log görüntüleme, filtre/arama ve rotasyon. | İnceleme/kabul açık |
| MON-05 | Servis watchdog/yeniden başlatma ve disk izleme. | İnceleme/kabul açık |
| MON-06 | Harici uptime/360 Monitoring benzeri servis; bağımsız sağlayıcı koşulları. | Ayrı hat |

## 16 — WordPress araçları [S21]

| ID | Hedef özellik | Güncel durum |
| --- | --- | --- |
| WP-01 | WordPress kurma, tarama, bağlama ve admin girişi. | İnceleme/kabul açık |
| WP-02 | Core/plugin/theme kurma, güncelleme, etkinleştirme/silme. | İnceleme/kabul açık |
| WP-03 | Toplu yönetim ve plugin/theme setleri. | İnceleme/kabul açık |
| WP-04 | Klonlama, staging ve veri senkronizasyonu. | İnceleme/kabul açık |
| WP-05 | Yedek/restore, bakım ve arama motoru indeksleme ayarları. | İnceleme/kabul açık |
| WP-06 | Güvenlik denetimi/sıkılaştırma ve zafiyet görünürlüğü. | İnceleme/kabul açık |
| WP-07 | Otomatik/smart update ve premium davranışların ayrı kabulü. | Ayrı hat |

## 17 — Uygulama ve eklenti ekosistemi [S05, S22]

| ID | Hedef özellik | Güncel durum |
| --- | --- | --- |
| EKL-01 | Uygulama kurucu/katalog; site ve DB kurulum bütünlüğü. | İnceleme/kabul açık |
| EKL-02 | Eklenti kur/güncelle/kaldır ve paket bağımlılıkları. | İnceleme/kabul açık |
| EKL-03 | Sitejet/site-builder eşdeğeri; vendor anlaşması veya bağımsız alternatif. | Ayrı hat |
| EKL-04 | Güvenlik/antivirüs/posta premium entegrasyonları. | Ayrı hat |
| EKL-05 | Cloud backup, DNS/CDN ve dış servis connector'ları. | Ayrı hat |
| EKL-06 | Eklenti lisans/izin/sağlık/güncelleme envanteri. | Ayrı hat |
| EKL-07 | Marketplace'in tüm ürünlerini vendor/version/OS/lisans/işlev bazında ayrı satırlara dök; bu araştırmada henüz eksiksiz alt-ürün taraması yapılmadı. Liste dışındaki ürünü sessizce kapsam dışı sayma. | Ayrı hat |

## 18 — API, otomasyon ve ticari entegrasyon [S23, S24]

| ID | Hedef özellik | Güncel durum |
| --- | --- | --- |
| API-01 | REST işlevleri ve yetkili API anahtarı yaşam döngüsü. | İnceleme/kabul açık |
| API-02 | XML API'deki kapsam için uyumluluk/eşdeğer işlem matrisi. | İnceleme/kabul açık |
| API-03 | CLI, olay handler'ları ve otomatik provisioning. | İnceleme/kabul açık |
| API-04 | Tek kullanımlık oturum/SSO ve denetlenebilir bağlam değişimi. | İnceleme/kabul açık |
| API-05 | WHMCS/ödeme/faturalama/storefront bağlantıları; Plesk core ile harici ticari sistem ayrımı. | Ayrı hat |
| API-06 | Paket/abonelik yaratma, suspend/unsuspend/terminate ve kullanım senkronizasyonu. | Sonraki faz |
| API-07 | Domain/sertifika satışı ve registrar entegrasyonları; sağlayıcı sözleşmeleri. | Ayrı hat |

## 19 — Taşıma ve yaşam döngüsü [S25]

| ID | Hedef özellik | Güncel durum |
| --- | --- | --- |
| MIG-01 | Plesk'ten müşteri/reseller/paket/abonelik kaynaklarını içe aktarma. | İnceleme/kabul açık |
| MIG-02 | Desteklenen diğer hosting panellerinden taşıma. | İnceleme/kabul açık |
| MIG-03 | Site/mail/DB/DNS/SSL/kullanıcı verisi ve IP eşleme. | İnceleme/kabul açık |
| MIG-04 | Ön kontrol, tekrar senkronizasyon ve taşıma sonrası doğrulama. | İnceleme/kabul açık |
| MIG-05 | Site/mail import; kısıtlar ve veri kaybı uyarısı. | İnceleme/kabul açık |
| MIG-06 | Panel güncellemesi/OS migration/rollback ve kurtarma. | İnceleme/kabul açık |

## 20 — Arayüz, marka ve hesap deneyimi [S01, S26]

| ID | Hedef özellik | Güncel durum |
| --- | --- | --- |
| UX-01 | Plesk görev yerleşimi ve tüm rollerin doğru menüsü. | Kritik açık |
| UX-02 | Global Files + domain File Manager; kaynaklar saklanmaz. | Kısmi / kabul açık |
| UX-03 | Abonelik/all subscriptions seçimi ve doğru geri dönüş. | Sonraki faz |
| UX-04 | Dil, tema, marka/logo/giriş ekranı ve özel bağlantılar. | İnceleme/kabul açık |
| UX-05 | Arama, filtre, sıralama, sayfalama ve toplu eylemler. | İnceleme/kabul açık |
| UX-06 | İş ilerlemesi, güvenli yeniden deneme ve gerçek durum. | Kritik açık |

## 21 — Windows'a özgü eşdeğerlik hattı [S16, S27]

| ID | Hedef özellik | Güncel durum |
| --- | --- | --- |
| WIN-01 | Windows Server kurulumu, güncelleme ve servis yönetimi. | Ayrı hat |
| WIN-02 | IIS site/application pool/virtual directory yönetimi. | Ayrı hat |
| WIN-03 | ASP.NET/ASP.NET Core/.NET Toolkit işlevleri. | Ayrı hat |
| WIN-04 | Microsoft SQL Server ve ODBC veri kaynakları. | Ayrı hat |
| WIN-05 | Windows kullanıcı/NTFS izinleri ve erişim. | Ayrı hat |
| WIN-06 | Microsoft DNS ve Windows mail bileşeni eşdeğerleri. | Ayrı hat |


## Doğrulanan açıkların eşlemesi

TLS-01/06 → YP2-02; DB-01/02/03/04 → YP2-03/04; RUN-02 → YP2-05; WEB-07/UX-01 → YP2-06/08; BAK-08 → YP2-07; WEB/RUN/DOS/EML → YP2-09/10/11; UX-06/MON → YP2-12; ROL/HSP/PLN-08 → YP2-13. DB-05/06 için eski export/access/repair endpoint iddiaları kabul edilmedi; gerçek HTTP mount ve UI görevleri yeniden eşlenecek.

[Kanıt ve sınırlamalar](audit-2026-10-09.md). Endpoint olmayan yol envanterde tamamlandı yazılmaz; katalogdaki source path tek başına yeterli değil.

## Resmî kaynak kaydı

Aşağıdaki S01–S27 önceki kapsam araştırmasının korunmuş referanslarıdır; hepsi bu tur yeniden açılmış gibi sunulmaz. Bu tur ziyaret edilen Plesk/Certbot/Let’s Encrypt sayfaları [araştırmada](audit-2026-10-09.md) ayrıca kayıtlıdır.

- S01: [Kaynak](https://docs.plesk.com/en-US/obsidian/administrator-guide/70562/)
- S02: [Kaynak](https://docs.plesk.com/en-US/obsidian/administrator-guide/customers-and-resellers.70622/)
- S03: [Kaynak](https://docs.plesk.com/en-US/obsidian/administrator-guide/customers-and-resellers/reseller-plans.70625/)
- S04: [Kaynak](https://docs.plesk.com/en-US/obsidian/reseller-guide/managing-subscriptions.65732/)
- S05: [Kaynak](https://docs.plesk.com/en-US/obsidian/administrator-guide/creating-websites.80014/)
- S06: [Kaynak](https://doc.plesk.com/en-US/obsidian/administrator-guide/65150/)
- S07: [Kaynak](https://docs.plesk.com/en-US/obsidian/administrator-guide/website-management/websites-and-domains/website-content/uploading-content-with-file-manager.74105/)
- S08: [Kaynak](https://docs.plesk.com/en-US/obsidian/quick-start-guide/plesk-tutorial.74376/)
- S09: [Kaynak](https://docs.plesk.com/en-US/obsidian/quick-start-guide/plesk-functionality-explained/managing-web-hosting.74401/)
- S10: [Kaynak](https://docs.plesk.com/en-US/obsidian/administrator-guide/website-management/nodejs-support.76652/)
- S11: [Kaynak](https://docs.plesk.com/en-US/obsidian/administrator-guide/website-management/laravel-toolkit.80010/)
- S12: [Kaynak](https://docs.plesk.com/release-notes/obsidian/change-log/)
- S13: [Kaynak](https://docs.plesk.com/en-US/obsidian/administrator-guide/dns/dns-settings.72226/)
- S14: [Kaynak](https://docs.plesk.com/en-US/obsidian/customer-guide/websites-and-domains/securing-connections-with-ssltls-certificates/securing-connections-with-the-ssl-it!-extension.65160/)
- S15: [Kaynak](https://docs.plesk.com/en-US/obsidian/customer-guide/mail-settings.69551/)
- S16: [Kaynak](https://docs.plesk.com/en-US/obsidian/customer-guide/website-databases.69535/)
- S17: [Kaynak1](https://docs.plesk.com/en-US/obsidian/administrator-guide/59256/), [Kaynak2](https://docs.plesk.com/en-US/obsidian/administrator-guide/backing-up-and-restoration/scheduling-backups.59264/)
- S18: [Kaynak](https://docs.plesk.com/en-US/obsidian/administrator-guide/72046/)
- S19: [Kaynak](https://docs.plesk.com/en-US/obsidian/administrator-guide/server-administration.70568/)
- S20: [Kaynak](https://docs.plesk.com/en-US/obsidian/administrator-guide/statistics-and-monitoring/monitoring.68886/)
- S21: [Kaynak](https://docs.plesk.com/en-US/obsidian/administrator-guide/website-management/wp-toolkit.73391/)
- S22: [Kaynak](https://www.plesk.com/extensions/)
- S23: [Kaynak](https://docs.plesk.com/en-US/obsidian/api-rpc/79358/)
- S24: [Kaynak](https://docs.plesk.com/en-US/obsidian/api-read-me-first/integration-and-automation-capabilities.68662/)
- S25: [Kaynak](https://docs.plesk.com/en-US/obsidian/migration-guide/introduction.75496/)
- S26: [Kaynak](https://docs.plesk.com/en-US/obsidian/administrator-guide/customizing-the-plesk-interface/appearance-and-branding.69527/)
- S27: [Kaynak](https://docs.plesk.com/release-notes/obsidian/system-requirements/)
