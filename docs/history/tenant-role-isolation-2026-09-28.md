# Tenant Tabanlı Rol İzolasyonu ve Plesk Yetki Sınırları — 2026-09-28

Dal: `development`. Bu kayıt RS-02e kapsamında API ve servis katmanında Reseller (`reseller`) ve Customer (`customer`) rolleri için tenant tabanlı rol izolasyonu, Plesk izin sınırları ve audit/izleme gereksinimlerinin kaynak durumunu belgeler.

## 1. Plesk İzin Sınırları ve Rol İzolasyonu

- `apps/api/src/tenant-boundary.js`:
  - `extractActorTenant` ile aktörün rolü (`owner`, `reseller`, `customer`, `site_manager`) ve hosting profili (`reseller`, `customer`) tek tip, güvenli bir nesneye dönüştürülür.
  - Aktif olmayan aktörlerin istekleri doğrudan 403 `tenant_actor_inactive` ile reddedilir.
  - Plesk benzeri izin sınırları uç noktalarda uygulanır:
    - Genel sunucu ayarları (`/api/panel/settings`, `/api/settings`)
    - Sunucu paketleri, servisleri ve yükseltmeleri (`/api/system/packages`, `/api/system/upgrade`, `/api/servers/:id/system/packages`, `/api/servers/:id/services`, `/api/servers/:id/node-runtimes`)
    - Global yedekleme yönetimi (`/api/backups`, `/api/backups/repositories`, `/api/backups/remotes`)
    - Doğrudan üst düzey unmanaged site ve uygulama oluşturma (`POST /api/websites`, `POST /api/applications`)
    - Sunucu düzeyinde bağımsız veritabanı yönetimi (`/api/servers/:id/databases`)
    - Genel kullanıcı yönetimi (`/api/users` rotaları; `/api/users/hosting/accounts` istisnası hariç)
  - Müşteri koleksiyonu (`/api/customers`) yalnızca Owner ve Reseller erişimine açıktır; Customer ve legacy `site_manager` için 403 `tenant_boundary_forbidden` döner.
  - Doğrudan müşteri (`/api/customers/:id`) ve site (`/api/websites/:id`, `/api/servers/:id/websites/:websiteId/...`) rotalarında tenant sınırları denetlenir. Yabancı tenant kaynaklarına erişim 403 `tenant_boundary_forbidden` ile engellenir.
  - Alan adı oluşturma (`POST /api/domains`) isteğinde `websiteId` aktörün tenant `websiteIds` listesinde doğrulanır.
  - Bağımlılık eksikliği durumunda (`customerLookup` yokluğu veya hata vermesi) fail-closed ilkesiyle 503 `tenant_boundary_dependency_unavailable` döner.

- `apps/api/src/site-resource-boundary.js`:
  - `extractActorTenant` entegrasyonu ile inaktif hesaplar 403 `site_scope_forbidden` ile engellenir.
  - `POST /api/domains`, `POST /api/websites`, `POST /api/applications` yollarında tenant doğrulaması sağlanır.
  - `/api/users/hosting/accounts` yollarına izin verilirken genel `/api/users` yolları bloklanır.

- `apps/api/src/panel-http-guard.js`, `apps/api/src/panel-access.js`, `apps/api/src/owner-mfa-policy.js`:
  - `reseller` ve `customer` rolleri ile `hosting.kind` bilgisi site-capable roller arasında tanınır.
  - MFA zorunluluğu Owner'a özel kalırken, reseller ve customer hesapları site yönetim rotalarına güvenle erişebilir.

## 2. Terminal Yetenekleri İzolasyonu

- `apps/api/src/terminal-capability-http.js`:
  - Root terminali (`scope: 'server'`) strictly Owner-only tutulur; Reseller ve Customer için 403 `terminal_server_forbidden` döner.
  - Site terminali (`scope: 'site'`) aktörün aktifliği ve yetkili `websiteIds` kapsamı doğrulanarak verilir; yabancı site terminal istekleri 403 `terminal_site_forbidden` ile reddedilir.
  - İnaktif hesap istekleri 403 `tenant_actor_inactive` ile reddedilir.

## 3. Audit ve İzleme Gereksinimleri

- `apps/api/src/audit-request-context.js`:
  - `withAuditActor` fonksiyonuna `context` parametresi eklendi; aktörün `tenant` bilgisi `AsyncLocalStorage` içinde taşınır.
  - `currentAuditTenant()` ve `currentAuditContext()` dışa aktarıldı.

- `apps/api/src/management-audit.js`:
  - `classifyManagementMutation` içine müşteri ve hosting hesap mutasyonları (`POST /api/users/hosting/accounts/self/customers`, `PATCH .../login`, `PATCH .../status`, `POST .../self/sites`, `POST /api/customers`, `PATCH /api/customers/:id`, `DELETE /api/customers/:id`) eklendi.

