# Website Provisioning Step Failure Injection & Typed Retry Live Acceptance — 2026-09-20

## Özet

Ubuntu 24.04 LTS kurulu YunPanel test sunucusunda (`157.180.11.28` — `.28`, hostname `test`), `T-PROVISIONING` kapsamındaki aşağıdaki madde uçtan uca doğrulanmıştır:

> **Gerçek failure injection ile bir provisioning step'ini `failed` duruma düşür**; yalnız exact `retry-site-provisioning:<operationId>:<stepId>` confirmation ile retry edilebildiğini, aynı Website identity/path contract'ında normal durable apply/inspect yolundan ilerlediğini ve non-failed/yanlış-step/duplicate retry'nin fail-closed kaldığını doğrula.

IP adresi `.44` ile biten Plesk sunucusuna kesinlikle dokunulmamış; bütün işlemler repo dışı `.local/test-server.env` ile tanımlı `.28` test sunucusu üzerinde yürütülmüştür. Parola, secret, session token ve CSRF verileri rapora yazılmamıştır.

---

## 1. Test Düzeneği ve Hedef Kaynaklar

- **Test Operasyon ID**: `d1000000-0000-4000-8000-000000000002`
- **Hedef Website ID**: `d2000000-0000-4000-8000-000000000002`
- **Hedef Application ID**: `d3000000-0000-4000-8000-000000000002`
- **Türetilen Unix Kullanıcısı**: `yunapp-a5549769af8c`
- **Managed Home Dizini**: `/var/lib/yunpanel/data/d3000000-0000-4000-8000-000000000002` (mode `0750`, tmp `0700`, logs `0750`)
- **Hedef Domain**: `retry-test.prov.cryptoraichu.website`
- **Planlanan Adımlar**:
  1. `unix_identity` (kind: `unix_identity`, required: true, compensation: `{ state: 'pending' }`)
  2. `nginx` (kind: `nginx`, required: true, proxy target `127.0.0.1:8081`, compensation: `{ state: 'pending' }`)

---

## 2. Doğrulanan Yaşam Döngüsü ve Güvenlik Adımları

### Aşama 1: Temiz Başlangıç Durumu
- Host üzerinde `yunapp-a5549769af8c` kullanıcısının (`getent passwd`), home dizininin ve Nginx vhost konfigürasyonunun bulunmadığı doğrulandı.

### Aşama 2: Canlı Failure Injection (Adımı `failed` Duruma Düşürme)
1. **Host Seviyesinde Hata Enjeksiyonu**:
   - Henüz kullanıcı yokken canonical home dizini (`/var/lib/yunpanel/data/d3000000-0000-4000-8000-000000000002`) önceden oluşturularak mülkiyetsiz çakışma (`home conflict`) simüle edildi.
2. **Provisioning Çalıştırma & Hata Yakalama**:
   - `POST /api/sites/provisioning/:opId/continue` çağrıldı.
   - Handler `apply` öncesi `assertCreationPreconditions` kontrolünde home çakışmasını tespit ederek `website_identity_home_conflict` hatası fırlattı.
   - Orchestrator bu hatayı yakalayarak `registry.failStep()` ile adımı `failed` yaptı.
3. **API & Durum Doğrulaması**:
   - `continue` cevabı: `HTTP 200`, `outcome: "failed"`, `stepId: "unix_identity"`, `error: "website_identity_home_conflict"`.
   - `GET /api/sites/provisioning/:opId`: `status: "failed"`, `step[0].state: "failed"`, `step[0].error: "website_identity_home_conflict"`, `step[0].canRetry: true`, `ready: false`.
   - Host üzerinde Unix kullanıcısının kesinlikle oluşturulmadığı kanıtlandı.

### Aşama 3: Fail-Closed Güvenlik & Doğrulama Sınırları
Aşağıdaki geçersiz/yetkisiz retry denemelerinin tümü fail-closed olarak reddedildi:
1. **Eksik Gövde**: Boş `{}` ile istek -> `HTTP 400 Bad Request` (`website_provisioning_retry_confirmation_required`).
2. **Yanlış Step Onayı**: `confirmation: "retry-site-provisioning:...:nginx"` -> `HTTP 400 Bad Request` (`website_provisioning_retry_confirmation_required`).
3. **Yanlış Operasyon Onayı**: Başka op UUID içeren onay -> `HTTP 400 Bad Request` (`website_provisioning_retry_confirmation_required`).
4. **Failed Olmayan Adım İçin Retry**: `pending` durumdaki Step 2 (`nginx`) için retry -> `HTTP 409 Conflict` (`website_provisioning_retry_invalid`).
5. **URL'de Geçersiz Step ID**: `POST .../steps/non_existent_step/retry` -> `HTTP 404 Not Found` (`website_provisioning_step_not_found`).
6. **URL'de Geçersiz Operasyon ID**: `POST .../00000000-.../steps/.../retry` -> `HTTP 404 Not Found` (`website_provisioning_not_found`).

### Aşama 4: Hata Düzeltme ve İmzalı Typed Retry
1. **Düzeltme (Remediation)**:
   - Host üzerindeki çakışan dizin silindi.
2. **Typed Retry Çalıştırma**:
   - `POST /api/sites/provisioning/:opId/steps/unix_identity/retry`
   - Gövde: `{ "confirmation": "retry-site-provisioning:d1000000-0000-4000-8000-000000000002:unix_identity" }`
3. **Başarılı Sonuç**:
   - Yanıt: `HTTP 202 Accepted`, `outcome: "progressed"`, `stepId: "unix_identity"`.
   - Adım `succeeded` durumuna geçti, hata kodu temizlendi (`error: null`).
   - Host üzerinde `yunapp-a5549769af8c` Unix kullanıcısı, `0750` managed home dizini, `0700` `tmp` ve `0750` `logs` dizinleri ve makbuz dosyası canonical sözleşmeye tam uygun biçimde oluşturuldu.

### Aşama 5: Mükerrer (Duplicate) Retry Koruması
- `unix_identity` adımı artık `succeeded` durumdayken aynı exact onay ile tekrar retry çağrıldı:
  - `POST /api/sites/provisioning/:opId/steps/unix_identity/retry`
  - İstek `HTTP 409 Conflict` ve `error.code: "website_provisioning_retry_invalid"` ile fail-closed reddedildi.

### Aşama 6: Sonraki Adımların Tamamlanması
- `POST /api/sites/provisioning/:opId/continue` ile sonraki adım (`nginx`) uygulandı.
- Nginx vhost'u aktif edildi (`nginx -t` başarılı), operasyon `ready: true`, `outcome: "ready"` ile kapandı.

### Aşama 7: Temizlik ve Sıfır Regresyon Doğrulaması
- Test kaynakları ters sırada compensate edilip kütükten silindi.
- `provtest.webrich.news` ve `yunpanel-static-deploy.test` sitelerinin izolasyon audit'lerinin `isolated` kaldığı doğrulandı.
