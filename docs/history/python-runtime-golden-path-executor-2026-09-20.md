# Python Runtime Golden-Path Yürütücüsü ve Site-Create Entegrasyonu — 2026-09-20

Bu belge, YunPanel üzerinde Python Website ve Application'ları için `plan.md` P1.1 kapsamında yürütücü (executor), dağıtım (deploy), geri alma (rollback) ve işlemsel (transactional) site oluşturma sağlama (site-create provisioning) zincirinin kaynak kodda tamamlanmasını belgeler.

## 1. Kapsam ve Yapılan Değişiklikler

### 1.1 Dağıtım ve Geri Alma Operasyonları (`APP_PYTHON_DEPLOY`, `APP_PYTHON_ROLLBACK`)
- `apps/api/src/application-deploy-queue.js` ve `apps/api/src/core-app.js` dosyalarından `python_runtime_unavailable` hatası kaldırılarak Python dağıtım işleri kuyruğa alınabilir hale getirildi.
- `apps/api/src/local-host-operations.js` içine `OPERATIONS.APP_PYTHON_DEPLOY` ve `OPERATIONS.APP_PYTHON_ROLLBACK` operasyonları eklendi.
- Gizli Git kimlik bilgileri (credential) ve şifrelenmiş ortam değişkeni revizyonları (`environmentRevision`) güvenli şekilde çözülüp `host-runtime` katmanındaki `websitePythonReleaseManager`'a iletildi.
- Eski `application-deploy-python-unavailable.test.js` kaldırılarak `apps/api/test/application-deploy-python.test.js` ile Python deploy iş kuyruğu ve ortam revizyonu test edildi.

### 1.2 Python Release Manager Dışa Aktarımı ve Uygulama Kayıt Defteri
- `packages/host-runtime/package.json` içine `"./website-python-release-manager": "./src/website-python-release-manager.js"` dışa aktarımı eklendi.
- `apps/api/src/application-registry.js` içine `activatePythonRelease` ve `resetPythonInitialRelease` metotları eklenerek Python sürümlerinin atomik aktivasyonu ve ilk sağlama başarısızlıklarında geri alınması sağlandı.

### 1.3 İşlemsel Sağlama İşleyicileri (Provisioning Handlers)
Python sitelerinin oluşturulması sırasında sağlama adımları atomik, tersine çevrilebilir (compensatable) ve yeniden başlatmaya dayanıklı (inspect-first) olarak uygulandı:
1. `website-python-release-provisioning-handler.js` (`python_release`):
   - Git deposunu klonlar/açar, site UID altında izole sanal ortamı (`venv`) kurar, varsa `requirements.txt` paketlerini kurar.
   - Telafi durumunda (compensation) oluşturulan ilk sürümü ve sembolik bağı temizler.
2. `website-python-runtime-provisioning-handler.js` (`python_runtime`):
   - `systemd` servis dosyasını (`yunpanel-python-<appId>.service`) hazırlar (Gunicorn/Uvicorn, Unix socket veya TCP port).
   - Servisi etkinleştirir ve başlatır (`systemctl daemon-reload && systemctl enable --now`).
   - Telafi durumunda servisi durdurur, devre dışı bırakır ve birim dosyasını kaldırır.
3. `website-python-health-provisioning-handler.js` (`python_health`):
   - Nginx üzerinden uygulamanın sağlıklı yanıt verip vermediğini (`/` veya belirlenen sağlık yolu üzerinden HTTP 200/300) doğrular.
4. `website-python-application-release-provisioning-handler.js` (`python_application_release`):
   - `ApplicationRegistry` üzerinde sürümün aktif olduğunu belgeler ve kanıt (evidence) üretir.
   - Telafi durumunda ilk sürümü sıfırlar.

### 1.4 Site Oluşturma İş Akışı ve Nginx Entegrasyonu
- `apps/api/src/site-create-provisioning.js`: `pythonReleaseIntent`, `pythonRuntimeIntent`, `pythonHealthIntent` ve `pythonApplicationReleaseIntent` tanımlandı; `siteCreateProvisioningPlan` içerisine doğru sırayla yerleştirildi.
- `apps/api/src/site-create-base.js`: Python için `python_runtime_unavailable` kısıtı kaldırılarak önizleme ve oluşturma uçları açıldı.
- `apps/api/src/website-provisioning-handlers.js`: Nginx sağlama adımı için `pythonRuntimeEvidence` doğrulaması eklendi.
- `apps/api/src/website-provisioning-runtime.js` ve `apps/api/src/index.js`: Python işleyicileri sağlama çalışma zamanına bağlandı.

## 2. Doğrulama ve Testler

Aşağıdaki birim ve entegrasyon testleri başarıyla tamamlanmıştır:
- `apps/api/test/website-python-release-provisioning-handler.test.js` (5 test)
- `apps/api/test/website-python-runtime-provisioning-handler.test.js` (4 test)
- `apps/api/test/website-python-health-provisioning-handler.test.js` (3 test)
- `apps/api/test/website-python-application-release-provisioning-handler.test.js` (2 test)
- `apps/api/test/site-create-python.test.js` (2 test)
- `apps/api/test/application-deploy-python.test.js` (1 test)
- `apps/api/test/local-host-operations.test.js` (Python deploy/rollback dahil 9 test)
- `packages/host-runtime/test/*python*.test.js` (17 test)
- `packages/config-templates/test/*python*.test.js` (9 test)
- Tüm `apps/api` test paketi (2886 test, 0 hata).

## 3. Kalan Doğrulama ve Gerçek Ortam Kapıları

Kaynak kod implementasyonu tamamlanmış olup, gerçek Ubuntu 24.04 sunucusunda Python virtualenv, gunicorn/uvicorn servis çalışması ve Nginx reverse proxy uçtan uca testi `todo.md` dosyası altındaki `T-RUNTIME` maddelerinde takip edilmektedir.
