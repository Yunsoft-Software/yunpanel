# Python Runtime Golden Path Geliştirme İlerlemesi (2026-09-20)

## 1. Özet
P1.1 kapsamında Python WSGI (Gunicorn) ve ASGI (Uvicorn) runtime golden path implementasyonu tamamlandı. Dedicated site kullanıcısı altında izole virtualenv (`/var/lib/yunpanel/data/<applicationId>/venv`), systemd servis yönetimi (`yunpanel-python-<id>.service`), unix domain socket (`/run/yunpanel/python-<id>.sock`) veya loopback port üzerinden Nginx reverse proxy entegrasyonu, site-create `new_python` source kind desteği ve durable recovery/reconciliation zinciri kuruldu.

## 2. Gerçekleştirilen Değişiklikler

### `packages/shared`
- `src/python-application.js`:
  - Desteklenen sürümler (`3.10`, `3.11`, `3.12`), sunucular (`gunicorn`, `uvicorn`), workers, entry point formatı (`module:callable`), health path, restart policy ve proxy modu normalizer'ları eklendi.
  - `normalizePythonRuntimeConfig`, `normalizePythonApplicationSpec`, `normalizePythonRollbackSpec`, `normalizePythonRestartSpec`, `normalizePythonStatusSpec` fonksiyonları eklendi.
- `src/nginx-settings.js`:
  - `python` targetType için `proxyTimeoutSeconds` ve `websocket` ayarları tanımlandı.
- `src/index.js`:
  - Python normalizer'ları export edildi.

### `packages/config-templates`
- `src/python-systemd.js`:
  - Gunicorn ve Uvicorn için hardened systemd unit oluşturucu (`renderPythonSystemdUnit`) yazıldı.
  - Dedicated site user (`yunapp-*`), venv binary (`/venv/bin/gunicorn`, `/venv/bin/uvicorn`), unix socket izinleri (`UMask=0027`), private tmp, protect system/home ayarları uygulandı.
  - `pythonServiceName`, `pythonSocketPath`, `pythonApplicationUser` yardımcı fonksiyonları tanımlandı.
- `src/python-nginx.js`:
  - Python reverse proxy site konfigürasyon şablonu (`renderPythonSiteConfig`) yazıldı (Unix socket ve loopback TCP desteği).
- `src/nginx.js` & `src/index.js`:
  - Nginx template yöneticisine python desteği eklendi.

### `packages/protocol`
- `src/index.js` & `src/index-node-passenger.js`:
  - `APP_PYTHON_DEPLOY`, `APP_PYTHON_ROLLBACK`, `APP_PYTHON_RESTART`, `APP_PYTHON_STATUS` operasyonları ve envelope doğrulamaları eklendi.
  - `DOMAIN_STAGE` payload doğrulamasına `targetType: 'python'` desteği eklendi.

### `packages/host-runtime`
- `src/python-site-manager.js`:
  - `PythonSiteManager` sınıfı yazıldı.
  - `ensurePrerequisites`: Host üzerinde `python3` ve `python3-venv` modülünü doğrular.
  - `ensureVirtualenv`: Site kullanıcısı altında izole venv kurar.
  - `installRequirements`: `requirements.txt` varsa venv içine pip ile yükleme yapar.
  - `apply`: Systemd unit'ini yazar, reload eder, servisi başlatır/etkinleştirir ve receipt kaydeder.
  - `compensate`: Hata durumunda servisi durdurup unit dosyasını temizler.
  - `inspect`: Servisin systemd durumu ile socket dosyasını denetler.
  - `restart`, `stop`: Servis yönetim fonksiyonları sağlandı.
- `src/nginx-manager.js`:
  - `targetType: 'python'` için `renderPythonSiteConfig` üzerinden staging desteği eklendi.

### `apps/api`
- `src/application-registry.js`:
  - Python application oluşturma, port çakışma kontrolü ve release lifecycle yönetimi eklendi.
- `src/application-deploy-queue.js`:
  - Python deploy/rollback işlemlerinin kuyruk yönetimi sağlandı.
- `src/website-registry.js`:
  - `RUNTIME_TYPES` içine `'python'` eklendi.
- `src/domain-registry-base.js`:
  - `TARGET_TYPES` içine `'python'` eklendi.
  - `validateTarget`, `settingsFromTarget`, `targetWithSettings` python desteğiyle güncellendi.
  - Python domainleri için explicit Website binding zorunluluğu getirildi.
- `src/website-domain-target.js`:
  - `resolvePythonRuntimeTarget` fonksiyonu yazıldı (socket ve loopback port modları).
- `src/site-create-base.js`:
  - `new_python` source kind desteği, preview ve execution akışına entegre edildi.
- `src/website-isolation-audit.js`, `src/website-sftp-key-service.js`, `src/website-cron-registry.js`, `src/database-binding-registry.js`:
  - Python runtime desteklenen hosted runtime tiplerine eklendi.
- `src/job-registry.js`:
  - `APP_PYTHON_*` operasyonları `SUPPORTED_OPERATIONS` ve `ASYNC_OPERATIONS` listelerine eklendi.
  - `PYTHON_SERVICE_PATTERN` ve result sanitization eklendi.
- `src/job-reconciliation.js`:
  - `APP_PYTHON_DEPLOY`, `APP_PYTHON_ROLLBACK`, `APP_PYTHON_RESTART` reconciler'ları bağlandı.
- `src/job-running-recovery.js` & `src/job-running-python-recovery.js`:
  - Running recovery implementasyonları yazıldı (`recoverRunningPythonDeployment`, `recoverRunningPythonRollback`, `recoverRunningPythonRestart`).
- `src/local-host-operations.js`:
  - Yerel python operasyon eşlemeleri tamamlandı.

## 3. Test ve Doğrulama
- Node 24 (`v24.21.0`) ile tüm çalışma alanları test edildi:
  - `packages/shared`: 40/40 test geçti.
  - `packages/config-templates`: 166/166 test geçti.
  - `packages/protocol`: 77/77 test geçti.
  - `packages/host-runtime`: 651/651 test geçti.
  - `apps/api`: 2850/2850 test geçti.
  - `@yunpanel/agent`: 76/76 test geçti.
- `npm run check` (tüm lint ve derleme kontrolleri) 0 hata ile tamamlandı.
- Gerçek host/Ubuntu kabul adımları `todo.md` dosyasına eklendi.
