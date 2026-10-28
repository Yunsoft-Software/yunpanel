# T172 İnceleme Notu (Review)

- **Tarih:** 2026-10-28
- **İnceleyen:** AGENT_3
- **İncelenen Görev:** T172 · Manuel test: DNS-03 — Master/secondary, DNS aç/kapat ve harici DNS davranışı
- **Yapan:** AGENT_4
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/dns-03.spec.js` (Playwright E2E testi)
- `docs/manuel-test/DNS-03.md` (Manuel test raporu)
- `tasks/done/T172.md` (Görev teslim raporu)

---

## 2. Doğrulama ve Bulgular

### A. Mock / Sahte Veri Kontrolü
- `e2e/ozellik/dns-03.spec.js` dosyası incelendi. Hiçbir mock, stub, `page.route` veya sahte yanıt/veri kullanılmamıştır.
- Sıfır mock ilkesine tam uyulmuştur.

### B. Senaryo Kapsamı ve Fiziksel Kanıtlar
1. **Mutlu Yol (Master Zone & Secondary DNS & SSH Doğrulaması):**
   - `webrich.news` alan adının Authoritative DNS zone bilgileri incelendi: Zone türü (`Master`), SOA serial doğrulandı.
   - Secondary DNS senkronizasyonu panelinde durum yenileme ve zone/serial gösterimi kontrol edildi.
   - SSH üzerinden `pdnsutil show-zone webrich.news` çalıştırılarak fiziksel olarak `This is a Master zone` ve veritabanı serial eşleşmesi kanıtlandı.
2. **Harici DNS ve Delegasyon Davranışı:**
   - Alt alan adı (subdomain) üst zone delegasyonu ve yönlendirme arayüzü kontrol edildi.
   - Yerel zone bulunmayan harici alan adları için EmptyState ve "Yerel DNS Zone Oluştur" davranışı incelendi.
3. **Hatalı Girdi ve Sınır Durum:**
   - Var olmayan domain ID ile `/api/panel/domains/:id/dns/secondary` endpoint'ine yapılan istekte güvenli 404 yanıtı doğrulandı.
4. **Plesk Eşdeğerlik Eksikliği:**
   - Plesk DNS Settings'te bulunan domain bazında Master <-> Secondary rol dönüştürme ("Switch to Secondary") ve domain bazında DNS servisini devre dışı bırakma ("Disable DNS Service") eksikliği `test.fail` ile belgelendi.

### C. Test Koşusu ve Kararlılık
- Eşzamanlı test kilidi `sunucu-28-3` başarıyla alındı ve test tamamlanınca bırakıldı.
- `AGENT_N=3 npx playwright test e2e/ozellik/dns-03.spec.js --reporter=line --trace off` 2 ardışık kez koşturuldu:
  - Koşu 1: 4 passed (41.6s)
  - Koşu 2: 4 passed (35.6s)
- Testler %100 kararlı ve hatasız geçti.

### D. Rapor ve Kalite Kapıları
- `docs/manuel-test/DNS-03.md`: 29 satır (≤40 satır kuralına uygun), şablona tam uyumlu.
- `python3 orkestra/tasks.py lint`: lint OK.
- `npm run lint`: Repository policy validation passed.
- `python3 orkestra/orchestrator.py verify --quick`: Çalışır durumda, doğrulama hatası yok.

---

## 3. Karar Özeti
T172 görevi sıfır mock ilkesine, canlı ortam fiziksel doğrulama gereksinimlerine ve raporlama standartlarına eksiksiz uymaktadır. Görev ONAYLANMIŞTIR (`accept`).
