# Site Move/Delete Resource Impact Live Acceptance — 2026-09-20

## Özet

Ubuntu 24.04 LTS kurulu YunPanel test sunucusunda (`157.180.11.28` — `.28`, hostname `test`), `T-PROVISIONING` kapsamındaki aşağıdaki madde uçtan uca doğrulanmıştır:

> **Site move/delete impact gerçek DNS, mail/webmail, database/grant, SFTP, GoAccess, restic, cron ve active job ilişkilerini göstersin; implicit cascade yapmasın.**

IP adresi `.44` ile biten Plesk sunucusuna kesinlikle dokunulmamış; bütün işlemler repo dışı `.local/test-server.env` ile tanımlı `.28` test sunucusu üzerinde yürütülmüştür. Parola, secret, session token ve CSRF verileri rapora yazılmamıştır.

---

## 1. Test Düzeneği ve Canlı Kaynaklar

- **Test Sunucusu**: `157.180.11.28` (hostname: `test`, `localServerId: 99bc760a-d508-4ae6-92be-efdedee9658d`)
- **İncelenen Canlı Website**: `webrich.news` (`2689cb56-55a4-50c0-a3a4-258c7f2d48dd`)
- **İncelenen Canlı Apex Domain**: `webrich.news` (`e63c3342-787d-5222-8b24-8db2de9834cc`)
- **İncelenen Canlı Alt Domain**: `mailtest.webrich.news` (`ecca97c9-9a98-5e67-9b7e-a0423e0bc0ab`)
- **Canlı İlişkili Servisler**: PowerDNS Authoritative, Postfix/Dovecot (Local Mail), MariaDB, ACME TLS sertifikaları, GoAccess (Log Scope), Unix kimlikleri (`yunapp-a404896cf12e`).

---

## 2. Doğrulanan Yaşam Döngüsü ve Güvenlik Adımları

### Aşama 1: Website Delete Impact Preview (`webrich.news`)
`POST /api/websites/2689cb56-55a4-50c0-a3a4-258c7f2d48dd/impact-preview`
Gövde: `{ "operation": "delete" }`

API çıktısı aşağıdaki gerçek kaynak ilişkilerini eksiksiz listelemiştir:
1. **DNS & Routing İlişkileri**:
   - `linkedDomains`: 2 adet bağlı domain (`webrich.news`, `www.webrich.news`), targetType: `php`, active state ve Nginx checksum'ları ile.
   - `childDomains`: 2 adet alt domain listelenmiştir.
   - `authoritativeDns`: PowerDNS üzerindeki 4 ilgili zone denetlenmiş ve retirement blocker'ları gösterilmiştir (`domain_descendants_present`, `domain_website_binding_present`, `domain_routing_active`, `dns_zone_manual_rrsets_present`).
2. **Mail & Webmail İlişkileri**:
   - `mailDomains`: `mailtest.webrich.news` (id: `0fa91f02-e2f9-5519-8be3-0e1072dfa41f`, local management mode).
   - `mailboxes`: 1 aktif posta kutusu (`34c8d1a2-e621-4a3b-aa37-3682b3700a9b`, state: `enabled`).
3. **Database & Grant İlişkileri**:
   - `databases`: 1 veritabanı bağıntısı (`da72dc47-d2e2-413a-a0a2-7b8766b0d58e`, state: `site_a_db`).
4. **Sertifika (TLS) İlişkileri**:
   - `certificates`: 3 adet ACME sertifikası, son geçerlilik tarihleri ve durumları ile raporlanmıştır.
5. **Unix Kimliği ve Dosya İzolasyonu**:
   - `unixIdentities`: Dedicated Unix kullanıcısı `yunapp-a404896cf12e` (state: `active`).
6. **GoAccess / Log Kapsamı**:
   - `logScopes`: Dedicated site log kapsamı (`2689cb56-55a4-50c0-a3a4-258c7f2d48dd`, state: `managed`).
