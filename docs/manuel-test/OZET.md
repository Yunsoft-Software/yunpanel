# Manuel Test Özeti (1. Dalga — 124 Özellik)

> 1. dalga manuel test süreci tamamlanmıştır. Bu doküman `docs/manuel-test/` altındaki 124 adet özellik testi raporunun (`API-01`...`WP-06`) konsolide özetidir.

## Özet Metrikler

- **Toplam Test Edilen Özellik:** 124
- **ÇALIŞIYOR:** 26 (%21.0)
- **KISMİ:** 93 (%75.0)
- **SORUNLU:** 1 (%0.8) (`BAK-08` — Yedek deposu başlatma UI eksikliği)
- **ÇALIŞMIYOR:** 4 (%3.2) (`DOS-10` FTP, `EML-03` Autoresponder, `EML-05` Mailing list, `SEC-03` WAF/ModSecurity)
- **Kritik Bulgu Sayısı:** 6 (6 bulgu satırı / 5 görev kimliği: `T800`, `T801`, `T802`, `T803`, `T804`)
- **Normal Bulgu Satırı Sayısı:** 237 (API-01'de ürün hatası olmayan açıklama sayımdan çıkarıldı)
- **Raporlardaki Mevcut Test Sınıflandırma Girdileri:** 763 (GEÇERLİ: 450, MOCK: 149, YÜZEYSEL: 95, KIRMIZI: 28, EKSİK: 25, YANLIŞ: 13, DİĞER: 2, BOŞ: 1)

Sayılar raporların tarihsel bulgu ve sınıflandırma satırlarını toplar; aynı sorunun birden fazla raporda görünmesi mümkündür. Bunlar benzersiz açık hata veya benzersiz test dosyası sayıları değildir. Kritik satırlar, aşağıda düzeltildiği veya yeniden sınıflandırıldığı belirtilen geçmiş kayıtları da içerir. `test.fail` ile beklenen düşüşler ürünün çalıştığı anlamına gelmez. Bağımsız sayım ve kabul sınırı: [CODEX-KABUL-DENETIMI.md](CODEX-KABUL-DENETIMI.md).

---

## 1. Özellik Durum Tablosu (124 Özellik)

| ID | Özellik | Sonuç | Kritik | Normal | Bulgu Görevleri | 2. Dalga Önerisi |
|---|---|---|:---:|:---:|:---:|---|
| API-01 | REST işlevleri ve API anahtarı yaşam döngüsü | `ÇALIŞIYOR` | 0 | 0 | — | Koru / Düzelt |
| API-02 | XML API'deki kapsam için uyumluluk/eşdeğer işlem matrisi | `KISMİ` | 0 | 2 | — | Koru |
| API-03 | CLI, olay handler'ları ve otomatik provisioning | `KISMİ` | 0 | 2 | — | Koru |
| API-04 | Tek kullanımlık oturum/SSO ve denetlenebilir bağlam değişimi | `KISMİ` | 0 | 2 | — | Koru |
| BAK-01 | Server, reseller/customer, subscription ve site düzeyleri | `KISMİ` | 0 | 1 | — | Koru |
| BAK-02 | Yapılandırma/içerik, dosya/mail/DB kapsam seçimi | `KISMİ` | 0 | 1 | — | Koru |
| BAK-03 | Tam ve artımlı yedekleme | `ÇALIŞIYOR` | 0 | 1 | — | Koru / Düzelt |
| BAK-04 | Zamanlama, rotasyon, saklama ve hariç tutmalar | `ÇALIŞIYOR` | 0 | 0 | — | Koru |
| BAK-05 | Yerel ve uzak FTP/cloud/object storage hedefleri | `KISMİ` | 0 | 2 | — | Koru |
| BAK-06 | Seçici geri yükleme, indir/yükle ve parola koruması | `KISMİ` | 0 | 2 | — | Koru |
| BAK-08 | Gerçek kurtarma, hata bildirimi ve yedek sahipliği | `SORUNLU` | 1 | 3 | T802 | Koru / Düzelt |
| DB-01 | MySQL/MariaDB oluşturma, silme, site ilişkisi ve boyut | `KISMİ` | 0 | 5 | — | Koru / Düzelt / Yaz |
| DB-02 | DB kullanıcıları, parolalar, roller ve grant yönetimi | `KISMİ` | 0 | 5 | — | Koru / Düzelt / Yaz |
| DB-03 | Uzak erişim, izinli kaynaklar ve bağlantı bilgileri | `KISMİ` | 0 | 3 | — | Koru / Düzelt / Yaz |
| DB-04 | phpMyAdmin geçişi ve oturum/yetki izolasyonu | `ÇALIŞIYOR` | 0 | 0 | — | Koru |
| DB-05 | Dump import/export, kopyalama ve backup/restore | `ÇALIŞIYOR` | 0 | 0 | — | Koru |
| DB-06 | Veritabanı denetimi/onarımı; desteklenen engine sınırı | `KISMİ` | 0 | 1 | — | Koru |
| DEV-01 | Uzak Git repository ve yerel Git repository | `KISMİ` | 0 | 2 | — | Koru |
| DEV-02 | Branch, deployment path, manuel/otomatik deployment | `KISMİ` | 0 | 3 | — | Koru |
| DEV-03 | Deploy anahtarı/webhook/ek komut ve işlem sonucu | `KISMİ` | 0 | 3 | — | Koru |
| DEV-04 | Laravel oluşturma, repository'den kurma ve mevcut app tarama | `KISMİ` | 0 | 3 | — | Koru / Düzelt |
| DEV-05 | Laravel environment, Artisan, Composer ve Node komutları | `KISMİ` | 0 | 3 | — | Koru |
| DEV-06 | Laravel scheduled task, log ve deployment senaryosu | `KISMİ` | 0 | 3 | — | Koru |
| DKR-01 | Registry/image arama, indirme ve image yönetimi | `KISMİ` | 0 | 1 | — | Koru |
| DKR-02 | Container oluşturma, başlatma, durdurma, yeniden oluşturma/silme | `ÇALIŞIYOR` | 0 | 0 | — | Koru |
| DKR-03 | Port, environment, volume ve restart politikası | `ÇALIŞIYOR` | 0 | 0 | — | Koru |
| DKR-04 | Domain reverse-proxy bağlantısı ve container log/terminal | `KISMİ` | 0 | 1 | — | Koru |
| DKR-05 | Compose stack oluşturma/yükleme/güncelleme/up/stop/down | `ÇALIŞIYOR` | 0 | 0 | — | Koru / Düzelt |
| DKR-06 | Container yapılandırma yedeği ile volume verisi yedeğinin ayrımı | `KISMİ` | 0 | 1 | — | Koru / Düzelt |
| DNS-01 | Domain zone ve DNS kayıt CRUD; desteklenen RR türleri matrisi | `ÇALIŞIYOR` | 0 | 0 | — | Koru |
| DNS-02 | TTL, SOA, zone şablonu ve şablon değişimini uygulama | `KISMİ` | 0 | 1 | — | Koru |
| DNS-03 | Master/secondary, DNS aç/kapat ve harici DNS davranışı | `KISMİ` | 0 | 1 | — | Koru |
| DNS-04 | DNSSEC anahtar/DS/rollover ve güvenli kapatma | `KISMİ` | 0 | 2 | — | Koru |
| DNS-05 | Zone transfer yetkileri ve secondary doğrulama | `KISMİ` | 0 | 2 | — | Koru |
| DNS-06 | Harici sağlayıcı entegrasyonları ve kayıt yayılım tanılaması | `KISMİ` | 0 | 2 | — | Koru |
| DOS-01 | Global Files ve domain File Manager girişleri | `ÇALIŞIYOR` | 0 | 0 | — | Koru / Yaz |
| DOS-02 | Klasör ağacı, yol, liste, seçim, sıralama ve arama | `ÇALIŞIYOR` | 0 | 0 | — | Koru / Yaz |
| DOS-03 | Dosya/klasör oluşturma, yeniden adlandırma ve silme | `ÇALIŞIYOR` | 0 | 0 | — | Koru |
| DOS-04 | Tekli/çoklu dosya ve klasör yükleme; sürükle/bırak | `KISMİ` | 0 | 0 | — | Koru / Düzelt / Yaz |
| DOS-05 | Dosya indirme ve URL'den içe aktarma; SSRF koruması | `KISMİ` | 0 | 2 | — | Koru |
| DOS-06 | Kopyalama ve taşıma; çakışma/onay davranışı | `ÇALIŞIYOR` | 0 | 0 | — | Koru |
| DOS-07 | Arşiv oluşturma/açma ve güvenli overwrite | `ÇALIŞIYOR` | 0 | 0 | — | Koru |
| DOS-08 | Kod/metin/HTML düzenleme, kaydetme ve değişiklik uyarısı | `ÇALIŞIYOR` | 0 | 0 | — | Koru / Yaz |
| DOS-09 | Dosya adı/içerik araması, gizli dosyalar, izinler | `KISMİ` | 0 | 1 | — | Koru |
| DOS-10 | FTP/FTPS hesapları, dizin kapsamı ve kota | `ÇALIŞMIYOR` | 0 | 2 | — | Koru |
| DOS-11 | SSH/SFTP/shell erişimi ve anahtarlar; kullanıcı izolasyonu | `KISMİ` | 0 | 1 | — | Koru / Yaz |
| EKL-01 | Uygulama kurucu/katalog; site ve DB kurulum bütünlüğü | `KISMİ` | 0 | 2 | — | Koru |
| EKL-02 | Eklenti kur/güncelle/kaldır ve paket bağımlılıkları | `KISMİ` | 0 | 2 | — | Koru |
| EML-01 | Mailbox oluşturma/düzenleme/silme, parola ve kota | `ÇALIŞIYOR` | 0 | 0 | — | Koru |
| EML-02 | Mailbox Forwarding, Alias ve Yerel Kopya Tercihleri | `ÇALIŞIYOR` | 0 | 0 | — | Yaz |
| EML-03 | Otomatik yanıt ve tatil mesajları | `ÇALIŞMIYOR` | 0 | 1 | — | Düzelt |
| EML-04 | Spam filtre, allow/deny list ve antivirüs politikası | `KISMİ` | 0 | 1 | — | Koru / Düzelt |
| EML-05 | Mailing list ve üyelik yönetimi; OS/eklenti matrisi | `ÇALIŞMIYOR` | 0 | 1 | — | Düzelt |
| EML-06 | Domain mail aç/kapat, harici mail ve bulunmayan alıcı politikası | `KISMİ` | 0 | 1 | — | Koru |
| EML-07 | Webmail, mail istemci ayarları ve otomatik yapılandırma | `KISMİ` | 0 | 1 | — | Koru / Düzelt |
| EML-08 | SMTP/IMAP/POP3 ve TLS port politikası; kurulum bileşenine göre | `KISMİ` | 0 | 1 | — | Koru |
| EML-09 | SPF/DKIM/DMARC ve relay/kimlik doğrulama güvenliği | `KISMİ` | 0 | 2 | — | Koru |
| EML-10 | Giden posta limitleri, kuyruk ve teslimat tanılama | `KISMİ` | 0 | 2 | — | Koru |
| EML-11 | Mail servisi sertifikası ve hostname/SNI davranışı | `KISMİ` | 0 | 1 | — | Koru |
| HSP-01 | Müşteri oluştur/düzenle/askıya al/etkinleştir/sil | `KISMİ` | 0 | 5 | — | Koru / Düzelt / Yaz |
| HSP-02 | Reseller oluştur/düzenle/askıya al/etkinleştir/sil | `KISMİ` | 0 | 5 | — | Koru / Düzelt / Yaz |
| HSP-03 | İletişim, şirket, açıklama ve hesap erişim bilgileri | `KISMİ` | 0 | 6 | — | Koru / Düzelt |
| HSP-04 | Hesap altında domain, müşteri ve abonelik listeleri | `ÇALIŞIYOR` | 0 | 0 | — | Koru |
| MIG-01 | Plesk'ten kaynakları içe aktarma | `KISMİ` | 0 | 4 | — | Koru |
| MIG-02 | Desteklenen diğer hosting panellerinden taşıma (cPanel, DirectAdmin vb.) | `KISMİ` | 0 | 4 | — | Koru |
| MIG-03 | Site/mail/DB/DNS/SSL/kullanıcı verisi ve IP eşleme | `KISMİ` | 0 | 3 | — | Koru |
| MIG-04 | Ön kontrol, tekrar senkronizasyon ve taşıma sonrası doğrulama | `KISMİ` | 0 | 4 | — | Koru |
| MIG-05 | Site/mail import; kısıtlar ve veri kaybı uyarısı | `KISMİ` | 0 | 4 | — | Koru |
| MIG-06 | Panel güncellemesi/OS migration/rollback ve kurtarma | `KISMİ` | 0 | 4 | — | Koru / Yaz |
| MON-01 | CPU/RAM/disk/ağ/servis ölçümleri ve geçmiş grafikler | `KISMİ` | 0 | 1 | — | Koru |
| MON-02 | Eşik/teslim alıcısı/bildirim tercihleri ve teslim kanıtı | `KISMİ` | 0 | 1 | — | Koru |
| MON-03 | Domain web istatistikleri, trafik ve kullanım raporları | `KISMİ` | 0 | 1 | — | Koru |
| MON-04 | Web/mail/sistem log görüntüleme, filtre/arama ve rotasyon | `KISMİ` | 0 | 1 | — | Koru |
| MON-05 | Servis watchdog/yeniden başlatma ve disk izleme | `KISMİ` | 0 | 1 | — | Koru |
| PLN-08 | Disk, trafik, domain, mailbox, DB ve kullanıcı adet limitleri | `KISMİ` | 0 | 1 | — | Koru |
| ROL-01 | Yönetici Service Provider görünümü | `KISMİ` | 0 | 5 | — | Koru / Düzelt / Yaz |
| ROL-03 | Reseller paneli ve kendi kaynak/kullanıcı sınırı | `KISMİ` | 1 | 4 | T803, T804 | Koru / Düzelt / Yaz |
| ROL-04 | Müşteri paneli ve abonelik/site seçimi | `KISMİ` | 0 | 6 | — | Koru / Düzelt / Yaz |
| ROL-05 | Ek kullanıcılar, roller ve izin matrisi | `KISMİ` | 0 | 5 | — | Koru / Düzelt / Yaz |
| ROL-06 | Ek yönetici hesapları ve yönetim yetkileri | `KISMİ` | 0 | 6 | — | Koru / Düzelt / Yaz |
| ROL-07 | Profil, iletişim bilgisi, parola, oturum ve MFA | `KISMİ` | 0 | 7 | — | Koru / Düzelt / Yaz |
| RUN-01 | Document root, sistem kullanıcısı ve hosting ayarları | `ÇALIŞIYOR` | 0 | 0 | — | Koru |
| RUN-02 | PHP sürümü/handler, php.ini ve PHP-FPM ayarları | `KISMİ` | 0 | 3 | — | Koru / Düzelt / Yaz |
| RUN-03 | Apache/Nginx ayarları, ek direktifler ve testli uygulama | `KISMİ` | 0 | 1 | — | Koru |
| RUN-04 | MIME, index, hata sayfaları ve parola korumalı dizinler | `KISMİ` | 0 | 3 | — | Koru / Düzelt |
| RUN-05 | Node.js sürümü, app root, startup dosyası ve environment | `KISMİ` | 0 | 1 | — | Koru |
| RUN-06 | Node paket kurulumu, script, restart ve loglar | `KISMİ` | 0 | 1 | — | Koru |
| RUN-07 | Composer bağımlılık yönetimi | `KISMİ` | 0 | 1 | — | Düzelt |
| RUN-08 | Dil/runtime eklentilerinin kurulum ve erişim politikası | `KISMİ` | 0 | 1 | — | Koru |
| SEC-01 | Firewall aç/kapat, kurallar, portlar ve güvenli geri dönüş | `KISMİ` | 0 | 1 | — | Koru / Düzelt |
| SEC-02 | IP erişim kısıtları, brute-force koruması ve ban/unban | `KISMİ` | 0 | 2 | — | Koru |
| SEC-03 | ModSecurity/WAF policy, ruleset ve domain istisnaları | `ÇALIŞMIYOR` | 0 | 1 | — | Koru / Düzelt |
| SEC-04 | Oturum/MFA/parola politikası ve API erişim sınırı | `KISMİ` | 0 | 1 | — | Koru |
| SYS-01 | IP havuzu, IPv4/IPv6, shared/dedicated ve remap | `KISMİ` | 0 | 1 | — | Koru / Düzelt |
| SYS-02 | Sistem servislerini kurma/başlatma/durdurma/yeniden başlatma | `ÇALIŞIYOR` | 0 | 1 | — | Koru |
| SYS-03 | Hostname, saat/saat dilimi ve sistem ayarları | `KISMİ` | 0 | 2 | — | Koru / Yaz |
| SYS-04 | Sistem/PHP/panel güncellemeleri ve bileşen yönetimi | `ÇALIŞIYOR` | 0 | 2 | — | Koru |
| SYS-05 | Yönetici terminali, olay tetikleyicileri ve onarım araçları | `KISMİ` | 0 | 1 | — | Koru / Düzelt |
| SYS-06 | Cron/scheduled tasks; kullanıcı, zamanlama ve çıktı bildirimi | `KISMİ` | 0 | 1 | — | Düzelt |
| TLS-01 | Ücretsiz ACME issue, renew ve otomatik yenileme | `KISMİ` | 2 | 5 | T800, T801 | Koru / Düzelt / Yaz |
| TLS-02 | Wildcard/DNS-01, SAN ve www/mail/webmail kapsamı | `KISMİ` | 0 | 1 | — | Koru |
| TLS-03 | Sertifika/anahtar/chain yükleme, CSR ve envanter | `KISMİ` | 0 | 3 | — | Koru |
| TLS-04 | Panel, website ve mail servisine doğru sertifika atama | `KISMİ` | 0 | 1 | — | Koru |
| TLS-05 | HTTPS yönlendirme, HSTS ve desteklenen TLS seçenekleri | `KISMİ` | 0 | 1 | — | Koru |
| TLS-06 | Geçerlilik, gerçek sunulan sertifika, durum ve uyarılar | `KISMİ` | 0 | 6 | — | Koru / Düzelt / Yaz |
| UX-01 | Plesk görev yerleşimi ve tüm rollerin doğru menüsü | `KISMİ` | 0 | 6 | — | Koru / Düzelt / Yaz |
| UX-02 | Global Files + domain File Manager; kaynaklar saklanmaz | `ÇALIŞIYOR` | 0 | 0 | — | Koru / Yaz |
| UX-04 | Dil, tema, marka ve giriş ekranı | `KISMİ` | 0 | 4 | — | Düzelt |
| UX-05 | Arama, filtre, sıralama, sayfalama ve toplu eylemler | `KISMİ` | 0 | 3 | — | Koru / Düzelt |
| UX-06 | İş ilerlemesi, güvenli yeniden deneme ve gerçek durum | `KISMİ` | 0 | 4 | — | Koru / Düzelt / Yaz |
| WEB-01 | Domain ekleme ve amaca göre site oluşturma sihirbazı | `KISMİ` | 2 | 5 | T803 | Koru / Düzelt |
| WEB-02 | Subdomain ve ayrı document root | `ÇALIŞIYOR` | 0 | 0 | — | Koru |
| WEB-03 | Domain alias (ek alan adı; web/mail/DNS ve yönlendirme tercihleri) | `ÇALIŞIYOR` | 0 | 0 | — | Koru / Düzelt |
| WEB-04 | Hosting, forwarding ve hosting olmadan domain davranışı | `ÇALIŞIYOR` | 0 | 0 | — | Koru |
| WEB-05 | Tercih edilen domain, HTTP→HTTPS ve yönlendirmeler | `ÇALIŞIYOR` | 0 | 0 | — | Koru |
| WEB-06 | Domain askıya alma, kapatma, etkinleştirme ve güvenli silme | `KISMİ` | 0 | 1 | — | Koru |
| WEB-07 | Domain kartı/liste, arama, filtre ve doğru araç grupları | `KISMİ` | 0 | 7 | — | Koru / Düzelt / Yaz |
| WEB-08 | Önizleme, geçici domain ve site açma bağlantıları | `KISMİ` | 0 | 1 | — | Koru |
| WP-01 | WordPress kurma, tarama, bağlama ve admin girişi | `KISMİ` | 0 | 1 | — | Koru / Düzelt |
| WP-02 | WordPress Core, eklenti ve tema yönetimi | `KISMİ` | 0 | 1 | — | Koru / Düzelt |
| WP-03 | Toplu yönetim ve plugin/theme setleri | `KISMİ` | 0 | 1 | — | Koru |
| WP-04 | WordPress klonlama, staging ve veri senkronizasyonu | `KISMİ` | 0 | 1 | — | Koru |
| WP-05 | WordPress yedek/restore, bakım ve arama motoru indeksleme ayarları | `KISMİ` | 0 | 3 | — | Koru / Düzelt |
| WP-06 | Güvenlik denetimi/sıkılaştırma ve zafiyet görünürlüğü | `KISMİ` | 0 | 1 | — | Koru |

---

## 2. Kritik Bulguların Durumu

1. dalga boyunca toplam 6 kritik bulgu kaydı açılmış ve bunlara ilişkin 5 görev kimliği (`T800`, `T801`, `T802`, `T803`, `T804`) oluşturulmuştur. Bu bulguların son durumları aşağıda sunulmuştur:

### T800 (`TLS-01`) — Kiracı (Tenant) İzolasyonu Kontrolü Eksikliği
- **Hata:** `apps/api/src/core-app.js:1138-1205` sertifika yenileme ve sonuç uçlarında (`POST /api/certificates/:id/renew`, `GET /renewal-outcome`, `GET /reload-outcome`) `canAccessDomain(req, domain)` çağırmadığı için müşteri (Customer) hesabı `202 Accepted` ile Owner'a ait sertifikayı yenileyebilmekte ve detaylarını okuyabilmekteydi.
- **Durum:** **DÜZELTİLDİ** (`tasks/done/T800.md`, `docs/gorevler/T800-inceleme.md`).
- **Çözüm:** `apps/api/test/ssl-renewal-wiring.test.js` içine yetkisiz müşteri testi eklendi; `core-app.js` rotalarında sertifika domaini üzerinde `canAccessDomain` denetimi ve yetkisiz erişimde `403 domain_forbidden` zorunlu kılındı.

### T801 (`TLS-01`) — SSL Sertifikalı Sitelerin Silinememesi
- **Hata:** Bir web sitesinde SSL sertifikası tanımlıyken, site silme planında `certificates_present` engeli sertifika emeklilik adımı tarafından otomatik çözülmediği için `hardBlockers: ["certificates_present"]` ile silme butonu kilitli kalmaktaydı.
- **Durum:** **DÜZELTİLDİ** (`tasks/done/T801.md`, `docs/gorevler/T801-inceleme.md`).
- **Çözüm:** `apps/api/src/website-removal-plan.js` içindeki `ORCHESTRATABLE_WEBSITE_IMPACT_BLOCKERS` kümesine `certificates_present` eklendi; site silme sürecinde bağlı sertifikalar otomatik olarak güvenli emeklilik (`retire`) adımına dahil edildi.

### T802 (`BAK-08`) — Panelde Restic Yedek Deposu Başlatma Arayüzü Eksikliği
- **Hata:** Sunucuda henüz tanımlı bir Restic deposu yokken panel arayüzünde depo ekleme/başlatma formu bulunmadığı için kullanıcı `Yedek deposu yok` ekranında kilitli kalmaktaydı.
- **Durum:** **ENGELLENDİ / NORMAL OLARAK 1. DALGA SONUNA BIRAKILDI** (`tasks/blocked/T802.md`).
- **Açıklama:** Senior incelemesi sonucunda bu durumun bir güvenlik/çökme açığı olmadığı, arka uç API'nin (`POST /api/panel/backups/repositories`) eksiksiz çalıştığı, ön yüz eksikliğinin 1. dalga kararı gereği `NORMAL` sınıfında kalması ve 1. dalga sonunda İNSAN tarafından önceliklendirilmesi kararlaştırılmıştır.

### T803 (`WEB-01`, `ROL-03`) — Bayi Site Tahsisi Kilidi ve Silmede `domain_removal_not_ready`
- **Hata:**
  1. Bayi `/customers` ekranında `Site tahsis et` modalı `servers` koleksiyonu kapalı olduğundan kalıcı olarak kilitli kalmaktaydı ve form gönderiminde payload anahtarları uyumsuzdu.
  2. Sihirbazla oluşturulan sitelerin silinmesi `001:domain_removal` adımında `domain_removal_not_ready` (`dns_zone_parent_ds_unverifiable`) ile bloke olmaktaydı.
- **Durum:** **DÜZELTİLDİ** (`tasks/done/T803.md`, `docs/gorevler/T803-inceleme.md`).
- **Çözüm:** `apps/web/src/workspace/ResellerCustomersPage.jsx` payload alanları normalize edildi, `workspace-resources.js` rota kaynakları düzeltildi ve `apps/api/src/website-removal-runtime.js` ile domain silme planı bağımsızlaştırıldı.

### T804 (`ROL-03`) — Bayi Müşteri Site Tahsisinde `customerLookup` 403 Hatası
- **Hata:** Bayi oturumuyla `POST /api/panel/sites/hosted/create-preview` çağrıldığında `management-app.js` içinde `userAdminStore` değişkeninin hatalı destructure edilmesi sonucu `options.userAdminStore` `undefined` kalmakta ve `tenant-boundary.js` isteği `403 tenant_boundary_forbidden` (`"Site allocation requires customer verification."`) ile reddetmekteydi; ayrıca 0 siteli bayide sunucu listesi boş gelmekteydi.
- **Durum:** **DÜZELTİLDİ** (`tasks/done/T804.md`, `docs/gorevler/T804-inceleme.md`).
- **Çözüm:** `management-app.js` içine `options.userAdminStore` açıkça enjekte edildi ve `site-resource-boundary.js:214` sunucu listesi filtreleme mantığı yetkili bayilere yerel sunucuyu dönecek şekilde düzeltildi.

---

## 3. En Sık Tekrar Eden NORMAL Hata Kalıpları

124 rapordaki toplam 237 normal bulgu satırı için aşağıdaki temalar derlenmiştir. Temalar arasında örtüşme olabilir; satır bazında tema eşleştirmesi bulunmadığı için yüzdesel dağılım veya sıklık sıralaması verilmez. WEB-01'deki bir KOZMETİK satır NORMAL toplamına dahildir.

### 1. Plesk Eşdeğerliği ve UI Eylem/Form Kapsamı Eksiklikleri
- **Kalıp:** Arka uçta API veya servis yeteneği kısmen bulunsa bile ön yüzde son kullanıcının işlemi başlatabileceği modal, buton veya ayar girişinin olmaması.
- **Örnekler:**
  - `BAK-02`: Yedek alma modalında dosya, e-posta veya veritabanı kapsam seçimi yok (yalnızca geri yüklemede var).
  - `BAK-05`: Uzak yedek depolama (S3, B2, SFTP) ekleme sihirbazının panelde olmaması (yalnızca API'de var).
  - `BAK-06`: Yerel bilgisayara yedek arşivi indirme (`download`) veya dışarıdan arşiv yükleme (`upload`) butonlarının olmaması.
  - `RUN-02`: PHP havuz ayarları (`pm.max_children`, `memory_limit`) ve php.ini direktiflerinin arayüzden düzenlenememesi.
  - `API-02`, `API-03`: Plesk CLI provisioning ve Event Handler (olay tetikleyici) arayüzlerinin bulunmaması.

### 2. Durum Güncelleme ve Reaktivite / Stale State Sorunları
- **Kalıp:** Bir asenkron iş (yedekleme, geri alma, silme, oluşturma, DNS güncelleme) bittiğinde arayüzün (özet kartları, tablolar, rozetler) otomatik `refresh` yapmaması; sayfa yenilenene kadar eski veriyi göstermesi.
- **Örnekler:**
  - `BAK-08`: Otomatik geri alma (`rolled_back`) veya `failed` sonrasında `Son geri yükleme sonucu` kartının ve snapshot tablosunun yenilenmemesi.
  - `DB-01`, `DB-02`: DB kullanıcısı silindiğinde veya yetki değiştirildiğinde liste ve kota sayacının otomatik güncellenmemesi.
  - `TLS-06`: SSL yenilendikten sonra sertifika parmak izi ve geçerlilik rozetlerinin sayfayı F5 yapmadan güncellenmemesi.

### 3. İstemci Doğrulama Eksikliği ve Hata Mesajı Maskeleme
- **Kalıp:** Form girdilerinin (alan adı sözdizimi, UUID formatı, dosya boyutu, port çakışması, şifre eşleşmesi) istemci tarafında form submit edilmeden önce doğrulanmaması; arka uçtan gelen 400/409 yanıtlarının ise spesifik neden yerine genel fallback metinleriyle maskelenmesi.
- **Örnekler:**
  - `WEB-01`: Sihirbaz Adım 1'de geçersiz alan adına izin verilmesi; Adım 3'te `409 domain_conflict` hatasının `"Önizleme doğrulanamadı..."` genel metniyle gizlenmesi.
  - `DEV-01`, `DEV-02`: Git repo URL'si hatalı olduğunda veya SSH anahtarı eksik olduğunda net hata kodu yerine genel bağlantı hatası verilmesi.
  - `BAK-06`: Seçici geri yüklemede boş seçim yapıldığında genel fallback hatası dönmesi.

### 4. Alt Alan Adı (Subdomain) Dosya Kökü ve Dizin Ayrımı Tutarsızlıkları
- **Kalıp:** `AGENTS.md` 24 Ekim kuralı gereği subdomain'lerin ana domain çalışma alanında (`<domain-root>/subdomains/<subdomain>`) olması gerekirken, arayüz metni ile fiziksel disk yapısının farklı davranması.
- **Örnekler:**
  - `WEB-01`: UI'da `/var/www/vhosts/<domain>/subdomains/<sub>` yazarken fiziksel sunucuda ayrı `/var/www/yunpanel/apps/<id>/current` açılması.
  - `DOS-05`: Subdomain dosya yöneticisinde ana domain köküne üst dizin gezintisi ve izin sınırlarının netleşmemesi.

### 5. `AGENTS.md` Madde 6 Kural İhlalleri (Kozmetik / Buzzword / Ham Hata Kodları)
- **Kalıp:** Kullanıcı arayüzünde parantez içi İngilizce buzzword, ham değişken veya teknik hata kodlarının yer alması.
- **Örnekler:**
  - `BAK-08`: `(Rollback)`, `(rclone)`, `(health_check_failed)`.
  - `WEB-01`: Sonuç ekranında `application_metadata`, `website_metadata`, `primary_domain_metadata` ham snake_case anahtarlarının görünmesi.
  - `DKR-01`: Docker arayüzünde `(outputDir)`, `(healthPath)` ham alan isimleri.

### 6. Kiracı (Tenant) & Rol Görünüm / Bildirim Filtreleri Tutarsızlığı
- **Kalıp:** Bildirimlerin, sistem olaylarının veya kaynak listelerinin rollere (Owner / Reseller / Customer) göre doğru filtrelenmemesi.
- **Örnekler:**
  - `TLS-06`: `checkCertificateExpirations()` bildirim üretirken `websiteId` geçirmediği için sertifika süre dolum bildirimlerinin yalnızca Owner'a gitmesi, site sahibine (Customer) düşmemesi.
  - `HSP-03`: Owner ekranında müşteri veya bayi parolasını sıfırlama butonunun eksik olması.

---

## 4. "Panelde Olmayan" Listesinin Birleşimi (3. Dalga Girdisi)

124 raporda belirtilen ve mevcut YunPanel sürümünde yer almayıp Plesk eşdeğerliği için 3. dalga geliştirme yol haritasına girdi oluşturacak maddelerin modüler birleşimi:

### API & Otomasyon (`API`)
- **`API-01`:** Tam REST eşdeğerliği ayrı kapsamdır; bu senaryo anahtar yaşam döngüsünü ve otomasyon erişim sınırını ölçer.
- **`API-02`:** - Klasik Plesk XML API agent endpoint'i (`/enterprise/control/agent.php`). - Plesk XML paketlerini (`<packet>`) doğrudan kabul eden XML-RPC parser veya XML-to-REST adapter/gateway.
- **`API-03`:** Plesk Event Manager / Event Handlers arayüzü ve CLI üzerinden alan adı/site provisioning araçları (`plesk bin domain`).
- **`API-04`:** - Harici portaller (WHMCS/fatura) için tek kullanımlık Plesk CLI/REST oturum açma API'si (`POST /api/v2/cli/session` veya `/api/v2/sessions`). - Yönetici veya bayinin müşteri paneline kimlik taklit ederek geçiş yapması (login-as / context switch).

### Yedekleme & Kurtarma (Backup) (`BAK`)
- **`BAK-01`:** - Tools & Settings altında tek tıkla tüm sunucuyu (server config + all accounts) tek arşivde yedekleme arayüzü - Müşteri veya Bayi paneli altında tüm aboneliğe/müşteriye ait siteleri tek tıkla topluca yedekleme arayüzü
- **`BAK-02`:** - Yedek alırken "Yalnızca yapılandırma" vs "Tüm içerik" seçimi - Yedek alırken dosya, veritabanı ve e-posta bileşenlerini bağımsız olarak hariç tutma / dahil etme seçimi (yalnızca geri yükleme modalında seçici kapsam mevcut)
- **`BAK-03`:** Plesk'te "Backup Type: Full / Incremental" radyo buton seçimi yer alır; YunPanel Restic'in içerik tabanlı blok deduplication mekanizmasına dayanarak her yedeği otomatik artımlı depolar.
- **`BAK-04`:** Plesk'teki gibi kullanıcı tanımlı hariç tutma maskeleri / özel dosya exclusion girdi alanı panel arayüzünde bulunmuyor; varsayılan sistem dışlama kalıpları (.git, node_modules/.cache, tmp) otomatik uygulanıyor.
- **`BAK-05`:** Plesk'te yer alan kullanıcı dostu uzak depolama yapılandırma sihirbazı (Remote Storage Settings / FTP / S3 form arayüzü) ve geleneksel FTP depolama seçeneği; YunPanel'de uzak hedefler API üzerinden rclone (S3, B2, SFTP, WebDAV) olarak tanımlanır.
- **`BAK-06`:** Plesk'te yer alan yedek arşivini (.tar/.zip) yerel bilgisayara indirme ("Download") ve bilgisayardan yükleme ("Upload") özellikleri; YunPanel tüm yedekleri doğrudan Restic reposunda blok/chunk olarak depolar.
- **`BAK-08`:** 1. **Restic Yedek Deposu Oluşturma / Başlatma / Silme Arayüzü Yok:** Arka uçta `GET/POST/DELETE /api/panel/backups/repositories` ve `POST /api/panel/backups/repositories/:id/init` uç noktaları (`apps/api/src/backup-repository-http.js`) mevcut olmasına rağmen, panel arayüzünde (`Araçlar ve Ayarlar` veya `Yedekleme ve Geri Yükleme`) yeni Restic deposu tanımlayacak veya başlatacak hiçbir ekran/modal …

### Veritabanı (Database) (`DB`)
- **`DB-01`:** 1. **Site bazlı veritabanı tablosunda (`/websites/:id/databases`) boyut bilgisi:** Plesk'te bir sitenin `Databases` ekranında her veritabanının disk kullanımı ve tablo sayısı doğrudan görünürken, YunPanel'de `/websites/:id/databases` tablosunda `Boyut` sütunu yoktur (yalnız Owner'a açık olan global `/databases` tablosunda vardır). 2. **Siteye bağlı veritabanını başka bir siteye taşıma veya yalnız …
- **`DB-02`:** - **Rol Seçimi ve Tekil Grant (SQL İzinleri) Düzenleme Arayüzü:** Plesk'teki *Read and Write*, *Read Only*, *Write Only* rol seçimi veya tekil SQL yetkilerini (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`, `INDEX`, `DROP`, `REFERENCES`, `CREATE TEMPORARY TABLES`, `LOCK TABLES`, `EXECUTE`) açıp kapatma ekranı ön yüzde bulunmuyor (arka uç API'si `PATCH .../grants` hazır, UI bağlantısı y…
- **`DB-03`:** - **Veritabanı kullanıcısı bazında uzak erişim politikası seçimi:** Plesk'teki *"Allow local connections only"*, *"Allow remote connections from any host (`%`)"* ve *"Allow remote connections from specific IP addresses"* seçeneklerinin karşılığı ne **Veritabanı oluştur** modalında ne de **Yönet** / **Bağlantı bilgileri** modallarında mevcuttur. - **İzinli kaynak (Allowed Hosts / IP / CIDR) listesi…
- **`DB-06`:** Plesk'te her veritabanı kartında bulunan "Check and Repair" (veritabanı tablolarını denetle ve onar / `CHECK TABLE`, `REPAIR TABLE`) butonu ve ilgili onarım endpoint'i.

### Geliştirici Araçları & Git (`DEV`)
- **`DEV-01`:** - Yerel Git repository oluşturma ve doğrudan sunucuya push ile dağıtım (Plesk Local Git repo). - PHP ve mevcut sitelerde sonradan Git repository bağlama / değiştirme arayüzü.
- **`DEV-02`:** - Plesk Git eşdeğeri dal değiştirme (Switch branch) ve depodaki remote dalları listeleme arayüzü. - Hedef dağıtım dizini (Deployment directory / Target path) değiştirme arayüzü. - Dağıtım modunu (Automatic vs Manual deployment) arayüzden seçme / webhook devre dışı bırakma seçeneği.
- **`DEV-03`:** Plesk Git uzantısındaki SSH Deploy Key oluşturma/kopyalama, Dağıtım Sonrası Ek Komutlar (Additional deployment actions) ve Webhook URL'inde uygulama UUID/Secret yönetimi bulunmamaktadır.
- **`DEV-04`:** Plesk Obsidian Laravel Toolkit eşdeğerliği: hazır Laravel kurulum sihirbazı (composer create-project, env/app key üretimi), Git deposundan Laravel kurma ve mevcut sitelerdeki Laravel uygulamalarını tarayıp bağlama (Scan / Attach).
- **`DEV-05`:** - Plesk Laravel Toolkit eşdeğeri `.env` ortam dosyası ve çevre değişkenleri editörü. - Arayüzden tek tıkla veya parametreyle Artisan komutu koşturma (Run Artisan Command / migrate / cache:clear). - Serbest Composer bağımlılık yönetimi (`composer install`, `update`, `require`) ve Node/npm komut çalıştırma arayüzü.
- **`DEV-06`:** - Plesk Laravel Toolkit eşdeğeri otomatik `artisan schedule:run` entegrasyonu ve Kernel console görev listeleme (Scheduled Tasks). - Laravel uygulama günlükleri (`storage/logs/laravel.log`) okuma, log seviyesi (error/info/warning) filtreleme ve log temizleme arayüzü. - Hazır Laravel dağıtım senaryoları (Deployment Script / composer install, artisan migrate, maintenance mode toggle) otomasyonu.

### Docker & Container (`DKR`)
- **`DKR-01`:** Plesk Docker uzantısında yer alan bağımsız "Local Images" (yerel imajları boyut/tag ile listeleme), doğrudan `docker pull` ve tekil imaj silme (`docker rmi`) ekranı panelde bulunmaz; imajlar yalnızca Compose stack yaşam döngüsüyle dolaylı yönetilir.
- **`DKR-02`:** Plesk'te bulunan doğrudan tekil container üzerinde "Recreate (yeniden oluştur)" butonu ayrı bir aksiyon olarak yer almaz, yerine restart veya compose güncelleme kullanılır.
- **`DKR-03`:** Plesk'te port/env/volume/restart için ayrı GUI form satırı ekleme butonları bulunurken; YunPanel'de bu ayarlar Compose YAML editörü ve şifreli Compose Environment paneli üzerinden yönetilmektedir.
- **`DKR-04`:** Plesk eşdeğeri container terminal / interaktif web shell (`docker exec` konsolu).
- **`DKR-06`:** Plesk Docker eklentisinde konteyner yapılandırması (Compose YAML, port, env, etiketler) ile kalıcı veriler (volume data) bağımsız olarak yedeklenebilirken; YunPanel'de Docker depolama manifesti incelenebilmekte fakat konteyner yapılandırması ile volume verisini ayrı ayrı seçerek yedekleyen/geri yükleyen bağımsız bir Docker yedekleme aracı bulunmamaktadır.

### DNS & Alan Adı Yönetimi (`DNS`)
- **`DNS-02`:** - Plesk eşdeğeri Genel DNS Zone Şablonu (DNS Zone Template) kayıt yönetim ekranı (yalnızca backend API mevcut) - Şablon değişikliklerini tüm mevcut alan adlarının zone'larına topluca uygulama (Apply DNS Template Changes)
- **`DNS-03`:** Domain bazında Master DNS rolünden Secondary (Slave) rolüne dönüştürme ("Switch to Secondary" / "Switch to Primary"), Secondary modunda Master IP tanımlama ve domain bazında DNS servisini devre dışı bırakma ("Disable DNS Service" / "Switch DNS to Off") arayüzü ve mutation endpoint'i.
- **`DNS-04`:** UI üzerinden Plesk eşdeğeri KSK/ZSK Rollover (Anahtar yenileme) başlatma ve aşama takibi.
- **`DNS-05`:** Plesk eşdeğeri her domain için ayrı Zone Transfer ACL (Transfer Restrictions) tanımlama sekmesi ve harici sunucudan zone replike eden Slave/Secondary Zone yönetim arayüzü.
- **`DNS-06`:** Plesk eşdeğeri Harici DNS Eklentileri (Amazon Route 53, DigitalOcean DNS, Cloudflare DNS arayüzü) ve görsel DNS Yayılım / Tanılama (Propagation Check & dig +trace) aracı.

### Dosya Yöneticisi & FTP (`DOS`)
- **`DOS-04`:** Doğrudan klasör yükleme (`webkitdirectory` veya klasör ağacı sürükleme) panelde bulunmuyor; klasör için önce 'Yeni Klasör' açılıp içine dosya yükleniyor veya ZIP yüklenip 'Arşivi Çıkart' kullanılıyor.
- **`DOS-05`:** Plesk Dosya Yöneticisi'ndeki "URL'den İçe Aktar" (Import via URL) aracı, uzak adresten sunucuya dosya indirme akışı ve buna eşlik eden SSRF koruması (127.0.0.1, 169.254.169.254, dahili IP engeli).
- **`DOS-06`:** Plesk'te kopyalama ve taşıma sırasında hedefte aynı adlı dosya varsa interaktif "Üzerine yazılsın mı?" (Replace/Skip/Cancel) modalı sorulur. YunPanel'de taşıma çakışmada 409 hatasıyla engellenir, kopyalama doğrudan yazar.
- **`DOS-09`:** Dosya içerik araması (Plesk eşdeğeri recursive content/grep search); arama kutusu yalnızca geçerli dizindeki dosya adlarını filtreler.
- **`DOS-10`:** Plesk eşdeğeri ek FTP/FTPS hesabı oluşturma, kullanıcı bazlı dizin kapsamı (chroot docroot) ve FTP hard quota tanımlama özellikleri panel arayüzünde ve API'de yer almıyor; sunucuda da FTP daemon kurulu değil (yalnızca port 22 internal-sftp mevcut).
- **`DOS-11`:** Plesk'teki gibi web arayüzünden doğrudan SSH anahtarı ekleme/yükleme (SSH Keys UI) ve SSH/SFTP kullanıcı parolası belirleme formları panelde bulunmuyor (yalnızca arka uç API seviyesinde mevcut).

### Eklentiler & Katalog (`EKL`)
- **`EKL-01`:** - Plesk Application Vault / APS Katalogu: kurulum öncesi sürüm seçimi (v5/v6), ticari uygulama lisansı yönetimi ve otomatik güncelleme motoru. - WordPress harici CMS (Joomla, Drupal vb.) için yerel vhost dizinine PHP ve MySQL DB otomatik kurulumu (yalnız Docker compose destekli).
- **`EKL-02`:** - Plesk Extensions Marketplace / Catalog API ve harici uzantı (.zip/.tar) yükleme/yönetme motoru. - Kurulu eklenti ve servisleri paket bağımlılıklarıyla sistemden tamamen kaldıran (purge/uninstall) mekanizma.

### E-posta & Posta Kutuları (`EML`)
- **`EML-03`:** - E-posta hesabı bazında Otomatik Yanıtlayıcı (Autoresponder / Out of Office / Vacation) açma/kapatma - Otomatik yanıt konusu (subject), mesaj gövdesi (body) ve formatı (düz metin/HTML) belirleme - Başlangıç ve bitiş tarihi (start/end date) tanımlama ve zamanlı otomatik devre dışı bırakma - Fiziksel Dovecot Sieve `vacation` betiği oluşturma ve teslimat zamanı tetikleme
- **`EML-04`:** - E-posta hesabı veya alan adı bazında Spam Filtresi açma/kapatma ve spam puanı/eşiği belirleme - Spam e-postalar için konu başlığı değiştirme ([SPAM]), karantinaya alma veya silme aksiyonları - Beyaz liste (Allowlist / Whitelist) ve kara liste (Denylist / Blacklist) e-posta/alan adı listesi yönetimi - Antivirüs politikası (ClamAV ile gelen/giden e-posta tarama) etkinleştirme arayüzü ve backend ba…
- **`EML-05`:** - Alan adı bazında Posta Listeleri (Mailing Lists / Mailman) sekmesi ve yönetimi - Posta listesi oluşturma (liste adı, yönetici e-posta, parola) ve silme - Liste aboneleri / üyeleri yönetimi (üye ekleme, çıkarma, liste görünümü) - GNU Mailman web yönetim arayüzü entegrasyonu ve OS/eklenti matrisi
- **`EML-06`:** - Alan adı bazında bulunmayan alıcı politikası (What to do with mail for non-existent users: Bounce / Forward to catch-all address / Reject) - Harici mail seçildiğinde DNS MX kayıtları entegrasyonu (Google Workspace, Microsoft 365 hazır MX şablonları)
- **`EML-07`:** - E-posta istemcileri için otomatik mobil profil (.mobileconfig) indirme veya e-posta ile kurulum talimatı gönderme - Webmail'e panelden tek tıkla otomatik oturum açma (Roundcube SSO / login-as)
- **`EML-08`:** - Plesk Tools & Settings / Mail altındaki gibi SMTP/IMAP dinleme portlarını panelden değiştirme - POP3 (110/995) protokolünü açma/kapatma (kurulum bileşeni gereği dovecot-pop3d kurulu değil) - Minimum TLS sürümü (TLS 1.2 / TLS 1.3) ve SSL/TLS cipher suite politikası seçici arayüzü
- **`EML-09`:** - Canlı sunucuda çalışan Smarthost giden relay yönetim motoru - UI üzerinde SPF/DMARC kayıtlarını doğrudan düzenleme sihirbazı (DNS zone üzerinden yapılıyor)
- **`EML-10`:** - Plesk Outbound Mail Control: Alan adı veya posta kutusu bazında saatlik/günlük giden posta gönderim limitleri - Posta kuyruğunu zorla gönderme/boşaltma (Flush Queue / `postqueue -f`) ve kuyruktan posta silme (Delete / `postsuper -d`)
- **`EML-11`:** - Postfix `tls_server_sni_maps` ile alan adı bazlı ayrı TLS sertifikası sunma - Dovecot `local_name <hostname> { ssl_cert = ... ssl_key = ... }` SNI desteği - Çoklu alan adı için farklı SSL sertifikalarını mail servisine ayrı ayrı atama arayüzü

### Hosting, Müşteri & Bayi (Reseller) (`HSP`)
- **`HSP-01`:** - Bayi (`/customers` — `ResellerCustomersPage.jsx`) ve Owner (`/customers` — `OwnerHostingAccountsPage.jsx`) ekranlarında bağlı kaynağı olmayan müşteriyi tek adımda silen `Sil` / `Hesabı sil` butonu ve ön yüz istemci bağlantısı (`DELETE /api/panel/users/hosting/accounts/:id/login` arka uçta hazır olmasına rağmen arayüze bağlanmamış). - Owner'ın `/customers` (`OwnerHostingAccountsPage.jsx` / `Hosti…
- **`HSP-02`:** - **Bayi Hesabını Tek Adımda Silme (`/resellers` üzerinden):** Plesk'te bir bayi (Reseller) hesabı silindiğinde giriş hesabı ve profili tek işlemle kaldırılabilirken; YunPanel `/resellers` ekranında yalnızca `Profili kaldır` (profil bağını koparma) işlemi vardır ve giriş hesabını silmek için ayrıca `/settings/users` ekranına gidilmesi gerekmektedir. - **Bayi Parola Sıfırlama ve Giriş Bilgisi Düzen…
- **`HSP-03`:** - Müşteri ve bayi hesapları için **İletişim adı (`Contact name`)**, **Ayrı iletişim e-postası (`Email address`)**, **Şirket (`Company`)**, **Telefon (`Phone`)**, **Adres / Şehir / Ülke (`Address / City / Country`)** ve **Yönetici açıklaması (`Description / Notes`)** alanları (hem oluşturma hem düzenleme modallarında ve veritabanı şemasında yok). - Owner için `/customers` ve `/resellers` ekranların…
- **`HSP-04`:** Plesk'teki ayrı "Abonelikler" (Subscriptions) listesi/sekmesi panelde yer almamaktadır; YunPanel MVP mimarisinde siteler doğrudan müşteriye bağlanır, paket/abonelik nesneleri PLN-01..PLN-07 kapsamında sonraki faza ertelenmiştir.

### Taşıma & Migrasyon (`MIG`)
- **`MIG-01`:** - Plesk Migrator web arayüzü, sihirbazı ve dosya yükleme arayüzü. - Plesk Müşteri, Bayi, Hizmet Paketi ve Abonelik nesnelerinin ayrıştırılması ve içe aktarımı. - Önizlenen kaynakları sisteme kalıcı olarak kuran `/api/importer/plesk/import` yürütme rotası. - Canlı Plesk sunucusundan SSH/RPC Migration Agent ile uzaktan doğrudan veri çekme yeteneği.
- **`MIG-02`:** - cPanel / DirectAdmin içe aktarma ve geçiş sihirbazı kullanıcı arayüzü. - cPanel cpmove / full backup arşiv ayrıştırıcı ve önizleme rotası (`/api/importer/cpanel`). - DirectAdmin backup arşiv ayrıştırıcı ve önizleme rotası (`/api/importer/directadmin`). - Canlı uzak cPanel/WHM ve DirectAdmin sunucularından SSH/API ile uzaktan aktarma yeteneği.
- **`MIG-03`:** - Plesk Migrator IP eşleme tablosu (IP remapping) ve DNS A kayıtları ile vhost dinleme IP'lerinin otomatik dönüştürülmesi. - Sistem Unix kullanıcısı (systemUser) ve FTP kullanıcı hesaplarının ayrıştırılması ve hedef Linux ortamına eşlenmesi. - Seçici bileşen aktarımı (selective component migration) ve çakışma durumunda veritabanı/kullanıcı yeniden adlandırma eşlemesi.
- **`MIG-04`:** - Hedef sunucuda disk alanı, RAM ve PHP sürüm paketlerini denetleyen ön kontrol rotası. - Taşıma sonrası kaynak sunucudaki güncel değişiklikleri aktaran tekrar senkronizasyon (Re-sync) API/motoru. - Taşınan sitelerin HTTP yanıtı, SSL ve DB bağlantılarını test eden otomatik doğrulama rotası. - Ön yüzde ön kontroller, tekrar senkronizasyon ve doğrulama sonuçları arayüz bileşenleri.
- **`MIG-05`:** - Plesk Site Import aracı ve uzak FTP/SSH üzerinden tekil site içeriğini çeken API rotası. - Plesk Mail Import aracı ve harici IMAP sunucusundan posta kutusu kopyalayan senkronizasyon rotası. - Hedef sunucuda mevcut site veya posta kutusu çakışmalarında veri kaybı uyarısı ve onay kısıtı. - Ön yüzde Tekil Site/Mail Import ve Veri Kaybı Riski Onayı arayüz kontrolleri.
- **`MIG-06`:** - Canlı işletim sistemi yükseltme (Ubuntu 20->22->24 dist-upgrade) API ve iş motoru. - Panel güncellemesi başarısızlığında veya istendiğinde çalışan versiyon geri alma (Rollback) API rotası. - Plesk repair all eşdeğeri tüm servisleri (web, mail, dns, db) tarayıp onaran self-repair aracı. - Ön yüzde OS migration, versiyon rollback ve kurtarma yönetim bileşenleri.

### İzleme & Sistem Telemetrisi (`MON`)
- **`MON-01`:** - Plesk Advanced Monitoring tarzı sunucu tarafı kalıcı zaman serisi (24 saat, 7 gün, 30 gün) ve aralık seçici - Servis/proses bazlı (Nginx, PHP, MariaDB) CPU/RAM tüketim döküm grafiği ve Ağ/Disk I/O transfer hızı grafikleri
- **`MON-02`:** - Plesk "Tools & Settings -> Notifications" eşdeğeri olay bazlı (SSL, Disk, Yedek vb.) e-posta ve webhook alıcı yapılandırma ekranı - CPU/RAM/Disk uyarı ve kritik eşik yüzdelerinin arayüzden düzenlenebildiği form
- **`MON-03`:** - Tarih aralığı filtresi (günlük/aylık trafik tablosu) ve protokol kırılımlı (HTTP/FTP/Mail) bant genişliği kullanım raporları - Awstats / Webalizer alternatif istatistik sağlayıcı seçimi ve webstat dizini parola koruma ayarları
- **`MON-04`:** - Plesk'teki site bazlı "Log Rotation" (günlük döndürme frekansı, boyut limiti, sıkıştırma/gzip ve saklama adedi) UI ayarları
- **`MON-05`:** - Plesk'teki Tools & Settings / Extensions altında yer alan "Watchdog" eklentisi (Disk alarm eşikleri, servis yeniden başlatma kuralı ve e-posta bildirim frekansı yapılandırma arayüzü)

### Roller & Erişim Kontrolü (RBAC) (`ROL`)
- **`ROL-01`:** - Owner'ın `/customers` (`OwnerHostingAccountsPage`) ekranından müşteri kotalarını (`maxWebsites`, `maxDiskMb`, `maxTrafficMb`, `maxDatabases`) ve müşteri giriş bilgilerini (`username` / `password`) doğrudan düzenleme özelliği (backend API'de `PATCH /api/panel/users/hosting/accounts/:id/quotas` ve `PATCH .../login` mevcut ve Reseller panelinde açık olmasına rağmen Owner'ın `HostingProfileDialog` b…
- **`ROL-03`:** - **Bayi ekranından müşteri silme butonu (`deleteCustomerLogin`):** Arka uçta `DELETE /api/panel/users/hosting/accounts/:id/login` bayi yetkisine açık olduğu halde `ResellerCustomersPage.jsx` içinde müşteri silme aksiyonu bulunmuyor. - **Bayi için müşteri bazlı site filtreleme (`/websites?customer=<id>`):** Owner için çalışan müşteri filtresi `WebsitesPage.jsx:24` (`isOwner`) kısıtı nedeniyle bayi…
- **`ROL-04`:** - **Üst/yan barda kalıcı aktif site/abonelik seçicisi (Global Site / Subscription Switcher):** Plesk Müşteri Panelinde üst veya sol barda yer alan ve müşterinin hangi abonelik/site bağlamında çalıştığını gösterip tek tıkla başka bir siteye geçmesini sağlayan kalıcı açılır seçici (context switcher) YunPanel'de bulunmuyor; site değişimi için `/websites` listesine veya global araç giriş sayfasındaki …
- **`ROL-05`:** - **Müşteri ve Bayi Alt Kullanıcıları (Plesk "Users" / "Additional Users"):** Plesk'te bir müşteri (Customer) veya bayi (Reseller), kendi aboneliği/siteleri altında ek panel kullanıcıları (ör. Webmaster, Application Developer, Accountant, Mail User) oluşturabilirken; YunPanel'de kullanıcı yönetimi (`/settings/users`, `/api/panel/users`) yalnızca `Owner` rolüne açıktır (`Reseller` ve `Customer` içi…
- **`ROL-06`:** - **Mevcut yönetici/kullanıcı parolasını `/settings/users` arayüzünden sıfırlama:** Arka uç `PATCH /api/users/:id` içinde `password` alanını desteklediği halde `UsersPage.jsx` (`Kullanıcıyı düzenle` modalı) içinde parola değiştirme alanı bulunmamaktadır. - **Kısıtlı yönetici yetki matrisi (Plesk Restricted Mode / Custom Administrative Permissions):** Plesk'te ek yönetici hesaplarına sunucu ayarlar…
- **`ROL-07`:** - **Kişisel ve Kurumsal İletişim Bilgileri (`My Profile` / `Contact Details`):** Plesk'te kullanıcının kendi profilinden güncelleyebildiği **Ad Soyad (`Contact name`)**, **E-posta (`Email address`)**, **Telefon (`Phone number`)**, **Şirket (`Company name`)**, **Adres / Şehir / Ülke** ve **Arayüz Dili / Saat Dilimi** alanları YunPanel `Hesabım` (`AccountDialog.jsx`) ekranında ve arka uç `users` şem…

### Çalışma Zamanı (PHP, Node, Python) (`RUN`)
- **`RUN-01`:** Plesk'te olan arayüz içi docroot klasör gezgini/seçicisi (YunPanel'de alt dizinin önceden oluşturulması gerekir).
- **`RUN-02`:** - **PHP Handler seçimi:** Plesk'teki `run PHP as` (`FPM application served by Nginx`, `FPM application served by Apache`, `FastCGI` vb.) seçimi yok; yalnızca sabit `Çalışma biçimi: PHP-FPM` metni bulunuyor. - **Temel `php.ini` ayarları ve serbest direktif editörü:** Plesk `PHP Settings` ekranında bulunan `upload_max_filesize`, `post_max_size`, `max_input_time`, `max_input_vars`, `display_errors`, …
- **`RUN-03`:** - Serbest metin "Ek Nginx direktifleri" (Additional nginx directives textarea) alanı - Apache web sunucusu ve Apache ek direktifleri (YunPanel doğrudan Nginx kullanır)
- **`RUN-04`:** - Plesk eşdeğeri Parola Korumalı Dizinler (Password-Protected Directories / HTTP Basic Auth) kullanıcı yönetim arayüzü - Plesk eşdeğeri uzantı -> MIME türü eşleme editörü (MIME Types) - Plesk eşdeğeri Directory Browsing / Autoindex (dizin listeleme) açma/kapatma seçeneği
- **`RUN-05`:** - Plesk eşdeğeri Node.js sürüm (Node 20/22/24) seçici arayüzü (varsayılan Node 24 sabit). - Site detayında Node.js sürümü, App Root ve Startup Dosyası değiştirme formu (salt-okunur). - Git reposu olmadan yerel dizinden/dosyadan Node.js çalıştırma (yalnızca Git tabanlı `new_node`).
- **`RUN-06`:** Plesk Node.js yönetim ekranındaki bağımsız "NPM Install <paket>" ve package.json scriptlerini arayüzden tek tıkla çalıştıran "Run Script" butonları.
- **`RUN-07`:** Plesk Composer Toolkit eşdeğeri "Composer Install", "Composer Update", "Paket Ekle (Require)", paket listeleme/kaldırma ve yerleşik composer.json düzenleme arayüzü; canlı sunucuda Composer CLI ikilisi önceden kurulu gelmemektedir.
- **`RUN-08`:** - Plesk PHP Settings / Extensions tablosu (modülleri checkbox ile açıp kapatma) - Müşteri veya alan adı bazlı izinli/yasaklı dil eklentileri erişim politikası kuralı

### Güvenlik & Güvenlik Duvarı (`SEC`)
- **`SEC-01`:** Plesk eşdeğeri hazır kural şablonları (predefined service templates), ICMP ping açma/kapama anahtarı ve görsel kural öncelik sıralaması.
- **`SEC-02`:** Plesk IP Address Banning (Fail2ban) eşdeğeri: Jail yönetimi (ssh, nginx, postfix kuralları), Güvenilen IP'ler (Whitelist/Trusted IPs) listesi ve log izleme UI.
- **`SEC-03`:** Plesk Tools & Settings ve domain Web Application Firewall (ModSecurity): WAF modu (On, DetectionOnly, Off), kural seti seçimi (OWASP CRS, Comodo), hazır ön ayarlar (Fast, Balanced, Thorough), kural istisnaları / ID whitelist (rule exclusions).
- **`SEC-04`:** Global Güvenlik Politikası ekranı (Tools & Settings -> Security Policy: oturum boşta kalma süresi, parola karmaşıklığı seçimi, zorunlu 2FA kuralı).

### Sistem Yönetimi & Servisler (`SYS`)
- **`SYS-01`:** - Plesk Tools & Settings -> "IP Addresses" eşdeğeri IP havuzu yönetim arayüzü - IP adresi bazında Shared / Dedicated tür ayrımı ve site/müşteri bazlı IP tahsisi - IP Re-mapping aracı (toplu IP değiştirme / taşıma sihirbazı)
- **`SYS-02`:** Plesk Services Management ekranındaki servis başlangıç modu (Startup Type: Automatic/Manual/Disabled) yapılandırması ve tekil PHP-FPM / PowerDNS servis kontrolleri sistem servisleri panelinde yer almıyor.
- **`SYS-03`:** - Plesk "System Time" eşdeğeri Sistem saati ve tarihi gösterimi, Saat Dilimi (Time Zone) değiştirme ve otomatik NTP zaman senkronizasyonu yapılandırması. - Plesk "Server Settings" eşdeğeri Sunucu Hostname (FQDN) güncelleme arayüzü ve API desteği (mevcut panelde hostname salt okunurdur).
- **`SYS-04`:** Plesk System Updates (tüm OS paketlerinin seçmeli güncellenmesi ve otomatik güvenlik güncelleme takvimi) ve sunucu geneli bileşen ekleme/kaldırma (Add/Remove Components) arayüzü.
- **`SYS-05`:** - Plesk Tools & Settings eşdeğeri Olay Tetikleyicileri (Event Handlers / Olay Yöneticisi) arayüzü - Plesk Repair Kit eşdeğeri merkezi Sistem Onarım Araçları (Self-Repair / Diagnose & Repair) ekranı
- **`SYS-06`:** Görev çıktısı e-posta bildirimi (MAILTO / her çalıştırmada ya da hata anında bildirim) ve site Unix kullanıcısı dışında kullanıcı seçimi.

### SSL/TLS Sertifikaları (`TLS`)
- **`TLS-01`:** - **Aktif sertifika varken sertifika kapsamını (SAN) değiştirerek yeniden sertifika isteme:** Bir alan adı için yalnız kök domain (`ttls01-a2.webrich.news`) ile sertifika alındıktan sonra `/websites/:id/ssl` sekmesinde `www`, `mail`, `webmail` veya `wildcard` kutularını seçip sertifikayı genişleterek yeniden isteme (`re-issue`) seçeneği arayüzde bulunmuyor (`SslRenewalPanel` yalnızca mevcut kapsam…
- **`TLS-02`:** - Plesk SSL It! / Let's Encrypt eşdeğeri olarak arayüzde Wildcard talep ederken DNS-01 sağlayıcı/token seçimi veya harici DNS için manuel `_acme-challenge` TXT prompt doğrulama ekranı. - Yerel PowerDNS üzerinden otomatik `_acme-challenge` TXT kaydı ekleyerek Wildcard sertifika çıkarma desteği. - Aktif sertifikaya sahip bir alan adında sertifika kapsamını genişletme (Reissue Certificate with SANs) …
- **`TLS-03`:** - Plesk SSL/TLS Certificates -> "Add SSL/TLS Certificate" altındaki CSR parametreleri sihirbazı (Country, State, Org, Email vs.). - Web sitesi SSL ekranında dosya yükleme veya PEM yapıştırma (Certificate, Private Key, CA Certificate/Chain) arayüzü. - Alan adı veya sunucu genelinde sertifikaları topluca listeleyen, durumlarını ve bitiş tarihlerini gösteren Sertifika Deposu sayfası.
- **`TLS-04`:** - Plesk Tools & Settings -> SSL/TLS Certificates altındaki "Certificate for securing Plesk" (panelin kendi Nginx vhost sertifikasını atama/değiştirme) arayüzü ve API'si. - Web sitesi SSL arayüzünde aktif veya alternatif sertifikalar arasından seçim yapma dropdown/formu (yalnızca ACME yenileme veya ilk sertifika alma formu mevcut).
- **`TLS-05`:** - Plesk SSL It! / SSL/TLS Certificates altındaki yerleşik "HSTS" (HTTP Strict Transport Security) açma/kapatma, max-age süresi seçimi, includeSubDomains ve Preload onay kutuları (YunPanel'de yalnızca Web Sunucusu ayarlarından özel yanıt başlığı olarak manuel eklenebiliyor). - Plesk Tools & Settings -> "TLS versions and ciphers by default" veya domain bazlı TLS protokol sürümü (TLS 1.2, TLS 1.3) ve…
- **`TLS-06`:** | Özellik | Beklenen yer | Gerçekte ne var | Kaynak | |---|---|---|---| | Gerçek sunulan sertifika (Live TLS Presentation) doğrulama göstergesi | `/websites/:id/ssl` (`SSL/TLS Sertifikaları` sekmesi) | Arka uçta `GET/POST /api/panel/domains/:domainId/certificates/:certificateId/verify-tls` uç noktası var ancak ön yüzde hiç çağrılmıyor ve sunucunun `:443` portunda fiilen sunduğu sertifikanın kayıtl…

### Kullanıcı Deneyimi & Tasarım (`UX`)
- **`UX-01`:** - `/settings/users` (`Kullanıcı ekle`) modalında doğrudan `Müşteri` veya `Bayi` rolüyle tek adımda hesap oluşturma seçeneği (mevcut akışta ya `/customers` ve `/resellers` sayfalarından oluşturuluyor ya da `/settings/users` içinde önce `Site Yöneticisi` oluşturulup ardından `Bayi / müşteri` dönüşüm modalı açılıyor). - Mobil görünümde (`<=768px`) `SiteNavigation` içindeki `Site aracı` `<select>` açı…
- **`UX-04`:** Panel dili, marka/logo/giriş ekranı ve özel menü bağlantısı yönetimi sunulmuyor.
- **`UX-05`:** Web siteleri listesinde toplu seçim (checkbox) ve toplu eylemler (toplu askıya alma, toplu silme vb.), tarih/disk sıralaması, 100 kayıt seçeneği ve doğrudan sayfa numarasına gitme.
- **`UX-06`:** - **HTTP ve Arayüzde Manuel İş Yeniden Deneme (`POST /api/jobs/:jobId/retry` ve `onRetry` bağlantısı):** Arka uçta `jobRegistry.retryJob(id, options)` (`apps/api/src/job-registry.js:1699`) ve ön yüzde `JobsTable`/`JobDrawer` içinde `onRetry` prop desteği bulunmasına rağmen, `apps/api/src/core-app.js` içinde `/api/jobs/:jobId/retry` HTTP ucu tanımlanmamış ve ön yüz sayfalarında (`JobsPage`, `SiteDe…

### Web Siteleri & Alan Adları (`WEB`)
- **`WEB-01`:** - **Sihirbaz içinden yeni Compose YAML yapıştırarak/yükleyerek sıfırdan Docker Stack ile site açma:** `/websites/new` Adım 2'de `Docker / Compose Proxy` seçildiğinde yalnızca mevcut bir `Docker Compose proje kimliği` (UUID) girilebiliyor; sihirbaz içinde Compose YAML editörü veya mevcut projeleri listeleyen bir açılır kutu (`<select>`) bulunmuyor. - **Paylaşılan alan adını (`shared_website`) Websi…
- **`WEB-04`:** Plesk tarzı bağımsız Domain Forwarding (hosting olmadan doğrudan dış URL'ye 301/302 veya Frame yönlendirme) ve No-Hosting (yalnızca DNS/Mail veya parked domain açma) tipi bulunmuyor; yönlendirmeler ek alan adlarının canonical URL'ye yönlendirilmesi ve HTTP→HTTPS ile sınırlı, tüm domainler bir web hosting nesnesine bağlanmak zorundadır.
- **`WEB-07`:** - Site kartlarında (`WebsiteTaskCard`) disk ve trafik tüketim özeti ile kart içi araç çekmecesinin 3 görev grubuna (`Genel Bakış`, `Barındırma ve DNS`, `Posta`) ayrılması (`ui-plan.md` §2). - `/websites` `Tür` filtresinde `PHP` ve `Node.js / Passenger` çalışma türlerinin seçilebilmesi ve `Durum` filtresinde `Askıda` (`suspended`) seçeneği. - Site kartı çekmecesinde ve Site Genel Bakış üst kısayoll…
- **`WEB-08`:** - DNS öncesi Site Önizleme (Plesk Site Preview / Geçici Domain URL) düğmesi ve altyapısı panelde henüz yer almıyor.

### WordPress Araç Seti (WP Toolkit) (`WP`)
- **`WP-01`:** Plesk WordPress Toolkit'te yer alan harici/ayrık WordPress kurulumlarını arama ("Scan" / "Tara"), toolkit'e bağlama ("Attach") ve şifresiz doğrudan WordPress yönetici paneline oturum açma ("Log in" / 1-Click SSO) işlevleri.
- **`WP-02`:** Plesk WordPress Toolkit'te yer alan eklenti ve tema otomatik güncelleme (Auto-updates / Smart Updates) politikaları, ZIP arşivi yükleyerek eklenti/tema kurma (Upload Plugin/Theme) ve WordPress.org deposunda canlı arama/filtreleme arayüzü.
- **`WP-03`:** - Plesk WP Toolkit merkezi toplu güncelleme ve yönetim ekranı (Mass Actions) - Önceden tanımlı veya özel eklenti/tema setleri (Plugin & Theme Sets) ve toplu dağıtım
- **`WP-04`:** Plesk WordPress Toolkit'te yer alan ortamlar arası seçici/çift yönlü veri senkronizasyonu ("Copy Data" / "Data Sync" - veritabanı veya dosyaların canlıya/staging'e aktarımı) ve klonlama modalı içinde tek tıkla yeni alt alan adı (subdomain) oluşturma yeteneği.
- **`WP-05`:** Plesk WP Toolkit'te yer alan WordPress kartı üzerinden tek tıkla "Maintenance Mode" açma/kapatma ve özel şablon (countdown timer, sosyal bağlantılar, özel metin) yapılandırma sihirbazı; WordPress arama motoru indeksleme ("Search engine indexing" / `blog_public`) geçiş anahtarı ve doğrudan WordPress'e özel "Back Up / Restore" modalı.
- **`WP-06`:** - Plesk WP Toolkit Güvenlik Durumu (Security Status) ve otomatik/manuel sıkılaştırma (Security Measures) - Eklenti/tema ve çekirdek bilinen zafiyetlerinin (CVE Vulnerability Scanner) tespiti ve gösterimi - /api/panel/websites/:id/wordpress/security uç noktası (404 döner)

---

## 5. Mevcut Test Sınıflarının Toplamı ve 2. Dalga İçin ID Başına "Koru / Düzelt / Yaz" Önerisi

### 5.1 Mevcut Testlerin Dağılımı

Bu tablo raporlardaki sınıflandırmaları aktarır; dosyalar tekilleştirilmemiş ve her test bu özet kapsamında yeniden denetlenmemiştir. Bir sınıflandırma, başka bir katmanın veya canlı host kabulünün yerine geçmez. Örneğin T812/T815'in yeniden oluşturma fixture'ı Nginx komutu, kimlik ve silme adaptörlerini taklit eder; geçen yerel koşusu sıfır mock veya canlı HTTPS kanıtı değildir.

| Test Sınıfı | Adet | Oran | 2. Dalga Stratejisi |
|---|:---:|:---:|---|
| **GEÇERLİ** | 450 | %59.0 | **Koru.** Gerçek dosya sistemi, gerçek SQLite/MySQL ve gerçek API uç noktalarıyla doğrulanan sağlam testlerdir; bozulmadan korunmalıdır. |
| **MOCK** | 149 | %19.5 | **Düzelt.** AGENTS.md 24 Ekim Madde 1 kuralı gereği sıfır mock ilkesine aykırıdır; sahte servis/stub HTTP cevapları kaldırılarak gerçek DB ve gerçek backend'e bağlanmalıdır. |
| **YÜZEYSEL** | 95 | %12.5 | **Düzelt / Yaz.** Yalnızca `fs.readFileSync` ve regex metin araması yapan testlerdir; gerçek çalışma mantığını sınamaz. Derin API ve DOM etkileşim testlerine dönüştürülmelidir. |
| **KIRMIZI** | 28 | %3.7 | **Düzelt.** Eski tek sayfalı form veya kaldırılmış `table.ws-table` seçicilerini arayan eski e2e testleridir. Yeni Shadcn UI hiyerarşisiyle güncellenmelidir. |
| **EKSİK** | 25 | %3.3 | **Yaz.** İlgili özelliğin kritik sınır durumları veya mutasyon adımları için henüz yazılmamış testlerdir; sıfırdan yazılmalıdır. |
| **YANLIŞ** | 13 | %1.7 | **Düzelt.** Hatalı beklentiye sahip veya arayüzde olmayan parametreleri bekleyen testlerdir; doğru akışla revize edilmelidir. |
| **BOŞ / DİĞER** | 3 | %0.4 | **Yaz / Düzenle.** Gövdesi boş bırakılmış veya sınıflandırılamayan testlerdir; doldurulmalıdır. |
| **TOPLAM** | **763** | **%100** | — |

### 5.2 2. Dalga İçin ID Başına "Koru / Düzelt / Yaz" Öneri Özeti

- **Düzelt (5 özellik):** EML-03, EML-05, RUN-07, SYS-06, UX-04
- **Koru (73 özellik):** API-02, API-03, API-04, BAK-01, BAK-02, BAK-04, BAK-05, BAK-06, DB-04, DB-05, DB-06, DEV-01, DEV-02, DEV-03, DEV-05, DEV-06, DKR-01, DKR-02, DKR-03, DKR-04, DNS-01, DNS-02, DNS-03, DNS-04, DNS-05, DNS-06, DOS-03, DOS-05, DOS-06, DOS-07, DOS-09, DOS-10, EKL-01, EKL-02, EML-01, EML-06, EML-08, EML-09, EML-10, EML-11, HSP-04, MIG-01, MIG-02, MIG-03, MIG-04, MIG-05, MON-01, MON-02, MON-03, MON-04, MON-05, PLN-08, RUN-01, RUN-03, RUN-05, RUN-06, RUN-08, SEC-02, SEC-04, SYS-02, SYS-04, TLS-02, TLS-03, TLS-04, TLS-05, WEB-02, WEB-04, WEB-05, WEB-06, WEB-08, WP-03, WP-04, WP-06
- **Koru / Düzelt (20 özellik):** API-01, BAK-03, BAK-08, DEV-04, DKR-05, DKR-06, EML-04, EML-07, HSP-03, RUN-04, SEC-01, SEC-03, SYS-01, SYS-05, UX-05, WEB-01, WEB-03, WP-01, WP-02, WP-05
- **Koru / Düzelt / Yaz (18 özellik):** DB-01, DB-02, DB-03, DOS-04, HSP-01, HSP-02, ROL-01, ROL-03, ROL-04, ROL-05, ROL-06, ROL-07, RUN-02, TLS-01, TLS-06, UX-01, UX-06, WEB-07
- **Koru / Yaz (7 özellik):** DOS-01, DOS-02, DOS-08, DOS-11, MIG-06, SYS-03, UX-02
- **Yaz (1 özellik):** EML-02

---

## 6. Test Edilemeyenler ve Nedenleri

1. dalga manuel testlerinde doğrudan test edilemeyen veya E2E'de bilinen hata (`test.fail`) olarak işaretlenen başlıklar ve nedenleri:

### 1. Sunucuda Bulunmayan Servisler ve Daemon Eksiklikleri
- **`DOS-10` (FTP/FTPS Hesapları):** Test sunucusunda (`.28`) port 21 kapalıdır; sistemde `vsftpd`, `proftpd` veya `pure-ftpd` kurulu değildir. YunPanel yalnızca SSH/SFTP (port 22) protokolünü desteklemektedir.
- **`EML-03` (Otomatik Yanıtlayıcı / Vacation):** Dovecot Sieve LMTP aktif olmasına rağmen autoresponder / tatil mesajı Sieve vacation kural motoru ve panel arayüzü mevcut değildir.
- **`EML-05` (Posta Listeleri / Mailman):** Test sunucusunda GNU Mailman servisi ve ikilileri kurulu değildir; panelde ve API'de posta listesi desteği yoktur.
- **`SEC-03` (ModSecurity / WAF):** Test sunucusunda `libnginx-mod-http-modsecurity` modülü ve `/etc/nginx/modsec/` kural kümesi kurulu değildir; panelde WAF sekmesi ve API rotası bulunmamaktadır.

### 2. Canlı Dış Sağlayıcı ve Ağ Bağımlılıkları
- **Harici DNS Delegasyonu (`DNS-03`, `DNS-04`):** Canlı internet registrar yetkisi (`DS`, `NS` delegasyonu) gerektiren DNSSEC üst sunucu doğrulamaları yerel test ortamında tam olarak simüle edilememiştir.
- **Canlı Bulut Depolama (`BAK-05`):** Uzak depolama hedeflerinde (AWS S3, Backblaze B2, Google Cloud Storage) canlı harici kimlik bilgisi kullanılmadığı için API düzeyindeki rclone adapter sözleşmesiyle yetinilmiş, canlı buluta veri aktarımı denenmemiştir.
- **Harici Fatura / WHMCS Entegrasyonu (`API-04`):** Dış SSO veya WHMCS portali bulunmadığından tek kullanımlık oturum testleri iç bağlam geçişleriyle sınırlı kalmıştır.

### 3. Canlı Ortam Koruma ve Yıkıcı İşlem Kısıtları
- **Mevcut Üretim Siteleri (`WEB-07`, `TLS-06`):** `.28` test sunucusunda aktif çalışan 6 adet sitenin kesintiye uğramaması için bu sitelerin silinmesi, sunucu genelinde yıkıcı DNS sıfırlaması veya genel Nginx konfigürasyonunun geçersiz kılınması test edilmemiş; tüm testler `t*-a*` izole önekli geçici kaynaklarla yürütülmüştür.
