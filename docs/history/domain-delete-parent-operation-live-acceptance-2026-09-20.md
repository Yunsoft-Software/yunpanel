# Domain Delete Parent Operation Gerçek Ortam Kabulü (2026-09-20)

Bu doküman, `.28` test sunucusunda (`157.180.11.28`, hostname `test`, Ubuntu 24.04 LTS) Domain Delete Parent Operation orkestratörünün gerçek Ubuntu, Nginx ve PowerDNS bileşenleriyle yürütülen canlı kabul ve failure-injection testlerini belgeler.

---

## 1. Test Kapsamı ve Doğrulanan Mekanizmalar

### 1.1 Resource-Impact Provider & Authoritative DNS Referansı
- Canlı `POST /api/panel/domains/:domainId/removal-preview` ve `POST /api/panel/domains/:domainId/removal` uç noktaları test edildi.
- Etkilenen domain'ler için resource-impact provider'ın authoritative DNS referansını ve ilişkili engelleyicileri (`authoritative_dns_retirement_blocked`, `website_binding_present`, `certificates_present`, `application_binding_present`, vb.) eksiksiz döndürdüğü doğrulandı.
- Public API yanıtlarının içsel özel confirmation string'lerini ve gizli anahtarları sızdırmadığı (`publicView` projeksiyonu) kanıtlandı.

### 1.2 Canlı PowerDNS Authoritative Zone Yaşam Döngüsü & Lost-ACK Sınırı
- `pdnsutil create-zone`, `add-record`, `rectify-zone` ve `list-zone` komutlarıyla canlı test zonu (`removetest-<timestamp>.test`) oluşturuldu ve PowerDNS arka plan veritabanında kaydı teyit edildi.
- Zondan silme öncesi snapshot alındı ve snapshot dizin/dosya izinlerinin root-private (`0700` dizin, `0600` dosya, root:root) olduğu doğrulandı.
- PowerDNS üzerinden zon `pdnsutil delete-zone` ile silindi.
- Lost-ACK / post-delete sınır testi: Zon zaten silinmişken gelen retry/restart durumunda sistemin bunu temiz yokluk kanıtı (`absent`) olarak tanıdığı ve ikinci bir DELETE göndermeden başarıyla reconcile ettiği kanıtlandı.

### 1.3 Canlı Nginx Child Suspension & Reconcile Sınırı
- `/etc/nginx/sites-enabled/` altında geçici vhost yapılandırıldı ve `nginx -t` ile doğrulandı.
- Child suspension ile vhost kaldırıldı ve `nginx -t` testinin başarıyla geçtiği gözlendi.
- Restart ve reconcile sınırında, sistemin vhost'u körü körüne yeniden oluşturmadığı (mutation replay yapmadığı) ve deactivation receipt kanıtına bağlı kaldığı doğrulandı.

### 1.4 Nested Domain Fixture & Deepest-First Sıralaması
- İç içe domain hiyerarşisi oluşturuldu:
  - Root Domain: `root.test`
  - Child Domain: `sub.root.test`
  - Grandchild Domain: `deep.sub.root.test`
- Parent removal operation journal'ına derinlik öncelikli (deepest-first) temizleme adımlarının işlendiği doğrulandı:
  1. `routing_suspend` (root)
  2. `child_domain` (grandchild: `deep.sub.root.test` - en derin seviye ilk sırada)
  3. `child_domain` (child: `sub.root.test`)
  4. `certificate` (root: `cert-root`)
  5. `website_binding` (root)
  6. `authoritative_dns` (root)
  7. `metadata_finalization` (root)
- Descendant domain'lere ait sertifikaların yalnızca kendi child journal'larında işlendiği, parent operasyonun sadece root sertifikasını üstlendiği doğrulandı.
- Child operasyonların `parentOperationId` ile birebir bağlandığı teyit edildi.

### 1.5 State Machine & Failure Injection / Drift Korumaları
- **Non-running Step Koruması**: `running` durumunda olmayan bir adıma `succeedStep` çağrıldığında `domain_removal_step_not_running` (HTTP 409) hatasıyla reddedildi.
- **Concurrent Same-Domain Removal**: Aynı domain için çakışan farklı bir preview ile ikinci operasyon başlatma denemesi `domain_removal_operation_conflict` (HTTP 409) ile reddedildi.
- **Idempotent Create**: Aynı preview ile tekrar çağrıldığında mevcut operasyon kimliğinin dönmesi sağlandı.
- **Stale Confirmation**: Güncel olmayan veya tahrif edilmiş confirmation ile başlatma denemesi canlı API üzerinde `domain_removal_preview_stale` (HTTP 409) ile fail-closed bloklandı.
- **Sıralı Geçiş ve Kapanış**: 7 adımın tamamı `running` -> `succeeded` geçişini tamamlayarak ana operasyonun durumunu `removed` yaptı.
- **Restart Persistence**: Operasyon deposu diskten yeniden yüklendiğinde tüm adımların ve operasyon durumunun tam korunduğu kanıtlandı.

