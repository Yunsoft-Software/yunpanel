# Static Website Durable Runtime Binding Live Acceptance — 2026-09-20

## Özet

Ubuntu 24.04 LTS kurulu YunPanel test sunucusunda (`157.180.11.28` — `.28`, hostname `test`), `todo.md` altındaki şu P0 maddesi canlı ortamda uçtan uca doğrulanmıştır:

> Static Website durable runtime binding kabulü: ilk gerçek Domain stage'de binding kaydı oluştuğunu, deploy ve rollback sonrasında `ApplicationRuntimeBinding` disk kaydının beklenen revizyon ile atomik olarak güncellendiğini, `releaseId`'nin aktif deploy ID'sini taşıdığını, Website domain hedefinin Application release'i ile drift kontrolünden geçerek doğru `documentRoot`'a yönlendirildiğini ve domain restage'de Nginx checksum kanıtının binding içine işlendiğini `.28` Ubuntu hostta doğrula.

---

## Test Ortamı ve Kaynak Kimlikleri

- **Hedef Sunucu**: `157.180.11.28` (Ubuntu 24.04 LTS, hostname `test`)
- **Web Sitesi**: `yunpanel-static-deploy.test` (`ed6dbfee-b769-5704-8216-32c4258b56d2`)
- **Domain**: `yunpanel-static-deploy.test` (`d6be6717-e53f-4bc5-a501-2ec546ff3ba5`)
- **Application**: `YunPanel static lifecycle smoke` (`6e7cf4c6-85c4-49c5-a635-6ddcf068d163`)
- **Release 1**: `b0ed679c-44a1-4960-984d-858c63eb4e37`
- **Release 2**: `f1e4f36f-7b8a-46c9-9071-911ff6fc7ee4`
- **Unix Kullanıcısı**: `yunapp-264d0ba10e07` (UID 996, GID 996)
- **Persisted Binding Deposu**: `/var/lib/yunpanel/control-plane/application-runtime-binding-registry.json` (mode `0600`, `root:root`)

---

## Doğrulanan Adımlar ve Kanıtlar

### 1. Owner Kimlik Doğrulama ve İlk Durum
- `POST /api/auth/login` ile oturum açıldı, `__Host-yunpanel_session` cookie ve CSRF token alındı.
- Test öncesinde statik uygulama için binding kaydı olmadığı teyit edildi.

### 2. İlk Domain Stage ile Binding Oluşturma
- `POST /api/domains/d6be6717-e53f-4bc5-a501-2ec546ff3ba5/stage` çağrıldı.
- `domain.stage` işi (`f525720a-1e07-4b74-90bc-e21565837599`) başarıyla tamamlandı.
- `ApplicationRuntimeBinding` disk kaydı oluşturuldu:
  - `adapter`: `'static'`
  - `state`: `'active'`
  - `revision`: `1`
  - `releaseId`: `'b0ed679c-44a1-4960-984d-858c63eb4e37'`
  - `websiteId`: `'ed6dbfee-b769-5704-8216-32c4258b56d2'`
  - `domains[0].domainId`: `'d6be6717-e53f-4bc5-a501-2ec546ff3ba5'`
  - `domains[0].nginxChecksum`: `'301fef691df75785fa18f29496e6c50ca12713c6ad7b7e9a5f598ca8b136a095'`
  - `staticTarget`:
    - `publishRoot`: `'/var/www/yunpanel/apps/6e7cf4c6-85c4-49c5-a635-6ddcf068d163'`
    - `documentRoot`: `'/var/www/yunpanel/apps/6e7cf4c6-85c4-49c5-a635-6ddcf068d163/current'`
    - `user`: `'yunapp-264d0ba10e07'`
    - `group`: `'yunapp-264d0ba10e07'`

