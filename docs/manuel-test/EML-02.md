# EML-02: Mailbox Forwarding, Alias ve Yerel Kopya Tercihleri

### Kapsam ve İnceleme
- **Özellik:** Email alias CRUD işlemleri, mailbox forwarding modları (`copy` yerel kopya saklama / `redirect` yalnızca iletme) ve döngüsel/kendine yönlendirme engelleme.
- **İncelenen Mevcut Testler:**
  1. `apps/api/test/mail-alias-http.test.js`: GEÇERLİ (Alias oluşturma/güncelleme/silme ve kendine yönlendirme doğrulaması).
  2. `apps/api/test/mailbox-forwarding-http.test.js`: GEÇERLİ (Forwarding `copy`/`redirect` modları ve döngü engeli).
  3. `apps/api/test/mail-configuration-forwarding.test.js`: GEÇERLİ (Dovecot Sieve script derleme ve SRS gereksinimleri).

### Playwright E2E Doğrulaması
- **Test Dosyası:** `e2e/ozellik/eml-02.spec.js`
- **Koşu Komutu:** `AGENT_N=3 npx playwright test e2e/ozellik/eml-02.spec.js --reporter=line`
- **Sonuç:** `2 passed (1.3m)` (Sıfır mock, canlı sunucu ve gerçek tarayıcı).

### Senaryolar ve Fiziksel Kanıtlar
1. **Mutlu Yol (Alias CRUD & Forwarding Modları):**
   - **Alias:** UI üzerinden oluşturuldu, `virtual-mail.sqlite3` (`virtual_aliases`) tablosunda kaynak/hedef doğrulandı, düzenlendi, güncellenen hedef doğrulandı ve silinip tablodan kaldırıldığı teyit edildi.
   - **Forwarding "copy" Modu:** UI'da `Bir kopyasını ilet` seçildi; `/etc/dovecot/yunpanel-forwarding.sieve` içinde `redirect :copy "<dst>"; keep;` direktifleri doğrulandı.
   - **Forwarding "redirect" Modu:** UI'da `Yalnız yönlendir` seçildi; Sieve dosyasında `:copy` olmadan doğrudan `redirect "<dst>";` direktifi doğrulandı.
   - **Forwarding Kaldırma:** Modal onayıyla kaldırıldı; Sieve dosyasından kuralın temizlendiği ve UI'da `Mevcut: Yapılandırılmadı` durumuna dönüldüğü doğrulandı.
2. **Hatalı Girdi (Kendine / Döngüsel Yönlendirme):**
   - Alias hedefi olarak kendine yönlendirme (`source == destination`) girildiğinde arayüzde hata mesajı gösterildi, modal açık tutuldu ve veritabanına yazılmadı.

### Temizlik
- `teml02-a3-*` posta kutuları, takma adları, forwarding kayıtları ve Sieve blokları test sonunda temizlendi; `sqlite3` üzerinde 0 kayıt kaldığı doğrulandı.
