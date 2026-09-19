# Delete Impact Providers ve Parent Removal Plan Entegrasyonu — 2026-09-19

## Özet

`plan.md` P0.9 kapsamındaki "Mevcut delete impact graph'ında henüz unavailable/eksik kalan Unix/runtime/DB/SFTP/log bağımlılık provider'larını tamamla" maddesi doğrultusunda:
1. `resource-impact.js` içindeki `ADDITIONAL_TYPES` listesine `databases`, `sftpKeys`, `runtimeBindings`, `unixIdentities`, `logScopes` eklendi.
2. `website-delete-impact-providers.js` modülünde reusable, fail-closed impact provider'lar ve bunları birleştiren `createAllWebsiteImpactProviders` factory'si oluşturuldu.
3. `domain-removal-plan.js` modülünde `dependencyPlan` fonksiyonu güncellenerek `databases`, `sftpKeys`, `runtimeBindings`, `unixIdentities`, `logScopes` bucket'ları `normalizedBucket` ile eklendi.
4. `domain-removal-production-runtime.js` modülünde `websiteSftpKeyRegistry` ve `runtimeBindingRegistry` kabul edilip `createAllWebsiteImpactProviders` üzerinden `additionalProviders` nesnesine bağlandı.
5. `app.js` ve `index.js` üretim/bootstrap katmanlarında `mountResourceImpactRoutes` ve `createDomainRemovalProductionRuntime` çağrılarına bu provider'lar geçirildi.
6. `apps/api/test/website-delete-impact-providers.test.js`, `apps/api/test/resource-impact.test.js`, `apps/api/test/domain-removal-production-runtime.test.js` ve `apps/api/test/domain-removal-plan.test.js` testleri yazıldı/güncellendi; tam `npm run check` (lint, tüm workspace testleri ve build) Node 24 ile doğrulandı.

## Değişen ve Eklenen Dosyalar

- `apps/api/src/resource-impact.js`
- `apps/api/src/website-delete-impact-providers.js` (YENİ)
- `apps/api/src/domain-removal-plan.js`
- `apps/api/src/domain-removal-production-runtime.js`
- `apps/api/src/app.js`
- `apps/api/src/index.js`
- `apps/api/test/website-delete-impact-providers.test.js` (YENİ)
- `apps/api/test/resource-impact.test.js`
- `apps/api/test/domain-removal-production-runtime.test.js`
- `apps/api/test/domain-removal-plan.test.js`
