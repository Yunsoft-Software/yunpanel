# Bayi ve Müşteri Veri Modelleri ile Tenant Sınırları — 2026-09-27

Dal: `development`. Bu rapor `plan.md` Bölüm F (RS-02e), `docs/plesk-feature-parity.md` ve `docs/ux/plesk-full-scope.md` referans alınarak bayi (reseller) ve müşteri rollerinin veri modellerinin açıkça ayrıştırılması, tüm ilgili varlıkların tenant/reseller sahiplik kapsamının belirlenmesi ve tenant sınır ayrımının tanımlanmasını belgeler.

## 1. Bayi ve Müşteri Veri Modellerinin Ayrıştırılması

Plesk görev düzeni ve sade reseller kararı uyarınca hiyerarşi **Owner → isteğe bağlı tek Reseller → Customer → mevcut Website** zinciridir:

1. **Reseller Veri Modeli (`ACCOUNT_KINDS.RESELLER`):**
   - `id`: Benzersiz kullanıcı/profil kimliği (1–128 karakter güvenli tanımlayıcı).
   - `kind`: `'reseller'` (sabit ve immutable).
   - `resellerId`: `null` (bayi altında alt bayi kurulamaz; reseller nesting kesinlikle yasaktır).
   - `active`: boolean (aktiflik durumu).
   - `maxCustomers` & `maxWebsites`: Negatif olmayan tam sayı veya `null` (açık limit; `null` sınırsız, `0` yeni kayıt kapalı).
   - `revision`: Pozitif tam sayı (optimistik kilit ve oturum uzlaştırması).

2. **Customer Veri Modeli (`ACCOUNT_KINDS.CUSTOMER`):**
   - `id`: Benzersiz kullanıcı/profil kimliği.
   - `kind`: `'customer'` (sabit ve immutable).
   - `resellerId`: Bir bayiye bağlıysa bayi kimliği (`string`), doğrudan Owner'a bağlıysa `null`. Müşteri kendi kendisinin bayisi olamaz (`resellerId !== id`).
   - `active`: boolean (aktiflik durumu).
   - `revision`: Pozitif tam sayı.

3. **Website Sahiplik Projeksiyonu:**
   - `{ id: websiteId, customerId }`: Website daima tek bir müşteriye aittir. Müşterinin `resellerId` değeri üzerinden üst bayi sahipliği canlı çözülür; ikinci bir bağımsız sahiplik kaydı tutulmaz.

## 2. Varlıkların Tenant/Reseller Sahiplik Kapsamı

YunPanel altyapısındaki tüm ilgili varlıklar hiyerarşik olarak bir Website'e ve dolayısıyla Customer / Reseller tenant kapsamına bağlanmıştır:

| Varlık Türü | Doğrudan Bağlantı | Çözümlenen Tenant Sahipliği |
| --- | --- | --- |
| **Website** | `customerId` | Customer (`customerId`), Reseller (`customer.resellerId` veya `null`) |
| **Domain** | `websiteId` | Website üzerinden Customer ve Reseller |
| **Application** | `websiteId` (`applicationId`) | Website üzerinden Customer ve Reseller |
| **Database Binding & Credential** | `websiteId` | Website üzerinden Customer ve Reseller |
| **Mail Domain** | `webDomainId` → `domainId` | Domain → Website üzerinden Customer ve Reseller |
| **Mailbox & Mail Alias** | `mailDomainId` | Mail Domain → Domain → Website üzerinden Customer ve Reseller |
| **Durable Job** | `resourceType` + `resourceId` / `payload.websiteId` | İlgili Website üzerinden Customer ve Reseller |

## 3. Tenant Sınır Kuralları ve Güvenlik

