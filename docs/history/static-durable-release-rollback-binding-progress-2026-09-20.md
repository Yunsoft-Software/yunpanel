# Static Durable Release & Rollback Binding Revision İlerletmesi — 2026-09-20

## Kapsam ve Amaç

Bu çalışma, `plan.md` altındaki `P1.1 — Runtime golden path` bölümünün şu maddesini kaynak kod ve test düzeyinde tamamlar:
- `Static durable release/rollback binding revision.`

Hedef:
1. Static siteler için runtime binding otoritesini (`ApplicationRuntimeBindingRegistry`) `passenger` ve `direct-systemd`'nin yanına 3. adapter (`'static'`) olarak eklemek.
2. Static binding hedef yapısını (`staticTarget: { publishRoot, documentRoot, user, group }`) tanımlamak ve doğrulamak; Passenger target veya cleanup_required gibi uyumsuz durumları fail-closed engellemek.
3. Operasyon sahipliği ve revizyon zinciri:
   - Deploy ve rollback işlemlerinde (`APP_STATIC_DEPLOY`, `APP_STATIC_ROLLBACK`) durable binding'in `releaseId` ve `sourceOperationId` değerlerini `expectedRevision` denetimiyle atomik olarak güncellemek ve revizyonu artırmak.
   - İdempotent tekrarlarda (`sameActivation`) revizyon artırmadan aynı kanıtı korumak.
   - Olası geri alma veya silmelerde `removeOwnedStatic` ile operasyon sahipliği ve beklenen revizyon kontrolü sağlamak.
4. Domain trafik yönlendirmesi (`website-domain-target.js`):
   - Static web siteleri için `resolveStaticRuntimeTarget` üzerinden `ApplicationRuntimeBindingRegistry` sorgulanarak aktif sürüm (`releaseId === application.currentReleaseId`), sunucu kimliği, website/domain revizyonu ve hedef kökü (`staticTarget.documentRoot`) doğrulanır.
   - Drift durumlarında (`static_runtime_binding_drift`) fail-closed durdurulur; bağlayıcı bulunmayan unmanaged/legacy statik siteler için `persistedDomainTarget` fallback'i korunur.
5. Domain restage mutabakatı (`job-reconciliation.js`):
   - `DOMAIN_STAGE` sonucunda Nginx checksum ve domain revizyonunu `reconcileStaticDomainStageBinding` ile static binding'e yansıtmak.

## Yapılan Değişiklikler

### 1. Application Runtime Binding Registry (`apps/api/src/application-runtime-binding-registry.js`)
- `ADAPTERS` kümesine `'static'` eklendi.
- `STATIC_TARGET_FIELDS` (`publishRoot`, `documentRoot`, `user`, `group`) ve `staticTarget(value, adapter)` doğrulayıcısı tanımlandı.
- `passengerTarget` ve `staticTarget` çapraz kontrolleri eklendi (static binding Passenger hedefi taşıyamaz, Passenger binding static hedef taşıyamaz).
- `sameActivation`, `normalizeRecord` ve `publicRecord` fonksiyonları `staticTarget` desteğiyle güncellendi.
- `removeOwnedStatic(applicationId, { sourceOperationId, expectedRevision })` eklendi.
- Dışa aktarılan internal fonksiyonlara `staticTarget` eklendi.
- **Testler (`apps/api/test/application-runtime-binding-registry.test.js`)**:
  - `staticTarget` ve `staticActivation` fikstürleri eklendi.
  - Sürüm ilerletme, deploy/rollback revizyon takibi, idempotency, hedef uyumsuzluğu ve `removeOwnedStatic` testleri dahil 10 test başarıyla geçti.

### 2. Website Domain Target Resolution (`apps/api/src/website-domain-target.js`)
- `staticBindingDrift(message)` yardımcı hatası eklendi (`static_runtime_binding_drift`, 409).
- `resolveStaticRuntimeTarget({ domain, website, applicationRegistry, runtimeBindingRegistry })` eklendi:
  - `website.runtimeType === 'static'` ve `website.applicationId` varlığında registry sorgulanır.
  - Sürüm uyuşmazlığı (`binding.releaseId !== application.currentReleaseId`), sunucu uyuşmazlığı, kaynak uyuşmazlığı veya domain revizyon gerilemesinde drift hatası fırlatılır.
  - Hedef olarak `{ source: 'static', targetType: 'static', target: { root: binding.staticTarget.documentRoot, spaFallback: ... } }` üretilir.
- `resolveWebsiteDomainTarget` akışına `resolveStaticRuntimeTarget` eklendi; binding bulunamazsa `persistedDomainTarget` fallback'i korunarak geriye dönük uyumluluk sağlandı.
- `websiteDomainTargetInternals` içerisine `resolveStaticRuntimeTarget` eklendi.
- **Testler (`apps/api/test/website-domain-target.test.js`)**:
  - Statik bağlama olmadan persisted target fallback doğrulaması.
  - Kanonik statik hedef üretimi.
  - Release drift, domain revizyon gerilemesi ve uyumsuz domain targetType reddi testleri eklendi; 17 test başarıyla geçti.

### 3. Job Reconciliation (`apps/api/src/job-reconciliation.js`)
- `reconcileApplicationJob`:
  - `runtimeBindingRegistry` bağımlılığı geçirildi.
  - `APP_STATIC_DEPLOY` ve `APP_STATIC_ROLLBACK` başarılı tamamlandığında, varsa static runtime binding'in `releaseId` ve `sourceOperationId` alanları `expectedRevision` kontrolüyle güncellenerek revizyon atomik olarak ilerletildi.
- `reconcileStaticDomainStageBinding`:
  - Static domain sahneleme (`DOMAIN_STAGE`) sonucunda Nginx checksum ve `desiredRevision` static runtime binding `domains` kanıtına kaydedildi.
  - Hedef dizin uyuşmazlığında (`static_domain_stage_target_drift`) ve revizyon gerilemesinde fail-closed koruma sağlandı.
- `jobReconciliationInternals` içerisine `reconcileStaticDomainStageBinding` eklendi.
- **Testler (`apps/api/test/job-reconciliation-static-runtime.test.js`)**:
  - Restage evidence ilerletme, target root drift fail-closed, deploy ve rollback tamamlanma mutabakatı testleri eklendi; 4 test başarıyla geçti.

## Doğrulama
- Full check (`npm run check`): Tüm lint kontrolleri, tüm çalışma alanı testleri ve production web bundle build'ı 0 hata ile tamamlandı.
