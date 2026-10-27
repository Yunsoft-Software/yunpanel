# T138 İnceleme Notu (Review)

- **Tarih:** 2026-10-27
- **İnceleyen:** AGENT_3
- **İncelenen Görev:** T138 · Manuel test: SYS-05 — Yönetici terminali, olay tetikleyicileri ve onarım araçları
- **Yapan:** AGENT_4
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/sys-05.spec.js` (Playwright E2E testi)
- `docs/manuel-test/SYS-05.md` (Manuel test raporu)
- `tasks/review/T138.md` -> `tasks/done/T138.md` (Görev teslim / kabul raporu)

---

## 2. Doğrulama ve Bulgular

### A. Playwright Test Senaryoları (`.28` Gerçek Panel & Fiziksel Doğrulama)
- Mock, `page.route` veya sahte veri kesinlikle bulunmamaktadır; doğrudan `.28` test sunucusu ve backend API'sine karşı çalışmaktadır.
- `e2e/ozellik/sys-05.spec.js` bağımsız olarak çalıştırıldı (`AGENT_N=3 npx playwright test e2e/ozellik/sys-05.spec.js --reporter=line`):
  - **Mutlu Yol 1 (`mutlu yol 1: Yönetici kök terminali (WebSocket xterm PTY) açılması ve komut yürütme`):**
    - UI üzerinden `/servers` sayfasında root terminal başlatıldı.
    - `echo`, `id -u`, `whoami` komutları xterm içine yazılıp çalıştırıldı. Çıktıda `ROOT_EXEC_*`, `0` (uid 0) ve `root` doğrulandı.
    - Sunucuda çalışan PTY / terminal shell prosesinin varlığı fiziksel olarak teyit edildi.
    - Terminal güvenle kapatıldı.
  - **Mutlu Yol 2 (`mutlu yol 2: ttyd oturumu başlatma, fiziksel soket kanıtı ve oturumu sonlandırma`):**
    - `/api/panel/terminal/capabilities` uç noktasından sunucu kapsamlı capability üretildi (43 karakter).
    - `/api/panel/terminal/ttyd-sessions` üzerinden oturum başlatıldı (HTTP 201, UUID sessionId).
    - Fiziksel kanıt: Sunucuda `/run/yunpanel/ttyd/<sessionId>.sock` UNIX soket dosyasının varlığı `test -S` ile doğrulandı.
    - DELETE `/api/panel/terminal/ttyd-sessions/:id` ile oturum sonlandırıldı (HTTP 204) ve fiziksel soketin silindiği doğrulandı.
  - **Yetki ve Sınır Kontrolleri (`yetki ve sınır kontrolleri: yetkisiz terminal capability reddi ve site_manager sınırları`):**
    - Sahte capability ile oturum başlatma girişimi reddedildi (HTTP 400/401/403).
    - UI üzerinden dinamik geçici `site_manager` kullanıcısı oluşturuldu ve oturum açıldı.
    - `/servers` sayfasında sunucu kök terminali arayüzünün gizlendiği teyit edildi.
    - `site_manager` kullanıcısının root capability talep etmesi HTTP 403 ile engellendi.
  - **Onarım Araçları (`onarım araçları: site health repair API ve hatalı girdi denetimi`):**
    - `/api/panel/websites/:id/health/repair` uç noktasından `repair_permissions` işlemi çalıştırıldı (HTTP 200, `repairedLayer: filesystem`).
    - Geçersiz action ile yapılan çağrının HTTP 400 (`invalid_repair_action`) ile reddedildiği doğrulandı.
  - **Plesk Eşdeğerliği / Eksiklik Tespiti (`Plesk UI eşdeğerliği: Olay Tetikleyicileri (Event Handlers) ve Sistem Onarım Araçları (Repair Kit)`):**
    - Araçlar ve Ayarlar altında Plesk eşdeğeri merkezi Event Handlers ve Repair Kit UI ekranlarının bulunmaması `test.fail` ile belgelendi.
  - **Temizlik (`afterAll`):**
    - Geçici oluşturulan kullanıcı önce UI üzerinden, ardından doğrudan SQLite üzerinden silindi.
    - Artık ttyd prosesleri ve geçici soketler temizlendi.
  - **Koşu Sonucu:** 5 passed (1 test.fail beklenen eksiklikle geçti, toplam 48.3s).

### B. Rapor Formatı ve İçerik Kontrolü
- `docs/manuel-test/SYS-05.md`: 28 satır (≤40 satır kuralına tam uygun).
- Tablo yapıları ve bulgu formatı yönergeye uygun.

### C. Orkestra ve Bütünlük Kontrolleri
- `python3 orkestra/orchestrator.py verify --quick`: `doğrulama: ok; yeniden açılan: -; bulgu: -`
- `python3 orkestra/tasks.py lint`: `lint OK`
- `npm run lint`: `Repository policy validation passed.`

---

## 3. Karar ve Sonuç
T138 görevi başarıyla tamamlanmış, tüm kabul kriterlerini eksiksiz karşılamış olup `tasks.py accept T138 AGENT_3` ile onaylanmıştır.
