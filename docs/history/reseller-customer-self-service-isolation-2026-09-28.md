# RS-03-05: Bayi ve Müşteri Paneli Self-Service Veri İzolasyonu ve Yönetim API'si

**Tarih:** 2026-09-28  
**Kapsam:** plan.md PAR-02 ve RS-03-05; Bayi ve Müşteri self-service veri izolasyonu, müşteri ve site tahsisi API'si, tenant boundary ve çapraz erişim koruması.

---

## 1. Amaç ve Kapsam

plan.md PAR-02 ve RS-03-05 maddeleri uyarınca:
1. **Bayi (Reseller) Rolü:**
   - Oturum açtığında yalnızca kendi doğrudan müşterilerini ve sitelerini listeleyebilmeli ve yönetebilmelidir.
   - Kendi müşterilerine yeni site tahsis edebilmeli (`/api/sites/hosted*`, `customerId` içeren `/api/sites*`).
   - Yeni müşteri login hesabı oluşturabilmeli (`/api/users/hosting/accounts/self/customers`).
   - Başka bir bayiye veya doğrudan Owner'a ait müşterilere site tahsis etme veya yönetim girişimleri engellenmelidir (403 `tenant_boundary_forbidden` / `reseller_scope_forbidden`).
   - Üst düzey unmanaged site oluşturma yolları (`/api/websites`, `/api/applications`, unhosted `/api/sites`) bayilere kapalı tutulmalıdır.
   - Bayi website kontenjanı atomik olarak denetlenmelidir (kota aşımında 409 `reseller_capacity_exceeded`).

2. **Müşteri (Customer) Rolü:**
   - Oturum açtığında yalnızca kendine tahsis edilmiş siteleri ve bu sitelere bağlı alan adlarını görebilmeli ve yönetebilmelidir (`websiteIds` izolasyonu).
   - Başka müşterilere veya bayilere ait sitelere, alan adlarına veya sunucu ayarlarına erişememelidir.
   - Site oluşturma (`/api/sites*`, `/api/websites`, `/api/applications`) ve müşteri yönetimi rotalarına erişimi 403 ile engellenmelidir.

3. **Zorunlu Güvenlik Kuralları:**
   - Doğrudan Plesk DB erişimi yerine güvenli panel API ve store soyutlamaları kullanılmalıdır.
   - Sunucudaki altyapının ve diğer tenant verilerinin güvenliği fail-closed ilkeleriyle korunmalıdır.

---

## 2. Yapılan Değişiklikler

