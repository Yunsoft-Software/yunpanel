# Website Cron Durable Job Lifecycle, Receipt Store, Reconciliation ve Authenticated CRUD API İlerlemesi (2026-09-19)

Bu belge, P1.4 kapsamındaki Website-scoped cron/timer yönetiminin durable job lifecycle, host execution, receipt store, reconciliation ve authenticated HTTP CRUD API geliştirmelerini belgeler.

## Yapılan İşler

1. **Protocol Extension (`packages/protocol`)**:
   - `CRON_APPLY: 'cron.apply'` ve `CRON_REMOVE: 'cron.remove'` operasyonları `OperationType` enum'ına eklendi.
   - `validateCronMutation` ile `taskId`, `websiteId`, `applicationId`, `unixUser` (`yunapp-*`), `expectedRevision`, `desiredStateSha256` zorunlu parametre validasyonu yapıldı.
   - Envelope validation ve factory wiring tamamlandı.

2. **Durable Receipt Store (`apps/api/src/website-cron-operation-receipt.js`)**:
   - Root-private receipt store: `/var/lib/yunpanel/recovery/website-crons` (`0700` dir, `0600` file, atomic temp+rename).
   - Store Version 1 receipt okuma/yazma ve validasyon metodları uygulandı.

3. **Job Result Sanitizer & Registry (`apps/api/src/website-cron-job-result.js` & `apps/api/src/job-registry.js`)**:
   - `sanitizeWebsiteCronJobResult` utility'si oluşturuldu.
   - `apps/api/src/job-resource-types.js` içine `'website_cron'` eklendi.
   - `apps/api/src/job-registry.js`: `KNOWN_OPERATIONS` ve `ASYNC_OPERATIONS` setlerine `CRON_APPLY` ve `CRON_REMOVE` eklendi, `sanitizeResult` içine bağlandı.

4. **Local Host Execution Handler (`apps/api/src/local-website-cron-operation.js`)**:
   - `createLocalWebsiteCronOperation`: `websiteCronManager.apply` ve `remove` çağrıları, execution context kontrolü (`resourceType: 'website_cron'`), receipt store'a atomic yazım ve remove sonrası registry `deleteTask` koordinasyonu sağlandı.
   - `apps/api/src/local-host-operations.js`: `LOCAL_CRON_OPERATIONS` eklendi, `websiteCronOperation` parametresi ve handler'ları bağlandı.

5. **Live Reconciliation Provider (`apps/api/src/website-cron-reconciliation.js`)**:
   - `createWebsiteCronReconciliationProvider`: `inspectTask`, `reconcileWebsite`, `reconcileServer` metodları ile registry task'ı, host file (`contentSha256`), cron service active ve orphan host file durumlarını denetleyen live provider oluşturuldu (`status: 'ready' | 'missing_host_file' | 'drifted' | 'service_inactive'`).

6. **Website Cron Apply Service (`apps/api/src/website-cron-apply-service.js`)**:
   - `createWebsiteCronApplyService`: `listCrons`, `getCron`, `createCron`, `updateCron`, `deleteCron` metodları ile hosted runtime (`static`, `node`, `php`) kontrolü ve durable job queueing (`CRON_APPLY` / `CRON_REMOVE`) sağlandı.

7. **Authenticated HTTP API Routes (`apps/api/src/website-cron-http.js`)**:
   - `GET /api/websites/:websiteId/crons`: Website'a ait cron task'larını listeler ve live host reconciliation durumunu ekler.
   - `POST /api/websites/:websiteId/crons`: Yeni cron task oluşturur, durable `CRON_APPLY` job'ı kuyruğa alır.
   - `GET /api/websites/:websiteId/crons/:cronId`: Tek bir cron task detayını döner.
   - `PATCH /api/websites/:websiteId/crons/:cronId`: Cron task'ını günceller, durable `CRON_APPLY` job'ı kuyruğa alır.
   - `DELETE /api/websites/:websiteId/crons/:cronId`: Cron task'ını siler, durable `CRON_REMOVE` job'ı kuyruğa alır.
   - `requirePanelRouteAccess` guard'ı ve strict request body validasyonu uygulandı.
   - `apps/api/src/app.js` ve `apps/api/src/index.js` production bootstrap'ına bağlandı.

8. **Job Recovery & Parity Entegrasyonu**:
   - `apps/api/src/job-running-cron-recovery.js`: running cron job'ları receipt ve host inspection ile kurtaran recovery handler oluşturuldu.
   - `apps/api/test/local-operation-queue-parity.test.js` ve `apps/api/test/job-recovery-operation-parity.test.js` testleri güncellendi ve geçti.