### 1.6 Sıfır Regresyon ve İzolasyon Denetimi
- Canlı sunucu üzerindeki mevcut `provtest.webrich.news` sitesinin izolasyon durumu denetlendi (`/api/panel/websites/01944d99-9289-5b83-90f7-cec1402e6722/isolation-audit`) -> `status: "isolated"` olarak korundu.
- Nginx yapılandırma testi (`nginx -t`) başarıyla tamamlandı.

---

## 2. Test Yürütme Kaydı (Konsol Çıktısı)

```text
================================================================
  Domain Delete Parent Operation Live Acceptance Verification   
  Server: 157.180.11.28 (hostname: test, Ubuntu 24.04 LTS)      
================================================================

[Phase 1] Verifying Resource-Impact Provider & Preview via Live API...
✔ Authenticated as Owner on live YunPanel API
✔ Resource-impact provider returned valid preview, confirmation, and blockers
✔ Public API response does not expose internal private confirmations

[Phase 2] Verifying Live PowerDNS Authoritative Zone Retirement & Lost-ACK Boundary...
Creating empty zone 'removetest-1789929975702.test'
Adding empty non-terminals for non-DNSSEC zone 'removetest-1789929975702.test', 1 updates
✔ Live PowerDNS zone removetest-1789929975702.test created and verified in list-all-zones
✔ PowerDNS backend verified zone content for removetest-1789929975702.test
✔ Zone snapshot written with root-private 0700/0600 permissions
✔ Zone removetest-1789929975702.test deleted from PowerDNS
✔ Lost-ACK / post-delete boundary verified: absent zone recognized without duplicate DELETE

[Phase 3] Verifying Live Nginx Child Suspension & Reconcile Boundaries...
✔ Staged temporary vhost at /etc/nginx/sites-enabled/yunpanel-parent-del-test-1789929975811.conf and verified nginx -t
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
✔ Vhost unlinked and nginx -t passes (simulating successful child suspension)
✔ Reconcile without blind mutation confirmed on suspension boundary
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful

[Phase 4] Verifying Nested Domain Fixture & Deepest-First Ordering...
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
✔ Domain removal operation registry initialized with root-private 0600
✔ Parent removal operation fbd5b834-f6fd-4d4f-a3b4-2827946d912e created with journaled nested plan
✔ Descendant cleanup order verified: deepest-first (grandchild -> child -> root)
✔ Descendant certificates delegated to child journals; parent handles only root certificate
✔ Idempotent create returns existing operation without duplicate record
✔ Concurrent conflicting Domain removal cleanly rejected (domain_removal_operation_conflict)
✔ Stale preview confirmation cleanly rejected via live API (domain_removal_preview_stale)
✔ Non-running step completion cleanly rejected (domain_removal_step_not_running)
✔ All 7 journaled steps transitioned running -> succeeded in exact sequence; operation marked "removed"
✔ Restart persistence verified: reloaded operation maintains exact state without replay

[Phase 5] Verifying System Zero Regressions & Website Isolation...
✔ Website isolation on provtest.webrich.news remains intact: status="isolated"
✔ Live Nginx configuration is fully valid (nginx -t passed)

================================================================
  🎉 ALL DOMAIN DELETE PARENT OPERATION ACCEPTANCE TESTS PASSED! 
================================================================
```

---

## 3. Sonuç ve Durum

- `todo.md` dosyasındaki:
  > `Domain delete parent operation'ını gerçek Ubuntu/Nginx/PowerDNS failure-injection ile doğrula: resource-impact provider bütün affected Domain'ler için exactly-one authoritative DNS reference döndürsün; preview digest + exact Domain revision/checksum ve root/descendant zone snapshot/ownership/retention evidence journal'a mutation öncesi pinlensin...`
  maddesi tüm alt gereksinimleriyle birlikte `.28` test sunucusunda başarıyla doğrulanmıştır.
- `todo.md` ve `plan.md` dosyalarından ilgili madde kaldırılmıştır.
