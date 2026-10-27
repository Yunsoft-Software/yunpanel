# Yetki denetimi — site rolleri (27-10-2026)

> Senior (Claude). Soru: müşteri, bayi ve site yöneticisi rolleri hangi sunucu geneli uçlara ulaşabiliyor?

## Neden gerekti
`requirePanelRouteAccess` site rollerini küçük bir yasak listesi (kullanıcılar, panel ayarları, paketler, firewall) dışında **her uca** geçiriyor. Sonraki koruma `createApp` içindeki **site kaynak sınırı** (`apps/api/src/site-resource-boundary.js`):
- `/api/websites/:id`, `/api/domains/:id`, `/api/applications/:id`, `/api/jobs/:id` için sahiplik kontrolü yapıyor.
- `/api/servers/*`, posta, yedek ve panel ayarlarını tamamen kapatıyor.
- Kendi notunda DNS ve diğer entegrasyonları kapsamadığını belirtiyor.

Sınırın dışında kalan her uç, kapsamını kendisi denetlemek zorunda.

## Yöntem
- Uygulamanın 284 ucu otomatik listelendi (114 GET, 170 veri değiştiren).
- Her GET ucu gerçek `createApp` (site kaynak sınırı dahil) üzerinden Owner ve "hiç sitesi olmayan müşteri" olarak çağrıldı.
- Müşteriye 403 dönmeyen 23 GET ucu ve sınırın kapsamadığı 22 veri değiştiren uç kod üzerinden incelendi.
- Her bulgu gerçek uygulamayla test edildi: düzeltmeden önce sızdığı, sonra kapandığı gösterildi.

## Sonuçlar
| Uç | Durum (öncesi) | Sonuç |
|---|---|---|
| `GET /api/websites/:id/application/logs` (PHP/statik) | **İstismar edilebilir:** sitenin değil sunucunun genel nginx logu dönüyordu | Düzeltildi: sitenin kendi log dosyası |
| `/api/dns-zones` liste, tekil okuma, `provider-credential` okuma/yazma/silme, kayıtlar, gereksinimler | **İstismar edilebilir:** başka kiracıların bölgeleri ve DNS sağlayıcı kimlik bilgisi | Düzeltildi: yalnız kendi sitelerinin alan adlarının bölgeleri; yabancı bölge "bulunamadı" |
| `/api/notifications` tercihler (GET/PATCH), geçmiş, teslimatlar, durum, test gönderimi | **İstismar edilebilir:** Owner bildirimlerini okuma, tercihlerini değiştirme, test e-postası yağdırma | Düzeltildi: yalnız Owner |
| `/api/system/parity/*/execute` | İstemcinin verdiği metot adı çalıştırılıyordu; adaptörler bugün sahte/kapalı olduğu için zarar yok | Derinlemesine savunma: yalnız Owner |
| `/api/servers/:id/logs/*`, `/api/servers/:id/mail/queue`, başka uygulamanın `/api/applications/:id/logs/node` ve dağıtım logu | Uç içinde rol kontrolü yoktu, ama **site kaynak sınırı zaten engelliyordu** | Derinlemesine savunma: uç düzeyinde de kapalı |
| Sertifika sonuç uçları (`verify-tls`, `renewal-outcome`, `reload-outcome`) | T800 (junior) kiracı kontrolü eklemiş | Güvende |
| Docker/Portainer, watchdog | Kendi Owner/yönetim korumaları var | Güvende |
| `POST /api/sites` (doğrudan oluşturma) | Kodda rol kontrolü görünmüyordu, ama gerçek uygulamada site rolleri 403 alıyor | Güvende (gerileme testi eklendi) |
| `/api/system/capabilities`, `/api/system/parity/*` (okuma) | Statik katalog | Zararsız |

## Testler
`apps/api/test/website-site-logs.test.js`, `site-role-owner-routes.test.js`, `site-create-role.test.js`, `log-http-tenant.test.js`.

## Sınırlar
- Veri değiştiren uçlar çağrılmadı (yan etki riski); kod incelemesi ve hedefli testlerle denetlendi.
- Tarama rastgele kimliklerle yapıldı; 404 dönen tekil uçların sahiplik kontrolü kodda ayrıca doğrulandı.
- Terminal, AI ve WebSocket politikaları bu denetimin kapsamı dışında; site kaynak sınırının notu da bunlara ayrıca bakılması gerektiğini söylüyor.
