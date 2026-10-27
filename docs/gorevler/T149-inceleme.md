# T149 İnceleme Notu (Review)

- **Tarih:** 2026-10-27
- **İnceleyen:** AGENT_4
- **İncelenen Görev:** T149 · Manuel test: DOS-06 — Kopyalama ve taşıma; çakışma/onay davranışı
- **Yapan:** AGENT_2
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/dos-06.spec.js` (Playwright E2E testi)
- `docs/manuel-test/DOS-06.md` (Manuel test raporu)
- `tasks/review/T149.md` (Görev teslim raporu)

---

## 2. Doğrulama ve Bulgular

### A. Mock / Sahte Veri Kontrolü
- `e2e/ozellik/dos-06.spec.js` dosyası incelendi. Hiçbir mock, stub, `page.route` veya sahte yanıt/veri kullanılmamıştır.
- Test doğrudan canlı `.28` test sunucusuna karşı çalışmakta, gerçek DOM elemanları, gerçek API ve gerçek SSH komutlarıyla doğrulanmaktadır.

### B. Senaryo Kapsamı ve Fiziksel Kanıtlar
1. **Mutlu Yol (Dosya Kopyalama ve Taşıma):**
   - Hedef klasör ve kaynak dosya UI üzerinden oluşturuldu.
   - Dosya kopyalama işlemi gerçekleştirildi; modal/bildirim takibi, hedef klasör içeriği ve fiziksel sunucu doğrulaması yapıldı.
   - SSH `find` komutu ile dosyanın hem kök dizinde hem de hedef dizinde olmak üzere fiziksel olarak 2 adet bulunduğu kanıtlandı.
   - Başka bir dosya oluşturularak hedef klasöre taşındı; kök dizinden silindiği, hedef klasörde yer aldığı ve SSH `find` ile sunucuda fiziksel olarak yalnız hedefte (1 adet) bulunduğu doğrulandı.
2. **Çakışma ve Hatalı Girdi Senaryoları:**
   - Path traversal (`../../disari`) hedef yolu denemesinde UI'da "Hedef klasör yolu geçersiz" uyarısı ile engellendiği doğrulandı.
   - Bir klasörün kendisi hedef gösterilerek kopyalanmak istendiğinde "Bir klasör kendi içine veya alt klasörlerine kopyalanamaz/taşınamaz" uyarısı ile engellendiği doğrulandı.
   - Hedef klasörde aynı isimli bir dosya varken taşıma denendiğinde, backend API'nin 409 `Destination already exists` hatası verdiği ve her iki dosyanın da silinmeden korunduğu başarıyla doğrulandı.

### C. Temizlik (`afterAll`)
- `test.afterAll` bloğunda oluşturulan tüm dosyalar ve klasörler önce API (`DELETE /api/panel/websites/:id/files`) üzerinden, ardından SSH ile sunucu üzerinde `find ... -exec rm -rf {} +` ile temizlenmektedir.

### D. Rapor ve Kurallar Uyumu
- `docs/manuel-test/DOS-06.md`: 24 satır (≤40 satır kuralına uygun), şablona tam uyumlu.
- `AGENT_N=4 npx playwright test e2e/ozellik/dos-06.spec.js`: 2/2 passed (22.5s).
- `python3 orkestra/tasks.py lint`: lint OK.
- `python3 orkestra/orchestrator.py verify --quick`: Doğrulama başarılı.

---

## 3. Karar Özeti
T149 görevi tüm kabul kriterlerini, sıfır mock ilkesini, fiziksel kanıtları ve temizlik gereksinimlerini eksiksiz karşılamaktadır. Görev ONAYLANMIŞTIR (`accept`).
