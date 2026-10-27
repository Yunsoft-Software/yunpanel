# T800 İnceleme Notu — KRİTİK TLS-01 Kiracı İzolasyonu

**İnceleyen:** AGENT_2  
**Tarih:** 2026-10-27  
**Karar:** KABUL (APPROVE)

---

## 1. Görev Tanımı ve Bulguların Kapsamı
- **Görev:** T800 — KRİTİK TLS-01: `core-app.js` sertifika yenileme ve sonuç uçlarında kiracı (tenant) izolasyonu eksik.
- **Problem:** `apps/api/src/core-app.js` altındaki `/api/certificates/:id/renew`, `/renewal-outcome` ve `/reload-outcome` rotaları `certificate-http.js` rotalarını gölgelemekte ve yalnızca `domains.write`/`domains.read` rol iznine bakıp `canAccessDomain(req, domain)` / kiracı kontrolü yapmamaktaydı. Web sitesi olmayan veya başka bir kiracıya ait Customer/Reseller hesapları, yabancı sertifikalarda yenileme işi tetikleyebiliyor ve sertifika sonuçlarını okuyabiliyordu.

---

## 2. Yapılan Değişiklikler ve Kod İncelemesi

### `apps/api/src/core-app.js`
- `requireCertificate(certificateId, request)` fonksiyonuna kiracı izolasyonu eklendi:
  - Sertifikanın bağlı olduğu domain (`domainId`) ve web sitesi (`websiteId`) tespit edilerek `isWebsiteIdAllowedForRequest(domain.websiteId, request)` ile yetki kontrolü yapılıyor.
  - Owner ve Read-Only rolleri hariç tüm kiracılarda (Reseller, Customer) yetkisiz erişim denemeleri fail-closed şekilde `403 Forbidden` (`CertificateRegistryError('forbidden', ...)`) fırlatıyor.
- `GET /api/certificates` uç noktasında kiracı kapsamı (`isScoped`) filtresi eklendi; kiracılar yalnızca erişim hakkı bulunan web sitelerine ait sertifikaları listeleyebiliyor.
- `GET /api/certificates/:certificateId` ve `POST /api/certificates/:certificateId/renew` rotalarına `request` parametresi aktarılarak `requireCertificate(..., request)` üzerinden kiracı doğrulaması zorunlu kılındı.

### `apps/api/src/certificate-http.js`
- `isWebsiteAllowedForRequest`, `isScopedTenantRequest`, `assertDomainTenantAccess` ve `assertCertificateTenantAccess` yardımcı kontrolleri eklendi.
- `POST /api/certificates/:certificateId/renew`, `GET /api/certificates/:certificateId/renewal-outcome`, `POST /api/certificates/:certificateId/reload-outcome`, `GET /api/certificates/:certificateId/reload-outcome`, `GET /api/certificates/:certificateId/verify-tls` ve ilgili domain uçlarında kiracı izolasyon kontrolleri uygulandı.
- `renewal-outcome` sorgusunda yabancı `jobId` sızıntısı engellendi (`job.resourceId !== certId` ise eşleşmeyen işler yoksayılıyor).

### `apps/api/test/ssl-renewal-wiring.test.js`
- Fiziksel API testi eklendi:
  - Web sitesi olmayan Customer (`ttls01-a2-cust`), yabancı Customer (`cust-b`) ve yabancı Reseller (`reseller-b`) için `POST renew`, `GET cert`, `GET/POST renewal-outcome`, `GET/POST reload-outcome`, `GET/POST verify-tls` isteklerinin tamamının `403 Forbidden` aldığı ve `GET /api/certificates` listesinde yabancı sertifikaların dönmediği doğrulandı.
  - Yetkisiz isteklerin arka planda hiçbir yenileme işi enque etmediği ve kayıtları mutasyona uğratmadığı teyit edildi.
  - Sertifika ve web sitesi sahibi Customer'ın (`cust-a`) ve Owner'ın yetkili işlemleri başarıyla yürütebildiği (`200 OK`, `202 Accepted`) doğrulandı.

---

## 3. Doğrulama ve Test Sonuçları
- **SSL ve Sertifika Birim/Entegrasyon Testleri:**
  `node --test apps/api/test/ssl-renewal-wiring.test.js apps/api/test/certificate-http.test.js apps/api/test/ssl-renewal.test.js`
  Çıktı: `pass 108, fail 0`
- **Repo Kuralları ve Lint Kontrolü:**
  `npm run lint`
  Çıktı: `Repository policy validation passed.`
- **Orkestra Doğrulaması:**
  `python3 orkestra/orchestrator.py verify --quick`
  Çıktı: `doğrulama: ok; yeniden açılan: -; bulgu: -`

---

## 4. Sonuç
T800 görevinin tüm gereksinimleri eksiksiz karşılanmış, hata önce otomatik teste dökülmüş, kiracı izolasyonu (Owner vs Reseller vs Customer) fail-closed ve güvenli şekilde uygulanmış, testler ve repository politikaları %100 başarıyla geçmiştir.
Görev onaylanmıştır.
