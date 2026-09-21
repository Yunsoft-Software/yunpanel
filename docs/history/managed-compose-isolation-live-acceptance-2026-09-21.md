# Managed Compose Website İzolasyonu Canlı Kabul Raporu (2026-09-21)

## Kapsam ve Amaç

Bu rapor, YunPanel'in Docker ve Managed Compose mimarisinde:
1. **Yönetilen Docker ve Docker Compose Servisi**:
   - Ubuntu 24.04 üzerinde Docker (`docker.io`) ve Docker Compose (`docker-compose-v2`) paketlerinin yönetilen servis kataloğunda (`packages: ['docker.io', 'docker-compose-v2']`) doğrulanması,
   - `docker.service` biriminin ve Docker CLI (`29.1.3`) / Docker Compose CLI (`2.40.3`) araçlarının hazır olması,
2. **Dedicated Project, Network ve Volume İzolasyon Denetimi**:
   - Güvenlik ve izolasyonu bozan `network_mode: host` veya container network paylaşımının (`container:...`) `docker_compose_service_network_invalid` ile fail-closed reddedilmesi,
   - Proje kapsamlı köprü ağı (`app_net`, `driver: bridge`, `scope: 'project'`) ve isimlendirilmiş birimin (`app_data`, `scope: 'project'`) doğrulanması,
   - Proje arzu edilen durumunun AES-256-GCM ile şifrelenerek `DockerComposeProjectRegistry` içinde güvenle saklanması,
3. **Canlı Docker Compose Çalıştırma ve Çalışma Zamanı İzolasyon Kanıtı**:
   - `createDockerComposeManager()` ile projenin detached modda başlatılması,
   - Konteyner etiketlerinin (`com.docker.compose.project`, `com.docker.compose.service`) canlı olarak doğrulanması,
   - Konteynerin yalnızca izole edilmiş proje köprü ağına (`yunpanel_compose_iso_app_net`) bağlı olduğunun teyit edilmesi,
   - İsimlendirilmiş birimin (`yunpanel_compose_iso_app_data`) yerel sürücüyle (`driver: local`) `/usr/share/nginx/html` altına bağlandığının ve `dockerVolumeInspector` ile doğrulandığının kanıtlanması,
   - Yayınlanan döngüsel (loopback) port (`127.0.0.1:49380`) üzerinden yapılan HTTP sorgusunun izole birimdeki içeriği kesintisiz döndürmesi,
4. **Website Bağlantısı (Binding) ve Çapraz-Site Çatışma Engellemesi**:
   - Website A için oluşturulan `managedComposeBinding` ({ projectId, serviceName: 'web', targetPort: 80, protocol: 'tcp' }) tanımının döngüsel proxy hedefine (`127.0.0.1:49380`, `websocket: true`) çözümlenmesi,
   - Website B'nin aynı servis/port ikilisine bağlanma girişiminin `managed_compose_binding_already_bound` (409) ile fail-closed engellenmesi; hiçbir sitenin başka bir sitenin Compose servisini gasp edememesi,
   - `diagnoseManagedComposeBinding` ile Website A tanısının `status: 'ready'`, `issues: 0` olarak doğrulanması,
5. **Log ve Gözlemci (Observer) Kapsam İzolasyonu**:
   - `dockerComposeObserver.logs()` çağrısının yalnızca ilgili projeye ait konteynerlerin erişim kayıtlarını döndürmesi; sunucudaki diğer konteynerlerin veya ana makinenin kayıtlarının sızdırılmaması,
   - Yabancı veya var olmayan projelerde `status: 'absent'`, `containerCount: 0` dönülmesi,
6. **Yedekleme ve Depolama Kapsamı İzolasyonu**:
   - İsimlendirilmiş birimin (`app_data`) `sourceScope: 'project'`, `kind: 'named_volume'` olarak yedekleme kapsamına dahil edilmesi; geçici veya harici bağlamaların kapsam dışı tutulması,
