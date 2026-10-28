# T197 İnceleme Notu (Review)

- **Tarih:** 2026-10-28
- **İnceleyen:** AGENT_1
- **İncelenen Görev:** T197 · Manuel test: SYS-02 — Sistem servislerini kurma/başlatma/durdurma/yeniden başlatma
- **Yapan:** AGENT_3
- **Karar:** ONAY (ACCEPT)

---

## 1. İncelenen Değişiklikler ve Uyumluluk Denetimi

- `docs/manuel-test/SYS-02.md`:
  - Satır sayısı kontrolü: 28 satır (kural: <= 40 satır; tam uyumlu).
  - Tablo formatı ve bulgular kurala uygun: Mutlu yol 1 (Sistem servisleri listeleme, API `/api/panel/servers/:id/services`, SSH `systemctl is-active cron` active), Mutlu yol 2 (Güvenli restart, ConfirmDialog onay akışı, SSH `systemctl is-active cron` active), Hatalı girdi ve güvenlik (400 `unsupported_managed_service`, `unsupported_managed_service_action`, `managed_service_confirmation_required`, MariaDB/MySQL çakışma engeli), Plesk eşdeğerlik eksikliği (Plesk Services Management başlangıç türü / Startup Type ve PHP-FPM/PowerDNS servis kontrolleri UI'da eksik; `test.fail` ile işaretli).
- `e2e/ozellik/sys-02.spec.js`:
  - **Sıfır mock ilkesi:** Gerçek panel arayüzü (`/servers`), gerçek backend REST API (`/api/panel/servers/:id/services`, control endpoint'leri) ve SSH ile test sunucusunda (`yunpanel-test`) `systemctl is-active cron` / `systemctl is-active nginx` kontrolleri ile yazılmıştır. Sahte veri, mock veya stub kesinlikle yoktur.
  - **Fiziksel doğrulama:**
    1. UI üzerinden Sistem Servisleri tablosu, servis rozetleri ("Çalışıyor") ve tarama akışı doğrulanmıştır.
    2. API üzerinden servis durumları (`cron.active === true`, `cron.installed === true`) sorgulanmış ve SSH ile systemd üzerinde aktifliği kanıtlanmıştır.
    3. `cron` servisi için UI üzerinde ConfirmDialog onay akışıyla güvenli yeniden başlatma yapılmış ve sonrasında servis çalışırlığı SSH ile teyit edilmiştir.
    4. Geçersiz servis adı, geçersiz aksiyon ve eksik/hatalı konfirmasyon metni için 400 Bad Request yanıtları ve MariaDB kurulu iken MySQL çakışma engeli UI üzerinde doğrulanmıştır.
    5. Plesk Services Management başlangıç türü (Startup Type) ve PHP-FPM / PowerDNS servis kontrolleri eksikliği `test.fail` ile belgelenmiştir.
  - **Kaynak temizliği ve sıfır artık ilkesi:**
    - `afterAll` hook'unda test edilen servislerin sistemde çalışır durumda olduğu garantiye alınmış, test sonrasında yapılan SSH kontrolünde `cron` ve `nginx` servislerinin `active` çalıştığı doğrulanmıştır (0 artık).

---

## 2. Bağımsız Test Koşusu (Reviewer Koşusu)

- Test bağımsız olarak gerçek `.28` test sunucusunda çalıştırıldı:
  `AGENT_N=1 npx playwright test e2e/ozellik/sys-02.spec.js --reporter=line`
  - Çıktı:
    ```
    Running 4 tests using 1 worker

    [1/4] …yol 1: Sistem servislerini listeleme, durum rozetleri ve tarama (inspect)
    [2/4] …ol 2: Güvenli servis yeniden başlatma (cron restart) işlemi ve onay akışı
    [3/4] …rdi ve güvenlik: Geçersiz servis, geçersiz aksiyon ve eksik onay koruması
    [4/4] …rtup Type / Boot) yapılandırması ve PHP-FPM / PowerDNS servis kontrolleri
      4 passed (26.8s)
    ```
  - Sonuç: **4 passed (26.8s)** (1 beklenen `test.fail` Plesk eşdeğerlik bulgusu ile tam uyumlu).

---

## 3. Kalite Kapıları ve Kaynak Kontrolü

- `npm run lint`: Repository policy validation passed.
- Kaynak kontrolü: Test sonrasında sunucuda ve yerel depoda artık kaynak bırakılmamıştır (`cron` ve `nginx` aktif; 0 artık).

---

## 4. Karar Özeti

T197 görevi kapsamındaki SYS-02 test senaryosu ve raporu; sıfır mock, fiziksel SSH doğrulamaları, satır sayısı kuralı (28 <= 40) ve kalite gereksinimlerine tam olarak uymaktadır. Görev ONAYLANMIŞTIR (`accept`).
