# T170 İnceleme Notu (Review)

- **Tarih:** 2026-10-27
- **İnceleyen:** AGENT_2
- **İncelenen Görev:** T170 · Manuel test: DNS-01 — Domain zone ve DNS kayıt CRUD; desteklenen RR türleri matrisi
- **Yapan:** AGENT_4
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/dns-01.spec.js` (Playwright E2E testi)
- `docs/manuel-test/DNS-01.md` (Manuel test raporu, 27 satır)
- `tasks/review/T170.md` -> `tasks/done/T170.md` (Görev teslim / kabul raporu)

---

## 2. Doğrulama ve Bulgular

### A. Playwright Test Senaryoları (`.28` Gerçek Panel & Fiziksel Doğrulama)
- Mock, `page.route` veya sahte veri kesinlikle bulunmamaktadır; doğrudan `.28` test sunucusu ve backend API / PowerDNS bileşenlerine karşı çalışmaktadır.
- `e2e/ozellik/dns-01.spec.js` içeriği incelendi ve çalıştırıldı (`AGENT_N=2 npx playwright test e2e/ozellik/dns-01.spec.js --reporter=line --trace off`):
  - **Zone ve RR Matrisi Doğrulaması:**
    - Panel üzerinden webrich.news detayına ve DNS sekmesine gidiliyor.
    - Authoritative DNS zone ve `.dns-table` bölümleri, SOA serial, tablo başlıkları (`Ad`, `Tür`, `TTL`, `Kaynak`, `Değer`) teyit ediliyor.
    - "Manual kayıt ekle" modalı açılarak desteklenen tüm RR türlerinin (`A`, `AAAA`, `CNAME`, `MX`, `TXT`, `CAA`, `SRV`, `NS`, `SOA`) buton olarak varlığı doğrulanıyor.
  - **Mutlu Yol (`mutlu yol: DNS zone görüntüleme, desteklenen RR türleri matrisi ve A/CNAME/TXT/MX CRUD işlemleri ile yerel PowerDNS dig fiziksel doğrulaması`):**
    - A kaydı (`157.180.11.99`), CNAME kaydı (`webrich.news`), TXT kaydı (`"v=spf1 ~all"`), MX kaydı (`10 mail.webrich.news`) panelden oluşturuluyor ve DNS tablosunda doğrulanıyor.
    - A kaydı "Düzenle" modalı üzerinden `157.180.11.105` olarak güncelleniyor.
    - **Fiziksel Kanıt:** SSH üzerinden yerel PowerDNS sunucusuna doğrudan `dig @127.0.0.1` sorguları yapılarak:
      - A kaydı: `157.180.11.105`
      - TXT kaydı: `"v=spf1 ~all"`
      - CNAME kaydı: `webrich.news.`
      - MX kaydı: `10 mail.webrich.news.` değerleri fiziksel olarak teyit ediliyor.
    - CRUD Silme: Eklenen 4 kayıt `delete-dns:` onay kodu girilerek UI üzerinden siliniyor ve silinme sonrası yerel PowerDNS `dig` sorgusunun boş döndüğü fiziksel olarak doğrulanıyor.
  - **Hatalı Girdi (`hatalı girdi: geçersiz IP formatı girildiğinde form hata verir, kayıt oluşturulmaz ve DNS sunucusunda yansımaz`):**
    - Geçersiz IPv4 adresi (`999.999.999.999`) girildiğinde form modalında `invalid` hatası gösterildiği, modalın kapanmadığı, kaydın tabloda oluşmadığı ve PowerDNS `dig` sorgusunda da kaydın yansımadığı teyit ediliyor.
  - **afterAll Temizliği:**
    - Test sırasında oluşturulan kayıtlar `pdnsutil delete-rrset` ile fiziksel PowerDNS üzerinden güvence amaçlı temizleniyor.
  - **Çalıştırma Sonucu:** `2 passed (38.2s)` (AGENT_2 ortamında eksiksiz başarılı).

### B. Rapor Formatı ve İçerik Kontrolü
- `docs/manuel-test/DNS-01.md`: 27 satır (≤40 satır kuralına tam uygun), `docs/manuel-test/YONTEM.md` şablonuna eksiksiz uyumlu.
- Fiziksel kanıtlar ve mevcut test değerlendirmeleri (`e2e/06-authoritative-dns.spec.js`, `apps/api/test/dns-zone-records.test.js`, `apps/api/test/dns-zone-records-validation.test.js`) yerinde.

### C. Orkestra ve Bütünlük Kontrolleri
- `python3 orkestra/orchestrator.py verify --quick`: `doğrulama: ok; yeniden açılan: -; bulgu: -`
- `python3 orkestra/tasks.py lint`: `lint OK`
- `npm run lint`: `Repository policy validation passed.`

---

## 3. Karar Özeti
T170 görevinin tüm kabul kriterleri eksiksiz karşılanmıştır. DNS-01 Domain zone ve DNS kayıt CRUD; desteklenen RR türleri matrisi Playwright e2e testi ve dokümantasyonu onaylandı (`accept`).
