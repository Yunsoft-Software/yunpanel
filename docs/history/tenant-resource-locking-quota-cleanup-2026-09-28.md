# HTTP ve Job Runtime Katmanında Tenant Kaynak Kilidi ve Güvenli Kontenjan Temizliği — 2026-09-28

Dal: `development`. Bu kayıt `plan.md` Bölüm F ve RS-02e kapsamında iç servis bileşiminin HTTP ve job runtime katmanına bağlanmasını, website oluşturma/provisioning ve silme yollarında tenant kaynak kilidi ve canlı tenant yetkisini, silme ve geri alma (compensation/recovery) işlemlerinde bayi ve müşteri kontenjanlarının atomik olarak serbest bırakılmasını ve hesap askıya alma (suspend/revoke) kurallarının işletilmesini belgeler.

## 1. Mimari ve Güvenlik Uygulaması

### A. Tenant Sınırları ve HTTP Yetkilendirme Katmanı
1. **Plesk Yönetim Sınırları ve Site Oluşturma Yolları (`apps/api/src/tenant-boundary.js`):**
   - `createTenantBoundaryMiddleware` ara katmanına `/api/sites`, `/api/sites/create-preview`, `/api/sites/hosted`, `/api/sites/hosted/create-preview`, `/api/sites/hosted/recover-reservation` ve `/api/sites/recover-reservation` uç noktaları eklendi.
   - Non-global roller (`reseller`, `customer`, `site_manager`) doğrudan üst düzey unmanaged site oluşturma veya önizleme çağrısı yaptıklarında 403 `tenant_boundary_forbidden` ile fail-closed reddedilir.
2. **Ham Oturum Belirteci Bağlamı (`apps/api/src/auth-http.js`):**
   - Express `request` nesnesine `request.rawToken = rawToken;` atandı. Böylece downstream hosting runtime servisleri oturum belirtecini canlı store ve lifecycle denetimlerine kesintisiz aktarır.
3. **HTTP Site Oluşturma ve Rezervasyon Kurtarma (`apps/api/src/site-create-http.js`):**
   - `createHostingSiteCreateRuntime` iç servis bileşimi HTTP katmanına dinamik bağlandı (`resolveHostingRuntime`).
   - `POST /api/sites/create-preview` ve `POST /api/sites` gövdelerinde `customerId` varlığı durumunda otomatik olarak barındırma önizleme ve oluşturma akışına yönlendirme sağlandı.
   - Açık uç noktalar bağlandı: `POST /api/sites/hosted/create-preview`, `POST /api/sites/hosted`, `POST /api/sites/hosted/recover-reservation` ve `POST /api/sites/recover-reservation`.
   - `recoverReservation` akışı, başarısız veya zaman aşımına uğramış barındırma oluşturma denemelerinde ayrılmış kontenjanı atomik olarak temizler (`releaseUncreated`).

### B. Canlı Tenant Yetkisi ve Kaynak Kilidi (Provisioning & Removal)
1. **Provisioning Yetkilendirmesi (`apps/api/src/website-provisioning-http.js`, `apps/api/src/website-provisioning-runtime.js`):**
   - `requestActor` izinli rolleri `owner`, `site_manager`, `reseller` ve `customer` olarak güncellendi.
   - `requireWebsiteAccess` fonksiyonunda `extractActorTenant(request.auth)` çağrılarak aktörün aktifliği (`actorTenant.active`) denetlendi; pasif hesaplar 403 `tenant_actor_inactive` ile fail-closed durdurulur.
   - Aktörün `websiteIds` dizisinde bulunmayan bir siteye yönelik provisioning sorguları veya mutasyonları yabancı tenant varlığını sızdırmamak adına 404 `provisioningNotFound()` döndürür.
2. **Website Silme Yetkilendirmesi (`apps/api/src/website-removal-http.js`, `apps/api/src/website-removal-runtime.js`, `apps/api/src/index.js`):**
   - `requireRemovalOwner` kısıtlaması kaldırılarak `requirePanelRouteAccess` ve `requireWebsiteAccess` ile tenant tabanlı yetkilendirme sağlandı.
   - `removalActor` izinli rolleri `owner`, `site_manager`, `reseller` ve `customer` olarak genişletildi.
   - `requireWebsiteAccess` ile aktiflik kontrolü (`!actorTenant.active` ise 403 `tenant_actor_inactive`) ve yetkili `websiteIds` doğrulaması uygulandı (atanmamış sitelere erişimde 404 dönerek metadata sızıntısı engellenir).
   - Global işlem listeleme (`GET /api/website-removal-operations`) tenant aktörler için yalnızca kendilerine ait `websiteIds` işlemlerini döndürecek şekilde filtrelendi.
   - `authorizeWebsiteRemovalActor` (`apps/api/src/index.js`), canlı session doğrulaması, aktiflik denetimi (`session.user.active !== false`), owner için MFA ve tenant aktörler için `websiteIds` kontrolünü uygulayacak şekilde bağlandı. Non-owner roller (`reseller`, `customer`, `site_manager`) için `websiteId` eksik/null olduğunda veya yetkili `websiteIds` listesinde yer almadığında yetkilendirme fail-closed olarak reddedilir (`return null`).
