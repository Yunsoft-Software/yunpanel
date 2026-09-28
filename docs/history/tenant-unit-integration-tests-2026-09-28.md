# Rol İzolasyonu ve Tenant Sınırları Birim ve Entegrasyon Testleri — 2026-09-28

Dal: `development`. Bu kayıt RS-02e kapsamında geliştirilen bayi/müşteri ayrımını ve tenant izolasyonunu güvence altına alan birim ve entegrasyon testlerinin development dalındaki durumunu ve kapsamını belgeler.

## 1. Test Kapsamı ve Mimari Ayrım

Tenant modelleri, rol izolasyonu ve sınır kontrolleri iki ana katmanda test edilmektedir:

1. **Paylaşılan Kütüphane Katmanı (`packages/shared/test/tenant.test.js`):**
   - **Rol ve Hesap Sınıflandırması:** `TENANT_ROLES`, `ACCOUNT_KINDS`, `SUPPORTED_ACCOUNT_KINDS`, `SUPPORTED_TENANT_ROLES`, `ALL_SYSTEM_ROLES` sabitleri ve rol yüklemleri (`isOwnerRole`, `isResellerRole`, `isCustomerRole`, `isSiteManagerRole`, `isReadOnlyRole`).
   - **Güvenli Kimlik Denetimi (`assertTenantIdentifier`, `isValidTenantIdentifier`):** Path traversal (`../`), geçersiz karakterler, null byte ve boşluk içeren kimliklerin reddedilmesi.
   - **Reseller Hesap Doğrulaması (`normalizeResellerAccount`):** Alt bayi zinciri yasağı (`resellerId: null` zorunluluğu), tek seviyeli hiyerarşi (`nested_reseller_not_supported`), kota ve aktiflik tiplerinin dondurulmuş (frozen) nesnelerle güvenceye alınması.
   - **Customer Hesap Doğrulaması (`normalizeCustomerAccount`):** Bir bayiye bağlı veya doğrudan Owner müşterisi (`resellerId: null`) tanımları, müşterinin kendi kendisinin bayisi olamayacağı kuralı (`invalid_customer_parent`).
   - **Website Sahiplik Projeksiyonu (`normalizeWebsiteOwnership`):** `website -> customerId` eşleşmesi, tanımsız sahiplik bayrağı (`allowUnassigned`).
   - **Tenant Bağlamı Oluşturma (`createTenantContext`):** `owner`, `reseller`, `customer`, `legacy_site_manager` bağlamlarının doğru `tenantId`, `isGlobal`, `resellerId` ve `websiteIds` ile üretilmesi; eksik id (`invalid_actor`) ile geçersiz tanımlayıcı (`invalid_identifier`) ayrımının güvenceye alınması.
   - **Varlık Kapsamı Çözümleme (`resolveEntityTenantScope`):** `website`, `domain`, `application`, `database`, `mail_domain`, `mailbox`, `mail_alias`, `job` varlıklarının `websiteId`, `customerId`, `resellerId` hiyerarşisine deterministik çözümlenmesi.
   - **Negatif Çapraz Tenant Senaryoları:**
     - Aynı bayi altındaki müşteriler arası izolasyon (Müşteri A1'in Müşteri A2 sitesine veya hesabına erişim girişiminin `tenant_boundary_forbidden` ile reddi).
     - Müşterinin ebeveyn bayiye erişim girişiminin reddi.
     - Bayi sınırları (Bayi A'nın Bayi B veya doğrudan Owner müşterilerine / sitelerine erişim girişimlerinin reddi).
     - Aktif olmayan aktörlerin fail-closed reddi (`tenant_actor_inactive`).
     - Koleksiyonlarda çapraz tenant veri sızıntısının engellenmesi (`filterByTenantBoundary`).

2. **API ve Servis Entegrasyon Katmanı (`apps/api/test/tenant-boundary.test.js`):**
   - **Aktör Çıkarımı (`extractActorTenant`):** Oturum veya kullanıcı nesnesinden rol, hosting profili, `isGlobal`, `isDirectOwnerCustomer` ve `websiteIds` çıkarımı.
   - **Sınır Denetleyicileri (`assertCustomerBelongsToReseller`, `assertWebsiteBelongsToTenant`, `assertEntityTenantBoundary`):**
     - Sahiplik hiyerarşisinin doğrulanması, yetkisiz aktörlerin 403 `tenant_boundary_forbidden` ile durdurulması.
     - Hata mesajlarında yabancı tenant kimliklerinin sızdırılmaması (information disclosure prevention).
   - **Koleksiyon Sanitizasyonu (`sanitizeTenantCollection`):** Yanıt nesnelerinden yabancı tenant kaynaklarının filtrelenmesi, dizi dışı girdilerde güvenli boş liste dönüşü.
   - **HTTP Ara Katmanı (`createTenantBoundaryMiddleware`):**
     - Aktif olmayan hesapların reddi (403 `tenant_actor_inactive`).
     - Plesk rol sınırları: Genel sunucu ayarları (`/api/panel/settings`, `/api/settings`), paket ve servis yönetimi (`/api/system/packages`, `/api/servers/:id/services`), global yedekler (`/api/backups`), bağımsız veritabanı yönetimi (`/api/servers/:id/databases`), genel kullanıcı yönetimi (`/api/users`) yollarının bayiler, müşteriler ve site yöneticilerine kapatılması.
     - Müşteri koleksiyonu (`/api/customers`) ve tekil müşteri rotalarında (`/api/customers/:id`) tenant yetkilendirmesi; eksik bağımlılıkta fail-closed (503 `tenant_boundary_dependency_unavailable`) davranışı.
     - Senkron ve asenkron `customerLookup` fonksiyonlarının hata toleransı.
     - Güvenlik başlığı (`Cache-Control: no-store`) denetimleri.
   - **Audit Sorgu İzolasyonu ve Sonuç Filtreleme:**
     - `/api/audit` sorgularında `actorId`, `resourceType` ve `resourceId` filtrelerinin aktör tenant kapsamına göre sınırlandırılması.
     - `handleAuditRead` ile dönen olay listesinin aktörün tenant kapsamı dışındaki hiçbir kaydı içermemesi.
   - **Terminal Yetenekleri İzolasyonu (`mountTerminalCapabilityRoutes`):**
     - Root terminalinin strictly Owner-only olması (`terminal_server_forbidden`).
     - Site terminalinin Reseller ve Customer için aktif hesap ve `websiteIds` doğrulamasıyla açılması (`terminal_site_forbidden`).
   - **Yönetim Mutasyonu Sınıflandırması ve Denetim Bağlamı:**
     - `classifyManagementMutation` ile müşteri ve hosting mutasyonlarının doğru sınıflandırılması.
     - `withAuditActor` üzerinden `tenant` bağlamının taşınması ve `attachManagementAudit` mutasyon kayıtlarına eklenmesi.

## 2. Doğrulama Gereksinimleri

İlgili birim ve entegrasyon testleri Node.js dahili test koşucusu (`node --test`) ile doğrulanmaktadır:
- `node --test packages/shared/test/tenant.test.js`
- `node --test apps/api/test/tenant-boundary.test.js`
