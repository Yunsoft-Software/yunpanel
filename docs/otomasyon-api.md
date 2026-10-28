# Otomasyon API'si (tenant siteleri)

Başka bir sistemin (ör. Novasis Control provisioner) YunPanel'de `slug.<üst alan adı>` siteleri açması, durdurması, arşivlemesi ve silmesi için. Plesk'teki `plesk bin subscription/dns/extension letsencrypt` adımlarının karşılığıdır.

## Anahtar
- Owner, **Ayarlar → API anahtarları**'ndan oluşturur: ad, üst alan adı (ör. `st.novasis.ai`), port aralığı (ör. 32000–32999).
- Anahtar yalnız oluşturulurken bir kez gösterilir; sunucuda yalnız SHA-256 özeti tutulur. İptal edilen anahtar hemen geçersizdir.
- Anahtar yalnız `/api/automation/*` yollarında geçer; panelin başka hiçbir yoluna erişemez. Çerez veya `Origin` başlığı olan istek reddedilir (403).
- Üst alan adı panelde önceden kayıtlı olmalıdır.

```bash
curl -H "Authorization: Bearer $YUNPANEL_KEY" https://panel.example.com/api/automation/whoami
```

## Uçlar
| İstek | Gövde | Sonuç |
|---|---|---|
| `PUT /api/automation/tenant-sites/:slug` | `{"upstreamPort": 32010}` (isteğe bağlı `"https": false`) | Site + `127.0.0.1:port` proxy + Let's Encrypt. Tekrar çağrı aynı siteyi döner. 202 = sürüyor, 200 = hazır |
| `GET /api/automation/tenant-sites/:slug` | — | Durum; her okuma işi bir adım ilerletir. `active` olana kadar yoklayın |
| `POST /api/automation/tenant-sites/:slug/state` | `{"state":"stopped"}` · `{"state":"archived","redirectUrl":"https://…"}` · `{"state":"active"}` | 503 / adrese 302 / uygulama yeniden. Yayın bitene kadar `state: publishing` |
| `DELETE /api/automation/tenant-sites/:slug` | — | Site, alan adı ve sistem kaynakları panelin kaldırma motoruyla silinir. Bitince `state: removed`, sonra 404 |

Yanıt: `{ data: { hostname, slug, upstreamPort, websiteId, state, mode, steps } }`. `state`: `provisioning` · `publishing` · `active` · `removing` · `removed` · `attention` (`error` ve gerekiyorsa `failedStep` ile).

## Korumalar
- `slug`: 3–30 karakter, küçük harf/rakam/tek tire, harfle başlar. Ayrılmış adlar: `www api admin app mail webmail smtp imap pop ftp ns1 ns2 status control panel billing support autodiscover autoconfig cpanel st`.
- Port, anahtarın aralığında olmalı; bir sitenin portu sonradan değişmez (`tenant_port_change_unsupported`).
- Panelde zaten olan ve bu API ile açılmamış bir ad asla devralınmaz (`existing_domain_protected`). Başka kapsamdaki anahtar siteyi göremez (404).
- Arka plan işleri ve kaldırma, anahtarı her adımda yeniden doğrular: anahtar iptal edilirse ya da onu oluşturan Owner devre dışı kalırsa işlem durur.

## DNS
Alt alan adları için kayıt tek tek eklenmez: üst alan adında bir kez `*.st.novasis.ai A <sunucu IP>` kaydı yeterlidir. Sertifika her site için HTTP-01 ile alınır.

