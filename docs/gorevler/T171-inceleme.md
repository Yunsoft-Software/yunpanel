# T171 İnceleme Notu (Review)

- **Tarih:** 2026-10-28
- **İnceleyen:** AGENT_2
- **İncelenen Görev:** T171 · Manuel test: DNS-02 — TTL, SOA, zone şablonu ve şablon değişimini uygulama
- **Yapan:** AGENT_1
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/dns-02.spec.js` (Playwright E2E testi)
- `docs/manuel-test/DNS-02.md` (Manuel test raporu, 31 satır)
- `tasks/done/T171.md` (Görev teslim raporu)

---

## 2. Doğrulama ve Bulgular

### A. Mock / Sahte Veri Kontrolü
- `e2e/ozellik/dns-02.spec.js` dosyası incelendi. Hiçbir mock, stub, `page.route` veya sahte yanıt/veri kullanılmamıştır.
- Sıfır mock ilkesine tam uyulmuştur.

### B. Senaryo Kapsamı ve Fiziksel Kanıtlar
1. **Mutlu Yol (Özel TTL Tanımlama, Güncelleme ve Fiziksel Doğrulama):**
   - `webrich.news` DNS sekmesinde yeni manual TXT kaydına özel 7200 saniye TTL verildi, kaydedildi ve arayüzde görüntülendi.
   - SSH ile PowerDNS yerel sunucusuna `dig @127.0.0.1` sorgusu yapılarak cevaptaki TTL'in 7200 olduğu fiziksel olarak doğrulandı.
   - Kayıt düzenlenerek TTL 1800 yapıldı; `dig` ile 1800 TTL kanıtlandı.
   - Kayıt arayüz üzerinden onay kodu ile silindi; `dig` ile kaydın fiziksel olarak silindiği kanıtlandı.
2. **Mutlu Yol (SOA Politikası ve Zone Template Senkronizasyonu):**
   - `/settings?section=dns` sayfasında DNS kimliği ve SOA politikası parametreleri incelendi.
   - SSH ile `dig @127.0.0.1 webrich.news SOA` sorgusu yapılarak 7 SOA alanının fiziksel olarak yetkili sunucuda doğru yazıldığı doğrulandı.
   - Sitenin DNS sekmesinde Zone Template diff paneli yenilenerek Template sürümü, DNS identity revizyonu ve SOA serial durumu teyit edildi.
3. **Hatalı Girdi ve Sınır Kontrolü:**
   - TTL girdi alanında 60'tan küçük değerlerin (`30`) HTML5 min/max kısıtıyla engellendiği doğrulandı.
   - SOA düzenleme formunda `expire <= refresh` durumunda `SOA expire must be greater than refresh` doğrulama uyarısı verildiği ve hatalı kaydın oluşmadığı kanıtlandı.
4. **Plesk Eşdeğerlik Eksiklikleri (`test.fail`):**
   - BULGU DNS-02-A: Panel arayüzünde Genel DNS Zone Şablonu kayıt yönetim arayüzü bulunmamaktadır (yalnızca API mevcut).
   - BULGU DNS-02-B: DNS şablon değişikliklerini tüm mevcut alan adlarının zone'larına topluca uygulama (Bulk Apply DNS Template Changes) özelliği bulunmamaktadır.

### C. Test Koşusu ve Kararlılık
- Eşzamanlı test kilidi `sunucu-28-2` AGENT_2 tarafından alındı.
- Test bizzat koşturuldu: `AGENT_N=2 npx playwright test e2e/ozellik/dns-02.spec.js`
  - Sonuç: `5 passed (51.5s)` (2 `test.fail` dahil, 0 hata).
- Test bitiminde `sunucu-28-2` kilidi serbest bırakıldı.

### D. Temizlik ve Kaynak Kontrolü
- `afterAll` hook'unda oluşturulan tüm geçici test kayıtları (`prefix-ttl`, `prefix-err`) `pdnsutil delete-rrset` ile fiziksel olarak temizlenmektedir.

### E. Rapor ve Kalite Kapıları
- `docs/manuel-test/DNS-02.md`: 31 satır (≤40 satır kuralına uygun), şablona tam uyumlu.
- `python3 orkestra/tasks.py lint`: `lint OK`.
- `python3 orkestra/orchestrator.py verify --quick`: `doğrulama: ok; yeniden açılan: -; bulgu: -` (başarılı).

---

## 3. Sonuç
T171 görevi istenen tüm kriterleri (sıfır mock, fiziksel SSH doğrulaması, temizlik hook'u, ≤40 satır rapor, Playwright ve kalite kapıları) eksiksiz sağlamaktadır. Görev onaylanmıştır.
