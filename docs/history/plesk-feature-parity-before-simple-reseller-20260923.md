# Plesk → YunPanel Tam Özellik Eşdeğerliği Envanteri

Tarih: 2026-09-23. Çalışma dalı: `development`, başlangıç: `main@1a45ded8697d640b87c149143613454fac1fa94d`.

## Kapsam ve doğruluk sözleşmesi

Kullanıcı artık yalnız site paneli değil **Plesk'in yönetici, reseller, müşteri, abonelik ve hizmet paketi davranışları dahil tam işlevsel eşdeğerliğini** istiyor. Önceki belgelerin reseller/customer/subscription/billing kapsam dışı ifadeleri bu kararla geçersizdir. Service Provider ve Power User görünümleri ile Reseller ve Customer panelleri ayrı bağlamlardır; hepsi hedef kapsamındadır. İlk uygulama yine Dosyalar erişimi ve Plesk UX geçişidir. Mevcut Ember renk/font/radius korunur.

Bu liste resmî Obsidian belgelerinden çıkarılmış, tarihli bir **ürün envanteridir**; Plesk Marketplace'in bütün üçüncü taraf ürünlerinin tüm alt ayarlarının eksiksiz tarandığı iddiası değildir. Çekirdek, işletim sistemine bağlı özellik ve ticari/harici entegrasyon ayrılır; hiçbiri sessizce kapsamdan çıkarılmaz. Eklenti kataloğu için EKL-07 kapanış kapısı vardır. Kaynaklar belgenin sonunda; sürüm/edition/OS/provider koşulları uygulamada ayrıca sabitlenir. Plesk'in kaynak kodu, markası veya ücretli vendor kodu kopyalanmaz; davranış bağımsız veya lisansı uygun motorla karşılanır.

`[ ]` = eşdeğerlik kabulü açık; **kodda hiç yok demek değildir**. Mevcut YunPanel yeteneği kaynak/API/host/browser kanıtıyla eşlenmeden tamamlandı sayılmaz. Kaynak alt işi `[x]` olabilir, fakat gerçek kabul açıkken üst özellik açık kalır. Her özellik için normal akış, yetkisiz erişim, hata, tekrar deneme ve veri korunması sınanır.

## 01 — Paneller, roller ve erişim [S01, S02]
- [ ] ROL-01 Yönetici Service Provider görünümü.
- [ ] ROL-02 Yönetici Power User görünümü ve görünüm değiştirme.
- [ ] ROL-03 Reseller paneli ve kendi kaynak/kullanıcı sınırı.
- [ ] ROL-04 Müşteri paneli ve abonelik/site seçimi.
- [ ] ROL-05 Ek kullanıcılar, roller ve izin matrisi.
- [ ] ROL-06 Ek yönetici hesapları ve yönetim yetkileri.
- [ ] ROL-07 Profil, iletişim bilgisi, parola, oturum ve MFA.
- [ ] ROL-08 Yetkili müşteri/reseller bağlamına geçiş ve yöneticiliğe dönüş; audit zorunlu.

## 02 — Müşteri ve bayi yaşam döngüsü [S02, S03]
- [ ] HSP-01 Müşteri oluştur/düzenle/askıya al/etkinleştir/sil.
- [ ] HSP-02 Reseller oluştur/düzenle/askıya al/etkinleştir/sil.
- [ ] HSP-03 İletişim, şirket, açıklama ve hesap erişim bilgileri.
- [ ] HSP-04 Hesap altında domain, müşteri ve abonelik listeleri.
- [ ] HSP-05 Müşteriyi başka reseller/yöneticiye taşıma.
- [ ] HSP-06 Müşteri↔reseller dönüşümü ve kaynak etki önizlemesi.
- [ ] HSP-07 Toplu hesap işlemleri ve sahiplik değişiminde izin iptali.
- [ ] HSP-08 Reseller'ın kendi hosting abonelikleri ve müşteri abonelikleri.

