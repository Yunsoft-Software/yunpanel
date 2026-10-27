# T128 İnceleme Notu (Review)

- **Tarih:** 2026-10-27
- **İnceleyen:** AGENT_4
- **İncelenen Görev:** T128 · Manuel test: RUN-05 — Node.js sürümü, app root, startup dosyası ve environment
- **Yapan:** AGENT_3
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/run-05.spec.js` (Playwright E2E testi)
- `docs/manuel-test/RUN-05.md` (Manuel test raporu)
- `tasks/review/T128.md` -> `tasks/done/T128.md` (Görev teslim raporu)

---

## 2. Doğrulama ve Bulgular

### A. Playwright Test Senaryoları (`.28` Gerçek Panel)
- Mock/`page.route`/stub veya sahte veri kesinlikle bulunmuyor; test doğrudan `.28` test sunucusuna ve Nginx HTTP portuna karşı çalışıyor.
- **Hatalı Girdi:** Başlangıç dosyasında path traversal / geçersiz karakter (`../../../etc/passwd`) denendiğinde form/API doğrulama hatası (`ws-notice-error`, alert vb.) beklendiği gibi yakalandı ve onaylandı.
- **Mutlu Yol:**
  - Sihirbaz üzerinden yeni Node.js sitesi kurulumu (`new_node`), startup dosyasının `app.js` olarak yapılandırılması.
  - Sitenin Node.js sekmesinde (`/websites/:id/node`) Node.js 24 çalışma zamanı tespiti.
  - Ortam değişkenleri (Environment Variables) sekmesinde düz metin (`APP_RUN_STAGE=staging_test`) ve gizli (`SECRET_API_KEY`) değişken ekleme; gizli değerin `••••••••` şeklinde maskelendiğinin doğrulanması.
  - Nginx vhost / ters vekil portuna fiziksel doğrudan HTTP GET isteği (`checkDirectHttp`) ile HTTP yanıt doğrulaması.
- **Temizlik (`afterAll`):** Test sırasında oluşturulan site `removeWebsiteById` ile panel üzerinden silinerek sunucuda yetim kaynak bırakılmadı.

### B. Rapor Formatı ve İçerik Kontrolü
- `docs/manuel-test/RUN-05.md`: 29 satır (≤40 satır kuralına uygun), `docs/manuel-test/YONTEM.md` şablonuna tam uyumlu.
- Plesk RUN-05 eşdeğerliği kapsamında arayüzde tespit edilen eksiklikler (Node.js sürüm seçici olmaması, salt-okunur gösterim) raporda "Panelde olmayan" bölümünde belgelenmiş; engelleyici veya kritik olmayan normal davranış olarak not edilmiştir.

### C. Orkestra ve Bütünlük Kontrolleri
- `python3 orkestra/orchestrator.py verify --quick`: `doğrulama: ok; yeniden açılan: -; bulgu: -`
- `python3 orkestra/tasks.py lint`: `lint OK`

---

## 3. Karar Özeti
T128 görevinin tüm kabul kriterleri eksiksiz karşılanmıştır. Görev ONAYLANMIŞTIR (`accept`).
