# Website Removal Lifecycle ve Orchestration İlerlemesi — 2026-09-19

## Özet

`plan.md` P0.9 kapsamındaki "Website delete bağlı Domain delete operation'ları bitmeden Website/Application/Unix/runtime/file cleanup'a geçmesin" ve "Partial deletion retryable state bıraksın; restart hiçbir destructive step'i kör replay etmesin" maddeleri doğrultusunda:

1. **Website Removal Plan (`apps/api/src/website-removal-plan.js`)**:
   - `createWebsiteRemovalPreview({ website, impact })`: Website snapshot, resource impact evidence ve bağlı Domain'leri doğrular.
   - Bağlı domain'leri reverse order (subdomain'ler önce, sonra root/parent domain) sıralar.
   - Bağımlılıkları (`databases`, `sftpKeys`, `runtimeBindings`, `unixIdentities`, `logScopes`, `crons`, `backups`) `normalizedBucket` ile planlar.
   - Eksik envanter veya aktif iş varlığında fail-closed hardBlocker üretir.
   - Deterministik `previewDigest` ve typed `confirmation` (`start-website-remove:<websiteId>:<revision>:<digest>`) üretir.

2. **Website Removal Operation Registry (`apps/api/src/website-removal-operation-registry.js`)**:
   - Root-private JSON store tabanlı durable operasyon kaydı (`createWebsiteRemovalOperationRegistry({ filePath })`).
   - Reverse-order step sıralaması:
     1. `domain_removal` (bağlı her domain için)
     2. `cron_cleanup`
     3. `sftp_key_cleanup`
     4. `database_binding_cleanup`
     5. `runtime_cleanup`
     6. `file_cleanup`
     7. `unix_identity_cleanup`
     8. `metadata_finalization`
   - Atomik step geçişleri (`markStepRunning`, `succeedStep`, `blockStep`, `failStep`).
   - Tüm adımlar tamamlandığında `removed` terminal durumuna geçer.

3. **Website Removal Runtime (`apps/api/src/website-removal-runtime.js`)**:
   - Website removal orchestrator'ı; bağlı her domain için `DomainRemovalRuntime` child operasyonlarını başlatır, koordine eder ve domain'ler tamamen `removed` olmadan sonraki hiçbir temizlik (dosya, Unix, runtime, database, sftp, cron) adımına geçmez!
   - Restart ve lost-ack anında interrupted running adımları körlemesine replay etmeyip `blocked` olarak bekletir (`website_removal_interrupted`), explicit continuation ister.

4. **HTTP Routes (`apps/api/src/website-removal-http.js`)**:
   - `GET /api/websites/:websiteId/removal`
   - `POST /api/websites/:websiteId/removal-preview`
   - `POST /api/websites/:websiteId/removal`
   - `GET /api/websites/:websiteId/removal-operations`
   - `GET /api/websites/:websiteId/removal-operations/:operationId`
   - `POST /api/websites/:websiteId/removal-operations/:operationId/continue`
   - `requirePanelRouteAccess` ile yetkilendirilmiş, typed input doğrulamalı.

5. **Production Bootstrap Wiring (`apps/api/src/app.js` & `apps/api/src/index.js`)**:
   - `app.js`'e `mountWebsiteRemovalRoutes` bağlandı.
   - `index.js`'e `websiteRemovalOperationStorePath`, `websiteRemovalRuntime` başlatma, init ve `createApp` bağı eklendi.

6. **Testler ve Doğrulama**:
   - `apps/api/test/website-removal-plan.test.js` (4 test)
   - `apps/api/test/website-removal-operation-registry.test.js` (2 test)
   - `apps/api/test/website-removal-runtime.test.js` (2 test)
   - `apps/api/test/website-removal-http.test.js` (1 test)
   - Node 24 ile tam repo `npm run check` (linter, tüm workspace testleri ve build) başarıyla geçti.
