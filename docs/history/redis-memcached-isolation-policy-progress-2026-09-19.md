# Redis & Memcached Isolation Policy İlerlemesi (2026-09-19)

Bu doküman P1.4 kapsamındaki Redis ve Memcached izolasyon politikalarının tasarımını, kaynak kod uygulamasını ve doğrulama sonuçlarını özetler.

## 1. Mimari ve İzolasyon Modeli

### Redis İzolasyonu:
- **Site-Scoped ACL User**: Her site için `yunapp-<websiteId>` adına bir Redis ACL kullanıcısı tanımlanır.
- **Güçlü Parola**: 32 byte kriptografik rastgele parola üretilir (`crypto.randomBytes(32).toString('hex')`).
- **Key Prefix / Namespace Kısıtı**: Site kullanıcısı yalnız `~<websiteId>:*` prefix'i altındaki key'lere erişebilir (`resetkeys ~<websiteId>:*`).
- **Tehlikeli Komut Kısıtlaması**: Sitenin Redis instance'ına veya diğer sitelere zarar vermesini engellemek için tehlikeli komut grupları ve spesifik komutlar yasaklanır:
  `-@dangerous -@admin -FLUSHALL -FLUSHDB -CONFIG -SHUTDOWN +@all` (yalnız safe komutlar ve site prefix'li keyler).
- **ACL Drop-in**: `/etc/redis/users.d/yunpanel-<websiteId>.acl` dosyası (`root:redis 0640`) üzerinden yönetilir; `ACL LOAD` ile redis-server'a anında uygulanır.

### Memcached İzolasyonu:
- Memcached protokolü native auth/ACL sunmadığından:
  - Default policy olarak per-site key prefix (`yunapp_<websiteId>:`) ve port/socket bilgisi sağlanır.
  - Sitenin uygulama katmanında prefix zorunluluğu dokümante edilir ve env/bağlantı konfigürasyonu olarak sunulur.

## 2. Uygulanan Bileşenler

1. **Protocol (`packages/protocol`)**:
   - `MANAGED_SERVICE_IDS` ve `MANAGED_SERVICE_CONTROL_IDS` listelerine `redis` ve `memcached` eklendi.
   - İlgili protokol doğrulama testleri güncellendi.

2. **Host Runtime (`packages/host-runtime`)**:
   - `managed-service-manager.js`: `SERVICE_CATALOG` içine `redis` (`packages: ['redis-server']`, `units: ['redis-server.service']`) ve `memcached` (`packages: ['memcached']`, `units: ['memcached.service']`) eklendi.
   - `cache-isolation-manager.js`:
     - `applyRedisAcl({ websiteId, password, aclUser, prefix })`
     - `removeRedisAcl({ websiteId, aclUser })`
     - `inspectRedisAcl({ websiteId, aclUser })`
     - `generateMemcachedPolicy({ websiteId })`
   - `cache-isolation-manager.test.js`: 5 adet test ile ACL generate/apply, inspect, remove ve memcached policy doğrulandı.

3. **API Katmanı (`apps/api`)**:
   - `managed-service-state-policy.js`: `POLICY` içine `redis` ve `memcached` managed service state kuralları eklendi.
   - `website-cache-policy-registry.js`: Root-private `website-cache-policies.json` registry (`0700/0600`). Parolalar `AES-256-GCM` ve `masterKey` ile diskte şifreli saklanır.
   - `website-cache-service.js`:
     - `getCachePolicy`: Parola maskelenmiş olarak döner (`passwordConfigured: true`).
     - `enableRedisCache`: Parola ilk oluşturulduğunda tek seferlik düz metin döner.
     - `rotateRedisPassword`: Parola yenilendiğinde tek seferlik döner.
     - `enableMemcached`: Prefix ve port/socket contract'ı döner.
     - `disableCache`: Redis ACL dosyasını ve/veya Memcached kaydını güvenle temizler.
   - `website-cache-http.js`:
     - `GET /api/websites/:websiteId/cache`
     - `POST /api/websites/:websiteId/cache/redis/enable`
     - `POST /api/websites/:websiteId/cache/redis/rotate-password`
     - `POST /api/websites/:websiteId/cache/memcached/enable`
     - `DELETE /api/websites/:websiteId/cache`
     - Tüm rotalar `requirePanelRouteAccess({ minRole: 'operator' })` ile korunur.
   - `app.js` ve `index.js`: Service, registry ve HTTP router production API bootstrap'ına bağlandı.

## 3. Test ve Doğrulama

- Node 24 (`nvm use 24`) altında birim testler:
  - `packages/protocol/test/managed-services.test.js`: PASS
  - `packages/host-runtime/test/cache-isolation-manager.test.js`: PASS (5/5)
  - `packages/host-runtime/test/managed-service-manager.test.js`: PASS (7/7)
  - `apps/api/test/website-cache-service.test.js`: PASS (4/4)
  - `apps/api/test/website-cache-http.test.js`: PASS (5/5)
  - `apps/api/test/managed-service-http.test.js` & `managed-service-job-registry.test.js`: PASS
- `npm run check`: Tamamı başarıyla geçti (0 exit code, 72 protocol + 32 shared + API/host-runtime tests + web build).
