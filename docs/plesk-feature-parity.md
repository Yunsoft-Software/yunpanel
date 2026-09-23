# Plesk → YunPanel özellik kapsamı ve uygulama önceliği

2026-09-23; `development`. **Son kullanıcı kararı: Plesk görev düzeni korunur, reseller ilk sürümü sade tutulur.** Eski aynı tarihli tam reseller/paket/abonelik zorunluluğu bu belge, `plan.md` ve [güncel RS sözleşmesi](ux/plesk-full-scope.md) ile değiştirilmiştir.

Önceki **21 gruplu bütün özellik listesi ve S01–S27 resmî kaynak kaydı**, hiçbir satırı kaybetmeden [tam envanter kopyasında](history/plesk-feature-parity-before-simple-reseller-20260923.md) tutulur. Bu dosya o listenin **güncel kapsam/öncelik katmanıdır**. Reseller dışındaki özellik ID'leri, detayları ve açık kabulleri korunur. Kopyadaki eski “tam reseller ilk sürümde zorunlu” cümleleri güncel karar değildir. Bu tur yeni Plesk/Marketplace araştırması yapılmadı; kaynaklar 2026-09-23 önceki envanter kaydıdır.

## İlk reseller sürümü

**Owner → isteğe bağlı tek Reseller → Customer → mevcut Website.** Paket/Subscription nesnesi site işlemi için şart değildir. Mevcut site araçları, auth, yetki, Files girişleri ve Unix izolasyonu yeniden yazılmaz. Basit toplam müşteri ve Website adet sınırı uygulanır; ayrı overselling/rezervasyon/ölçüm motoru kurulmaz.

| Envanter karşılığı | Güncel ilk sürüm karşılığı | Durum |
| --- | --- | --- |
| ROL-03, ROL-04, HSP-04 | Bayinin kendi müşteri/site listesi; müşterinin kendi siteleri | RS-01 kaynak politikası var; RS-02–05 entegrasyon/kabul açık |
| HSP-01, HSP-02, HSP-03 | Basit hesap oluştur/düzenle/askı/etkinleştir; bağlı kaynakta güvenli silme engeli | RS-03–05 açık |
| PLN-08'in adet bölümü | `maxCustomers`, `maxWebsites`; `null` sınırsız, `0` ekleme kapalı | RS-01 kaynak sayım/kapasite var; atomik DB enforcement açık |
| WEB-09'un sahiplik bölümü | Açık Customer→Website ilişkisi; mevcut kimlikler korunur | Politika var; migration ve bağlama açık |
| UX-01, UX-02 | Mevcut menü/form/site araçları; global ve domain Files korunur | UX-PL ve RS-04/05 açık |

Kaynak politikası ve sayım testi **API, oturum, UI veya canlı kota enforcement tamamlandı** demek değildir. Üst özellik kutuları sırf helper eklendi diye kapanmaz.

## İlk sürümden çıkarılan ağır reseller işleri — sonraki faz

- ROL-08 / HSP-05–07: login-as, toplu transfer, müşteri↔reseller dönüşümü ve kapsamlı sahiplik taşıma. Bu işlemler UI'de gizlenmekle kalmaz; ilk sürüm API'sinde de açılmaz.
- HSP-08 / PLN-01–07 / PLN-09–10: ayrı reseller paket motoru, add-on, zorunlu abonelik, expiry, sync/lock/customization, overselling ve paket bazlı karmaşık izin tahsisi. PLN-08'in mevcut site disk/mail/DB/CPU limit işi PROD-15'te korunur; iki basit reseller adet limiti yukarıdadır.
- API-05/06'nın reseller ticari otomasyonu, reseller markalama, alt bayi zinciri ve paket/abonelik tabanlı toplu migration: ilk sürümün önkoşulu değildir. Genel API, site migration ve site backup işleri iptal değildir.

İki ayrı yönetici görünümü ve tam Service Provider deneyimi uzun vadeli UX referansı olarak kalır; sade reseller için iki yeni yönetici paneli yapmak gerekmez. Ertelenmiş işler tamamlandı işaretlenmez ve MVP ilerleme hesabına eksik zorunlu iş olarak katılmaz.

