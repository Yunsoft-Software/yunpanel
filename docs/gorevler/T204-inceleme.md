# T204 İnceleme Notu (Review)

- **Tarih:** 2026-10-28
- **İnceleyen:** AGENT_2
- **İncelenen Görev:** T204 · Manuel test: MON-05 — Servis watchdog/yeniden başlatma ve disk izleme
- **Yapan:** AGENT_1
- **Karar:** ONAY (ACCEPT)

---

## 1. İncelenen Değişiklikler ve Uyumluluk Denetimi

- `docs/manuel-test/MON-05.md`:
  - Satır sayısı kontrolü: 29 satır (kural: <= 40 satır; tam uyumlu).
  - Tablo formatı ve bulgular eksiksiz: Mutlu yol (`/servers` Sistem servisleri tablosu, 'Kaydı yenile' butonu, Nginx satırı, Dashboard Disk kullanım halkası ve %/GB metrikleri, API watchdog status ve check raporları), Hatalı girdi denetimi (boş gövde `target_parameters_required`, eksik onay tokeni `confirmation_required`, geçersiz hedef türü `invalid_target_type` ile 400 Bad Request yanıtları), Fiziksel kanıtlar (SSH `df -B1 /` disk kullanımı %19 ve `systemctl is-active nginx` servis durumu ile panel envanteri ve watchdog aktiflik eşleşmesi), Plesk eşdeğerlik eksikliği (Plesk Tools & Settings / Watchdog eklentisi disk kota alarm eşikleri, servis yeniden başlatma kuralı ve e-posta bildirim frekansı arayüzü eksikliği; `test.fail` ile işaretli).
- `e2e/ozellik/mon-05.spec.js`:
  - **Sıfır mock ilkesi:** Gerçek UI (`/servers`, `/dashboard`), gerçek panel REST API (`/api/panel/system/watchdog/status`, `/api/panel/system/watchdog/check`, `/api/panel/system/watchdog/recover`) ve canlı test sunucusunda (`yunpanel-test`) SSH üzerinden fiziksel sistem komutlarıyla (`df -B1 /`, `systemctl is-active nginx`) yazılmıştır. Mock veya stub veri kesinlikle yoktur.
  - **Fiziksel doğrulama:**
    1. `/servers` sayfasında Sistem servisleri kartı, Nginx satırı, servis durumu ve Kaydı yenile butonunun çalıştığı doğrulanmıştır.
    2. Dashboard sayfasında Sunucu kaynakları kartı altındaki Disk kullanım halkası (`.ws-usage-ring strong`) ve GB metrikleri doğrulanmıştır.
    3. API üzerinden watchdog status ve on-demand check uç noktaları çağrılarak servis durum envanteri doğrulanmıştır.
    4. Canlı sunucuda SSH ile `df -B1 /` çalıştırılarak fiziksel disk kullanım yüzdesi panel envanteriyle (`inventory.filesystem`) %5 tolerans dahilinde eşleştirilmiş, SSH `systemctl is-active nginx` çıktısı watchdog servis aktiflik kaydıyla eşleşmiştir.
    5. Hatalı girdi senaryolarında eksik parametreler ve geçersiz türler 400 Bad Request ile güvenli şekilde reddedilmiştir.
    6. Plesk Watchdog eklentisi UI yapılandırma eksikliği `test.fail` olarak belgelenmiştir.
  - **Kaynak temizliği (0 artık ilkesi):**
    - Sunucuda herhangi bir kalıcı nesne veya geçici dosya oluşturulmamış, `afterAll` hook'unda panel sunucu envanteri ve watchdog sağlık durumu doğrulanmıştır.

---

## 2. Bağımsız Test Koşusu (Reviewer Koşusu)

- Test bağımsız olarak gerçek `.28` test sunucusunda AGENT_2 tarafından çalıştırıldı:
  `AGENT_N=2 npx playwright test e2e/ozellik/mon-05.spec.js --reporter=line`
  - Çıktı:
    ```
    Running 4 tests using 1 worker

    [1/4] …tlu yol: Servis sağlık denetimi, watchdog durumu sorgulama ve disk izleme
    [2/4] …i: Geçersiz parametreler ve eksik onay tokeni ile 400 validation kontrolü
    [3/4] …anıt: Canlı sunucu SSH ile df -h / ve systemctl is-active karşılaştırması
    [4/4] … eklentisi / servis alarm eşikleri ve otomatik kurtarma arayüzü eksikliği
      4 passed (25.2s)
    ```
  - Sonuç: **4 passed (25.2s)** (1 beklenen `test.fail` Plesk eşdeğerlik bulgusu ile tam uyumlu).

---

## 3. Kalite Kapıları ve Kaynak Kontrolü

- `npm run lint`: Repository policy validation passed.
- Kaynak kontrolü: Test sonrası panel ve sunucu stabil durumda, herhangi bir geçici veya artık kaynak bırakılmamıştır.

---

## 4. Sonuç

T204 görevi için tüm kabul kriterleri eksiksiz karşılanmış, sıfır mock kuralı ve gerçek donanım/SSH doğrulamaları başarıyla yapılmıştır. Görev onaylanmıştır.
