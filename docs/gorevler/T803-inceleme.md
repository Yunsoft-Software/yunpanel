# T803 İnceleme Notu — KRİTİK WEB-01: Bayi Site Tahsisi ve Sihirbaz Sitelerinin Silme Blokajları

**İnceleyen:** AGENT_3  
**Tarih:** 2026-10-27  
**Karar:** KABUL (APPROVE)  

---

## 1. Görev Tanımı ve Problem Tespiti
- **Görev:** T803 · KRİTİK WEB-01: Bayi site tahsisi (AllocateSiteDialog) kilitli ve sihirbazla açılan sitelerin silinmesi `domain_removal_not_ready` ile bloke oluyor.
- **Problemler:**
  1. `/customers` ve `/resellers` rotalarında `servers` koleksiyonu yüklenmediği için `AllocateSiteDialog` içinde `serverId=null` kalıyordu ve bayi müşterisine site tahsis edemiyordu. Ayrıca `handlePreview` payload şeması `site-create-base.js` gereksinimleriyle uyumsuzdu (`displayName`, `aliases`, `dnsMode` gibi tanımsız alanlar gönderiliyordu).
  2. Sihirbazla açılan siteler (varsayılan authoritative DNS veya otomatik DB ile) silinmek istendiğinde 001:domain_removal adımında `dns_zone_parent_ds_unverifiable` ve `database_binding_dependencies_present` hardBlocker'ları nedeniyle `domain_removal_not_ready` hatasıyla bloke oluyordu.
  3. Subdomain dosya kökü UI'da `/var/www/vhosts/<domain>/subdomains/<sub>` gösterilirken çözümleme aşamasında ana site belge kökünün leaf dizinleri (`httpdocs`, `public`, `current`) ayıklanmadığı için tutarsızlık oluşabiliyordu.

---

## 2. Yapılan Değişiklikler ve Kod İncelemesi

### `apps/web/src/workspace/workspace-resources.js`
- `/customers` ve `/resellers` rotalarına `domains`, `websites` ve `servers` kaynak koleksiyonları eklendi.
- Böylece bayi müşterisi detayında ve site tahsis modalında sunucu listesi ve bağlı domainler eksiksiz yüklendi.

### `apps/web/src/workspace/ResellerCustomersPage.jsx`
- `AllocateSiteDialog` bileşeninin `handlePreview` metodunda payload yapısı `site-create-base.js` şemasına tam uyumlu hale getirildi. Tanımsız alanlar kaldırıldı; `name`, `source: { type: 'starter' }`, `database: { mode: 'none' }`, `mail: { mode: 'local' }`, `dns: { mode: 'local' }` alanları gönderildi.

### `apps/web/src/workspace/new-website-form.js`
- `resolveSubdomainSharedFileRoot` fonksiyonu ana website nesnesi (`parentWebsite`) desteğiyle genişletildi; leaf dizinleri (`httpdocs`, `public`, `current`) dinamik olarak temizlenip `/var/www/vhosts/<parent>/subdomains/<subdomain>` standart hiyerarşik dosya köküne bağlandı.

### `apps/api/src/domain-removal-plan.js`
- `database_binding_dependencies_present` engeli `ORCHESTRATABLE_IMPACT_BLOCKERS` ve `retainedBucket` ('databases') içine dahil edildi. Website silme orkestrasyonunda veritabanları sitenin kendisi tarafından temizlendiğinden domain silme önizlemesinin sahte hardBlocker üretmesi önlendi.
- `dns_zone_parent_ds_unverifiable` engeli `ORCHESTRATABLE_DNS_BLOCKERS` içine eklendi; DNSSEC üst DS kaydı doğrulanamayan yerel/özel test alanlarında domain silme akışının kilitlenmesi engellendi.

### `apps/api/src/dns-zone-retirement.js`
- `captureDeletionSnapshot` ve `deleteCapturedSnapshot` fonksiyonlarında parent DS kontrolü `parentDs.status !== 'absent'` yerine `parentDs.status === 'present'` olarak düzeltildi; `unverifiable` durumunda yıkıcı silme işleminin haksız yere bloke olması engellendi.

---

## 3. Doğrulama ve Test Sonuçları
- **Birim ve Entegrasyon Testleri:**
  - `node --test apps/web/test/workspace-resources.test.js apps/web/test/reseller-customer-panel.test.js apps/api/test/domain-removal-plan.test.js apps/api/test/dns-zone-retirement.test.js`
  - Sonuç: 67/67 test geçti (0 fail).
- **Orkestra Bütünlük Kontrolleri:**
  - `python3 orkestra/orchestrator.py verify --quick`
  - Sonuç: `doğrulama: ok; yeniden açılan: -; bulgu: -`
- **Görev Tahtası Lint:**
  - `python3 orkestra/tasks.py lint`
  - Sonuç: 131 tasks, lint OK.

---

## 4. Karar
T803 görevinin tüm gereksinimleri ve kabul kriterleri eksiksiz karşılanmıştır.
Görev onaylanmıştır (ACCEPT).
