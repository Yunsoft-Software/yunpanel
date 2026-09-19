# Delete Evidence Chains & Retention Wiring — 2026-09-19

Bu kayıt, P0.9 Suspend/delete/rollback başlığı altındaki silme kanıt zincirleri, veri koruma ve retention bağlarının tamamlanmasını belgeler.

## Tamamlanan Geliştirmeler

1. **Website Removal Plan & Orchestratable Impact Blockers**:
   - `apps/api/src/website-removal-plan.js` içine `ORCHESTRATABLE_WEBSITE_IMPACT_BLOCKERS` eklendi:
     - `domains_present`, `linked_domains_present`, `child_domains_present`
     - `website_binding_present`, `application_binding_present`
     - `database_binding_dependencies_present`, `sftp_key_dependencies_present`, `runtime_binding_dependencies_present`
     - `unix_identity_dependencies_present`, `log_scope_dependencies_present`, `cron_dependencies_present`
     - `backup_dependencies_present`, `impact_apply_not_implemented`
   - `hardBlockers` mantığı güncellendi; Website orchestrator'ının temizleyebildiği veya kanıt olarak koruduğu bu bağımlılıklar artık önizlemeyi kilitlemez.

2. **Database & File Deletion Evidence Zinciri (`website-removal-runtime.js`)**:
   - `createWebsiteRemovalRuntime` içerisine `databaseCredentialRegistry` entegre edildi.
   - `database_binding_cleanup`:
     - Her veritabanı bağı için varsa ilişkili credential'lar `databaseCredentialRegistry.deleteCredential` ile typed confirmation (`delete-database-credential:...`) ile kaldırılır.
     - Veritabanı bağı `databaseBindingRegistry.unbindDatabase` ile typed confirmation (`unbind-database:...`) ile çözülür.
     - Adım sonucunda `unboundBindings` (id, databaseName, revision, unbound) kanıtı saklanır.
   - `file_cleanup`:
     - `fileCleanupHandler`'a `retainedBackups` (`plan.additional.backups.ids`) aktarılır.
     - Adım sonucunda `filesCleaned: true` ve `retainedBackups` kanıtı saklanır.

3. **Production Wiring (`apps/api/src/index.js` & `domain-removal-production-runtime.js`)**:
   - `domain-removal-production-runtime.js` artık `backupImpactProvider`'ı dışa aktarır.
   - `apps/api/src/index.js` içinde Website preview `additionalProviders.backups` alanına `domainRemovalRuntimeBundle?.backupImpactProvider` bağlandı.
   - `createWebsiteRemovalRuntime` factory'sine `databaseCredentialRegistry` sağlandı.

4. **Test & Doğrulama**:
   - `apps/api/test/website-removal-plan.test.js`: Orchestratable blockers testi eklendi.
   - `apps/api/test/website-removal-runtime.test.js`: Veritabanı credential silme, unbind ve retainedBackups dosya temizliği testleri eklendi.
   - Node 24 ortamında `npm run check` (tüm paket testleri, build ve lint) başarıyla tamamlandı.
