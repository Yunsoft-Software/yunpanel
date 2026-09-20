# Website Provisioning Step Boundaries Live Acceptance — 2026-09-20

## Özet

Ubuntu 24.04 LTS kurulu YunPanel test sunucusunda (`157.180.11.28` — `.28`, hostname `test`), `T-PROVISIONING` kapsamındaki aşağıdaki madde uçtan uca doğrulanmıştır:

> **Provisioning'i her step sınırında kes**: intent sonrası, host mutation sonrası evidence öncesi ve compensation sırasında. Restart kör mutation tekrarlamasın; partial state ve düzeltme adımı görünür olsun.

IP adresi `.44` ile biten Plesk sunucusuna kesinlikle dokunulmamış; bütün işlemler repo dışı `.local/test-server.env` ile tanımlı `.28` test sunucusu üzerinde yürütülmüştür. Parola, secret, session token ve CSRF verileri rapora yazılmamıştır.

---

## 1. Test Düzeneği ve Hedef Kaynaklar

- **Test Operasyon ID**: `c1000000-0000-4000-8000-000000000001`
- **Hedef Website ID**: `b1000000-0000-4000-8000-000000000001`
- **Hedef Application ID**: `a1000000-0000-4000-8000-000000000001`
- **Türetilen Unix Kullanıcısı**: `yunapp-fa2b298ca938`
- **Managed Home Dizini**: `/var/lib/yunpanel/data/a1000000-0000-4000-8000-000000000001` (mode `0750`, tmp `0700`, logs `0750`)
- **Hedef Domain**: `boundary-test.prov.cryptoraichu.website`
- **Durable Adımlar**:
  1. `unix_identity` (kind: `unix_identity`, required: true, compensation: `{ state: 'pending' }`)
  2. `nginx` (kind: `nginx`, required: true, proxy target `127.0.0.1:8080`, compensation: `{ state: 'pending' }`)

---

## 2. Doğrulanan Yaşam Döngüsü ve Sınır Aşamaları

### Aşama 1: Temiz Başlangıç Durumu (Pre-flight Baseline)
- Host üzerinde `yunapp-fa2b298ca938` kullanıcısının (`getent passwd`), home dizininin ve Nginx vhost konfigürasyonunun bulunmadığı doğrulandı.
- `GET /api/sites/provisioning/c1000000-0000-4000-8000-000000000001` operasyonunun henüz var olmadığı doğrulandı.

### Aşama 2: Sınır 1 — Intent Sonrası Kesilme (Interrupted after `beginStep`, before Host Mutation)
1. **Durable Intent Yazımı**:
   - `website-provisioning-registry.json` kütüğüne Step 0 (`unix_identity`) `state: 'applying'`, `evidence: null` olarak yazıldı.
   - Host üzerinde henüz hiçbir kullanıcı veya dizin oluşturulmadı.
2. **Servis Kesintisi & Startup Recovery**:
   - `systemctl restart yunpanel-api` ile servis yeniden başlatıldı.
   - Startup sırasında `websiteProvisioningRuntime.init()` interrupted operasyonu bularak `orchestrator.runNext()` -> `reconcileInterrupted()` çağırdı.
   - Handler `inspect()` hostta kullanıcının bulunmadığını (`satisfied: false`, `reason: 'website_identity_user_missing'`) saptadı.
   - Step otomatik olarak mutation replay **yapmadı**; durum `applying`, genel sonuç `interrupted` olarak korundu.
3. **API & Host Kanıtı**:
   - `GET /api/sites/provisioning/:opId` sorgusu `status: 'applying'`, `step[0].state: 'applying'`, `canRetry: false`, `ready: false` döndürdü.
   - `POST /api/sites/provisioning/:opId/continue` çağrısı `HTTP 200`, `outcome: 'interrupted'`, `actionRequired: 'inspect_or_remediate'`, `stepId: 'unix_identity'` döndürdü.
   - `/usr/bin/getent passwd yunapp-fa2b298ca938` çalıştırıldığında kullanıcının oluşturulmadığı (kod 2) kesin olarak kanıtlandı.

### Aşama 3: Sınır 2 — Host Mutation Sonrası, Evidence Öncesi Kesilme
1. **Host Mutation Yürütme**:
   - Step 0 `applying` durumundayken `runtime.handlers.unix_identity.apply()` host üzerinde çalıştırıldı.
   - Kullanıcı (`yunapp-fa2b298ca938`), grup, home dizini (`0750`), `tmp` (`0700`), `logs` (`0750`) ve root-private receipt (`/var/lib/yunpanel/staging/website-identities/` ve `website-identity-paths/`) oluşturuldu.
   - Kütükte `completeStep` yazılmayıp adım `state: 'applying'`, `evidence: null` olarak bırakıldı (crash simülasyonu).
2. **Servis Kesintisi & Startup Reconciliation**:
   - `systemctl restart yunpanel-api` ile servis yeniden başlatıldı.
   - Startup `init()` aşamasında `reconcileInterrupted()` hostu salt-okunur denetledi; kullanıcının, grubun ve dizinlerin tam istenen izinlerle var olduğunu (`satisfied: true`) teyit etti.
   - Adım **ikinci kez useradd çalıştırmadan** (duplicate apply olmaksızın) doğrudan `completeStep` ile `succeeded` durumuna geçirildi.
