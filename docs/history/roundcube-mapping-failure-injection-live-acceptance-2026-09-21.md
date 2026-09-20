# Shared Roundcube Mapping Failure-Injection ve Yaşam Döngüsü Canlı Kabul Raporu

**Tarih**: 2026-09-21  
**Hedef Sunucu**: `157.180.11.28` (hostname: `test`, Ubuntu 24.04 LTS)  
**Server ID**: `99bc760a-d508-4ae6-92be-efdedee9658d`  
**Test Edilen Alan Adı**: `mailtest.webrich.news` (Mail Domain ID: `0fa91f02-e2f9-5519-8be3-0e1072dfa41f`)  
**Webmail Sertifikası**: `7b495e27-92f0-4040-b5f7-cfaca576c049` (`purpose: webmail`, `CN=webmail.mailtest.webrich.news`)  
**Kapsam**: `todo.md` `T-MAIL` satır 44 — Shared Roundcube mapping failure-injection (bind intent persist, apply enqueue/attach, Nginx replace/reload/health, job completion, active finalize, delete active→removing DNS readiness drop, shared config apply, removed tombstone, tombstone persist ve parent Domain removal step recovery).

---

## 1. Özet ve Kabul Sonuçları

`todo.md` dosyasındaki `T-MAIL` satır 44 maddesi uyarınca, canlı test sunucusu (`.28`) üzerinde Shared Roundcube webmail eşleme yaşam döngüsü ve hata enjeksiyonu sınırları uçtan uca doğrulanmıştır.

### Doğrulanan Aşamalar ve Güvenlik Sınırları:

1. **Bind Önizlemesi ve Hata Enjeksiyonu (`/webmail/bind-preview`, `/webmail/bind`)**:
   - `expectedRevision: 4`, `webDomainRevision: 2` ile geçerli önizleme alındı (`previewDigest: 9a271b75b557...`, `confirmation: bind-roundcube-domain:...`).
   - **Stale previewDigest Enjeksiyonu**: Geçersiz 64 karakterli özet ile yapılan istek HTTP 409 `roundcube_mapping_confirmation_invalid` ile fail-closed reddedildi.
   - **Geçersiz Onay Dizgisi Enjeksiyonu**: Rastgele onay dizgisi ile yapılan istek HTTP 409 `roundcube_mapping_confirmation_invalid` ile reddedildi.

2. **Bind Başlatma / Niyet Kalıcılığı (Intent Persist)**:
   - Doğrulanmış `previewDigest` ve `confirmation` ile `POST /webmail/bind` çağrıldı (HTTP 202 Accepted).
   - Eşleme `state: 'pending'` durumunda ve tekil `operationId: 9c809907-35aa-...` ile kalıcı hale getirildi.
   - Henüz uygulanmadığı için genel aramalarda (`getForMailDomain`) aktif sayılmadığı ve canlı Nginx/DNS üzerinde erken etki oluşturmadığı doğrulandı.
   - Denetim (`GET /webmail`) çağrısının durumu değiştirmeden salt-okunur kaldığı ve `actions.continuation` sunduğu kanıtlandı.

3. **İş Kuyruklama ve İlişkilendirme (Apply Enqueue/Attach)**:
   - `POST /webmail/continue` ile ilk devam adımı yürütüldü (HTTP 202 Accepted).
   - Deterministik `idempotencyKey` ile `roundcube.config.apply` işi kuyruğa alındı (Job ID: `fc5b505b-4f94-4f91-9f2d-4fbe2f433232`).
   - Eşleme kaydına `applyJobId` iliştirildi. İş `queued`/`running` durumundayken arayüzün/servisin ikinci bir iş üretmediği (inspection-only kaldığı) doğrulandı.

4. **Nginx Yapılandırma Uygulaması, Yeniden Yükleme ve Sağlık Denetimi**:
   - `fc5b505b-...` işi sunucu üzerinde başarıyla tamamlandı (`status: 'succeeded'`).
   - Nginx yapılandırmasına `webmail.mailtest.webrich.news` server bloğu eklendi, sözdizimi doğrulandı ve Nginx başarıyla yeniden yüklendi.
   - İş bittikten sonra eşleme durumunun doğrudan `active` yapılmayıp, başarı kanıtı ile birlikte son onay adımını beklediği (`state: 'pending'`, `actions.continuation: continue-roundcube-domain:...`) doğrulandı.

5. **Aktif Durum Sonlandırma (Active Finalize)**:
   - `POST /webmail/continue` ile son onay dizgisi gönderildi (HTTP 202 Accepted).
   - Eşleme durumu atomik olarak `active` (`revision: 5`) durumuna geçirildi.
   - Canlı denetimde (`GET /webmail`) `state: 'active'` kanıtlandı.

6. **Silme Önizlemesi ve Hata Enjeksiyonu (`/webmail/delete-preview`, `/webmail/delete`)**:
   - `POST /webmail/delete-preview` ile `revision: 5`, `previewDigest: 5cb205066159...` ve `confirmation` alındı.
   - **Stale delete previewDigest Enjeksiyonu**: Bayat özet ile yapılan silme isteği HTTP 409 `roundcube_mapping_confirmation_invalid` ile engellendi.

7. **Silme Başlatma ve Anında DNS/Webmail Readiness Düşüşü**:
   - Doğrulanmış silme isteğiyle `POST /webmail/delete` çağrıldı (HTTP 202 Accepted).
   - Eşleme anında `state: 'removing'` durumuna geçti.
   - Host temizliği (Nginx geri alma) henüz başlamadan önce, DNS ve webmail hazır bulunuşluğunun anında düştüğü (`getForMailDomain` ve `listMappings` kapsamından anında çıkarıldığı) doğrulandı.

8. **Paylaşımlı Yapılandırma Kaldırma ve Tombstone Oluşumu**:
   - `POST /webmail/continue` ile Nginx temizleme işi kuyruklandı (Job ID: `65b54af8-7b07-4d1c-98b8-1e64df6b379f`).
   - İş başarıyla tamamlandı (`status: 'succeeded'`).
   - Son `continue` çağrısı ile eşleme `state: 'removed'` (tombstone) durumuna geçirildi (`deleted: true`, `actions.continuation: null`).
   - Tombstone'un kalıcı olduğu ve üzerine işlem yapılamayacak şekilde kilitlendiği doğrulandı.
   - `domain-removal-runtime`'ın `webmail_mapping` adımında mevcut `state: 'removed'` tombstone'unu tespit ettiğinde ikinci bir Roundcube apply tetiklemeden doğrudan `succeeded` kapandığı kanıtlandı.

---

## 2. Test Sonucu

Tüm aşamalar ve hata enjeksiyonları (stale digest, invalid confirmation, in-flight inspection-only, exact evidence finalize, removing DNS drop, tombstone generation) `.28` test sunucusunda sıfır hata ile başarıyla tamamlanmıştır.
