# T164 İnceleme Notu — Manuel test: DKR-01

- **İncelenen Görev:** T164 (Manuel test: DKR-01 — Registry/image arama, indirme ve image yönetimi)
- **Görevi Yapan:** AGENT_2
- **İnceleyen:** AGENT_4
- **Tarih:** 2026-10-27
- **Karar:** KABUL (Onaylandı)

## İnceleme Özeti
1. **Rapor Formatı ve İçerik Kontrolü:**
   - `docs/manuel-test/DKR-01.md` raporu 29 satır uzunluğunda (kural: ≤ 40 satır).
   - YONTEM şablonuna (`Sonuç: KISMİ`, `Ajan / Tarih / Senaryo / Koşu`, `## Senaryolar`, `## Hatalar`, `## Mevcut testler`, `## Panelde olmayan`, `## Temizlenemeyen kaynaklar`) eksiksiz uyulmuş.
   - Parity eksikliği (Plesk eşdeğeri bağımsız Local Images listeleme, doğrudan docker pull ve tekil docker rmi arayüzü) `test.fail` ile belgelenmiş ve raporda tabloya işlenmiştir.

2. **Playwright Senaryosu (`e2e/ozellik/dkr-01.spec.js`):**
   - Mock veri, `page.route` veya sahte API cevabı kullanılmamış; gerçek veritabanı, backend ve `.28` test sunucusuna karşı çalışmaktadır.
   - Mutlu yol 1: Docker Hub arama kutusu ve kategori filtreleme ile arama yapılması (`redis`), kart listesi (`.yp-docker-catalog-card`), port bilgisi (Inner: 6379/tcp) ve `/api/panel/docker/catalog?q=redis&live=true` JSON API cevabı fiziksel kanıtı eksiksiz yapılmıştır.
   - Hatalı girdi: Compose detay sayfasında Registry Credentials formuna geçersiz URL-formatlı host (`https://ghcr.io/invalid/path`) girilmesinin reddedilmesi, `.ws-notice-warn` hata bildirimi ve tabloya geçersiz kayıt eklenmediği doğrulanmıştır.
   - Mutlu yol 2: Compose stack başlatma ile imaj indirilmesi (`alpine:3.20`), container ayağa kalkışı, SSH üzerinden `docker images` ve `docker inspect` ile fiziksel imaj doğrulaması yapılmıştır.
   - `afterAll` hook'unda geçici Compose projesi (`docker compose down`, `docker rm -f`) ve test imajı (`docker rmi -f alpine:3.20`) SSH üzerinden tamamen temizlenmiş, test sonrası yapılan SSH kontrolünde 0 artık kalıntı doğrulanmıştır.

3. **Bağımsız Doğrulama Koşusu:**
   - Eşzamanlı test kilidi `sunucu-28-4` alındı.
   - `AGENT_N=4 npx playwright test e2e/ozellik/dkr-01.spec.js --reporter=line` komutu bağımsız olarak koşturuldu: `4 passed (1.2m)` (3 geçti, 1 bilinen eksiklik `test.fail` olarak beklenen şekilde geçti).
   - Sunucuda artık kontrolü yapıldı: `tdkr01` container'ları ve `alpine:3.20` imajının sunucuda kalmadığı teyit edildi.
   - Test kilidi serbest bırakıldı (`released sunucu-28-4`).

4. **Kalite Kapıları:**
   - `python3 orkestra/tasks.py lint` → `lint OK`.
   - `python3 orkestra/orchestrator.py verify --quick` → `doğrulama: ok; yeniden açılan: -; bulgu: -` başarıyla tamamlandı.

5. **Sonuç:**
   - Görev kabul kriterlerini eksiksiz karşılamaktadır. `python3 orkestra/tasks.py accept T164 AGENT_4 "DKR-01 registry ve image yonetimi testleri gercek ortamda dogrulandi, kabul edildi"` komutuyla kabul edilmiş ve `tasks/done/T164.md` durumuna taşınmıştır.
