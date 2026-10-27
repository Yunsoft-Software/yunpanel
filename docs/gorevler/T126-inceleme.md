# T126 İnceleme Notu (Review)

- **Tarih:** 2026-10-27
- **İnceleyen:** AGENT_2
- **İncelenen Görev:** T126 · Manuel test: DOS-11 — SSH/SFTP/shell erişimi ve anahtarlar; kullanıcı izolasyonu
- **Yapan:** AGENT_3
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/dos-11.spec.js` (Playwright E2E testi)
- `docs/manuel-test/DOS-11.md` (Manuel test raporu)
- `tasks/review/T126.md` -> `tasks/done/T126.md` (Görev teslim raporu)

---

## 2. Doğrulama ve Bulgular

### A. Playwright Test Koşusu (`.28` Gerçek Panel)
`AGENT_N=2 npx playwright test e2e/ozellik/dos-11.spec.js --reporter=line` çalıştırıldı:
- 4 test koşuldu: **3 passed, 1 expectedly failed (`test.fail`)** (1.1m).
- Mock/`page.route`/stub veya sahte veri kesinlikle bulunmuyor; testler doğrudan `.28` test sunucusu API ve Web arayüzü üzerinde çalışıyor.
- **Mutlu Yol 1:** Panel web arayüzünde (`/websites/:id/access`) SSH/SFTP erişim parametreleri (protokol, port 22, docroot, Unix kullanıcısı, izolasyon rozeti, terminal ve dosya yöneticisi linkleri) eksiksiz doğrulandı.
- **Mutlu Yol 2:** SFTP/SSH public key ekleme, listeleme (`/api/websites/:id/sftp/keys`), sunucuda fiziksel authorized_keys kontrolü, Unix kullanıcı/UID izolasyonu ve OpenSSH chroot kuralları başarıyla doğrulandı.
- **Hatalı Girdi:** Geçersiz public key formatı ve eksik/fazla alanlar için 400 Bad Request kontrolleri doğrulandı.
- **Plesk Eşdeğerliği (`test.fail`):** Panel UI üzerinde SSH anahtarı ekleme ve kullanıcı parolası belirleme formunun bulunmadığı (özelliğin yalnızca arka uç API seviyesinde mevcut olduğu) `test.fail` ile doğru şekilde belgelendi.

### B. Fiziksel Kanıtlar (SSH Doğrulaması)
- Host üzerinde `/etc/ssh/yunpanel-authorized-keys/<user>` dosyasında public key varlığı doğrulandı.
- Dedicated Unix kullanıcısı UID kontrolü yapıldı (`id <user>` -> non-root kullanıcı, UID != 0).
- OpenSSH chroot ve izolasyon konfigürasyonu `/etc/ssh/sshd_config.d/90-yunpanel-sftp-*.conf` dosyasında `internal-sftp -d /site -u 0027`, `PermitTTY no`, `PasswordAuthentication no` kurallarıyla doğrulandı.

### C. Temizlik (`afterAll`) ve Fiziksel Sunucu Durumu
- `afterAll` hook'unda eklenen test anahtarı hem API (`POST /revoke`) hem de SSH ile `/etc/ssh/yunpanel-authorized-keys/<user>` dosyasından temizlendi.

### D. Rapor Formatı ve Orkestra Kontrolleri
- `docs/manuel-test/DOS-11.md`: 29 satır (≤40 satır kuralına uygun), `docs/manuel-test/YONTEM.md` şablonuna tam uyumlu.
- `python3 orkestra/orchestrator.py verify --quick`: `doğrulama: ok; yeniden açılan: -; bulgu: -`
- `python3 orkestra/tasks.py lint`: `lint OK`

---

## 3. Karar Özeti
T126 görevinin tüm kabul kriterleri eksiksiz karşılanmıştır. Görev ONAYLANMIŞTIR (`accept`).
