# Website Provisioning and Workspace Isolation Migration Live Acceptance — 2026-09-20

## Özet

Ubuntu 24.04 LTS kurulu YunPanel test sunucusunda (`157.180.11.28` — `.28`, hostname `test`), `T-PROVISIONING` kapsamındaki aşağıdaki iki madde canlı ortamda uçtan uca doğrulanmıştır:

1. **Fresh Website Preview & Provisioning Isolation**:
   > Fresh Ubuntu hostta yeni Website preview/apply operation'ı dedicated Unix user/group, home, document root/release, data/tmp/log/backup scope ve seçilen runtime'ı oluşturabilsin; metadata-only state ready görünmesin.
2. **Missing Workspace Directory Isolation Migration & Typed Rollback**:
   > Canonical Unix identity'si sağlıklı fakat tmp/logs direct-child'ı eksik gerçek Website'te panelin gösterdiği exact path/mode hedefleriyle authenticated isolation migration apply'i preview digest'e bağlı typed confirmation üzerinden çalıştır; durable migration store ve workspace receipt hostta root-private kalsın. API'yi host mutation/evidence sınırlarında kesip restart et: tamamlanmış receipt inspection ile kapanmalı, incomplete/belirsiz state mutation'ı kör replay etmemeli ve panel doğru durable durumu göstermeli. Typed rollback yalnız operation-created boş dizini kaldırmalı; pre-existing ve veri içeren dizin, user/home/runtime/SFTP korunmalı; başka server Website'i ve canonical dışı target 404/fail-closed kalmalı.

---

## 1. Fresh Website Preview & Provisioning Kabulü

- **Hedef Web Sitesi**: `provtest.webrich.news`
  - Website ID: `01944d99-9289-5b83-90f7-cec1402e6722`
  - Application ID: `392d53e7-a6f5-5f12-85cb-828a3f4211cf`
  - Parent Domain: `webrich.news`
  - Runtime: PHP 8.3

### Doğrulanan Güvenlik ve Yaşam Döngüsü Adımları:
1. **Preview & Confirmation Enforcement**:
   - `POST /api/panel/sites` çağrısında geçersiz veya eksik onay (`confirmationText`) denendiğinde `400 Bad Request` (`site_create_confirmation_required`) ile mutation reddedildi.
   - Doğru confirmation verildiğinde site operasyonu oluşturuldu.
2. **Metadata-Only State Kapısı**:
   - Orchestrator continuation adımları yürütülmeden önce site durumu `pending`/`partial` olarak işaretlendi.
   - `provisioning.ready: false` kalarak metadata yazımının tek başına siteyi `ready` göstermediği kanıtlandı.
3. **Orchestrator Durable Execution**:
   - `POST /api/panel/sites/provisioning/:opId/continue` ile adımlar tamamlandı ve operasyon `succeeded`, `ready: true` durumuna ulaştı.
4. **Host Seviyesinde Doğrulanan İzolasyon Kaynakları**:
   - **Dedicated Unix User/Group**: `yunapp-d4c467173909` (UID: 990, GID: 990), login shell: `/usr/sbin/nologin`.
   - **Dedicated Home Dizin**: `/var/lib/yunpanel/data/392d53e7-a6f5-5f12-85cb-828a3f4211cf` (mode `0750`, mülkiyet: `yunapp-d4c467173909:yunapp-d4c467173909`).
   - **Document Root & Release**: `/var/lib/yunpanel/apps/392d53e7-a6f5-5f12-85cb-828a3f4211cf/current/public` (mode `0750`), `index.php` provision edildi.
   - **Tmp Dizini**: `/var/lib/yunpanel/data/392d53e7-a6f5-5f12-85cb-828a3f4211cf/tmp` (mode `0700`, mülkiyet: `yunapp-d4c467173909:yunapp-d4c467173909`).
   - **Logs Dizini**: `/var/lib/yunpanel/data/392d53e7-a6f5-5f12-85cb-828a3f4211cf/logs` (mode `0750`, mülkiyet: `yunapp-d4c467173909:yunapp-d4c467173909`).
   - **Backup Scope**: `/var/lib/yunpanel/backups/resources` ve `/var/lib/yunpanel/backups/websites` kapsamına alındı.
   - **PHP-FPM Pool & Socket**: Pool `/etc/php/8.3/fpm/pool.d/yunpanel-yunapp-d4c467173909.conf`, socket `/run/php/yunpanel-yunapp-d4c467173909.sock` aktif ve servis çalışır durumda.
   - **Nginx vHost**: `/etc/nginx/sites-enabled/yunpanel-provtest.webrich.news.conf` oluşturuldu, HTTP 200 yanıtı alındı.
   - **İzolasyon Durumu**: İlk audit sorgusunda `status: "isolated"` ve `migrationRequired: false` doğrulandı.

