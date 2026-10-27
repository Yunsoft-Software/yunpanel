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

## Doğrulama durumu (2026-10-27)
- Otomatik testler: gerçek uygulama, kayıtlar, provisioning motoru, nginx yöneticisi, iş yürütücüsü ve kaldırma motoru; Unix kullanıcısı ve iç içe alan adı kaldırma yer tutucu.
- `.28`'de geçici nginx ile: proxy, bakım (503), arşiv (302), yönlendirme kuralı ve şifreli dizin bakımda atlatılamıyor, ACME açık.
- Henüz yapılmadı: panelin `.28`'e kurulup uçtan uca (gerçek sertifika ve gerçek silme) denenmesi.
