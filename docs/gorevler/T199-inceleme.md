# T199 İnceleme Notu (Review)

- **Tarih:** 2026-10-28
- **İnceleyen:** AGENT_3
- **İncelenen Görev:** T199 · Manuel test: SYS-04 — Sistem/PHP/panel güncellemeleri ve bileşen yönetimi
- **Yapan:** AGENT_2
- **Karar:** ONAY (ACCEPT)

---

## 1. İncelenen Değişiklikler ve Uyumluluk Denetimi

- `docs/manuel-test/SYS-04.md`:
  - Satır sayısı kontrolü: 29 satır (kural: <= 40 satır; tam uyumlu).
  - Tablo formatı ve bulgular eksiksiz: Mutlu yol (Ayarlar `/settings?section=updates` UI render, güncelleme denetimi, kurulu sürüm doğrulaması), Hatalı girdi & formatlar (geçersiz onay kodu için 400 `upgrade_confirmation_required`, boş body 400 ve geçersiz sunucu ID 404 doğrulaması), Fiziksel kanıtlar (SSH `apt-cache policy yunpanel` ile sürüm eşleşmesi, SSH `php -v` ile PHP 8.3 ve `systemctl is-active php8.3-fpm` ile servis aktifliği, SSH `apt list --upgradable` ile yükseltilebilir paket sorgusu), Plesk eşdeğerlik eksiklikleri (Plesk System Updates arayüzü ve Add/Remove Components arayüzü eksiklikleri; `test.fail` ile işaretli).
- `e2e/ozellik/sys-04.spec.js`:
  - **Sıfır mock ilkesi:** Gerçek UI (`/settings?section=updates`), gerçek panel REST API (`/api/panel/servers/:id/system/upgrade` ve inspect) ve canlı test sunucusunda (`yunpanel-test`) SSH üzerinden APT paket durumu, PHP sürümü ve servis durumlarıyla yazılmıştır. Mock veya sahte veri kesinlikle yoktur.
  - **Fiziksel doğrulama:**
    1. Arayüzde "Check updates" butonu tetiklenerek dönen sürüm (YunPanel 0.3.0) SSH'taki `apt-cache policy yunpanel` ile birebir eşleştirilmiştir.
    2. SSH üzerinden PHP 8.3.6 sürümü ve `php8.3-fpm` servisinin active durumu doğrulanmıştır.
    3. Hatalı girdi validasyonları (400) ve sunucu bulunamadı (404) API seviyesinde test edilmiştir.
    4. Plesk System Updates ve Add/Remove Components eksiklikleri `test.fail` olarak belgelenmiştir.
  - **Kaynak temizliği (0 artık ilkesi):**
    - Sunucuda yıkıcı `apt upgrade` veya plansız paket silme yapılmamış, `afterAll` hook'unda `yunpanel-api` servisinin aktifliği ve APT paket durumu SSH ile doğrulanmıştır.

---

## 2. Bağımsız Test Koşusu (Reviewer Koşusu)

- Test bağımsız olarak gerçek `.28` test sunucusunda AGENT_3 tarafından çalıştırıldı:
  `AGENT_N=3 npx playwright test e2e/ozellik/sys-04.spec.js --reporter=line`
  - Çıktı:
    ```
    Running 4 tests using 1 worker

    [1/4] …yol: Panel sürüm denetimi, kurulu PHP sürümü ve sistem güncelleme sorgusu
    [2/4] …lı girdi: Geçersiz onay kodu ile sistem yükseltme reddedilir ve 400 döner
    [3/4] …Eksikliği: Sistem güncellemeleri arayüzü (Plesk System Updates) eksikliği
    [4/4] …: Sunucu geneli bileşen ekleme/kaldırma (Add/Remove Components) eksikliği
      4 passed (33.6s)
    ```
  - Sonuç: **4 passed (33.6s)** (2 beklenen `test.fail` Plesk eşdeğerlik bulgusu ile tam uyumlu).

---

## 3. Kalite Kapıları ve Kaynak Kontrolü

- `npm run lint`: Repository policy validation passed.
- Kaynak kontrolü: Test sonrası `yunpanel-api` servisi aktif, paket tablosu temiz ve sunucuda artık/çöp durum bırakılmamıştır.

---

## 4. Karar Özeti

T199 görevi kapsamındaki SYS-04 test senaryosu ve raporu; sıfır mock ilkesine, fiziksel SSH doğrulamalarına, satır sayısı kuralına (29 <= 40) ve projenin kalite standartlarına tam olarak uymaktadır. Görev ONAYLANMIŞTIR (`accept`).