## 03 — Hizmet paketleri ve abonelikler [S03, S04]
- [ ] PLN-01 Hosting hizmet paketi oluşturma, klonlama, düzenleme, silme.
- [ ] PLN-02 Hosting add-on paketleri ve aboneliğe ekleme.
- [ ] PLN-03 Reseller paketleri ve reseller kaynak aboneliği.
- [ ] PLN-04 Müşteriye paketli veya özel abonelik oluşturma.
- [ ] PLN-05 Abonelik değiştirme, süre/askıya alma/etkinleştirme/silme.
- [ ] PLN-06 Paket senkronizasyonu, kilitleme, özelleştirme ve sync hataları.
- [ ] PLN-07 Aboneliği başka müşteriye taşıma ve bağlı kaynakları koruma.
- [ ] PLN-08 Disk, trafik, domain, mailbox, DB ve kullanıcı adet limitleri.
- [ ] PLN-09 Kaynak aşımı politikası, bildirimler ve reseller overselling izinleri.
- [ ] PLN-10 Paket bazlı PHP/hosting/mail/DNS/backup izinleri.

## 04 — Siteler ve domainler [S05, S06]
- [ ] WEB-01 Domain ekleme ve amaca göre site oluşturma sihirbazı.
- [ ] WEB-02 Subdomain ve ayrı document root.
- [ ] WEB-03 Domain alias; web/mail/DNS ve yönlendirme tercihleri.
- [ ] WEB-04 Hosting, forwarding ve hosting olmadan domain davranışı.
- [ ] WEB-05 Tercih edilen domain, HTTP→HTTPS ve yönlendirmeler.
- [ ] WEB-06 Domain askıya alma, kapatma, etkinleştirme ve güvenli silme.
- [ ] WEB-07 Domain kartı/liste, arama, filtre ve doğru araç grupları.
- [ ] WEB-08 Önizleme, geçici domain ve site açma bağlantıları.
- [ ] WEB-09 Siteyi aboneliğe/müşteriye bağlama ve taşıma.

## 05 — Dosyalar ve erişim [S07, S08]
- [ ] DOS-01 Global Files ve domain File Manager girişleri.
- [ ] DOS-02 Klasör ağacı, yol, liste, seçim, sıralama ve arama.
- [ ] DOS-03 Dosya/klasör oluşturma, yeniden adlandırma ve silme.
- [ ] DOS-04 Tekli/çoklu dosya ve klasör yükleme; sürükle/bırak.
- [ ] DOS-05 Dosya indirme ve URL'den içe aktarma; SSRF koruması.
- [ ] DOS-06 Kopyalama ve taşıma; çakışma/onay davranışı.
- [ ] DOS-07 Arşiv oluşturma/açma ve güvenli overwrite.
- [ ] DOS-08 Kod/metin/HTML düzenleme, kaydetme ve değişiklik uyarısı.
- [ ] DOS-09 Dosya adı/içerik araması, gizli dosyalar, izinler.
- [ ] DOS-10 FTP/FTPS hesapları, dizin kapsamı ve kota.
- [ ] DOS-11 SSH/SFTP/shell erişimi ve anahtarlar; kullanıcı izolasyonu.

## 06 — Hosting ve çalışma ortamları [S05, S09, S10]
- [ ] RUN-01 Document root, sistem kullanıcısı ve hosting ayarları.
- [ ] RUN-02 PHP sürümü/handler, php.ini ve PHP-FPM ayarları.
- [ ] RUN-03 Apache/Nginx ayarları, ek direktifler ve testli uygulama.
- [ ] RUN-04 MIME, index, hata sayfaları ve parola korumalı dizinler.
- [ ] RUN-05 Node.js sürümü, app root, startup dosyası ve environment.
- [ ] RUN-06 Node paket kurulumu, script, restart ve loglar.
- [ ] RUN-07 Composer bağımlılık yönetimi.
- [ ] RUN-08 Dil/runtime eklentilerinin kurulum ve erişim politikası.