## Diğer özellik grupları — kapsamları korunur

Aşağıdaki ID'lerin ayrıntılı açık listesi [korunan tam envanterdedir](history/plesk-feature-parity-before-simple-reseller-20260923.md). Bu tablo yeni bir tamamlanma iddiası değildir.

| Grup | Korunan ID'ler / kapsam |
| --- | --- |
| 01 Paneller/roller | ROL-01–08; reseller için yukarıdaki faz ayrımı |
| 02 Hesaplar | HSP-01–08; sade hesaplar şimdi, transfer/dönüşüm sonra |
| 03 Paketler/abonelikler | PLN-01–10; ilk sürüm yalnız basit adet sınırı ve mevcut site limitleri |
| 04 Siteler/domainler | WEB-01–09; site oluşturma, subdomain/alias, hosting, liste ve güvenli lifecycle |
| 05 Dosyalar/erişim | DOS-01–11; Files, upload/edit/archive, izinler ve site izolasyonu |
| 06 Runtime/hosting | RUN-01–08; PHP/Node/hosting/runtime bileşenleri |
| 07 Git/framework | DEV-01–06; Git/deploy/Laravel |
| 08 Docker | DKR-01–06; image/container/Compose/proxy/veri ayrımı |
| 09 DNS | DNS-01–06; zone, DNSSEC, sağlayıcı ve tanılama |
| 10 TLS | TLS-01–07; ACME, wildcard, atama, gerçek sertifika ve sağlayıcılar |
| 11 Mail | EML-01–11; mailbox, alias, spam, TLS, DKIM ve teslimat |
| 12 Veritabanları | DB-01–09; DB/grant, phpMyAdmin, import/export ve engine koşulları |
| 13 Yedek/kurtarma | BAK-01–08; mevcut site/server yedekleri; reseller/paket seviyeleri kendi fazında |
| 14 Güvenlik/sunucu | SEC-01–04, SYS-01–06; firewall, erişim, servis ve işletim |
| 15 İzleme/log | MON-01–06; gerçek ölçüm, log, eşik ve teslim kanıtı |
| 16 WordPress | WP-01–07; toolkit kapsamı ve premium davranışlar |
| 17 Eklentiler | EKL-01–07; vendor/OS/lisans/alt ürün taraması halen açık |
| 18 API/ticari | API-01–07; reseller fatura/abonelik otomasyonu sonraki faz |
| 19 Migration | MIG-01–06; reseller/paket importu sade sürümün şartı değil; site/veri korunur |
| 20 UX/marka | UX-01–06; site görevleri şimdi, reseller marka/abonelik bağlamı sonra |
| 21 Windows | WIN-01–06; ayrı Windows backend/kurulum/kabul, Ubuntu ile kapanmaz |

## Kanıt ve kapanış

- [x] Önceki 21 gruplu envanter ve resmî kaynak listesi byte-identical Git blob olarak korundu: `5b975f324000f2f653a9858b5963d6a694b26176`.
- [x] Reseller MVP ile uzun vadeli parity ayrıldı; RS-00 kapsam dokümanları ve ana plan güncellendi.
- [x] RS-01a/b kaynak politikası ve iki test dosyası: 107 test geçti (Node22); [kapsam raporu](history/reseller-scope-source-2026-09-23.md), [limit raporu](history/reseller-limits-source-2026-09-23.md).
- [ ] RS-02–05: auth/state/migration, bütün API/job/tool/WS sınırları, atomik limit kontrolü, UI ve gerçek kabul.
- [ ] PAR-00b: diğer envanter ID'lerini mevcut kaynak/API/servis/rol/OS/provider/test kanıtına bağla. EKL-07 tam Marketplace araştırması açık.

Bu tur reseller login veya yeni API/UI açılmadı. Plesk'in marka/CSS/kodu taşınmaz; mevcut Ember tasarım dili ve güvenlik sınırları korunur. SFTP FTP diye, Ubuntu Windows diye, saf kaynak testi canlı kabul diye sunulmaz.
