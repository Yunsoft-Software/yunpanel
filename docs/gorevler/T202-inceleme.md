# T202 İnceleme Notu (Review)

- **Tarih:** 2026-10-28
- **İnceleyen:** AGENT_1
- **İncelenen Görev:** T202 · Manuel test: MON-02 — Eşik/teslim alıcısı/bildirim tercihleri ve teslim kanıtı
- **Yapan:** AGENT_2
- **Karar:** ONAY (ACCEPT)

---

## 1. İncelenen Değişiklikler ve Uyumluluk Denetimi

- `docs/manuel-test/MON-02.md`:
  - Satır sayısı kontrolü: 29 satır (kural: <= 40 satır; tam uyumlu).
  - Tablo formatı ve bulgular eksiksiz: Mutlu yol (Bildirim merkezi çekmecesi ve Tercih/Eşik API yönetimi), Hatalı girdi kontrolleri (Geçersiz minSeverity 400 `invalid_min_severity`, geçersiz patch gövdesi 400 `invalid_preferences_patch`), Fiziksel kanıtlar (`/api/panel/notifications/deliveries` üzerinden test bildirimi teslim kaydı ve `/api/panel/notifications/status` motor durumu teyidi), Plesk eşdeğerlik eksikliği (Olay bazlı alıcı şablonları ve eşik UI ekranı eksikliği `test.fail` ile işaretli).
- `e2e/ozellik/mon-02.spec.js`:
  - **Sıfır mock ilkesi:** Gerçek UI (`NotificationCenterDrawer`, üst bar zil butonu, Görev Kuyruğu / Sistem Uyarıları / Bildirimler sekmeleri) ve canlı panel REST API rotaları (`/api/panel/notifications/*`) üzerinde sıfır mock/stub ile yazılmıştır.
  - **Fiziksel doğrulama:**
    1. UI üzerinde aaPanel tarzı `NotificationCenterDrawer` bileşeni, sekmeler ve kapanma akışı test edilmiştir.
    2. API seviyesinde bildirim tercihleri okuma (GET) ve güncelleme (PATCH) ile test bildirimi gönderimi (POST) 200 başarı kodu ile doğrulanmıştır.
    3. Hatalı girdi durumlarında 400 Bad Request yanıtları ve hata kodları denetlenmiştir.
    4. `/api/panel/notifications/deliveries` üzerinden teslimat durumu (`status: delivered`, `channel: panel`) ve `/status` rotasında motor durumu (`active`) fiziksel olarak doğrulanmıştır.
    5. Plesk eşdeğeri eksikliği `test.fail` ile belgelenmiştir.
  - **Kaynak temizliği (0 artık ilkesi):**
    - `afterAll` hook'unda başlangıç tercihleri (`initialPreferences`) PATCH isteği ile geri yüklenmiş, test ortamında kalıntı bırakılmamıştır.

---

## 2. Bağımsız Test Koşusu (Reviewer Koşusu)

- Test bağımsız olarak gerçek `.28` test sunucusunda AGENT_1 tarafından çalıştırıldı:
  `AGENT_N=1 npx playwright test e2e/ozellik/mon-02.spec.js --reporter=line`
  - Çıktı:
    ```
    Running 4 tests using 1 worker

    [1/4] …mecesi (Görev Kuyruğu, Uyarılar, Bildirimler) ve Tercih/Eşik API yönetimi
    [2/4] …irdi: Geçersiz minSeverity ve hatalı gövde 400 Bad Request ile reddedilir
    [3/4] … (/api/panel/notifications/deliveries) ve motor durumunun fiziksel teyidi
    [4/4] …lay bazlı e-posta/webhook alıcı şablonları ve eşik yapılandırma UI ekranı
      4 passed (21.4s)
    ```
  - Sonuç: **4 passed (21.4s)** (1 beklenen `test.fail` Plesk eşdeğerlik bulgusu ile tam uyumlu).

---

## 3. Kalite Kapıları ve Kaynak Kontrolü

- `npm run lint`: Repository policy validation passed.
- Kaynak kontrolü: Test sonrası bildirim tercihleri başlangıç durumuna döndürülmüş ve artık kaynak bırakılmamıştır.

---

## 4. Karar Özeti

T202 görevi kapsamındaki MON-02 test senaryosu ve raporu; sıfır mock ilkesine, fiziksel teslimat doğrulamalarına, satır sayısı kuralına (29 <= 40) ve projenin kalite standartlarına tam olarak uymaktadır. Görev ONAYLANMIŞTIR (`accept`).
