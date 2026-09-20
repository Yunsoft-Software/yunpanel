# Passenger Node Migration Canlı Kabul Raporu (2026-09-20)

## 1. Amaç ve Kapsam

Bu rapor, YunPanel'in doğrudan systemd ile çalışan mevcut bir Node.js uygulamasını (`yunpanel-node-smoke.test`, ID: `30b4bec9-f640-4a47-bf33-47a386c09b42`) kesintisiz ve güvenli bir şekilde Phusion Passenger runtime'ına taşıyan (`app.node.passenger-migrate`) geçiş operasyonunun `.28` test sunucusundaki (`157.180.11.28`, hostname: `test`) canlı kabul testlerini belgeler.

## 2. Test Edilen Bileşenler ve Güvenlik Sınırları

1. **Preflight ve Canlı Durum Doğrulaması**:
   - Uygulama: `YunPanel Node lifecycle smoke` (`30b4bec9-f640-4a47-bf33-47a386c09b42`)
   - Doğrudan systemd servisi: `yunpanel-node-3c0c10406148a269.service` aktif ve 4200 portunda HTTP 200 yanıtı veriyor.
   - Nginx reverse proxy: `yunpanel-node-smoke.test` üzerinden HTTP 200 yanıtı veriyor.
   - Dedicated site kullanıcısı: `yunapp-3c0c10406148` (UID: 997, GID: 997).
   - Home dizini: `/var/lib/yunpanel/data/30b4bec9-f640-4a47-bf33-47a386c09b42`, izinler: `0750` (`yunapp-3c0c10406148:yunapp-3c0c10406148`).

2. **Önizleme ve Onay Doğrulaması (Preview & Confirmation)**:
   - Gerçek Owner oturumu (`yunsoft-owner`) ve CSRF koruması ile `GET /api/applications/:id/passenger-migration-preview` çağrısı:
     - `ready: true`
     - `digest: 1436c0366c18e4890e3705f6bdfc4ebd3be5c5a24a96d4325adb278a47cf94eb`
     - `confirmation: migrate-node-passenger:30b4bec9-f640-4a47-bf33-47a386c09b42:1436c0366c18e4890e3705f6bdfc4ebd3be5c5a24a96d4325adb278a47cf94eb`
   - CSRF Koruması: CSRF token olmadan yapılan POST isteği HTTP 403 ile reddedildi.
   - Onay Doğrulaması: Yanlış veya eksik confirmation ile yapılan POST isteği HTTP 400 ile reddedildi.

3. **Geçiş Operasyonu (Cutover & Migration Job)**:
   - `POST /api/applications/:id/passenger-migration` ile `app.node.passenger-migrate` işi HTTP 202 kabulü ile kuyruğa alındı.
   - İkincil ortam hazırlığı: `/etc/yunpanel/passenger-env/30b4bec9-f640-4a47-bf33-47a386c09b42.conf` dosyası `0600` izinleriyle ve `passenger_env_var` direktifleriyle oluşturuldu.
   - Nginx yapılandırması güncellendi:
     - `passenger_enabled on;`
     - `passenger_user yunapp-3c0c10406148;`
     - `passenger_app_root /var/lib/yunpanel/apps/30b4bec9-f640-4a47-bf33-47a386c09b42/current;`
     - `passenger_nodejs /opt/yunpanel/node-runtimes/v24/bin/node;`
     - `include /etc/yunpanel/passenger-env/30b4bec9-f640-4a47-bf33-47a386c09b42.conf;`
   - Eski doğrudan systemd servisi `yunpanel-node-3c0c10406148a269.service` durduruldu (`inactive`) ve devre dışı bırakıldı (`disabled`).
   - Nginx yeniden yüklendi ve Passenger sağlık kontrolü HTTP 200 ile başarılı oldu.
   - İlgili iş `succeeded` olarak tamamlandı.

4. **Kalıcı Durum ve İzolasyon Doğrulaması (Runtime Binding)**:
   - `ApplicationRuntimeBinding` kaydı `/var/lib/yunpanel/control-plane/application-runtime-binding-registry.json` içinde kalıcı olarak `adapter: "passenger"`, `state: "active"` olarak kaydedildi.
   - `passenger-status` çıktısında uygulamanın Passenger altında `yunapp-3c0c10406148` (UID: 997) kimliğiyle çalıştığı ve istekleri başarıyla karşıladığı doğrulandı.

5. **Yeniden Başlatma Dayanıklılığı ve Idempotency**:
   - `yunpanel-api` servisi yeniden başlatıldı (`systemctl restart yunpanel-api`).
   - Yeniden başlatma sonrasında `ApplicationRuntimeBinding` durumu bozulmadan `adapter: "passenger"`, `state: "active"` olarak korundu.
   - HTTP 200 trafiği kesintisiz devam etti.
   - Tekrar eden geçiş çağrısı HTTP 409 (`node_passenger_migration_preview_stale`) ile güvenli bir şekilde engellendi.

## 3. Sonuç

Direct-systemd Node.js uygulamasından Phusion Passenger'a geçiş akışı; önizleme, onaylama, ortam hazırlığı, Nginx cutover, systemd temizliği, servis sürekliliği ve yeniden başlatma dayanıklılığı ile `.28` test sunucusunda eksiksiz doğrulanmıştır.
