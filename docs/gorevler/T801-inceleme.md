# T801 İnceleme Notu — KRİTİK TLS-01: SSL Sertifikası Bulunan Web Sitelerinin Silinmesi

**İnceleyen:** AGENT_4  
**Tarih:** 2026-10-27  
**Karar:** KABUL (APPROVE)

---

## 1. Görev Tanımı ve Bulguların Kapsamı
- **Görev:** T801 — KRİTİK TLS-01: SSL sertifikası bulunan web siteleri `certificates_present` engeli yüzünden silinemiyor.
- **Problem:** Bir web sitesine bağlı alan adında SSL sertifikası (Let's Encrypt / ACME vb.) bulunduğunda, domain removal orchestration katmanı (`domain-removal-plan.js` ve `domain-removal-runtime.js`) sertifikayı emekliye ayırma (`retire`) yeteneğine sahip olmasına rağmen, `apps/api/src/website-removal-plan.js` içindeki `ORCHESTRATABLE_WEBSITE_IMPACT_BLOCKERS` kümesinde `'certificates_present'` bulunmuyordu. Bu durum, `createWebsiteRemovalPreview` çağrısının `certificates_present` kodunu bir hardBlocker sayarak `readyToStart: false` dönmesine ve UI üzerinde "Silme işlemi için gerekli güvenlik kontrolü tamamlanmadı: certificates_present" uyarısıyla silme butonunun kilitlenmesine yol açıyordu.

---

## 2. Yapılan Değişiklikler ve Kod İncelemesi

### `apps/api/src/website-removal-plan.js`
- `ORCHESTRATABLE_WEBSITE_IMPACT_BLOCKERS` `Set` koleksiyonuna `'certificates_present'` eklendi.
- Böylece web sitesi silme önizleme katmanı, bağlı domainlerin SSL sertifikalarını domain orchestration süreci içinde temizleyebileceğini bilerek silme işlemini başlatılabilir (`readyToStart: true`, `hardBlockers: []`) duruma getirmektedir.

### `apps/api/test/website-removal-plan.test.js`
- `orchestratable website impact blockers do not prevent removal preview from starting` testine `certificates_present` eklendi.
- Yeni `allows website removal preview when website domains have SSL certificates present (T801)` birim testi eklenerek, SSL sertifikalı alan adlarına sahip bir sitenin silme önizlemesinin `readyToStart: true` ve `hardBlockers: []` döndüğü teyit edildi.

### `apps/api/test/website-removal-certificates.test.js`
- Uçtan uca fiziksel simülasyon ve entegrasyon testi oluşturuldu:
  - SSL sertifikalı aktif bir web sitesinin etki analizi (`previewResourceImpact`) yapıldığında `certificates_present` blocker'ının tespit edildiği,
  - `createWebsiteRemovalPreview` ile bunun orchestratable olarak algılanıp `readyToStart: true` ve geçerli silme onay token'ı ürettiği,
  - `websiteRemovalRuntime` yürütüldüğünde domain silme alt adımının tetiklendiği, sertifikanın `retired` durumuna geçirildiği ve sitenin tüm temizlik adımlarıyla birlikte `removed` durumuna ulaştığı doğrulandı.

---

## 3. Doğrulama ve Test Sonuçları
- **İlgili Birim ve Entegrasyon Testleri:**
  - `node --test apps/api/test/website-removal-plan.test.js` (12 test passed, 0 fail)
  - `node --test apps/api/test/website-removal-certificates.test.js` (1 test passed, 0 fail)
  - `node --test apps/api/test/website-removal*` (169 test passed, 0 fail)
- **Görev Tahtası Lint Kontrolü:**
  - `python3 orkestra/tasks.py lint` (131 tasks, lint OK)
- **Orkestra Doğrulaması:**
  - `python3 orkestra/orchestrator.py verify --quick`
  - Çıktı: `doğrulama: ok; yeniden açılan: -; bulgu: -`

---

## 4. Sonuç
T801 görevinin tüm kabul kriterleri eksiksiz karşılanmış, SSL sertifikalı sitelerin `certificates_present` engeline takılmadan silinme önizlemesi alabilmesi ve orchestration üzerinden sertifikanın emekliye ayrılarak sitenin temiz bir şekilde kaldırılabilmesi kanıtlanmıştır.
Görev onaylanmıştır.