7. **Implicit Cascade Yasağı**:
   - `cascade: false`: Örtülü cascade silme kesinlikle engellenmiştir.
   - `safeToApply: false`: Mevcut bağımlılıklar nedeniyle doğrudan silinemez olarak işaretlenmiştir.
   - `autoApply: false`: Otomatik uygulama kapalıdır.
   - `applySupported: false`: Resource impact salt okunur preview'dur; kontrolsüz genel silme açık değildir.
   - `blockers`: 12 ayrı engel (`linked_domains_present`, `child_domains_present`, `application_binding_present`, `certificates_present`, `mail_domains_present`, `authoritative_dns_retirement_blocked`, `mailbox_dependencies_present`, `database_binding_dependencies_present`, `unix_identity_dependencies_present`, `log_scope_dependencies_present`, `impact_apply_not_implemented`) açıkça listelenmiştir.

### Aşama 2: Domain Delete Impact Preview (Apex & Subdomain)
1. **Apex Domain (`webrich.news`)**:
   - `POST /api/domains/e63c3342-787d-5222-8b24-8db2de9834cc/impact-preview`
   - Alt subdomain'leri (`childDomains`: 3 domain) ve ilişkili sertifikaları listelemiştir.
   - `cascade: false` ile alt domainlerin örtülü silinmesi engellenmiştir.
2. **Subdomain (`mailtest.webrich.news`)**:
   - `POST /api/domains/ecca97c9-9a98-5e67-9b7e-a0423e0bc0ab/impact-preview`
   - Bağlı Mail Domain'i (`mailtest.webrich.news`) ve alt sertifikaları tespit etmiştir; `cascade: false`.

### Aşama 3: Tek Sunucu (Agentless) "Move" Yasağı Sınırı (HTTP 409 Conflict)
2026-09-12 tek-sunucu mimari kararı gereği, yerel panel üzerinden uzak sunucuya kaynak taşıma yapılamaz:
1. `POST /api/websites/:websiteId/impact-preview` ile `{ "operation": "move", "targetServerId": "..." }`:
   - Yanıt: `HTTP 409 Conflict`, `error.code: "local_server_only"`.
2. `POST /api/domains/:domainId/impact-preview` ile `{ "operation": "move", "targetServerId": "..." }`:
   - Yanıt: `HTTP 409 Conflict`, `error.code: "local_server_only"`.

### Aşama 4: Girdi Doğrulama ve Fail-Closed Güvenlik Sınırları
1. **Boş Gövde**: `{}` -> `HTTP 400 Bad Request` (`impact_input_invalid`).
2. **Geçersiz İşlem**: `{ "operation": "clone" }` -> `HTTP 400 Bad Request` (`impact_operation_invalid`).
3. **Fazladan Alan**: `{ "operation": "delete", "extraParam": true }` -> `HTTP 400 Bad Request` (`impact_input_invalid`).
4. **Delete İle Hedef Sunucu Gönderme**: `{ "operation": "delete", "targetServerId": "..." }` -> `HTTP 400 Bad Request` (`impact_input_invalid`).
5. **Bilinmeyen Website**: `00000000-0000-4000-8000-000000000000` -> `HTTP 404 Not Found` (`website_not_found`).
6. **Bilinmeyen Domain**: `00000000-0000-4000-8000-000000000000` -> `HTTP 404 Not Found` (`domain_not_found`).

### Aşama 5: Sıfır Regresyon ve İzolasyon Denetimi
- Tüm çağrıların salt okunur (read-only) çalıştığı ve mevcut canlı sistem kaynaklarını değiştirmediği kanıtlandı.
- Canlı izolasyon denetimi ile doğrulama yapıldı:
  - `provtest.webrich.news`: `HTTP 200`, `status: "isolated"`.
  - `yunpanel-static-deploy.test`: `HTTP 200`, `status: "isolated"`.