### A. Tenant Boundary Katmanı (`apps/api/src/tenant-boundary.js`)
- `createTenantBoundaryMiddleware` içinde hosted site oluşturma istekleri (`/api/sites/hosted*` ve body'sinde `customerId` taşıyan `/api/sites*`) unmanaged site oluşturma rotalarından ayrıştırıldı.
- Müşteri (`isCustomer`) veya eski site yöneticisi (`isLegacySiteManager`) rollerinin site tahsis rotalarına erişimi 403 `tenant_boundary_forbidden` ile engellendi.
- Bayi (`isReseller`) rolünün hosted site isteklerinde `customerId` doğrulaması yapıldı:
  - `customerId` eksik veya geçersizse 403 `tenant_boundary_forbidden`.
  - `customerLookup` bağımlılığı olmadan çağrıldığında fail-closed olarak 403 `tenant_boundary_forbidden` döndürüldü.
  - Hedef müşteri bulunamadığında 404 `customer_not_found`.
  - Hedef müşteri başka bir bayiye veya doğrudan Owner'a aitse `assertCustomerBelongsToReseller` ile 403 `tenant_boundary_forbidden` fırlatıldı.
  - Hedef müşteri bayinin kendi doğrudan müşterisi olduğunda isteğin devamına izin verildi (`next()`).

### B. Hosting Site Allocation Store (`apps/api/src/hosting-site-allocation-store.js`)
- `createHostingSiteAllocationStore` fonksiyonuna `managementActor` desteği eklendi.
- `check()` fonksiyonunda `managementActor` ile aktör doğrulandı.
- Aktör doğrulamasında `actor.role === 'reseller'`, `actor.kind === 'reseller'` ve `actor.hosting?.kind === 'reseller'` denetlendi; bayi rolü platformda `site_manager` olan hesapların tenant boundary kontrolünü atlaması engellendi.
- Bayi aktörler için hedef müşterinin üst bayisi (`chain.current.resellerId === actor.id`) denetlendi; eşleşmeme durumunda 403 `reseller_scope_forbidden` fırlatıldı.
- Sahip (Owner) olmayan ve bayi olmayan aktörler 403 `reseller_scope_forbidden` ile engellendi.
- Bayinin website kontenjanı `assertResellerCapacity` ile atomik olarak doğrulandı.

### C. Hosting Account Store (`apps/api/src/hosting-account-store.js`)
- `projection` fonksiyonu `site_manager`, `reseller` ve `customer` rollerini kapsayacak şekilde güncellendi; böylece `users` tablosunda `role: 'customer'` olarak saklanan hesapların 503 `hosting_account_state_invalid` hatası alması engellendi.
- `managementActor` fonksiyonu hem `site_manager` hem de `reseller` rollerini kapsayacak şekilde güncellendi.
- `siteAllocations` oluşturulurken `managementActor` parametresi aktarıldı.

### D. Site Create HTTP Servisi (`apps/api/src/site-create-http.js`)
- `resolveRequireManagement` fonksiyonu, aktif bayi oturumlarına izin verecek şekilde güncellendi.

### E. Site Resource Boundary & JSON Parser (`apps/api/src/site-resource-boundary.js`)
- `needsSiteResourceJson` fonksiyonunda `reseller` ve `customer` rolleri ile `hosting.kind` alanları dahil edilerek, bayi ve müşteri aktörlerinin `/api/sites*` ve `/api/domains*` istek gövdelerinin tenant boundary öncesinde JSON olarak çözümlenmesi sağlandı (böylece request.body undefined kalması önlendi).
- `siteResourceBoundary` middleware'inde bayi aktörlerinin bypass edilmesi kaldırıldı (`isReseller` muafiyeti giderildi); `customerLookup` bağımlılığı entegre edilerek `isAllowedSiteId` mekanizması ile bayinin erişebileceği siteler ve alt kaynaklar (`mailboxes`, `mail-aliases`, `phpmyadmin-handoffs`, `database-bindings`, `database-credentials`, `domains`) doğrulanır hale getirildi. Yabancı bayi ve doğrudan Owner kaynaklarına erişim fail-closed 403 `site_scope_forbidden` ile engellendi.

### F. Web Siteleri ve Alan Adı İzolasyonu (`apps/api/src/website-http.js` & `apps/api/src/core-app.js`)
- `apps/api/src/website-http.js` içinde `!isReseller` muafiyeti kaldırılarak yerine `isWebsiteAllowedForRequest` ve `checkWebsiteAccess` eklendi:
  - `GET /api/websites` rotasında bayi aktörler için yalnız kendi alt müşterilerine ait web siteleri listelenir; doğrudan Owner veya başka bayilere ait siteler filtrelenerek sızma tamamen önlenir.
  - `GET /api/websites/:websiteId` ve `PATCH /api/websites/:websiteId` gibi tekil site uç noktalarında yabancı veya Owner sitelerine erişim 403 `forbidden` ile fail-closed reddedilir.
- `apps/api/src/core-app.js` içinde `!isReseller` muafiyetleri kaldırılarak `isWebsiteIdAllowedForRequest` entegre edildi:
  - `GET /api/domains` rotasında bayiler yalnız kendi alt müşterilerinin sitelerine bağlı alan adlarını görebilir; Owner veya yabancı bayi alan adları filtrelenir.
  - `requireDomain` (`GET /api/domains/:domainId`, `PATCH /api/domains/:domainId` vb.) rotalarında yabancı veya Owner alan adları için 403 `forbidden` uygulanır.
  - `POST /api/domains` rotasında alan adı yalnız bayinin kendi alt müşterisine ait bir web sitesi altında oluşturulabilir; yabancı siteye alan adı ekleme girişimleri 403 `forbidden` alır.

### G. Tenant Boundary Middleware Dinamik Müşteri-Site Doğrulaması (`apps/api/src/tenant-boundary.js`)
- `createTenantBoundaryMiddleware` içinde `/api/websites/:websiteId`, `/api/servers/:serverId/websites/:websiteId`, `POST /api/domains` ve audit website sorguları için `isWebsiteInTenant` yardımcı denetimi eklendi.
- Bayi aktörler için hedef web sitesi `websiteLookup` / `websiteRegistry` ve `customerLookup` üzerinden incelenerek; sitenin bayinin kendi alt müşterisine ait olup olmadığı doğrulanır (`site.resellerId === actorTenant.actorId` veya `customer.resellerId === actorTenant.actorId`). Başka bayiye veya doğrudan Owner'a ait sitelere erişim 403 `tenant_boundary_forbidden` ile engellenir.

---

## 3. Doğrulama ve Testler

1. **Tenant Boundary Testleri (`apps/api/test/tenant-boundary.test.js`):**
   - Reseller'ın kendi müşterisi için hosted site oluşturma/önizleme rotalarına erişebildiği (`200` / `next()`).
   - Reseller'ın yabancı bayinin müşterisi veya doğrudan Owner müşterisi için site tahsis girişimlerinin 403 ile engellendiği.
   - Reseller'ın var olmayan müşteri için site tahsis isteğinin 404 döndüğü.
   - Reseller'ın unmanaged (`/api/websites`, `/api/applications`, unhosted `/api/sites`) çağrılarının 403 ile reddedildiği.
   - Pasif bayi hesaplarının 403 `tenant_actor_inactive` aldığı.
   - Müşteri rolünün site oluşturma ve müşteri yönetimi rotalarına erişiminin 403 ile engellendiği.
   - Müşteri rolünün sadece kendi sitelerine ve alan adlarına erişebildiği, yabancı sitelere ve alan adlarına erişimin 403 olduğu doğrulandı.
   - `role: 'reseller'` taşıyan ve kullanıcı oturumunda doğrudan `websiteIds` bulunmayan bayi aktörünün, kendi müşterisine ait sitelere (`GET /api/websites/site-a1`, `GET /api/servers/srv-1/websites/site-a1`) erişebildiği ve alan adı oluşturabildiği (`POST /api/domains`), yabancı müşteri sitelerine ve doğrudan Owner sitelerine erişiminin ise 403 `tenant_boundary_forbidden` ile engellendiği doğrulandı.
   - `RS-03-05: website-http and core-app enforce tenant boundary for reseller on websites and domains` testi ile:
     - `GET /api/websites` çağrısının bayiye sadece kendi alt müşterilerinin sitelerini döndürdüğü (`['site-a1', 'site-a2']`), yabancı site (`site-b1`) ve doğrudan Owner sitesini (`site-direct`) içermediği,
     - `GET /api/websites/:websiteId` çağrısının kendi sitesine 200, yabancı ve Owner sitelerine 403 `forbidden` döndürdüğü,
     - `GET /api/domains` çağrısının bayiye sadece kendi alt müşterilerinin alan adlarını döndürdüğü (`['domain-a1', 'domain-a2']`), yabancı veya Owner alan adlarını içermediği,
     - `GET /api/domains/:domainId` çağrısının kendi alan adına 200, yabancı ve Owner alan adlarına 403 `forbidden` döndürdüğü,
     - `POST /api/domains` çağrısının kendi sitesi altında alan adı oluşturmaya izin verirken (201), yabancı ve Owner siteleri altında alan adı oluşturma girişimlerini 403 `forbidden` ile engellediği doğrulandı.

2. **Site Resource Boundary Testleri (`apps/api/test/site-resource-boundary.test.js`):**
   - `reseller actor site resource boundary enforces child customer scope and rejects foreign/owner resources` testi ile:
     - Bayi aktörün kendi alan adına ait posta kutularını listeleyebildiği (`GET /api/mailboxes?mailDomainId=mail-a`), yabancı posta alan adı sorgusunun 403 `site_scope_forbidden` ile engellendiği,
     - Kendi posta alan adına posta kutusu oluşturabildiği (`POST /api/mailboxes`), yabancı posta alan adına posta kutusu oluşturma girişiminin 403 ile reddedildiği,
     - Kendi posta kutusunu tekil okuyabildiği (`GET /api/mailboxes/box-a`), yabancı posta kutusu okuma girişiminin 403 ile engellendiği,
     - Kendi e-posta takma adına erişebildiği (`GET /api/mail-aliases/alias-a`), yabancı takma adı değiştirme girişiminin 403 aldığı,
     - Kendi web sitesi için phpMyAdmin handoff alabilmesine (`POST /api/servers/server/websites/site-a/phpmyadmin-handoffs`) izin verilirken, yabancı web sitesi veya Owner sitesi için handoff isteklerinin 403 `site_scope_forbidden` ile engellendiği,
     - Yabancı veritabanı bağlamları (`/api/servers/server/database-bindings/binding-b/credential`) ve yabancı siteye alan adı ekleme (`POST /api/domains` with `websiteId: 'site-b'`) isteklerinin 403 aldığı,
     - Oturumda doğrudan `websiteIds` taşınmadığı durumlarda dinamik `customerLookup` entegrasyonuyla kendi müşterisinin sitesine ait phpMyAdmin handoff alabildiği, yabancı müşteri sitesine ait handoff isteklerinin ise 403 ile fail-closed reddedildiği doğrulandı.

3. **Hosted Site Create HTTP Servis Testleri (`apps/api/test/hosting-site-create-http.test.js`):**
   - Reseller oturumu ile kendi müşterisine site önizlemesi ve tahsisinin başarıyla gerçekleştiği (`201 Created`, state `'attached'`).
   - Reseller website limitine ulaşıldığında ikinci site tahsisinin 409 `reseller_capacity_exceeded` ile durdurulduğu.
   - Yabancı bayi müşterisi veya doğrudan Owner müşterisi için site tahsisinin 403 `reseller_scope_forbidden` ile engellendiği.
   - Müşteri rolünün site tahsis rotasını çağıramadığı doğrulandı.
   - `hosting-site-allocation-store enforces customer ownership for site_manager reseller actors` testi ile:
     - `role: 'site_manager'` ve `kind: 'reseller'` aktörünün yabancı müşteri veya doğrudan Owner müşterisine site tahsisinin 403 `reseller_scope_forbidden` ile reddedildiği,
     - `role: 'site_manager'` ve `hosting.kind: 'reseller'` aktörünün yabancı müşteriye site tahsisinin 403 `reseller_scope_forbidden` ile engellendiği,
     - Kendi müşterisi için site tahsisinin her iki aktör varyantı için de başarıyla `'available'` döndüğü doğrulandı.
   - `hosting-site-allocation-store supports role: reseller actor and customer role in projection` testi ile:
     - `role: 'reseller'` aktörü ile yabancı müşteri ve direct Owner müşterisi için önizleme isteğinin 403 `reseller_scope_forbidden` aldığı,
     - Kendi müşterisi için önizlemenin `'available'` döndüğü,
     - `users` tablosunda `role: 'customer'` olarak kayıtlı müşterilerin `store.get` ile başarıyla yüklendiği ve `kind: 'customer'` projeksiyonu ürettiği doğrulandı.