3. **API & Host Kanıtı**:
   - `GET /api/sites/provisioning/:opId` sorgusunda `step[0].state: 'succeeded'`, `step[0].error: null`, `step[1].state: 'pending'`, `ready: false` doğrulandı.
   - Kütüğe gerçek UID/GID ve receipt verileri başarıyla işlendi.

### Aşama 4: İkinci Adımın (Nginx) Yürütülmesi
- `POST /api/sites/provisioning/:opId/continue` ile bekleyen Nginx adımı yürütüldü.
- `/etc/nginx/sites-enabled/yunpanel-boundary-test.prov.cryptoraichu.website.conf` vhost'u aktif edildi, `nginx -t` başarıyla geçti.
- Operasyon durumu `ready: true`, her iki adım da `succeeded` oldu.

### Aşama 5: Ters Sırada Compensation Koruma Kapısı (Fail-Closed Ordering)
- Nginx adımı hâlâ `succeeded` iken üst adım olan `unix_identity` geri alınmak istendi:
  - `POST /api/sites/provisioning/:opId/steps/unix_identity/compensate`
  - İstek `HTTP 409 Conflict` ve `error.code: 'website_provisioning_compensation_order_invalid'` ile reddedildi.
  - Host üzerindeki kullanıcı ve dizinlere dokunulmadı.
- Önce downstream `nginx` adımı compensate edildi:
  - `POST /api/sites/provisioning/:opId/steps/nginx/compensate` `HTTP 200`, `outcome: 'compensated'` döndü.
  - Nginx vhost'u hosttan temizlendi, `nginx -t` doğrulandı.

### Aşama 6: Sınır 3a — Compensation Sırasında Kesilme (Host Temizliği Tamamlanmadan Önce)
1. **Compensation Başlatma**:
   - Step 0 kütükte `state: 'compensating'`, `compensation: { state: 'applying' }` durumuna geçirildi.
   - Host üzerindeki kullanıcı ve dizinler henüz silinmedi (silme işlemi öncesi kesinti simülasyonu).
2. **Servis Kesintisi & Startup Reconciliation**:
   - `systemctl restart yunpanel-api` ile servis yeniden başlatıldı.
   - Startup sırasında `reconcileInterruptedCompensation()` tetiklendi.
   - `inspectCompensation()` kullanıcının hostta hâlâ var olduğunu saptadı (`satisfied: false`, `reason: 'website_identity_compensation_pending'`).
   - Servis kullanıcının üstüne körlemesine `userdel` çalıştırmadı; adımı güvenli biçimde `compensating` durumunda bıraktı.
3. **API & Host Kanıtı**:
   - `GET /api/sites/provisioning/:opId` sorgusu `step[0].state: 'compensating'`, `step[0].compensation.state: 'applying'` döndürdü.
   - `POST /api/sites/provisioning/:opId/continue` çağrısı `outcome: 'compensation_interrupted'`, `actionRequired: 'inspect_or_remediate_compensation'` döndürdü.
   - Hostta kullanıcının ve dizinin silinmediği doğrulandı.

### Aşama 7: Sınır 3b — Compensation Sırasında Kesilme (Host Temizliği Sonrası, Evidence Öncesi)
1. **Host Temizliği**:
   - Host üzerinde `unix_identity` kaynakları temizlendi (`userdel`, `groupdel`, home dizini ve makbuzlar kaldırıldı).
   - Kütükte `completeCompensation` yazılmadan adım `state: 'compensating'`, `compensation: { state: 'applying' }` olarak bırakıldı (crash simülasyonu).
2. **Servis Kesintisi & Startup Reconciliation**:
   - `systemctl restart yunpanel-api` ile servis yeniden başlatıldı.
   - Startup `reconcileInterruptedCompensation()` hostun temizlendiğini (`satisfied: true`, `removedUser: true`, `removedGroup: true`, `removedHome: true`) teyit etti.
   - Adım **ikinci bir silme mutation'ı denemeden** doğrudan `completeCompensation` ile kapatıldı.
3. **API & Host Kanıtı**:
   - `GET /api/sites/provisioning/:opId` sorgusu `step[0].state: 'compensated'`, `step[0].compensation.state: 'succeeded'`, `ready: false` döndürdü.
   - Kütüğe compensation evidence'ı işlendi.

### Aşama 8: Temizlik ve Sıfır Regresyon Doğrulaması
- Test operasyonu `website-provisioning-registry.json` kütüğünden ve geçici kalıntılardan temizlendi.
- `systemctl restart yunpanel-api` sonrası mevcut canlı sitelerin izolasyon audit'leri denetlendi:
  - `provtest.webrich.news` (`01944d99-9289-5b83-90f7-cec1402e6722`): `status: "isolated"`
  - `yunpanel-static-deploy.test` (`ed6dbfee-b769-5704-8216-32c4258b56d2`): `status: "isolated"`
- Bütün test adımları eksiksiz başarıyla tamamlandı.
