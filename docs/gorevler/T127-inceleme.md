# T127 İnceleme Notu (Review)

- **Tarih:** 2026-10-27
- **İnceleyen:** AGENT_4
- **İncelenen Görev:** T127 · Manuel test: RUN-01 — Document root, sistem kullanıcısı ve hosting ayarları
- **Yapan:** AGENT_1
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/run-01.spec.js` (Playwright E2E testi)
- `docs/manuel-test/RUN-01.md` (Manuel test raporu)
- `tasks/review/T127.md` -> `tasks/done/T127.md` (Görev teslim raporu)

---

## 2. Doğrulama ve Bulgular

### A. Playwright Test Senaryoları (`.28` Gerçek Panel & Fiziksel Doğrulama)
- Kesinlikle mock, `page.route` veya sahte veri bulunmuyor; test doğrudan `.28` test sunucusuna, Linux SSH ve Nginx HTTP portuna karşı çalışıyor.
- **Mutlu Yol:**
  - Panel üzerinden yeni statik web sitesi oluşturuldu (`/websites/new`).
  - `/websites/:id/access` ekranında `Dedicated Unix kullanıcısı (İzole)` rozeti, Unix kullanıcı adı (`yunapp-...`) ve Belge kök dizini doğrulandı.
  - Fiziksel Linux SSH kontrolüyle kullanıcının sistemde varlığı (`id <unixUser>`, non-root, `uid!=0`) ve docroot dizini doğrulandı.
  - `/websites/:id/hosting` ekranında document root `public` alt dizinine ayarlandı ve "Kaydet ve uygula" ile uygulandı.
  - Fiziksel Nginx vhost dosyasında (`/etc/nginx/sites-enabled/yunpanel-<domain>.conf`) `root <docroot>/public;` ve `disable_symlinks on from=<docroot>;` direktifleri doğrulandı.
  - Fiziksel doğrudan HTTP isteği (157.180.11.28 IP'sine Host başlığı ile) ile HTTP 200 OK ve `<h1>RUN-01 OK</h1>` çıktısı teyit edildi.
- **Hatalı Girdi:**
  - Document root alanında path traversal (`../../../etc/passwd`) denendiğinde form ve panel doğrulaması beklendiği gibi hata uyarısı verdi.
  - Fiziksel Nginx config dosyasında traversal yolunun yer almadığı ve önceki geçerli document root'un korunduğu doğrulandı.
- **Temizlik (`afterAll`):**
  - Test sırasında oluşturulan site `removeWebsiteById` ile panel üzerinden silinerek sunucuda yetim kaynak bırakılmadı.

### B. Rapor Formatı ve İçerik Kontrolü
- `docs/manuel-test/RUN-01.md`: 27 satır (≤40 satır kuralına uygun), `docs/manuel-test/YONTEM.md` şablonuna tam uyumlu.
- Plesk eşdeğerliğinde tespit edilen arayüz içi docroot klasör gezgini/seçicisi eksikliği "Panelde olmayan" bölümünde belgelenmiştir.

### C. Orkestra ve Bütünlük Kontrolleri
- `python3 orkestra/orchestrator.py verify --quick`: `doğrulama: ok; yeniden açılan: -; bulgu: -`
- `python3 orkestra/tasks.py lint`: `lint OK`

---

## 3. Karar Özeti
T127 görevinin tüm kabul kriterleri eksiksiz karşılanmıştır. Görev ONAYLANMIŞTIR (`accept`).