---

## 2. Eksik Workspace Dizin İzolasyon Migrasyonu & Typed Rollback Kabulü

### Audit Düzeltmesi (Cascading Defect Fix):
- `apps/api/src/website-isolation-audit.js` modülünde, `tmp`/`logs` dizinleri eksik olduğunda downstream adımların (`php_runtime`, `sftp`) `website_identity_workspace_missing` nedeniyle ek reconcilation adımı önermesi ve bu sebeple `applyAvailable: false` (deadlock) oluşturması engellendi. `create_workspace_directories` varken downstream workspace cascade adımları audit tarafından temizlendi.
- Düzeltme API test paketinden başarıyla geçti (`npm test`).

### Canlı Drift & Migrasyon Doğrulaması:
1. **Drift Simülasyonu**:
   - `provtest.webrich.news` sitesinin `tmp` dizini silindi (`rmdir /var/lib/yunpanel/data/392d53e7-a6f5-5f12-85cb-828a3f4211cf/tmp`).
2. **Audit & Preview Denetimi**:
   - `GET /api/panel/sites/:id/isolation` sorgusunda drift tespit edildi (`status: "migration_required"`, `migrationRequired: true`).
   - Yalnızca tek bir `create_workspace_directories` adımı (`temporary` workspace, exact path `/var/lib/yunpanel/data/392d53e7-a6f5-5f12-85cb-828a3f4211cf/tmp`, mode `0700`) önerildi ve `applyAvailable: true` oldu.
3. **Güvenlik Sınırları**:
   - Var olmayan Website ID ile istek: `404 Not Found`.
   - Hatalı veya boş confirmation text: `400 Bad Request` (`site_isolation_migration_confirmation_required`).
   - Tahrif edilmiş / uyuşmayan digest ile confirmation: `409 Conflict` (`website_isolation_migration_plan_mismatch`).
4. **Durable Apply & Root-Private Receipt**:
   - Doğru `migrate-isolation:...` confirmation ile migrasyon çalıştırıldı (`operationId: 37b5d4e3-39a3-4668-a5bd-022e56950571`).
   - Host üzerinde `/var/lib/yunpanel/staging/website-identity-paths/37b5d4e3-39a3-4668-a5bd-022e56950571.json` makbuz dosyası root-private izinlerle (`0600`) oluşturuldu.
   - `tmp` dizini tam istenen hedef modunda (`0700`) ve `yunapp-d4c467173909:yunapp-d4c467173909` mülkiyetinde yeniden oluşturuldu.
5. **API Restart & Inspection Sınırı**:
   - `systemctl restart yunpanel-api` sonrasında operasyon durumu sorgulandı. Tamamlanmış makbuz inspect edilerek işlem mutation kör replay edilmeden `succeeded` kapandı. Site audit'i `status: "isolated"` döndü.
6. **Typed Rollback Doğrulaması**:
   - Doğru `rollback-isolation-migration:...` confirmation ile rollback çalıştırıldı.
   - Yalnızca operasyon tarafından oluşturulan boş `tmp` dizini temizlendi.
   - Önceden var olan `logs`, `data` (home), release ve runtime kaynaklarına kesinlikle dokunulmadı.
7. **Veri Koruma (Data Preservation) Güvenlik Kontrolü**:
   - Migrasyon tekrar uygulandıktan sonra `tmp` dizinine kullanıcı dosyası (`important_user_data.log`) bırakıldı.
   - Rollback tekrar çağrıldığında sistem veri içeren dizini silmeyi güvenle reddetti ve kullanıcı verisi korundu (`preserved`).
   - Test dosyası temizlendikten sonra site audit `status: "isolated"` olarak doğrulandı.
