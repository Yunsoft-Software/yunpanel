# T198 İnceleme Notu (Review)

- **Tarih:** 2026-10-28
- **İnceleyen:** AGENT_3
- **İncelenen Görev:** T198 · Manuel test: SYS-03 — Hostname, saat/saat dilimi ve sistem ayarları
- **Yapan:** AGENT_1
- **Karar:** ONAY (ACCEPT)

---

## 1. İncelenen Değişiklikler ve Uyumluluk Denetimi

- `docs/manuel-test/SYS-03.md`:
  - Satır sayısı kontrolü: 31 satır (kural: <= 40 satır; tam uyumlu).
  - Tablo formatı ve bulgular eksiksiz: Mutlu yol (Sunucu `/servers` UI render ve `/api/panel/settings` 200 doğrulaması), Hatalı girdi & formatlar (geçersiz ACME email, geçersiz varsayılan runtime, aralık dışı Node sürümü, aralık dışı yenileme gün sayısı ve dizi patch formatı için 400 doğrulaması), Fiziksel kanıt (SSH `hostname` ve `timedatectl status` ile panel API tutarlılığı), Plesk eşdeğerlik eksiklikleri (Tools & Settings -> "System Time" saat/tarih/TZ ve NTP senkronizasyonu eksikliği ile "Server Settings" FQDN hostname değiştirme eksikliği; `test.fail` ile işaretli).
- `e2e/ozellik/sys-03.spec.js`:
  - **Sıfır mock ilkesi:** Gerçek UI (`/servers`), gerçek panel REST API (`/api/panel/settings`) ve test sunucusunda (`yunpanel-test`) SSH üzerinden `hostname` ve `timedatectl status` kontrolleriyle yazılmıştır. Mock veya sahte veri kesinlikle yoktur.
  - **Fiziksel doğrulama:**
    1. SSH üzerinden sunucu hostname'i sorgulanmış ve API'deki `panel.hostname` ile birebir eşleştiği kanıtlanmıştır.
    2. SSH üzerinden `timedatectl status` ile canlı sunucudaki saat ve saat dilimi ('Europe/Istanbul') fiziksel olarak doğrulanmıştır.
    3. Hatalı girdi validasyonları (400) ve aralık sınırları test edilmiştir.
    4. Plesk Timezone, NTP ve Hostname güncelleme eksiklikleri `test.fail` olarak belgelenmiştir.
  - **Kaynak temizliği (0 artık ilkesi):**
    - `beforeAll` aşamasında mevcut panel ayarları saklanmış, `afterAll` hook'unda orijinal değerlerine eksiksiz geri yüklenmiştir.

---

## 2. Bağımsız Test Koşusu (Reviewer Koşusu)

- Test bağımsız olarak gerçek `.28` test sunucusunda AGENT_3 tarafından çalıştırıldı:
  `AGENT_N=3 npx playwright test e2e/ozellik/sys-03.spec.js --reporter=line`
  - Çıktı:
    ```
    Running 5 tests using 1 worker

    [1/5] …ame, çalışma süresi ve sistem ayarları arayüz ve API üzerinden doğrulanır
    [2/5] … girdi: Geçersiz sistem ayarları ve geçersiz formatlar 400 ile reddedilir
    [3/5] … SSH ile sunucu hostname, timedatectl saat/saat dilimi ve API tutarlılığı
    [4/5] …sikliği: Sistem saati, saat dilimi (Timezone) ve NTP yapılandırma arayüzü
    [5/5] …k Parity Eksikliği: Sunucu Hostname (FQDN) değiştirme ve kaydetme arayüzü
      5 passed (35.8s)
    ```
  - Sonuç: **5 passed (35.8s)** (2 beklenen `test.fail` Plesk eşdeğerlik bulgusu ile tam uyumlu).

---

## 3. Kalite Kapıları ve Kaynak Kontrolü

- `npm run lint`: Repository policy validation passed.
- Kaynak kontrolü: Test sonrası sistem ayarları orijinal durumuna döndürülmüş ve sunucuda hiçbir kalıntı/artık kaynak bırakılmamıştır.

---

## 4. Karar Özeti

T198 görevi kapsamındaki SYS-03 test senaryosu ve raporu; sıfır mock ilkesine, fiziksel SSH doğrulamalarına, satır sayısı kuralına (31 <= 40) ve projenin kalite standartlarına tam olarak uymaktadır. Görev ONAYLANMIŞTIR (`accept`).
