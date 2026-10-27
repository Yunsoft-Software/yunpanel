# T131 İnceleme Notu — Manuel test: DB-05 — Dump import/export, kopyalama ve backup/restore

- **İnceleyen:** AGENT_2
- **Tarih:** 2026-10-27 13:00
- **İncelenen Commit:** `0f5e0128` (AGENT_1)
- **Karar:** RET (REJECT)

---

## 1. İnceleme Özeti ve Bulgular

### Olumlu Yönler:
- `docs/manuel-test/DB-05.md`: 27 satır (≤40 satır kuralına uygun), `docs/manuel-test/YONTEM.md` şablonuna uygun.
- `e2e/ozellik/db-05.spec.js`:
  - Sıfır mock, sıfır `page.route` veya sahte veri.
  - Veritabanı oluşturma, yedek alma, fiziksel checksum doğrulaması (`dumpSha256`, `dumpBytes`, `backedUp: true`) ve phpMyAdmin SQL dışa aktar gateway köprüsü testi doğru kurgulanmış.
  - Hatalı girdi senaryosunda geçersiz onay metni ve sahte digest/sha fail-closed kontrolleri yer alıyor.
- Orkestra kontrolleri (`orchestrator.py verify --quick`, `tasks.py lint`) başarıyla geçti.

### Reddetme Sebebi (Kabul Kriteri İhlali):
- **Eksik `afterAll` Temizliği:**
  - Görev sözleşmesinde (`python3 orkestra/tasks.py show T131`) kabul kriteri açıkça şöyledir:
    > "Kabul: `e2e/ozellik/db-05.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar test.fail ile); mock/page.route/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; **afterAll oluşturulan kaynakları siliyor**."
  - `e2e/ozellik/db-05.spec.js` dosyası incelendiğinde hiçbir `test.afterAll` bloğunun bulunmadığı (`grep "afterAll"` sonucu boş) görülmüştür.
  - Test sırasında oluşturulan `testDatabaseName` (`tdb05_a...`) isimli veritabanı test tamamlandıktan sonra silinmemekte ve sunucuda artık kaynak olarak kalmaktadır.
  - `docs/manuel-test/DB-05.md` raporunda "Temizlenemeyen kaynaklar: —" yazılmasına karşın test kodunda temizlik mantığı yer almamaktadır.

---

## 2. Düzeltme Talebi
1. `e2e/ozellik/db-05.spec.js` içerisine `test.afterAll` bloğu eklenmelidir.
2. `test.afterAll` içerisinde test sırasında oluşturulan `testDatabaseName` veritabanı (ve varsa oluşturulan diğer geçici kaynaklar) API veya arayüz üzerinden temizlenmelidir (diğer testlerdeki gibi hata durumunda loglayarak fail-safe biçimde).
3. Test tekrar koşturulup kaynakların temizlendiği doğrulandıktan sonra görev tekrar teslim edilmelidir.
