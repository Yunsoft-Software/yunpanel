# Netdata Loopback ve Yetkilendirilmiş Gateway Canlı Kabul Raporu (2026-09-20)

## 1. Kapsam ve Amaç
Bu rapor, `plan.md` (P1.3 — Monitoring/security: Netdata loopback + authenticated gateway) ve `todo.md` (T-OBSERVABILITY-SECURITY: Netdata yalnız loopback dinlesin ve YunPanel authenticated reverse proxy arkasında gerçek CPU/RAM/load/disk/inode/service/container verisi göstersin; doğrudan port public erişilemesin) maddelerinin `.28` test sunucusunda (`157.180.11.28`) canlı olarak uçtan uca doğrulanmasını belgeler.

## 2. Doğrulanan Bileşenler ve Güvenlik Sınırları

1. **Netdata Paket Kurulumu ve Servis Yönetimi:**
   - Ubuntu 24.04 LTS resmi deposundan Netdata (v1.43.2) kuruldu.
   - `packages/host-runtime/src/managed-service-manager.js` içindeki `SERVICE_CATALOG` kataloğuna ve `apps/api/src/managed-service-state-policy.js` içine `netdata` eklendi (`units: ['netdata.service']`, `configurationChecks: ['/usr/sbin/netdata -v', '/etc/netdata/netdata.conf']`).

2. **Loopback İzolasyon Politikası (`packages/config-templates`):**
   - `packages/config-templates/src/netdata.js` şablonu oluşturuldu.
   - `renderNetdataConfig`: `bind to = 127.0.0.1` ve `default port = 19999` zorunlu kılındı.
   - Loopback dışındaki (`0.0.0.0`, `::`, genel IP) adresler `netdata_bind_address_unsafe` hatasıyla fail-closed olarak reddedildi.

3. **Netdata Konfigürasyon Yöneticisi (`packages/host-runtime`):**
   - `createNetdataManager`: `/etc/netdata/netdata.conf` dosyasını atomik olarak yazıp `isLoopbackOnly: true` olduğunu doğruladı.
   - Sunucu üzerinde `netdata.service` yeniden başlatıldı ve `127.0.0.1:19999` portunu dinlediği (`ss -tulpn`) teyit edildi.

4. **Doğrudan Dış Erişim Koruması:**
   - Dış ağdan (istemci makineden) `http://157.180.11.28:19999` portuna doğrudan erişim denendi:
     `curl: (7) Failed to connect to 157.180.11.28 port 19999: Couldn't connect to server`
   - Netdata'nın dış dünyadan doğrudan erişilemediği kesin olarak kanıtlandı.

5. **Tümleşik Araç Gateway Protokolü (`packages/protocol`):**
   - `descriptor(value)` fonksiyonu `loopbackPort` (1024-65535) tipini destekleyecek şekilde genişletildi.
   - `INTEGRATED_TOOL_GATEWAYS.netdata` tanımlandı (`publicPrefix: '/tools/netdata'`, `accessPath: '/api/netdata-gateway-access'`, `accessMode: 'owner'`, `loopbackPort: 19999`).

6. **Web Gateway HTTP ve WebSocket Ters Proxy (`apps/web/server.js`):**
   - **Trailing Slash Yönlendirmesi:** `GET /tools/netdata` -> HTTP 308 ile `/tools/netdata/` adresine yönlendirildi.
   - **Yetkisiz Erişim Engelleme:** Oturum açmamış istekler `GET /tools/netdata/api/v1/info` -> HTTP 401 Unauthorized / "Authentication required." ile engellendi; yerel Netdata'ya iletilmedi.
   - **Yetkili Owner Erişimi:** Owner oturum çerezi (`__Host-yunpanel_session`) ile yapılan istekler HTTP 200 OK ile Netdata API ve konsol HTML içeriğini başarıyla getirdi (`server: Netdata Embedded HTTP Server v1.43.2`).
   - **Güvenlik Başlıkları:** `x-robots-tag: noindex, nofollow, noarchive` eklendi, `location` başlıkları `/tools/netdata/` önekine uyarlandı, `set-cookie` yolları kapsama alındı.
   - **WebSocket Canlı Akış Desteği:** `proxyNetdataWebSocket` ile canlı grafik ve metrik akışı için WebSocket upgrade doğrulandı.

## 3. Test Sonucu
Bütün birim ve canlı testler (loopback konfigürasyonu, yetkisiz erişim reddi, yetkili erişim kabulü, WebSocket yükseltmesi, port 19999 izolasyonu) `.28` test sunucusunda sıfır hata ile başarıyla tamamlandı.