## 07 — Git ve framework araçları [S10, S11]
- [ ] DEV-01 Uzak Git repository ve yerel Git repository.
- [ ] DEV-02 Branch, deployment path, manuel/otomatik deployment.
- [ ] DEV-03 Deploy anahtarı/webhook/ek komut ve işlem sonucu.
- [ ] DEV-04 Laravel oluşturma, repository'den kurma ve mevcut app tarama.
- [ ] DEV-05 Laravel environment, Artisan, Composer ve Node komutları.
- [ ] DEV-06 Laravel scheduled task, log ve deployment senaryosu.

## 08 — Docker [S12]
- [ ] DKR-01 Registry/image arama, indirme ve image yönetimi.
- [ ] DKR-02 Container oluşturma, başlatma, durdurma, yeniden oluşturma/silme.
- [ ] DKR-03 Port, environment, volume ve restart politikası.
- [ ] DKR-04 Domain reverse-proxy bağlantısı ve container log/terminal.
- [ ] DKR-05 Compose stack oluşturma/yükleme/güncelleme/up/stop/down.
- [ ] DKR-06 Container yapılandırma yedeği ile volume verisi yedeğinin ayrımı.

## 09 — DNS [S13]
- [ ] DNS-01 Domain zone ve DNS kayıt CRUD; desteklenen RR türleri matrisi.
- [ ] DNS-02 TTL, SOA, zone şablonu ve şablon değişimini uygulama.
- [ ] DNS-03 Master/secondary, DNS aç/kapat ve harici DNS davranışı.
- [ ] DNS-04 DNSSEC anahtar/DS/rollover ve güvenli kapatma.
- [ ] DNS-05 Zone transfer yetkileri ve secondary doğrulama.
- [ ] DNS-06 Harici sağlayıcı entegrasyonları ve kayıt yayılım tanılaması.

## 10 — Sertifikalar ve TLS [S14]
- [ ] TLS-01 Ücretsiz ACME issue, renew ve otomatik yenileme.
- [ ] TLS-02 Wildcard/DNS-01, SAN ve www/mail/webmail kapsamı.
- [ ] TLS-03 Sertifika/anahtar/chain yükleme, CSR ve envanter.
- [ ] TLS-04 Panel, website ve mail servisine doğru sertifika atama.
- [ ] TLS-05 HTTPS yönlendirme, HSTS ve desteklenen TLS seçenekleri.
- [ ] TLS-06 Geçerlilik, gerçek sunulan sertifika, durum ve uyarılar.
- [ ] TLS-07 Ticari sertifika sağlayıcıları; ayrı sözleşme/lisans bağımlılığı.

## 11 — E-posta [S15]
- [ ] EML-01 Mailbox oluşturma/düzenleme/silme, parola ve kota.
- [ ] EML-02 Alias, forwarding ve yerel kopya tercihleri.
- [ ] EML-03 Otomatik yanıt/tatil mesajları.
- [ ] EML-04 Spam filtre, allow/deny list ve antivirüs politikası.
- [ ] EML-05 Mailing list ve üyelik yönetimi; OS/eklenti matrisi.
- [ ] EML-06 Domain mail aç/kapat, harici mail ve bulunmayan alıcı politikası.
- [ ] EML-07 Webmail, mail istemci ayarları ve otomatik yapılandırma.
- [ ] EML-08 SMTP/IMAP/POP3 ve TLS port politikası; kurulum bileşenine göre.
- [ ] EML-09 SPF/DKIM/DMARC ve relay/kimlik doğrulama güvenliği.
- [ ] EML-10 Giden posta limitleri, kuyruk ve teslimat tanılama.
- [ ] EML-11 Mail servisi sertifikası ve hostname/SNI davranışı.