## Doğrulama durumu (2026-10-28)
- Otomatik testler: gerçek uygulama, kayıtlar, provisioning motoru, nginx yöneticisi, iş yürütücüsü, kaldırma motoru ve genel web geçidi; Unix kullanıcısı ve iç içe alan adı kaldırma yer tutucu.
- `.28` (paket `0.3.0-2026102702`), `157-180-11-28.sslip.io` üst alan adıyla: anahtar oluşturma, tarayıcı isteğinin reddi, site + nginx + alan adı yayını geçti. Geçici nginx ile bakım (503), arşiv (302), ACME açık doğrulandı.
- Uçtan uca ilk koşu, genel web geçidinin `Authorization`'ı silip değişiklikleri Origin'e bağladığını buldu; `/api/automation/*` için ayrı geçit yolu eklendi.
- 28 Ekim `.28` kabulü: ACME adresi API env dosyasına tanımlandı, servis yeniden başlatıldı. Yarım sitenin sertifika adımı yeniden denendi ve geçti. Eski yayın kaydı nedeniyle site normal kaldırma akışıyla temizlendi.
- `node e2e/otomasyon/tenant-e2e.mjs`: **19/19 geçti**, çıkış 0. Benzersiz tenant'ta gerçek Let's Encrypt sertifikası, HTTPS 200, Chromium ile uygulama içeriği, bakım 503, arşiv 302 + hedef adresi, yeniden 200, gerçek kaldırma ve ardından 404; anahtar iptali + 401 doğrulandı. Tarayıcı durum kontrolleri önbellekten bağımsız URL kullanır; başarısız kontrol artık sıfır olmayan çıkış verir.
- Gerçek silmede bulunan `website_cleanup_application_drift` düzeltildi: Application/Unix kullanıcı/dosya kökü olmayan dış proxy sıfır dosya hedefiyle temizlenir. Gerçek dosya registry ve üretim adaptörüyle hata önce tekrar üretildi; ilgili 82 test geçti. Kullanıcı onayıyla yalnız `website-removal-cleanup-adapters.js` hash kontrolüyle `.28`e aktarıldı; paket sürümü değişmedi.
- Anahtar saklama testi, base64url secret içindeki `_` karakterini yanlış ayırıyordu; tam secret kontrol edilir ve olumsuz doğrulama mesajına token yazılmaz. Tekrar koşarken `.28`in `127.0.0.1:32050` uygulaması `YUNPANEL_AUTOMATION_E2E_32050` metnini sunmalıdır. Betik varsayılan benzersiz slug üretir; açık yeniden kurma hatası için `YUNPANEL_TENANT_E2E_SLUG` ile sabit slug seçilebilir.
- Eski tenant, iki benzersiz test tenant'ı, `157-180-11-28.sslip.io` üst domaini ve Nginx dosyaları kaldırıldı. Python süreci kapatıldı, `32050` portu/dizin temizliği ve etkin test anahtarı kalmadığı doğrulandı; sunucu kilitleri bırakıldı.
- Silmeyi engelleyen beş eksik cron dosyasının registry kaydı, `SYS-06`/`DEV-06` testlerinin ad/komut/zamanlamasıyla birebir doğrulandı ve kullanıcının koşullu onayıyla normal API'den kaldırıldı; ilgili siteler korunuyor.
- Son yerel doğrulama: ilgili 82/82, lint, build ve diff kontrolü geçti. Tam API koşusu **5314/5316**: `website-site-logs.test.js` içindeki iki testin sabit `27/Oct/2026` satırları varsayılan son 24 saat aralığının dışında kaldığı için kırmızı; bu testler bu tur değiştirilmedi. Diğer workspace testlerinde hata yok (host-runtime'da mevcut bir atlanan test var). Tam depo doğrulaması yeşil sayılmaz.

## Kalan işler (sırayla)
1. **Aynı slug'ı silip yeniden oluşturma hatası açık:** hostname'den türetilen sabit provisioning kimliği eski `ready` kaydını, Website kaldırması da önceki domain kaldırma kaydını yeniden kullanıyor. Gerçek tekrarda yeni domain sertifikasızken `active` döndü; HTTPS hostname doğrulaması ve sonraki silme `website_removal_domains_still_attached` ile başarısız oldu. Yeni kurulum nesli için kimlik/journal tasarımı ve gerçek yeniden oluşturma testi gerekli. Bu durum tamamlandı sayılmıyor; başarılı 19 kontrol benzersiz tenant içindir. Hatalı tekrarın kaynakları normal domain/Website devam API'leriyle temizlendi.
2. **Test temizliği riski:** `e2e/ozellik/dev-06.spec.js` içindeki `afterAll`, `/etc/cron.d/yunpanel-*` genel desenini siliyor. Bu kod başka testlerin cron dosyalarını da silebilir; yalnız kendi oluşturduğu görev kimlikleriyle sınırlandırılmalı. Bu tur betik çalıştırılmadı/değiştirilmedi; Antigravity duraklatılmış durumda bırakıldı.
