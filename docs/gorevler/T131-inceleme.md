# T131 İnceleme Notu — Manuel test: DB-05 — Dump import/export, kopyalama ve backup/restore

- **İnceleyen:** AGENT_4
- **Tarih:** 2026-10-27 13:17
- **İncelenen Commit:** `4db7e70a` (AGENT_2)
- **Karar:** KABUL (ACCEPT)

---

## 1. İnceleme Özeti ve Bulgular

### Önceki Ret Gerekçesinin Giderilmesi:
- Önceki incelemede belirtilen `test.afterAll` eksikliği giderilmiştir.
- `e2e/ozellik/db-05.spec.js` dosyasına eklenen `test.afterAll` bloğunda:
  - Veritabanı kimliği (`database-credential`) önizleme ve silme finalization akışı yürütülüyor.
  - Veritabanı bağlamı (`database-binding`) gerekirse yedeklenip silme önizleme, job bekleme ve finalize akışı uygulanıyor.
  - Test veritabanı şeması doğrudan sunucu API'si üzerinden kaldırılıyor.
  - Hata durumunda fail-safe yakalama ve context kapatma güvenli şekilde uygulanıyor.

### Doğrulama ve Kriter Uygunluğu:
1. **Mock ve Sahte Veri:**
   - Sıfır mock, sıfır `page.route` veya sahte yanıt.
   - Doğrudan test sunucusuna (`.28`) ve gerçek API/UI bileşenlerine karşı çalışıyor.
2. **Fiziksel Kanıtlar:**
   - Vendor dump yedeği alma: `database.backup` job (`backedUp: true`, 64 karakter SHA256 checksum, pozitif `dumpBytes`).
   - Geri yükleme (restore): `restore-preview` digest doğrulaması, `database.restore` job'ı (`verified: true`, `preRestoreDumpSha256`).
   - phpMyAdmin SQL dışa aktar köprüsü: URL yönlendirmesinde `route=/database/export` ve `db=...` parametreleri ile phpMyAdmin başlığı.
   - Hatalı girdi ve güvenlik: Yanlış onay metninde butonun disabled kalması, geçersiz checksum/digest ile 400/404 fail-closed API yanıtı.
3. **Dokümantasyon:**
   - `docs/manuel-test/DB-05.md` dosyası 27 satırdır (≤ 40 satır kuralına uygun).
   - `tasks/review/T131.md` eksiksiz doldurulmuş ve commit referansları belirtilmiştir.
4. **Test ve Orkestra Koşuları:**
   - `python3 orkestra/orchestrator.py verify --quick`: `doğrulama: ok; yeniden açılan: -; bulgu: -`.
   - `python3 orkestra/tasks.py lint`: `lint OK`.
   - Gerçek test koşusu (`sunucu-28-4` kilidiyle): `AGENT_N=4 npx playwright test e2e/ozellik/db-05.spec.js` -> 2 passed (29.7s).

---

## 2. Sonuç
Görev sözleşmesindeki tüm kabul kriterleri eksiksiz karşılanmış, temizlik adımları doğrulanmış ve test başarıyla geçmiştir. Görev kabul edilmiştir.
