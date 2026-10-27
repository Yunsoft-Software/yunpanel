# T129 İnceleme Notu (Review)

- **Tarih:** 2026-10-27
- **İnceleyen:** AGENT_4
- **İncelenen Görev:** T129 · Manuel test: RUN-06 — Node paket kurulumu, script, restart ve loglar
- **Yapan:** AGENT_2
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/run-06.spec.js` (Playwright E2E testi)
- `docs/manuel-test/RUN-06.md` (Manuel test raporu)
- `tasks/review/T129.md` -> `tasks/done/T129.md` (Görev teslim / kabul raporu)

---

## 2. Doğrulama ve Bulgular

### A. Playwright Test Senaryoları (`.28` Gerçek Panel & Fiziksel Doğrulama)
- Kesinlikle mock, `page.route` veya sahte veri bulunmuyor; test doğrudan `.28` test sunucusuna, canlı Nginx, Passenger ve backend API'sine karşı çalışıyor.
- Test senaryoları:
  - **Hatalı Girdi:**
    - Geçersiz GitHub repository URL'si ile site oluşturma denemesi UI validasyonu ile reddedildi.
    - `/api/websites/:websiteId/application/process` uç noktasına geçersiz action gönderimi 400/404 ile fail-closed reddedildi.
  - **Mutlu Yol:**
    - Git ile gerçek Node.js sitesi kurulumu (`https://github.com/heroku/node-js-getting-started.git`).
    - `/websites/:id/node` yönetim ekranında Node.js sürümü (Node.js 24) ve branch (main) doğrulandı.
    - Yeniden başlatma (Restart) ve durum kontrolü yapıldı.
    - `/websites/:id/logs` ekranında log kaynağı seçimi, log tablosu ve indirme linki doğrulandı.
    - Fiziksel kanıtlar: Nginx vhost kaydı, `passenger_enabled on`, `passenger_app_type node` SSH ile teyit edildi; doğrudan HTTP yanıtı (status > 0) alındı.
  - **Plesk Eşdeğerliği (test.fail):**
    - Panel UI üzerinde Plesk eşdeğeri bağımsız "NPM Install <paket>" ve "Run Script" butonlarının eksikliği `test.fail` ile işaretlendi.
  - **Temizlik:**
    - `afterAll` hook'unda oluşturulan web sitesi kalıcı olarak silindi.

### B. Rapor Formatı ve İçerik Kontrolü
- `docs/manuel-test/RUN-06.md`: 28 satır (≤40 satır kuralına uygun), `docs/manuel-test/YONTEM.md` şablonuna tam uyumlu.
- Fiziksel kanıtlar ve mevcut test değerlendirmeleri eksiksiz.

### C. Orkestra ve Bütünlük Kontrolleri
- `python3 orkestra/orchestrator.py verify --quick`: `doğrulama: ok; yeniden açılan: -; bulgu: -`
- `python3 orkestra/tasks.py lint`: `132 tasks, lint OK`

---

## 3. Karar Özeti
T129 görevinin tüm kabul kriterleri eksiksiz karşılanmıştır. RUN-06 Playwright senaryosu, Node paket kurulumu ve log doğrulaması onaylandı (`accept`).
