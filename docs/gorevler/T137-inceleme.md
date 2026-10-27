# T137 İnceleme Notu (Review)

- **Tarih:** 2026-10-27
- **İnceleyen:** AGENT_3
- **İncelenen Görev:** T137 · Manuel test: SEC-04 — Oturum/MFA/parola politikası ve API erişim sınırı
- **Yapan:** AGENT_4
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/sec-04.spec.js` (Playwright E2E testi)
- `docs/manuel-test/SEC-04.md` (Manuel test raporu)
- `tasks/review/T137.md` -> `tasks/done/T137.md` (Görev teslim / kabul raporu)

---

## 2. Doğrulama ve Bulgular

### A. Playwright Test Senaryoları (`.28` Gerçek Panel & Fiziksel Doğrulama)
- Mock, `page.route` veya sahte veri kesinlikle bulunmamaktadır; doğrudan `.28` test sunucusu ve backend API'sine karşı çalışmaktadır.
- `e2e/ozellik/sec-04.spec.js` içeriği ve çalıştırma sonucu (`AGENT_N=3 npx playwright test e2e/ozellik/sec-04.spec.js`):
  - **Mutlu Yol (`mutlu yol: oturum çerezleri, MFA & aktif oturum listesi ve CSRF sınır kontrolü`):**
    - `yunpanel_session` çerezinin `HttpOnly`, `SameSite=Strict` ve (HTTPS altında) `Secure` özellikleri doğrulandı.
    - `AccountDialog` modalında MFA ve aktif oturumlar ("Bu oturum") bölümlerinin varlığı kontrol edildi.
    - Sahte `Origin` (`https://evil-attacker-site.com`) ile yapılan POST isteklerinin API tarafından 403 Forbidden ile engellendiği doğrulandı.
    - Fiziksel SQLite sorgusu ile sunucu `/var/lib/yunpanel/control-plane/auth/auth.sqlite` üzerinde aktif oturum sayısı (`sessions` tablosunda `count >= 1`) teyit edildi.
  - **Hatalı Girdi 1 (`hatalı girdi 1: parola politikası (12 karakter kuralı ve uyuşmazlık denetimi)`):**
    - AccountDialog ve Settings/Users üzerinden 12 karakterden kısa parolaların HTML5 `checkValidity=false` ve `minLength=12` kısıtıyla engellendiği doğrulandı.
    - Yeni parola ile tekrarının uyuşmaması durumunda formun hata mesajı verdiği test edildi.
  - **Hatalı Girdi 2 (`hatalı girdi 2: API erişim sınırı ve kaba kuvvet (brute-force rate limit) koruması`):**
    - `/api/auth/login` uç noktasına 11 kez hatalı istek gönderilerek ilk 10 denemenin 400/401, 11. denemenin HTTP 429 (`rate_limited`) döndürdüğü teyit edildi.
    - Sunucudaki `auth.sqlite` `auth_limits` tablosunda ilgili kullanıcı özeti için `attempts >= 10` fiziksel olarak doğrulandı.
  - **Plesk Eşdeğerliği / Eksiklik Tespiti (`Plesk Eşdeğerliği: Global Güvenlik Politikası yönetim arayüzü`):**
    - Tools & Settings altında global oturum zaman aşımı ve parola karmaşıklığı ekranının olmaması kural gereği `test.fail` ile belgelendi.
  - **Temizlik (`afterAll`):**
    - Test süresince üretilen geçici rate limit ve kullanıcı kayıtları `auth.sqlite` üzerinden temizlenmektedir.
  - **Koşu Sonucu:** 4 passed (1 test.fail beklenen eksiklikle geçti, toplam 28.7s).

### B. Rapor Formatı ve İçerik Kontrolü
- `docs/manuel-test/SEC-04.md`: 26 satır (≤40 satır kuralına tam uygun).
- Tablo yapıları ve bulgu formatı yönergeye uygun.

### C. Orkestra ve Bütünlük Kontrolleri
- `python3 orkestra/orchestrator.py verify --quick`: `doğrulama: ok; yeniden açılan: -; bulgu: -`
- `python3 orkestra/tasks.py lint`: `lint OK`
- `npm run lint`: `Repository policy validation passed.`

---

## 3. Karar Özeti
T137 görevinin tüm gereksinimleri eksiksiz karşılanmıştır. SEC-04 senaryosu gerçek backend ve DB üzerinde sıfır mock ile çalışmakta olup görev onaylanmıştır (`accept`).