3. **Kaynak Kilidi (`siteMutationLock`):**
   - Provisioning (`website-provisioning-runtime.js`), site oluşturma (`hosting-site-create-runtime.js`) ve site silme (`website-removal-http.js`, `website-removal-runtime.js`) mutasyonları `siteMutationLock.withSiteLock` altında işletilerek çakışan veya yarışan mutasyonlar engellendi.
   - `websiteRemovalRuntime`'a `hasSiteMutationLock` özelliği eklendi; HTTP katmanı ile runtime katmanı arasında çift kilitleme (deadlock) önlenirken kilit garantisi sağlandı.

### C. Atomik Kontenjan Temizliği ve Hesap Askıya Alma (Suspend/Revoke)
1. **Atomik Silme Kontenjanı İadesi (`releaseRemoved`):**
   - Silme sürecinde (`metadata_finalization` ve `application_cleanup`), doğrulanmış kaynak yokluğu kanıtı ile `hostingAccounts.siteAllocations.releaseRemoved` tetiklenir.
   - `auth_customer_websites` ve `auth_hosting_site_allocations` kayıtları tek SQLite transaction'ında temizlenir, bayi ve müşteri site kontenjanları atomik olarak serbest bırakılır.
   - Silme tamamlandığında müşteri ve üst bayi canlı oturumları `revokeLiveUser` ile iptal edilir ve denetim kaydı (`hosting.website_released`) oluşturulur.
2. **Rezervasyon İptali ve Geri Alma (`releaseUncreated`):**
   - Başarısız oluşturma veya geri alma (compensation) sürecinde `hostingAccountStore.siteAllocations.releaseUncreated` ile geçici rezervasyon atomik olarak iptal edilir ve sayaçlar düşülür.
3. **Hesap Askıya Alma ve Oturum İptali:**
   - Pasif/askıya alınmış hesapların istekleri 403 `tenant_actor_inactive` ile anında engellenir.

## 2. Test ve Doğrulama

1. **`apps/api/test/tenant-boundary.test.js`:**
   - Kısıtlanan rota listesine `/api/sites` ve `/api/sites/hosted*` rotaları dahil edilerek bayi ve müşteri rollerinin erişim engeli doğrulandı.
2. **`apps/api/test/website-provisioning-http.test.js`:**
   - Bayi ve müşteri aktörlerinin yetkili oldukları sitelerde provisioning adımlarını ilerletebildiği kanıtlandı.
   - Aktif olmayan aktörlerin 403 `tenant_actor_inactive` ile durdurulduğu doğrulandı.
   - Yabancı sitelerde 404 dönerek izolasyon sağlandığı test edildi.
3. **`apps/api/test/website-removal-http.test.js`:**
   - Önizleme, başlatma, adım devam ettirme ve operasyon sorgulama rotaları doğrulandı.
   - Geçersiz oturum ve aktör kimliklerinin 403 ile reddedildiği test edildi.
4. **`apps/api/test/website-removal-runtime.test.js`:**
   - Direct-systemd, dosya temizliği, veritabanı, cron ve çalışma zamanı temizlikleri doğrulandı.
5. **`apps/api/test/hosting-site-create-http.test.js`:**
   - Barındırma önizleme, kota rezervasyonlu site oluşturma ve sahiplik bağlama akışları test edildi.
   - `recover-reservation` (`releaseUncreated`) ile rezervasyon kurtarma ve kota iadesi doğrulandı.
   - Website silme HTTP rotalarında tenant yetkilendirmesi, aktiflik kontrolü (`tenant_actor_inactive`) ve `siteMutationLock` kaynak kilitlemesi test edildi.
   - `releaseRemoved` ile bayi/müşteri kontenjanlarının atomik iadesi ve oturum feshi (`revokeLiveUser`) kanıtlandı.
   - `authorizeWebsiteRemovalActor` için aktiflik, MFA, tenant site kapsamı ve non-owner roller için null/eksik `websiteId` durumunda fail-closed reddi doğrulandı.

## 3. Doğrulama Komutları ve Kanıtları

Aşağıdaki birim ve entegrasyon test paketleri Node.js 24 ortamında development dalında temiz şekilde geçmektedir:
- `node --test apps/api/test/hosting-site-create-http.test.js` (pass, 0 fail)
- `node --test apps/api/test/website-provisioning-http.test.js` (pass, 0 fail)
- `node --test apps/api/test/tenant-boundary.test.js` (pass, 0 fail)
- `node --test apps/api/test/website-removal-http.test.js` (pass, 0 fail)
- `node --test apps/api/test/website-removal-runtime.test.js` (pass, 0 fail)
- `node --test packages/shared/test/tenant.test.js` (pass, 0 fail)
