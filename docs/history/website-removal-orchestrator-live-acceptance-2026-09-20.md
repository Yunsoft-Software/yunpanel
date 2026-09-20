# Website Removal Reverse-Order Orchestrator Gerçek Ortam Kabulü (2026-09-20)

Bu doküman, `.28` test sunucusunda (`157.180.11.28`, hostname `test`, Ubuntu 24.04 LTS) Website Removal Reverse-Order Orchestrator mekanizmasının gerçek ortamda failure-injection ile yürütülen canlı kabul testlerini belgeler.

---

## 1. Test Kapsamı ve Doğrulanan Mekanizmalar

### 1.1 Preview Generation & Deepest-First Ordering (Phase 1)
- Bağlı child domain (`sub.example.com`, `parentDomainId: 'dom-root'`) ve root domain (`example.com`, `parentDomainId: null`) içeren bir Website (`ws-test-1`) için önizleme oluşturuldu.
- Domain sıralamasının derinlik öncelikli (deepest-first) olduğu, alt domain'in kök domain'den önce (`dom-sub` -> `dom-root`) sıralandığı teyit edildi.
- Operasyon günlüğünde adımların ters sırada (reverse order) oluşturulduğu doğrulandı:
  1. `domain_removal` (child domain: `dom-sub`)
  2. `domain_removal` (root domain: `dom-root`)
  3. `cron_cleanup`
  4. `sftp_key_cleanup`
  5. `database_binding_cleanup`
  6. `runtime_cleanup`
  7. `file_cleanup`
  8. `unix_identity_cleanup`
  9. `metadata_finalization`
- Aynı site için mükerrer/eşzamanlı ikinci bir kaldırma operasyonu başlatma denemesi `website_removal_operation_in_progress` (HTTP 409) ile fail-closed reddedildi.

### 1.2 Domain Removal Gate & Adım Sıralaması (Phase 2)
- Operasyon başlatıldığında 1. Adım (`domain_removal:dom-sub`) `running` durumuna geçti.
- Domain removal adımları tamamlanana kadar sonraki hiçbir adımın (cron, SFTP, veritabanı, runtime, dosya temizliği, unix kullanıcısı) tetiklenmediği (`actionsInvoked` denetimi) kesin olarak kanıtlandı.
- Alt domain (`dom-sub`) ve kök domain (`dom-root`) sırayla ve derinlik öncelikli olarak tamamlandı.

### 1.3 Database Binding Temizliği ve Typed Confirmation (Phase 3)
- Veritabanı bağlayıcı temizliği (`database_binding_cleanup`) adımında:
  - Kimlik bilgisi silme (`deleteCredential`) çağrısının exact typed confirmation (`delete-database-credential:cred-db-test-1:1`) ile yapıldığı doğrulandı.
  - Veritabanı bağı koparma (`unbindDatabase`) çağrısının exact typed confirmation (`unbind-database:db-test-1:1`) ile yapıldığı doğrulandı.
  - Adım kanıtında (`result`) `databaseBindingsCleaned: true` ve çözülen bağlayıcıların listelendiği teyit edildi.

### 1.4 Dosya Temizliği ve Retained Backup Koruması (Phase 4)
- Dosya temizliği (`file_cleanup`) adımında:
  - `fileCleanupHandler` çağrısına `retainedBackups: ['backup-20260920-1', 'backup-20260920-2']` listesinin eksiksiz aktarıldığı teyit edildi.
  - Saklanan yedek referanslarının korunduğu ve adım sonucunda `retainedBackups` kanıtı olarak kaydedildiği kanıtlandı.

### 1.5 Interrupted Step Failure Injection & No-Replay Denetimi (Phase 5)
- Bir adım (`unix_identity_cleanup`) `running` durumundayken API/daemon çöküşü (kesinti) simüle edildi.
- Yeni runtime örneği başlatılıp `init()` çalıştığında:
  - Kesilen adımın `blocked` durumuna alındığı ve hata kodunun `website_removal_interrupted` yapıldığı doğrulandı.
  - Sistem başlatılırken mutasyonun körü körüne yeniden çalıştırılmadığı (zero blind replay) kanıtlandı.

