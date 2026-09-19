# Mail Domain Disable & Delete Roundcube Webmail Mapping Teardown ve Blocker İlerlemesi (2026-09-20)

## 1. Özet
P0.4 mail core parity ve P0.9 suspend/delete gereksinimleri doğrultusunda, Mail Domain devre dışı bırakma (`disable`) ve silme (`delete`) yaşam döngüleri Roundcube webmail eşlemesine bağlanmıştır.
Bir Mail Domain üzerinde aktif veya işlem halindeki (`active`, `pending`, `removing`) bir Roundcube webmail eşlemesi (`webmail.<domain>`) bulunduğu sürece, Mail Domain'in devre dışı bırakılması (`ready: false`, blocker: `mail_domain_webmail_mapping_active`) ve silme etki/plan önizlemeleri (`safeToDelete: false`, `readyToStart: false`, blocker: `mail_domain_webmail_mapping_active`) engellenir. Bu sayede Nginx üzerinde yetim webmail sunucu bloğu kalması kesin olarak engellenir. Webmail eşlemesi silinip `removed` tombstone durumuna geçtikten sonra devre dışı bırakma ve silme işlemlerine izin verilir.

## 2. Gerçekleştirilen Değişiklikler

### `apps/api/src/mail-configuration.js`
- `createMailConfigurationService` kurucusuna opsiyonel `roundcubeDomainMappingRegistry` bağımlılığı eklendi ve doğrulandı.
- `materializeConfiguration` içinde, `resolved.input.status === 'disabled'` ve `resolved.candidate.status === 'enabled'` durumunda `roundcubeDomainMappingRegistry.getRecordForMailDomain` sorgulandı.
- Eğer kayıt varsa ve `state !== 'removed'` ise, `resolved.domains.length === 0` kontrolünden önce fail-closed olarak `ready: false` ve `blockers: ['mail_domain_webmail_mapping_active']` döndürüldü.
- Bu sayede son/tek yerel posta alan adı kapatılırken dahi aktif webmail eşlemesi varsa devre dışı bırakma engellendi; `materializeTransition` aşamasında `mail_configuration_not_ready` fırlatıldı.

### `apps/api/src/mail-delete-impact.js`
- `createMailDeleteImpactService` kurucusuna `roundcubeDomainMappingRegistry` opsiyonu eklendi ve doğrulandı.
- `inspectMailDomain` içinde `roundcubeDomainMappingRegistry.getRecordForMailDomain` çağrılarak `webmailMappingConfigured = Boolean(webmailMapping && webmailMapping.state !== 'removed')` hesaplandı.
- Aktif eşleme varsa `blockers.push(blocker('mail_domain_webmail_mapping_active'))` eklenerek `safeToDelete: false` olması sağlandı ve `dependencies.webmailMappingConfigured` alanında sunuldu.

### `apps/api/src/mail-domain-removal-plan.js`
- `createMailDomainRemovalPlanService` kurucusuna `roundcubeDomainMappingRegistry` opsiyonu eklendi ve doğrulandı.
- `preview` içinde `roundcubeDomainMappingRegistry.getRecordForMailDomain` kontrol edilerek eşleme `removed` değilse `blockers.push(blocker('mail_domain_webmail_mapping_active', 1))` eklendi ve `readyToStart: false` yapıldı.

### `apps/api/src/mail-domain-removal-production-runtime.js`
- Kurucuya `roundcubeDomainMappingRegistry = null` parametresi eklendi ve altındaki `deleteImpact` ile `planService` servislerine geçirildi.

### `apps/api/src/app.js` & `apps/api/src/index.js`
- `app.js` içinde `mailConfig` ve `mailDeleteImpact` servislerine `roundcubeDomainMappingRegistry` geçirildi.
- `index.js` içinde üretim `mailConfigurationService` örneğine `roundcubeDomainMappingRegistry` bağlandı.

## 3. Eklenen Testler ve Doğrulama
- `apps/api/test/mail-configuration-empty-disable.test.js`:
  - `active`, `pending`, `removing` durumlarındaki webmail eşlemesinin Mail Domain disable önizlemesini ve uygulamasını `mail_domain_webmail_mapping_active` blocker'ı ile durdurduğu doğrulandı.
  - Eşleme `removed` olduktan sonra disable işleminin başarıyla tamamlandığı doğrulandı.
- `apps/api/test/mail-delete-impact.test.js`:
  - Webmail eşlemesi varken `webmailMappingConfigured: true` ve `mail_domain_webmail_mapping_active` blocker'ı döndürüldüğü ve `safeToDelete: false` olduğu doğrulandı.
  - Eşleme `removed` veya `null` iken güvenli silinebilir olduğu doğrulandı.
- `apps/api/test/mail-domain-removal-plan.test.js`:
  - Aktif veya in-flight eşleme varken `readyToStart: false` ve `mail_domain_webmail_mapping_active` blocker'ı döndüğü doğrulandı.
  - Eşleme `removed` iken planın `readyToStart: true` verdiği doğrulandı.
- `apps/api/test/roundcube-webmail-production-wiring.test.js`:
  - `index.js`, `app.js` ve `mail-domain-removal-production-runtime.js` içerisindeki üretim bağlantıları doğrulandı.
- Node 24 (`v24.21.0`) ortamında tüm `apps/api` testleri (2,850 test) ve kök dizindeki `npm run check` (tüm paketlerin build/test süreçleri) sıfır hata ile geçti.