- **Owner:** Genel (global) tenant kapsamına sahiptir (`isGlobal: true`). Tüm tenant varlıklarını inceleyebilir ve askıdaki/hatalı varlıklarda onarım (`repair`) gerçekleştirebilir.
- **Reseller:** Yalnızca kendi doğrudan bağlı müşterilerini (`customer.resellerId === reseller.id`) ve bu müşterilere ait bağlı siteleri (**Sitelerim**) görebilir ve yönetebilir. Başka bir bayinin müşterilerine/sitelerine veya doğrudan Owner müşterilerine (`resellerId === null`) erişim `403 tenant_boundary_forbidden` ile fail-closed reddedilir. Varlık web sitesi veya siteye bağlı olduğunda aktörün `websiteIds` sınır kontrolü zorunludur.
- **Customer:** Yalnızca kendi hesabını ve kendisine atanmış Website'leri yönetebilir. Varlık web sitesi veya siteye bağlı olduğunda aktörün `websiteIds` sınır kontrolü zorunludur. Aynı bayi altında olsa dahi başka müşterilerin kaynaklarına erişemez (`403`).
- **Geriye Dönük Uyumluluk (Legacy `site_manager`):** Henüz hosting profili bağlanmamış geleneksel `site_manager` kullanıcıları için `auth_user_websites` (`websiteIds`) erişim modeli birebir korunur; henüz `customerId` atanmamış legacy sitelere erişim `websiteIds` üzerinden sağlanır. Müşteri yönetim rotalarına (`/api/customers/:id`) yetkisiz rollerin erişimi `403` ile engellenir.
- **Fail-Closed ve Bilgi Sızıntısı Koruması:**
  - Askıya alınmış bayi veya müşteri hesapları mutasyon ve site araçlarına erişemez (`tenant_actor_inactive`).
  - Hata mesajları yabancı tenant kimliklerini (`customerId`, `websiteId`, `resellerId`) sızdırmaz.
  - Koleksiyon listelerinde yabancı tenant kayıtları yanıt serileştirilmeden önce filtrelenir; global sayaç veya toplam sayı sızdırılmaz.
  - Reseller müşteri rotalarında (`/api/customers/:id`) `customerLookup` bağımlılığı eksik veya tanımsızsa sınır denetimi atlanmaz; `503 tenant_boundary_dependency_unavailable` ile fail-closed durdurulur.
  - Tüm sınır ihlali yanıtlarında `Cache-Control: no-store` başlığı zorunludur.

## 4. Eklenen ve Güncellenen Modüller

1. `packages/shared/src/tenant.js`:
   - `TENANT_ROLES`, `ACCOUNT_KINDS`, `SUPPORTED_ACCOUNT_KINDS`, `SUPPORTED_TENANT_ROLES`.
   - `TenantValidationError` tip doğrulaması.
   - `normalizeResellerAccount`, `normalizeCustomerAccount`, `normalizeHostingAccount`.
   - `normalizeWebsiteOwnership`.
   - `createTenantContext`.
   - `resolveEntityTenantScope`.
   - `assertTenantAccess`.
   - `filterByTenantBoundary`.
2. `packages/shared/src/index.js`:
   - `@yunpanel/shared` ortak modülü üzerinden tüm tenant fonksiyon ve sabitlerinin dışa aktarımı.
3. `packages/shared/test/tenant.test.js`:
   - Model ayrımı, alt bayi reddi, doğrudan müşteri, varlık tenant çözümleme ve sınır erişim testleri.
4. `apps/api/src/tenant-boundary.js`:
   - `TenantBoundaryError` (`AuthError` türevi).
   - `extractActorTenant`.
   - `assertCustomerBelongsToReseller`.
   - `assertWebsiteBelongsToTenant`.
   - `assertEntityTenantBoundary`.
   - `sanitizeTenantCollection`.
   - `createTenantBoundaryMiddleware`.
5. `apps/api/src/reseller-scope.js`:
   - Mevcut `validateHostingAccount` ve `assertCustomerWebsiteAccess` fonksiyonları korunarak tenant boundary yardımcılarının dışa aktarımı.
6. `apps/api/test/tenant-boundary.test.js`:
   - API seviyesinde çok kiracılı (multi-tenant) yetki, filtreleme, middleware ve fail-closed sınır testleri.