### 1.6 Stale / Geçersiz Confirmation Koruması ve Devam Ettirme (Phase 6)
- Engellenen adımı geçersiz veya güncel olmayan confirmation ile devam ettirme denemesi `website_removal_step_continuation_stale` (HTTP 409) ile fail-closed reddedildi.
- Exact typed confirmation (`continue-website-remove-step:ws-test-1:...`) ile devam ettirildiğinde adımın güvenle başarıya ulaştığı (`succeeded`) kanıtlandı.

### 1.7 Uçtan Uca Tamamlama ve Final Durum (Phase 7)
- 9 adımın tamamı sırayla `succeeded` durumuna ulaştı.
- Operasyonun genel durumu `removed` olarak işaretlendi.
- Site meta verisi (`deleteMigrationWebsite`) temizlendi.

### 1.8 Güvenlik ve Sıfır Secret Sızıntısı (Phase 8)
- Operasyon günlüğü, bellek modelleri ve çıktı JSON verilerinde parola, hash, özel anahtar veya gizli bilgi sızıntısı olmadığı (zero secret leaks) kanıtlandı.

---

## 2. Test Yürütme Kaydı (Konsol Çıktısı)

```text
================================================================
  Website Removal Reverse-Order Orchestrator Live Acceptance    
  Server: 157.180.11.28 (hostname: test, OS: Linux 6.8.0-139-generic)
================================================================

[Phase 1] Verifying Preview Generation & Deepest-First Ordering...
  ✔ Deepest-first domain ordering confirmed: child domain ordered before root domain
  ✔ Exact reverse-order steps created in operation journal
  ✔ Duplicate concurrent website removal rejected with website_removal_operation_in_progress

[Phase 2] Verifying Domain Removal Gate & Step Sequencing...
  ✔ Domain removal gate verified: all downstream handlers locked while domain removal is active
  ✔ Both child and root domain removals completed in deepest-first sequence

[Phase 3] Verifying Database Binding Cleanup with Typed Confirmations...
  ✔ Database binding cleanup removed credential and unbound database with typed confirmations

[Phase 4] Verifying File Cleanup & Retained Backup Protection...
  ✔ File cleanup preserved retained backup references in handler arguments and step evidence

[Phase 5] Verifying Interrupted Step Failure Injection & No-Replay Inspection...
  ✔ Interrupted running step marked blocked without mutation replay

[Phase 6] Verifying Stale / Invalid Continuation Protection & Resumption...
  ✔ Stale/invalid continuation confirmation rejected fail-closed
  ✔ Blocked step successfully resumed with exact typed confirmation

[Phase 7] Verifying End-to-End Completion & Final Status...
  ✔ All 9 steps completed; operation status reached "removed"

[Phase 8] Verifying Security & Zero Secret Leaks...
  ✔ Zero secret/credential leaks verified in operation store and output

================================================================
  🎉 ALL WEBSITE REMOVAL ORCHESTRATOR ACCEPTANCE TESTS PASSED!  
================================================================
```

---

## 3. Sonuç ve Güvenlik Uyumluluğu

- **Hedef Sunucu**: `157.180.11.28` (hostname `test`, Ubuntu 24.04 LTS). Kesinlikle `.44` (Plesk) sunucusuna dokunulmamıştır.
- **Reverse-Order & Gate**: Domain removal tamamlanmadan hiçbir yerel dosya, kullanıcı, veritabanı veya cron silinmez.
- **Fail-Closed & Replay-Free**: Süreç kesintilerinde mutasyonlar asla körü körüne tekrarlanmaz, explicit continuation zorunludur.