- `apps/api/src/audit-http.js`:
  - `/api/audit` okuma sorgularında tenant sınır denetimi uygulandı:
    - Customer rolü yalnızca kendi `actorId` ve `websiteIds` kapsamındaki audit kayıtlarını sorgulayabilir.
    - Reseller rolü kendi `actorId`, direct-child `customerIds` ve `websiteIds` kapsamındaki audit kayıtlarını sorgulayabilir.
    - Legacy `site_manager` için global audit erişimi 403 `forbidden` ile engellendi.
  - Dönen audit kayıtları sanitize edilerek yabancı tenant hareketlerinin listeye sızması engellendi.

## 4. Hosting Deposu ve Uygulama Entegrasyonu

- `apps/api/src/hosting-account-store.js`:
  - `getCustomer(id)` ve `listChildCustomerIds(resellerId)` yardımcıları eklendi.
- `apps/api/src/app.js`:
  - `createTenantBoundaryMiddleware` Express ara katmanı `createSiteResourceBoundary` öncesine monte edildi; `customerLookup` ve `websiteLookup` bağlandı.

## 5. Test Kapsamı

- `apps/api/test/tenant-boundary.test.js`:
  - Rol ve tenant sınıflandırması (`extractActorTenant`).
  - Müşteri ve site sahiplik kontrolleri (`assertCustomerBelongsToReseller`, `assertWebsiteBelongsToTenant`, `assertEntityTenantBoundary`).
  - Koleksiyon temizleme (`sanitizeTenantCollection`).
  - Middleware HTTP kontrolleri (Plesk sınırları, paketler, veritabanları, yedekler, audit sorguları, nested server-site rotaları, domain creation).
  - Terminal yetenekleri izolasyonu (root server terminal Owner-only, site terminal scoped, inaktif hesap engeli).
  - Audit mutation sınıflandırması ve `withAuditActor` tenant context doğrulaması.
  - Senkron ve asenkron `customerLookup` desteğinin ve hata toleransının doğrulanması.
  - Üst seviye `store.hostingAccounts` ve `store.users.hostingAccounts` yapılarında audit filtrelemesi ve çocuk müşteri loglarının doğrulanması.
  - `attachManagementAudit` yönetim mutasyonlarına tenant bağlamının eklenmesi.

## 6. Kod İnceleme Düzeltmeleri (Review Robot Resolutions)

- **Senkron customerLookup Desteği (`apps/api/src/tenant-boundary.js`):** `customerLookup(queriedActorId)` ve `customerLookup(queriedResourceId)` çağrıları `Promise.resolve(...)` ve `try/catch` blokları içine alınarak senkron fonksiyonların (örn. `(id) => hostingAccounts.getCustomer(id)`) `.catch is not a function` TypeError üretmesi engellendi; senkron hatalar fail-closed olarak ele alındı.
- **Audit Hosting Account Çözümleme (`apps/api/src/audit-http.js` & `apps/api/src/auth-store.js`):** `store.users?.hostingAccounts` doğrudan erişimi yerine `resolveHostingAccounts(store)` yardımcı fonksiyonu eklenerek hem `store.hostingAccounts` hem de `store.users.hostingAccounts` yapıları desteklendi. `createAuthStore` dönüş nesnesine `hostingAccounts: users.hostingAccounts` eklenerek üst düzey erişim sağlandı; bayilerin alt müşteri audit loglarını sorgulaması ve görüntülemesi güvenceye alındı.
- **Management Audit Tenant Bağlamı (`apps/api/src/management-audit.js`):** `attachManagementAudit` fonksiyonuna `currentAuditTenant()` entegrasyonu yapılarak dönen mutasyon kaydına tenant bilgisi bağlandı.
- **Kapsamlı Test Senaryoları (`apps/api/test/tenant-boundary.test.js`):** Senkron lookup fonksiyonu, hata fırlatan senkron lookup, üst seviye `hostingAccounts` yapısı, management audit tenant context, reseller site terminal yetkileri ve yabancı/geçersiz müşteri kaynak audit sorgusu 403 ret testleri eklendi.
- **Audit Müşteri Kaynağı Sınırlandırması (`apps/api/src/tenant-boundary.js` & `apps/api/src/audit-http.js`):** Reseller aktörünün `resourceType=customer` sorgularında yalnızca kendi doğrudan bağlı çocuk müşterilerini sorgulayabilmesi güvenceye alındı; bayi kimliğinin müşteri kaynağı olarak sorgulanması veya yabancı müşteri kaynağı sorguları fail-closed 403 ile engellendi.

