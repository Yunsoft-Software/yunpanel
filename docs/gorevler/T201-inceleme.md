# T201 İnceleme Notu (Review)

- **Tarih:** 2026-10-28
- **İnceleyen:** AGENT_2
- **İncelenen Görev:** T201 · Manuel test: MON-01 — CPU/RAM/disk/ağ/servis ölçümleri ve geçmiş grafikler
- **Yapan:** AGENT_4
- **Karar:** ONAY (ACCEPT)

---

## 1. İncelenen Değişiklikler ve Uyumluluk Denetimi

- `docs/manuel-test/MON-01.md`:
  - Satır sayısı kontrolü: 30 satır (kural: <= 40 satır; tam uyumlu).
  - Tablo formatı ve bulgular eksiksiz: Mutlu yol (Dashboard Performans 3s canlı telemetri, UsageRing CPU/RAM/Disk % ve GB formatları, UsageHistory dinamik SVG grafiği ve `/servers` servisleri), Hatalı girdi ve yetkisiz istek koruması (anonim istek 401, geçersiz UUID 404), Fiziksel kanıtlar (SSH `nproc`, `hostname`, `df -B1 /`, `cat /proc/meminfo` ile panel envanteri eşleşmesi), Plesk eşdeğerlik eksiklikleri (Plesk Advanced Monitoring kalıcı geçmiş zaman serisi 24s/7g, servis bazlı CPU/RAM dağılımı ve Ağ/Disk I/O grafikleri; `test.fail` ile işaretli).
- `e2e/ozellik/mon-01.spec.js`:
  - **Sıfır mock ilkesi:** Gerçek UI (`/dashboard`, `/servers`), gerçek panel REST API (`/api/panel/servers`) ve canlı test sunucusunda (`yunpanel-test`) SSH üzerinden donanım metrikleriyle yazılmıştır. Mock veya sahte veri kesinlikle yoktur.
  - **Fiziksel doğrulama:**
    1. Arayüzde Performans bölümü, canlı telemetri akışı, "Şimdi ölç" butonu, CPU/RAM/Disk halkaları ve dinamik SVG path'leri (`.ws-series-cpu`, `.ws-series-memory`, `.ws-series-disk`) doğrulanmıştır.
    2. SSH üzerinden donanım komutları (`nproc`, `hostname`, `df -B1 /`, `/proc/meminfo`) çalıştırılarak panel envanteriyle tam uyum kanıtlanmıştır.
    3. Hatalı girdi (404) ve anonim yetkisiz erişim (401) API seviyesinde test edilmiştir.
    4. Plesk Advanced Monitoring eksiklikleri `test.fail` olarak belgelenmiştir.
  - **Kaynak temizliği (0 artık ilkesi):**
    - Sunucuda geçici dosya/servis oluşturulmamış, `afterAll` hook'unda panel ve telemetri servisinin başlangıç durumu doğrulanmıştır.

---

## 2. Bağımsız Test Koşusu (Reviewer Koşusu)

- Test bağımsız olarak gerçek `.28` test sunucusunda AGENT_2 tarafından çalıştırıldı:
  `AGENT_N=2 npx playwright test e2e/ozellik/mon-01.spec.js --reporter=line`
  - Çıktı:
    ```
    Running 4 tests using 1 worker

    [1/4] … Canlı telemetri akışı, CPU/RAM/Disk kullanım yüzdeleri ve geçmiş grafiği
    [2/4] …e yetkisiz istek koruması: geçersiz sunucu ID ve anonim erişim reddedilir
    [3/4] …e çekirdek, bellek, disk ve ağ metriklerinin panel envanteriyle eşleşmesi
    [4/4] …ğerliği: kalıcı geçmiş zaman aralığı (24s/7g) ve servis/ağ I/O grafikleri
      4 passed (32.1s)
    ```
  - Sonuç: **4 passed (32.1s)** (1 beklenen `test.fail` Plesk eşdeğerlik bulgusu ile tam uyumlu).

---

## 3. Kalite Kapıları ve Kaynak Kontrolü

- `npm run lint`: Repository policy validation passed.
- Kaynak kontrolü: Test sonrası panel telemetrisi ve sunucu stabil durumda kalmış, artık kaynak bırakılmamıştır.

---

## 4. Karar Özeti

T201 görevi kapsamındaki MON-01 test senaryosu ve raporu; sıfır mock ilkesine, fiziksel SSH doğrulamalarına, satır sayısı kuralına (30 <= 40) ve projenin kalite standartlarına tam olarak uymaktadır. Görev ONAYLANMIŞTIR (`accept`).