7. **Güvenlik Duvarı (nftables) Köprü İletimi ve Temiz Teardown**:
   - `nftables` `chain forward` içinde köprü trafiğine (`iifname/oifname "docker0"`, `iifname/oifname "br-*"`, `ct state established,related`) açık izin verilmesi ve genel `policy drop;` politikasının korunması,
   - Projenin `docker compose down -v` ile konteyner, ağ ve birimlerinin kalıntısız temizlenmesi,
   - Temizlik sonrasında sunucudaki temel servislerin (`pdns`, `nginx`, `mariadb`, `postfix`, `dovecot`, `rspamd`) eksiksiz aktif kalması

yeteneklerinin `.28` (`157.180.11.28`, test sunucusu, Ubuntu 24.04 LTS) üzerinde canlı olarak doğrulanmasını belgeler.

Kural gereği `.44` (Plesk) sunucusuna dokunulmamış, tüm testler `.28` test sunucusunda yürütülmüştür.

---

## Doğrulanan Bileşenler ve Fazlar

Test scripti `.28` test sunucusunda root yetkisiyle izole bir proje (`yunpanel_compose_iso`) ve port (`49380`) üzerinde yürütülmüştür.

### Faz 1: Yönetilen Servis & Docker Engine Doğrulaması
- `managedServiceManager.inspect('docker')` çağrısı yapıldı:
  - `installed: true`, `active: true`
  - `packages`: `docker.io` ve `docker-compose-v2`
  - `units`: `docker.service`
- Canlı CLI sürümleri: Docker `29.1.3`, Docker Compose `2.40.3`.

### Faz 2: Ağ ve Birim İzolasyon Kuralları
- `createDockerComposeValidator`:
  - `network_mode: host` içeren konfigürasyon `docker_compose_service_network_invalid` ile reddedildi.
  - `network_mode: "container:other_app"` içeren çapraz konteyner ağı reddedildi.
  - Dedicated `app_net` köprü ağı ve `app_data` birimi içeren doküman doğrulandı (`validated: true`).
- `DockerComposeProjectRegistry`: Arzu edilen Compose dokümanı anahtar şifrelemesiyle başarıyla kaydedildi (`revision: 1`).

### Faz 3: Canlı Docker Compose Çalıştırma
- `createDockerComposeManager().start(...)` ile konteyner başlatıldı (`runtimeState: 'running'`).
- `docker inspect` ile etiketler doğrulandı:
  - `com.docker.compose.project: yunpanel_compose_iso`
  - `com.docker.compose.service: web`
- Ağ doğrulaması: Konteyner yalnızca `yunpanel_compose_iso_app_net` köprü ağına bağlandı.
- Birim doğrulaması: `yunpanel_compose_iso_app_data` birimi `/usr/share/nginx/html` dizinine bağlandı.
- `dockerVolumeInspector` ile birim bağlama noktası (`/var/lib/docker/volumes/.../_data`) tespit edildi; özel bir HTML yerleştirildi.
- `http://127.0.0.1:49380/index.html` adresine yapılan döngüsel istek 200 OK ile özel içeriği döndürdü.

### Faz 4: Website Binding & Çapraz-Site Çatışma Engellemesi
- Website A için bağlantı çözümlendi: `proxyTarget: { host: '127.0.0.1', port: 49380, websocket: true }`.
- Website B'nin aynı proje ve servisi bağlama girişimi tespit edildi ve `managed_compose_binding_already_bound` kuralı doğrulandı.
- `diagnoseManagedComposeBinding` tanısı `status: 'ready'`, `issues: 0` üretti.

### Faz 5: Log Kapsam İzolasyonu
- `dockerComposeObserver.logs()` ile yalnızca `web` servisine ait 24 satırlık HTTP erişim logu okundu; ana makineden veya yabancı konteynerlerden hiçbir kayıt sızmadı.
- Yabancı projede `status: 'absent'`, `containerCount: 0` elde edildi.

### Faz 6: Depolama & Yedekleme Kapsamı
- `sourceScope: 'project'`, `kind: 'named_volume'` teyit edildi.

### Faz 7: Temizlik ve Taban Çizgisi
- `docker compose down -v` başarıyla tamamlandı; konteyner, ağ ve birim silindi.
- `pdns`, `nginx`, `mariadb`, `postfix`, `dovecot`, `rspamd` servislerinin tümü `active` durumda doğrulandı.
