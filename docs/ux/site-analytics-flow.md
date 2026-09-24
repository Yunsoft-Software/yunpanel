# ANALYTICS-UI — Site İstatistikleri / GoAccess

2026-09-25 · development · başlangıç `8f69ff576a19ae55dc72008c283c339843ffc8b9`.
UX-PL-03/04/06 ve PROD-14/MON alt dilimi. Mevcut GoAccess motoru ve same-origin gateway korunur.

## Tamamlanan kaynak

- [x] **AN-01 backend güvenliği:** `a99ccaf1`, `0848080f`, `b3db42d2`; analytics status cevabı PID, pidPath, Unix socket yolu ve binary path yayımlamaz. Statik rapor JSON sonucu outputPath yayımlamaz. GoAccess alt katman hata mesajları raw host path içerebileceği için kullanıcıya sabit güvenli mesajla çevrilir.
- [x] **AN-01 rol sınırı:** statik rapor ve güvenli status kendi Website'ine yetkili site hesabına açık kalır; realtime daemon start/stop/restart Owner-only. Owner statusunda yalnız same-origin `/tools/goaccess/:websiteId/ws` URL'si bulunabilir; host socket yolu bulunmaz.
- [x] **AN-02 site ekranı:** `cedec1a0`; Site → Genel Bakış görev ailesinde **İstatistikler** aracı. GoAccess available/version, realtime durum ve socket-ready kanıtı, statik rapor yenile/aç. Site hesabı statik raporu kullanır; Owner ayrıca realtime görünümü açar ve daemon lifecycle eylemlerine ulaşır.
- [x] **AN-02 mutation sonucu:** realtime POST kayıp/5xx sonucunda istemci aynı POST'u otomatik tekrar etmez; status GET ile güncel durum yeniden okunur ve belirsizlik kullanıcıya gösterilir.
- [ ] **AN-03 seçili test/kabul:** backend safety/source ve frontend model/wiring testleri yazıldı; bu çalışma ortamında tam checkout/test koşusu yapılmadı. Node24/npm11 tam test/build ve gerçek browser/host kabulü açık.

## Kanıt sınırı

`docs/history/goaccess-live-acceptance-2026-09-20.md` eski `.28` izinli test hostunda GoAccess/log izolasyonu/realtime gateway için geçmiş canlı kanıttır; 2026-09-25 development head'inin dağıtıldığını veya yeni rol/response değişikliklerinin canlı geçtiğini kanıtlamaz. `.44` Plesk hostuna dokunulmaz.

Statik rapor GET'i GoAccess'ı çalıştırıp rapor dosyası üretir; salt dosya okuma değildir. Ancak aynı Website loguna sınırlıdır ve serbest komut yüzeyi açmaz. Realtime daemon lifecycle host mutation olduğu için site_manager'a açılmaz.

## T-DEV-ANALYTICS

- [ ] Node >=24.11.1/npm >=11 gerçek checkout: yeni `website-analytics-safety.test.js`, `website-analytics-source.test.js`, `site-analytics-model.test.js`, `site-analytics-wiring.test.js` ile mevcut GoAccess/gateway/site-resource-boundary regresyonlarını çalıştır; tam lint/test/build.
- [ ] Owner/Site A/Site B: site hesabı yalnız kendi Website status/statik raporuna erişmeli; başka Website 403. PID/socket/pidPath/outputPath/binaryPath/raw GoAccess error hiçbir JSON cevabına girmemeli.
- [ ] Site manager realtime POST start/stop/restart için 403; Owner start/status/open/restart/stop akışı. Kaybolan POST cevabı tekrar POST üretmemeli; status GET ile uzlaşmalı.
- [ ] Statik rapor izolasyonu: Site A log path/URL'leri Site B raporunda görünmemeli. Uzun/boş/rotated log ve GoAccess unavailable/error durumları.
- [ ] Chromium/Firefox 320/390/834/1440 px, %200 zoom, klavye, reload/back/forward, site değişimi, stale/403/500. Files/cron/PHP/backup/SSL deep link regresyonları.
- [ ] Yalnız izinli `.local/test-server.env` hostu; `.44` kullanılmaz. Geçmiş `.28` kabulünü bu head için yeniden yapılmış sayma.
