# Website Provisioning Reverse-Order Compensation, Drift & Restart Live Acceptance — 2026-09-20

## Özet

Ubuntu 24.04 LTS kurulu YunPanel test sunucusunda (`157.180.11.28` — `.28`, hostname `test`), `T-PROVISIONING` kapsamındaki aşağıdaki madde uçtan uca doğrulanmıştır:

> **Gerçek Ubuntu failure injection ile Unix identity, Nginx ve static runtime compensation'ını ters sırada doğrula**: Nginx/static runtime gibi downstream step `applying`/`succeeded`/`failed`/`compensating` iken `unix_identity` geri alma isteği 409 ile reddedilsin ve user/group/home'a dokunulmasın; downstream operation-owned kaynaklar compensate edildikten sonra identity cleanup açılabilsin. Yalnız exact `compensate-site-provisioning:<operationId>:<stepId>` confirmation mutation yapsın; önceden var olan identity/vhost/release korunsun. Compensation ortasında restart sonrası inspect/reconcile devam etsin; UID/GID/checksum/current-release drift veya ownership checkpoint eksikliği destructive cleanup yerine actionable fail-closed state bıraksın.

IP adresi `.44` ile biten Plesk sunucusuna kesinlikle dokunulmamış; bütün işlemler repo dışı `.local/test-server.env` ile tanımlı `.28` test sunucusu üzerinde yürütülmüştür. Parola, secret, session token ve CSRF verileri rapora yazılmamıştır.

---

## 1. Test Düzeneği ve Hedef Kaynaklar

- **Test Operasyon ID**: `d1000000-0000-4000-8000-000000000003`
- **Hedef Website ID**: `d2000000-0000-4000-8000-000000000003`
- **Hedef Application ID**: `d3000000-0000-4000-8000-000000000003`
- **Türetilen Unix Kullanıcısı**: `yunapp-89353ff586ea`
- **Managed Home Dizini**: `/var/lib/yunpanel/data/d3000000-0000-4000-8000-000000000003` (mode `0750`, tmp `0700`, logs `0750`)
- **Hedef Domain**: `comp-test.prov.cryptoraichu.website`
- **Nginx Vhost Yolu**: `/etc/nginx/sites-enabled/yunpanel-comp-test.prov.cryptoraichu.website.conf`
- **Planlanan Adımlar**:
  1. `unix_identity` (kind: `unix_identity`, required: true, compensation: `{ state: 'pending' }`)
  2. `nginx` (kind: `nginx`, required: true, targetType: `proxy`, upstream: `127.0.0.1:8083`, compensation: `{ state: 'pending' }`)
  3. `static_runtime` (kind: `static_runtime`, required: true, mode: `deploy`, repo: `https://github.com/example/does-not-exist-fixture.git`, compensation: `{ state: 'pending' }`)

---

## 2. Doğrulanan Yaşam Döngüsü ve Güvenlik Adımları

### Aşama 1: Temiz Başlangıç Durumu
- Host üzerinde `yunapp-89353ff586ea` kullanıcısının (`getent passwd`), home dizininin ve Nginx vhost konfigürasyonunun bulunmadığı teyit edildi.

### Aşama 2: İleriye Yönelik Provisioning ve Downstream Failure Injection
1. **İşlem Adımları**:
   - `unix_identity`: `continue` çağrıldı -> `outcome: "progressed"`, adım `succeeded`. Host üzerinde `yunapp-89353ff586ea` Unix kullanıcısı (UID: 989, GID: 989), `0750` home dizini, `0700` tmp, `0750` logs ve staging receipt dosyaları oluşturuldu.
   - `nginx`: `continue` çağrıldı -> `outcome: "progressed"`, adım `succeeded`. `/etc/nginx/sites-enabled/yunpanel-comp-test.prov.cryptoraichu.website.conf` oluşturuldu, `nginx -t` başarıyla geçti.
   - `static_runtime`: `continue` çağrıldı -> var olmayan repo adresi nedeniyle deploy başarısız oldu -> `outcome: "failed"`, adım `failed` oldu.