### 3. Rollback ile Atomik Güncelleme (Release 2)
- `POST /api/applications/6e7cf4c6-85c4-49c5-a635-6ddcf068d163/rollback` ile `f1e4f36f-7b8a-46c9-9071-911ff6fc7ee4` sürümüne dönüldü.
- `app.static.rollback` işi (`f33796bd-f092-4e6a-afc6-ffb6879d0f8b`) başarıyla tamamlandı.
- Binding disk kaydı atomik olarak güncellendi:
  - `revision`: `2`
  - `releaseId`: `'f1e4f36f-7b8a-46c9-9071-911ff6fc7ee4'`
  - `sourceOperationId`: `'f33796bd-f092-4e6a-afc6-ffb6879d0f8b'`
- Diskteki `current` symlink'inin `releases/f1e4f36f-7b8a-46c9-9071-911ff6fc7ee4` hedefine bağlandığı doğrulandı.

### 4. Rollback ile Atomik Güncelleme (Release 1)
- `POST /api/applications/6e7cf4c6-85c4-49c5-a635-6ddcf068d163/rollback` ile `b0ed679c-44a1-4960-984d-858c63eb4e37` sürümüne geri dönüldü.
- `app.static.rollback` işi (`2c20fce9-aaca-46b9-a794-642c5fa1112d`) başarıyla tamamlandı.
- Binding disk kaydı atomik olarak güncellendi:
  - `revision`: `3`
  - `releaseId`: `'b0ed679c-44a1-4960-984d-858c63eb4e37'`
  - `sourceOperationId`: `'2c20fce9-aaca-46b9-a794-642c5fa1112d'`
- Diskteki `current` symlink'inin `releases/b0ed679c-44a1-4960-984d-858c63eb4e37` hedefine bağlandığı doğrulandı.

### 5. Domain Ayar Güncellemesi ve Nginx Checksum Kanıtı
- `POST /api/domains/:id/update-preview` ve `PATCH /api/domains/:id` ile Nginx ayarı güncellendi (`desiredRevision: 2`).
- `POST /api/domains/:id/stage` ile domain sahnelendi (`job 534adc38-d222-49be-8835-0d4c500b5102`).
- Binding içine güncel Nginx checksum ve `desiredRevision` kanıtı işlendi:
  - `revision`: `6`
  - `domains[0].desiredRevision`: `2`
  - `domains[0].nginxChecksum`: `'4027f3643727a6e5292b97f9dddd07137f11499f1512f70eb74a5bb8ec665b60'`
- Domain aktive edildi, ardından ayarlar eski haline getirilip tekrar sahnelenip aktive edildi.

### 6. Drift Kontrolü Doğrulaması
- `resolveWebsiteDomainTarget` ile Website domain hedefi çözümlendi:
  - Geçerli hedef: `{ source: 'static', targetType: 'static', target: { root: '/var/www/yunpanel/apps/6e7cf4c6-85c4-49c5-a635-6ddcf068d163/current', spaFallback: true } }`.
- Binding'deki `releaseId` değiştirildiğinde (drift durumu), `resolveWebsiteDomainTarget` fonksiyonunun `static_runtime_binding_drift` hata koduyla fail-closed reddettiği kanıtlandı.

### 7. Servis Yeniden Başlatma Dayanıklılığı (API Restart Survival)
- `systemctl restart yunpanel-api` ile servis yeniden başlatıldı.
- `application-runtime-binding-registry.json` dosyasından okunan binding kaydı revizyon 7 ve `b0ed679c-44a1-4960-984d-858c63eb4e37` sürümüyle eksiksiz korundu.

### 8. HTTP Yayını Doğrulaması
- `curl -H "Host: yunpanel-static-deploy.test" http://127.0.0.1/` çağrısı HTTP 200 döndü ve içerik doğrulandı.

---

## Sonuç

`todo.md` içerisindeki **Static Website durable runtime binding kabulü** maddesi Ubuntu 24.04 LTS test sunucusunda (`157.180.11.28`) tüm kabul kriterleriyle doğrulanmış ve tamamlanmıştır.
