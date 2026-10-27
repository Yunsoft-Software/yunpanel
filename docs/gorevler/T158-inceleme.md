# T158 İnceleme Raporu — DEV-01 Uzak Git repository ve yerel Git repository

- **İnceleyen:** AGENT_1 (Kıdemli Denetçi)
- **Geliştirici (Maker):** AGENT_2
- **Tarih:** 2026-10-27 16:04
- **Karar:** **KABUL**

---

## 1. Kod ve Kural Denetimi

1. **Satır Sayısı Kontrolü:**
   - `docs/manuel-test/DEV-01.md`: 28 satır (`wc -l` <= 40 kuralı sağlandı).
2. **Sıfır Mock İlkesi:**
   - `e2e/ozellik/dev-01.spec.js` içinde `page.route`, mock HTTP yanıtı veya stub veri bulunmuyor.
   - Doğrudan canlı panel arayüzü, canlı backend API ve fiziksel host üzerinden test yürütüldü.
3. **Fiziksel Doğrulama:**
   - Canlı sunucu (157.180.11.28) üzerinde port 80 üzerinden HTTP routing yanıtı teyit edildi.
   - SSH üzerinden `/etc/nginx/sites-enabled/*` altında oluşturulan alan adına ait vhost konfigürasyonu ve `/var/lib/yunpanel/apps/*/releases/*` altındaki Git release yapısı doğrulandı.
4. **Temizlik ve İzolasyon:**
   - `test.afterAll` hook'unda oluşturulan site arayüzden (`/settings` -> Siteyi kalıcı sil) başarıyla silindi; artık kaynak bırakılmadı (0 artık ilkesi).
5. **Plesk Parity Farkları:**
   - Yerel Git repository (`git init --bare` / push deploy) eksikliği `test.fail` (BULGU DEV-01-A) olarak işaretlendi.
   - PHP/WordPress sitelerinde sonradan Git aracı bulunmaması ve 409 dönmesi `test.fail` (BULGU DEV-01-B) olarak işaretlendi.

---

## 2. Test Çalıştırma Kanıtı

- **Kilit:** `sunucu-28-1` (AGENT_1 tarafından alındı ve test sonrası bırakıldı).
- **Komut:** `AGENT_N=1 npx playwright test e2e/ozellik/dev-01.spec.js`
- **Sonuç:**
  ```text
  Running 4 tests using 1 worker

    ✓  1 …e oluştur, Git/Yayın sekmesini incele ve fiziksel kanıtı doğrula (28.8s)
    ✓  2 …y alanı boş veya geçersiz URL olduğunda form doğrulaması engeller (3.4s)
    ✘  3 …ocal Git repo / bare repo push deploy) desteği panelde bulunmuyor (6.5s)
    ✘  4 …e sonradan Git repository bağlama ve Git deploy aracı bulunmuyor (13.4s)
    4 passed (55.5s)
  ```

---

## 3. Sonuç

DEV-01 senaryoları tam ve eksiksiz olarak test edilmiş, kalite kapılarından geçmiş ve kabul edilmiştir.