2. **Durum Topolojisi**:
   - `unix_identity`: `state: "succeeded"`, `compensation.state: "pending"`
   - `nginx`: `state: "succeeded"`, `compensation.state: "pending"`
   - `static_runtime`: `state: "failed"`, `compensation.state: "pending"`
   - `operation.status`: `"failed"`

### Aşama 3: Ters Sıra (Reverse-Order) Bloklama Doğrulaması (HTTP 409 Conflict)
1. **Downstream Adımlar Aktif/Failed İken `unix_identity` Compensation Denemesi**:
   - `POST /api/sites/provisioning/:opId/steps/unix_identity/compensate`
   - Gövde: `{ "confirmation": "compensate-site-provisioning:d1000000-0000-4000-8000-000000000003:unix_identity" }`
   - **Sonuç**: `HTTP 409 Conflict`, `error.code: "website_provisioning_compensation_order_invalid"`.
   - **Host Doğrulaması**: `getent passwd yunapp-89353ff586ea` ve home dizini kontrol edildi; kullanıcı ve dosyalar **kesinlikle silinmedi, %100 korundu**.
2. **Downstream Adım Failed İken `nginx` Compensation Denemesi**:
   - `POST /api/sites/provisioning/:opId/steps/nginx/compensate`
   - Gövde: `{ "confirmation": "compensate-site-provisioning:d1000000-0000-4000-8000-000000000003:nginx" }`
   - **Sonuç**: `HTTP 409 Conflict`, `error.code: "website_provisioning_compensation_order_invalid"`.
   - **Host Doğrulaması**: `/etc/nginx/sites-enabled/yunpanel-comp-test.prov.cryptoraichu.website.conf` dosyasına dokunulmadı; vhost korundu.

### Aşama 4: İmzalı Exact Confirmation Doğrulama Sınırları (HTTP 400 Bad Request)
Aşağıdaki geçersiz gövde denemeleri mutation yapmadan fail-closed reddedildi:
1. **Eksik Gövde**: Boş `{}` -> `HTTP 400 Bad Request` (`website_provisioning_compensation_confirmation_required`).
2. **Yanlış Step Onayı**: `confirmation: "compensate-site-provisioning:...:unix_identity"` ile `static_runtime` çağırma -> `HTTP 400 Bad Request`.
3. **Yanlış Operasyon Onayı**: Başka operasyon UUID'si içeren confirmation -> `HTTP 400 Bad Request`.
4. **Ek Alan Taşıyan Gövde**: `{ confirmation: "...", extra: true }` -> `HTTP 400 Bad Request`.

### Aşama 5: Ters Sırada İlk Geri Alma — `static_runtime`
1. `POST /api/sites/provisioning/:opId/steps/static_runtime/compensate`
2. Gövde: `{ "confirmation": "compensate-site-provisioning:d1000000-0000-4000-8000-000000000003:static_runtime" }`
3. **Sonuç**: `HTTP 200 OK`, `outcome: "compensated"`, `stepId: "static_runtime"`.
4. **Ters Sıra Kilidi Doğrulaması**:
   - `static_runtime` artık `compensated` iken, `nginx` hâlâ `succeeded` durumdadır.
   - Bu aşamada tekrar `unix_identity` geri alınmak istendi -> **Hâlâ `HTTP 409 Conflict`** (`website_provisioning_compensation_order_invalid`) ile reddedildi; kullanıcı yine dokunulmadan korundu.

### Aşama 6: Nginx Checksum Drift Fail-Closed Hata Enjeksiyonu
1. **Drift Enjeksiyonu**:
   - Aktif Nginx konfigürasyon dosyasına (`yunpanel-comp-test.prov.cryptoraichu.website.conf`) `# CHECKSUM_DRIFT_INJECTION` satırı eklenerek SHA-256 checksum'ı bozuldu.
2. **Driftli Compensation Denemesi**:
   - `POST /api/sites/provisioning/:opId/steps/nginx/compensate`
   - **Sonuç**: `HTTP 200 OK`, `outcome: "compensation_failed"`, `error: "nginx_compensation_drift"`, `actionRequired: "retry_compensation_or_remediate"`.
   - **Host Doğrulaması**: Dosya silinmedi, vhost ve Nginx servisi korundu.