## 12 — Veritabanları [S16]
- [ ] DB-01 MySQL/MariaDB oluşturma, silme, site ilişkisi ve boyut.
- [ ] DB-02 DB kullanıcıları, parolalar, roller ve grant yönetimi.
- [ ] DB-03 Uzak erişim, izinli kaynaklar ve bağlantı bilgileri.
- [ ] DB-04 phpMyAdmin geçişi ve oturum/yetki izolasyonu.
- [ ] DB-05 Dump import/export, kopyalama ve backup/restore.
- [ ] DB-06 Veritabanı denetimi/onarımı; desteklenen engine sınırı.
- [ ] DB-07 Abonelikler arası DB taşıma ve siteye yeniden bağlama.
- [ ] DB-08 PostgreSQL; Linux/kurulum/edition koşulları ayrı kabul edilir.
- [ ] DB-09 Uzak DB sunucusu kaydı ve engine/default server seçimi.

## 13 — Yedek ve kurtarma [S17]
- [ ] BAK-01 Server, reseller/customer, subscription ve site düzeyleri.
- [ ] BAK-02 Yapılandırma/içerik, dosya/mail/DB kapsam seçimi.
- [ ] BAK-03 Tam ve artımlı yedekleme.
- [ ] BAK-04 Zamanlama, rotasyon, saklama ve hariç tutmalar.
- [ ] BAK-05 Yerel ve uzak FTP/cloud/object storage hedefleri.
- [ ] BAK-06 Seçici geri yükleme, indir/yükle ve parola koruması.
- [ ] BAK-07 Çoklu takvim/çoklu hedef gibi premium eşdeğer davranışlar.
- [ ] BAK-08 Gerçek kurtarma, hata bildirimi ve yedek sahipliği.

## 14 — Güvenlik ve sunucu [S18, S19]
- [ ] SEC-01 Firewall aç/kapat, kurallar, portlar ve güvenli geri dönüş.
- [ ] SEC-02 IP erişim kısıtları, brute-force koruması ve ban/unban.
- [ ] SEC-03 ModSecurity/WAF policy, ruleset ve domain istisnaları.
- [ ] SEC-04 Oturum/MFA/parola politikası ve API erişim sınırı.
- [ ] SYS-01 IP havuzu, IPv4/IPv6, shared/dedicated ve remap.
- [ ] SYS-02 Sistem servislerini kurma/başlatma/durdurma/yeniden başlatma.
- [ ] SYS-03 Hostname, saat/saat dilimi ve sistem ayarları.
- [ ] SYS-04 Sistem/PHP/panel güncellemeleri ve bileşen yönetimi.
- [ ] SYS-05 Yönetici terminali, olay tetikleyicileri ve onarım araçları.
- [ ] SYS-06 Cron/scheduled tasks; kullanıcı, zamanlama ve çıktı bildirimi.

## 15 — İzleme, log ve istatistik [S20]
- [ ] MON-01 CPU/RAM/disk/ağ/servis ölçümleri ve geçmiş grafikler.
- [ ] MON-02 Eşik/teslim alıcısı/bildirim tercihleri ve teslim kanıtı.
- [ ] MON-03 Domain web istatistikleri, trafik ve kullanım raporları.
- [ ] MON-04 Web/mail/sistem log görüntüleme, filtre/arama ve rotasyon.
- [ ] MON-05 Servis watchdog/yeniden başlatma ve disk izleme.
- [ ] MON-06 Harici uptime/360 Monitoring benzeri servis; bağımsız sağlayıcı koşulları.

## 16 — WordPress araçları [S21]
- [ ] WP-01 WordPress kurma, tarama, bağlama ve admin girişi.
- [ ] WP-02 Core/plugin/theme kurma, güncelleme, etkinleştirme/silme.
- [ ] WP-03 Toplu yönetim ve plugin/theme setleri.
- [ ] WP-04 Klonlama, staging ve veri senkronizasyonu.
- [ ] WP-05 Yedek/restore, bakım ve arama motoru indeksleme ayarları.
- [ ] WP-06 Güvenlik denetimi/sıkılaştırma ve zafiyet görünürlüğü.
- [ ] WP-07 Otomatik/smart update ve premium davranışların ayrı kabulü.

