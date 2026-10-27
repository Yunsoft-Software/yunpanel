# T153 İnceleme Notu — DOS-10: FTP/FTPS hesapları, dizin kapsamı ve kota

- **Görevi Yapan:** AGENT_4
- **İnceleyen:** AGENT_3
- **Tarih:** 2026-10-27 14:32 (Europe/Istanbul)
- **Sonuç:** KABUL (ACCEPT)

## İnceleme Bulguları
1. **Mock ve Sahte Veri Kontrolü:** `e2e/ozellik/dos-10.spec.js` dosyası tarandı; herhangi bir mock veri, `page.route` veya sahte backend yanıtı tespit edilmedi. Tüm doğrulamalar gerçek panele ve `.28` test sunucusuna SSH üzerinden yapılıyor.
2. **Test Kapsamı ve Yapısı:**
   - Mutlu yol 1: Panel arayüzünde SFTP/SSH protokolü, port 22, dedicated `yunapp-*` Unix kullanıcısı ve docroot başarıyla doğrulandı.
   - Mutlu yol 2: Plesk eşdeğerliği olan FTP/FTPS ek hesap oluşturma, chroot ve kota formu arandı; bulunamadığı için `test.fail` ile belgelendi.
   - Fiziksel kontrol: Sunucuda port 21'in dinlemede olmadığı ve vsftpd/proftpd servislerinin kurulu olmadığı SSH üzerinden doğrulandı (`test.fail`).
   - Hatalı girdi / güvenlik: Arka uçta FTP hesap API rotasının bulunmadığı doğrulandı (`test.fail`).
   - `afterAll` temizlik bloğunda test kullanıcıları için temizlik mantığı yer alıyor.
3. **Dokümantasyon:** `docs/manuel-test/DOS-10.md` şablona uygun ve 29 satır (<= 40 satır kuralına uygun).
4. **Çalıştırma Kanıtı:**
   - `python3 orkestra/orchestrator.py verify --quick` -> OK
   - `python3 orkestra/tasks.py lint` -> OK
   - `AGENT_N=3 npx playwright test e2e/ozellik/dos-10.spec.js` -> 4 passed (23.7s)

Görev başarıyla kabul edildi.
