# Managed Compose Identity ve Passenger Runtime Golden Path İlerlemesi (2026-09-20)

## 1. Kapsam ve Ürün Hedefi

`plan.md` P1.1 (Runtime golden path) kapsamındaki iki ana hedef tamamlandı:
1. **Managed Compose dedicated project/network/volume identity**:
   - Docker Compose konfigürasyonunda ağ izolasyonunun zorunlu kılınması (`network_mode: 'host'`, `container:...`, `service:...` yasaklanması).
   - Ağ kapsam sınıflandırması (`namedNetworkScope`: `project` vs `host`) ve `docker-compose-project-registry` içinde tüm ağların proje kapsamlı olmasının denetlenmesi.
   - `existing_managed_compose` kaynak türünün (`kind: 'existing_managed_compose'`, `projectId`, `serviceName`, `targetPort`, `protocol`) site-create pipeline'ına eklenmesi.
   - Proje, servis, yayınlanan port ve loopback hedefinin (`127.0.0.1:<publishedPort>`) doğrulanması.
   - Başka bir web sitesine bağlanmış servisin mükerrer bağlanmasının (`managed_compose_binding_already_bound`) önlenmesi.
   - Website kaydına `runtimeType: 'docker'` ve `managedComposeBinding: { projectId, serviceName, targetPort, protocol }` bağlanması.
   - Provisioning planına `managed_compose_binding` metadata adımının eklenmesi.
   - `apps/api/src/app.js` üzerinde `mountSiteCreateRoutes`'a `dockerComposeProjectRegistry` bağımlılığının geçirilmesi.
2. **Passenger dependency/env/log/startup/config validation + rollback**:
   - Kaynak kod düzeyinde Passenger bağımlılık, çevre değişkeni, log, startup dosyası ve konfigürasyon denetimi ile rollback receipt mekanizması zaten tamamlanmış olup birim testlerle korunmaktadır; canlı sunucu kabulü `todo.md` T-RUNTIME altında takip edilmektedir.

## 2. Yapılan Değişiklikler

### 2.1 `packages/host-runtime/src/docker-compose-validator.js`
- `namedNetworkScope(source, networkDefinitions, expectedProjectName)` fonksiyonu eklendi; default ağlar ve proje adıyla başlayan ağlar `project` kapsamına, diğerleri `host` kapsamına ayrıldı.
- `service.network_mode` alanında `host`, `container:...`, `service:...` gibi izole olmayan modlar reddedildi (`docker_compose_network_mode_unsupported`).
- `summarizeDockerComposeConfig` çıktısına `networkDetails: [{ name, scope }]` eklendi.
- `dockerComposeValidatorInternals` içine `namedNetworkScope` dışa aktarıldı.

### 2.2 `apps/api/src/docker-compose-project-registry.js`
- Proje kaydı ve güncellemesinde `summary.networkDetails` içindeki tüm ağların `scope === 'project'` olması kuralı getirildi; aksi takdirde `docker_compose_host_network_unsupported` hatası fırlatıldı.

### 2.3 `apps/api/src/site-create-base.js`
- `SOURCE_KINDS` kümesine `existing_managed_compose` eklendi.
- `normalizedSource` fonksiyonunda `projectId` (UUID), `serviceName` (desen), `targetPort` (1..65535) ve `protocol` ('tcp') doğrulandı.
- `domainTarget` fonksiyonunda `existing_managed_compose` için yayınlanan loopback portu üzerinden `proxy` hedefi (`127.0.0.1:<publishedPort>`, `websocket: true`) üretildi.
- `previewSiteCreate`:
  - `dockerComposeProjectRegistry` bağımlılığı kontrol edildi.
  - Projenin varlığı, sunucu eşleşmesi, servisin projede bulunması ve hedef portun TCP üzerinde yayınlanmış olması doğrulandı.
  - Mevcut siteler arasında aynı servisin başka bir siteye bağlanıp bağlanmadığı denetlendi (`managed_compose_binding_already_bound`).
  - `websiteExpected` içinde `managedComposeBinding: { projectId, serviceName, targetPort, protocol }`, `runtimeType: 'docker'`, `proxyTarget: null` modellendi.
  - `runtimeExpected` içinde `adapter: 'managed_compose'`, `serviceName`, `targetPort`, `protocol`, `publishedPort` sağlandı.
  - `planCore.resources.managedComposeBinding` ve `preview.steps.managedComposeReady` bağlandı.
- `createSite`:
  - `dockerComposeProjectRegistry` parametresi eklendi ve `previewSiteCreate`'e iletildi.
  - `websiteRegistry.createWebsite` çağrısına `managedComposeBinding` ve `runtimeType` geçirildi.

### 2.4 `apps/api/src/site-create-provisioning.js`
- `siteCreateProvisioningPlan` içinde `preview.plan.managedComposeBinding` varsa `managed_compose_binding` türünde metadata adımı eklendi.

### 2.5 `apps/api/src/app.js`
- `mountSiteCreateRoutes` bağımlılıklarına `dockerComposeProjectRegistry` eklendi.

### 2.6 Testler
- `packages/host-runtime/test/docker-compose-validator.test.js`: Ağ kapsam sınıflandırması ve izole olmayan ağ modlarının reddedilmesi test edildi.
- `apps/api/test/docker-compose-project-registry.test.js`: Proje kayıtlarında harici host ağlarının reddedilmesi test edildi.
- `apps/api/test/site-create-managed-compose.test.js`:
  - Önizleme ve oluşturma akışının loopback proxy hedefi ve provisioning adımı ile doğrulanması.
  - Proje bulunamadı (404), sunucu uyuşmazlığı (409), servis projede yok (404), port yayınlanmamış (409) ve servis portu zaten bağlı (409) senaryoları doğrulandı.

## 3. Doğrulama
- `node --test apps/api/test/site-create-managed-compose.test.js`: 6 test geçti.
- `node --test apps/api/test/site-create*.test.js`: 79 test geçti.
- `node --test packages/host-runtime/test/docker-compose-validator.test.js`: 11 test geçti.
- `node --test apps/api/test/docker-compose-project-registry.test.js`: 4 test geçti.