3. **Drift Temizleme ve Başarılı Compensation**:
   - Orijinal dosya içeriği geri yüklendi.
   - Tekrar exact confirmation ile `nginx` compensation çağrıldı.
   - **Sonuç**: `HTTP 200 OK`, `outcome: "compensated"`, `stepId: "nginx"`.
   - `/etc/nginx/sites-enabled/yunpanel-comp-test.prov.cryptoraichu.website.conf` güvenle kaldırıldı ve `nginx -t` ile reload yapıldı.

### Aşama 7: Ownership Checkpoint ve UID Drift Korunumu (`unix_identity`)
Tüm downstream adımlar (`static_runtime` ve `nginx`) compensate edildikten sonra `unix_identity` adımının sırası geldi:
1. **Eksik Ownership Checkpoint (UID/GID: null)**:
   - `/var/lib/yunpanel/staging/website-identities/<opId>.json` içindeki `uid` ve `gid` değerleri `null` yapılarak eksik checkpoint simüle edildi.
   - Compensation çağrıldı -> `outcome: "compensation_failed"`, `error: "website_identity_compensation_ownership_unknown"`.
   - Host üzerinde `getent passwd yunapp-89353ff586ea` kontrol edildi; **kullanıcı silinmedi**.
2. **UID/GID Drift (Drifted Ownership)**:
   - Receipt içine tampered `uid: 99999` yazıldı (hosttaki 989 UID'si ile uyumsuz).
   - Compensation çağrıldı -> `outcome: "compensation_failed"`, `error: "website_identity_compensation_drift"`.
   - Host üzerinde `getent passwd yunapp-89353ff586ea` kontrol edildi; **kullanıcı silinmedi**.
3. Orijinal receipt geri yüklendi.

### Aşama 8: Compensation Sırasında Restart Recovery & Reconcile
1. **Boundary A: Interrupted Compensation (Host Kaynakları Hâlâ Var İken)**:
   - Kütükte `unix_identity` adımı `state: "compensating"`, `compensation.state: "applying"` durumuna getirildi.
   - Sunucu servisi yeniden başlatıldı (`systemctl restart yunpanel-api`).
   - Servis ayağa kalktıktan sonra `runNext` reconciliation çağrısı tetiklendi; host üzerinde kullanıcı hâlâ mevcut olduğu için kör `userdel` çalıştırılmadı.
   - Adım güvenli biçimde `compensating` durumunda ve `actionRequired: "inspect_or_remediate_compensation"` olarak fail-closed bekletildi; kullanıcı sağlam kaldı.
2. **Boundary B: Host Temizliği Sonrası Crash & Restart Reconcile**:
   - Host kaynağı silindi (`userdel -r yunapp-89353ff586ea`).
   - API yeniden başlatıldı (`systemctl restart yunpanel-api`).
   - API bootstrap `init()` rutininde `listInterrupted()` üzerinden operasyon bulundu, `inspectCompensation` çalıştırıldı; kaynakların zaten yok olduğu (`satisfied: true`) teyit edilerek mükerrer host komutu işletilmeden adım `state: "compensated"`, `compensation.state: "succeeded"` olarak atomik kapatıldı.
3. **Mükerrer (Duplicate) Compensation Koruması**:
   - Zaten `compensated` olan adım için tekrar exact confirmation ile istek atıldı -> `HTTP 409 Conflict` (`website_provisioning_transition_invalid`) ile reddedildi.

### Aşama 9: Temizlik ve Sıfır Regresyon İzolasyon Denetimi
- Test operasyonu `website-provisioning-registry.json` kütüğünden temizlendi.
- Kalan geçici dosyalar temizlendi ve API yeniden başlatıldı.
- Mevcut sitelerin durumları doğrudan canlı API üzerinden denetlendi:
  - `GET /api/websites/01944d99-9289-5b83-90f7-cec1402e6722/isolation-audit` (`provtest.webrich.news`): `HTTP 200`, `status: "isolated"`, `findings: []`.
  - `GET /api/websites/ed6dbfee-b769-5704-8216-32c4258b56d2/isolation-audit` (`yunpanel-static-deploy.test`): `HTTP 200`, `status: "isolated"`, `findings: []`.
- Sıfır regresyon ile test başarıyla tamamlandı.