## 17 — Uygulama ve eklenti ekosistemi [S05, S22]
- [ ] EKL-01 Uygulama kurucu/katalog; site ve DB kurulum bütünlüğü.
- [ ] EKL-02 Eklenti kur/güncelle/kaldır ve paket bağımlılıkları.
- [ ] EKL-03 Sitejet/site-builder eşdeğeri; vendor anlaşması veya bağımsız alternatif.
- [ ] EKL-04 Güvenlik/antivirüs/posta premium entegrasyonları.
- [ ] EKL-05 Cloud backup, DNS/CDN ve dış servis connector'ları.
- [ ] EKL-06 Eklenti lisans/izin/sağlık/güncelleme envanteri.
- [ ] EKL-07 Marketplace'in tüm ürünlerini vendor/version/OS/lisans/işlev bazında ayrı satırlara dök; bu araştırmada henüz eksiksiz alt-ürün taraması yapılmadı. Liste dışındaki ürünü sessizce kapsam dışı sayma.

## 18 — API, otomasyon ve ticari entegrasyon [S23, S24]
- [ ] API-01 REST işlevleri ve yetkili API anahtarı yaşam döngüsü.
- [ ] API-02 XML API'deki kapsam için uyumluluk/eşdeğer işlem matrisi.
- [ ] API-03 CLI, olay handler'ları ve otomatik provisioning.
- [ ] API-04 Tek kullanımlık oturum/SSO ve denetlenebilir bağlam değişimi.
- [ ] API-05 WHMCS/ödeme/faturalama/storefront bağlantıları; Plesk core ile harici ticari sistem ayrımı.
- [ ] API-06 Paket/abonelik yaratma, suspend/unsuspend/terminate ve kullanım senkronizasyonu.
- [ ] API-07 Domain/sertifika satışı ve registrar entegrasyonları; sağlayıcı sözleşmeleri.

## 19 — Taşıma ve yaşam döngüsü [S25]
- [ ] MIG-01 Plesk'ten müşteri/reseller/paket/abonelik kaynaklarını içe aktarma.
- [ ] MIG-02 Desteklenen diğer hosting panellerinden taşıma.
- [ ] MIG-03 Site/mail/DB/DNS/SSL/kullanıcı verisi ve IP eşleme.
- [ ] MIG-04 Ön kontrol, tekrar senkronizasyon ve taşıma sonrası doğrulama.
- [ ] MIG-05 Site/mail import; kısıtlar ve veri kaybı uyarısı.
- [ ] MIG-06 Panel güncellemesi/OS migration/rollback ve kurtarma.

## 20 — Arayüz, marka ve hesap deneyimi [S01, S26]
- [ ] UX-01 Plesk görev yerleşimi ve tüm rollerin doğru menüsü.
- [ ] UX-02 Global Files + domain File Manager; kaynaklar saklanmaz.
- [ ] UX-03 Abonelik/all subscriptions seçimi ve doğru geri dönüş.
- [ ] UX-04 Dil, tema, marka/logo/giriş ekranı ve özel bağlantılar.
- [ ] UX-05 Arama, filtre, sıralama, sayfalama ve toplu eylemler.
- [ ] UX-06 İş ilerlemesi, güvenli yeniden deneme ve gerçek durum.

## 21 — Windows'a özgü eşdeğerlik hattı [S16, S27]

Ubuntu implementasyonu bu satırları tamamlamaz; bunlar kapsamdan çıkarılmadı, ayrı Windows backend/kurulum/test gerektirir.
- [ ] WIN-01 Windows Server kurulumu, güncelleme ve servis yönetimi.
- [ ] WIN-02 IIS site/application pool/virtual directory yönetimi.
- [ ] WIN-03 ASP.NET/ASP.NET Core/.NET Toolkit işlevleri.
- [ ] WIN-04 Microsoft SQL Server ve ODBC veri kaynakları.
- [ ] WIN-05 Windows kullanıcı/NTFS izinleri ve erişim.
- [ ] WIN-06 Microsoft DNS ve Windows mail bileşeni eşdeğerleri.

