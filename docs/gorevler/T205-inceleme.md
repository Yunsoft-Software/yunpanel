# T205 İnceleme Notu (Review)

- **Tarih:** 2026-10-27
- **İnceleyen:** AGENT_4
- **İncelenen Görev:** T205 · Manuel test: WP-01 — WordPress kurma, tarama, bağlama ve admin girişi
- **Yapan:** AGENT_3
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/wp-01.spec.js` (Playwright E2E testi)
- `docs/manuel-test/WP-01.md` (Manuel test raporu)
- `tasks/review/T205.md` (Görev teslim raporu)

---

## 2. Doğrulama ve Bulgular

### A. Mock / Sahte Veri Kontrolü
- `e2e/ozellik/wp-01.spec.js` dosyası incelendi. Hiçbir mock, stub, `page.route` veya sahte veri bulunmamaktadır.
- Test doğrudan canlı `.28` test sunucusuna karşı çalışmakta, gerçek DOM elemanlarını kullanmaktadır.

### B. Senaryo Kapsamı ve Fiziksel Kanıtlar
1. **Ön Hazırlık / Site Kurulumu:**
   - Panel arayüzünden (`/websites/new`) PHP barındırma türünde gerçek bir web sitesi oluşturuldu, provisioning adımları (dizinler, Unix kullanıcısı, PHP-FPM) tamamlandı.
2. **Hatalı Girdi Senaryosu:**
   - Kısa parola (<16 karakter) HTML5 `validity.tooShort` doğrulamasıyla form seviyesinde engellendi.
   - Geçersiz veritabanı adı (`invalid-db!@#name`) pattern (`validity.patternMismatch`) doğrulamasıyla güvenli şekilde engellendi.
3. **Mutlu Yol (WordPress Kurulum Sihirbazı & Canlı Doğrulama):**
   - Panel üzerinden WordPress kurulum formu dolduruldu; otomatik veritabanı açılması, WP core dosyalarının indirilmesi ve kurulumu başarıyla tamamlandı.
   - Arayüzde "Kurulu" rozeti ve WordPress sürüm numarası doğrulandı.
   - SSH ile sunucuda `wp-config.php` fiziksel olarak incelendi; `DB_NAME`, `DB_USER`, `$table_prefix` tanımlarının varlığı doğrulandı.
   - Canlı HTTP 200 yanıtı ve WordPress içeriği (`wp-content`, `wp-includes`, `wp-json`) doğrudan port 80 üzerinden doğrulandı.
   - `/wp-login.php` üzerinden WordPress yönetici girişi yapıldı; `/wp-admin/` URL'ine yönlenme ve `#wpadminbar` elementinin görünürlüğü doğrulandı.
4. **Plesk Eşdeğerlik Eksikliği Senaryosu:**
   - Plesk WP Toolkit'te bulunan harici WordPress tarama/bağlama ("Scan" / "Attach") ve tek tıkla şifresiz admin SSO girişi ("Log in") eksikliği `test.fail` ile işaretlenerek belgelendi.

### C. Temizlik (`afterAll`)
- `test.afterAll` bloğunda hem bu senaryonun oluşturduğu site hem de geçmiş test artıkları `removeWebsiteById` üzerinden panelden eksiksiz silinmektedir.

### D. Rapor ve Kurallar Uyumu
- `docs/manuel-test/WP-01.md`: 29 satır (≤40 satır kuralına uygun), şablona tam uyumlu.
- `npm run lint`: Repository policy validation passed (0 hata).
- `python3 orkestra/tasks.py lint`: lint OK.
- `python3 orkestra/orchestrator.py verify --quick`: Doğrulama başarılı.

---

## 3. Karar Özeti
T205 görevi tüm kabul kriterlerini, kural kısıtlamalarını ve fiziksel doğrulama gereksinimlerini eksiksiz karşılamaktadır. Görev ONAYLANMIŞTIR (`accept`).