## Abonelik ve kaynak sahipliği tasarım kapısı

Hedef ilişki: Yönetici → Reseller (isteğe bağlı) → Müşteri → Abonelik → Website/domain → kaynaklar; ek kullanıcılar üyelik/rol üzerinden bağlanır. Reseller yalnız rol etiketi değildir. Kota tahsisi/tüketimi, sahiplik transferi, paket sync ve suspend etkileri backend'de uygulanır. Mevcut site_manager hesabı otomatik reseller yapılmaz. Mevcut Website başına Unix izolasyonu yalnız Plesk abonelik modeli benziyor diye kaldırılmaz; mevcut kimlikler açık migration/rollback olmadan birleştirilmez.

## Resmî kaynak kaydı

S01 https://docs.plesk.com/en-US/obsidian/administrator-guide/70562/
S02 https://docs.plesk.com/en-US/obsidian/administrator-guide/customers-and-resellers.70622/
S03 https://docs.plesk.com/en-US/obsidian/administrator-guide/customers-and-resellers/reseller-plans.70625/
S04 https://docs.plesk.com/en-US/obsidian/reseller-guide/managing-subscriptions.65732/
S05 https://docs.plesk.com/en-US/obsidian/administrator-guide/creating-websites.80014/
S06 https://doc.plesk.com/en-US/obsidian/administrator-guide/65150/
S07 https://docs.plesk.com/en-US/obsidian/administrator-guide/website-management/websites-and-domains/website-content/uploading-content-with-file-manager.74105/
S08 https://docs.plesk.com/en-US/obsidian/quick-start-guide/plesk-tutorial.74376/
S09 https://docs.plesk.com/en-US/obsidian/quick-start-guide/plesk-functionality-explained/managing-web-hosting.74401/
S10 https://docs.plesk.com/en-US/obsidian/administrator-guide/website-management/nodejs-support.76652/
S11 https://docs.plesk.com/en-US/obsidian/administrator-guide/website-management/laravel-toolkit.80010/
S12 https://docs.plesk.com/release-notes/obsidian/change-log/
S13 https://docs.plesk.com/en-US/obsidian/administrator-guide/dns/dns-settings.72226/
S14 https://docs.plesk.com/en-US/obsidian/customer-guide/websites-and-domains/securing-connections-with-ssltls-certificates/securing-connections-with-the-ssl-it!-extension.65160/
S15 https://docs.plesk.com/en-US/obsidian/customer-guide/mail-settings.69551/
S16 https://docs.plesk.com/en-US/obsidian/customer-guide/website-databases.69535/
S17 https://docs.plesk.com/en-US/obsidian/administrator-guide/59256/ ; https://docs.plesk.com/en-US/obsidian/administrator-guide/backing-up-and-restoration/scheduling-backups.59264/
S18 https://docs.plesk.com/en-US/obsidian/administrator-guide/72046/
S19 https://docs.plesk.com/en-US/obsidian/administrator-guide/server-administration.70568/
S20 https://docs.plesk.com/en-US/obsidian/administrator-guide/statistics-and-monitoring/monitoring.68886/
S21 https://docs.plesk.com/en-US/obsidian/administrator-guide/website-management/wp-toolkit.73391/
S22 https://www.plesk.com/extensions/
S23 https://docs.plesk.com/en-US/obsidian/api-rpc/79358/
S24 https://docs.plesk.com/en-US/obsidian/api-read-me-first/integration-and-automation-capabilities.68662/
S25 https://docs.plesk.com/en-US/obsidian/migration-guide/introduction.75496/
S26 https://docs.plesk.com/en-US/obsidian/administrator-guide/customizing-the-plesk-interface/appearance-and-branding.69527/
S27 https://docs.plesk.com/release-notes/obsidian/system-requirements/
