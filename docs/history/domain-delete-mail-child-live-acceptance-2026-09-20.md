# Domain Delete Mail Domain Child Lifecycle Gerçek Ortam Kabulü (2026-09-20)

Bu doküman, `.28` test sunucusunda (`157.180.11.28`, hostname `test`, Ubuntu 24.04 LTS) Domain Delete Mail Domain Child Lifecycle mekanizmasının gerçek yerel mail fikstüründe failure-injection ile yürütülen canlı kabul testlerini belgeler.

---

## 1. Test Kapsamı ve Doğrulanan Mekanizmalar

### 1.1 Removal Preview Pinning & v3 Root-Private Journal (Phase 1)
- Yerel mail domain'i (`mailtest.webrich.news`, local management mode) üzerinde removal preview oluşturuldu.
- Preview nesnesinde tüm alt bağımlılıkların (mailbox, alias, quota, forwarding, DKIM, mailData, disableConfiguration) revision ve update kimliklerinin eksiksiz pinlendiği teyit edildi:
  - Mailbox: `admin@mailtest.webrich.news`
  - Mail Data: `present: true`, disk kullanım baytı, snapshot SHA-256
  - DKIM: `mailtest.webrich.news`, anahtar revizyonu ve selector
  - Disable Configuration: preview digest ve beklenen configuration SHA-256
- v3 Child Operation Journal'ı `/var/lib/yunpanel/control-plane/` altında root-private izinlerle (`0700` dizin, `0600` dosya) oluşturuldu.
- Journal dosyası ve bellek modelleri incelenerek parola, hash, DKIM private key veya secret sızıntısı olmadığı (zero secret leaks) kanıtlandı.

### 1.2 Post-Preview Drift Fail-Closed Blokajı (Phase 2)
- Preview sonrasında aktif job drift enjeksiyonu yapıldı (`mail_data_backup` aktif job'ı eklendi).
- Plan servisi drift durumunda `readyToStart: false`, `confirmation: null` ve `mail_domain_removal_job_active` hatası vererek fail-closed blokladı.
- Kaynak durum/revizyon uyuşmazlığında operasyon oluşturma ve ilerletme denemelerinin `mail_domain_removal_preview_stale` ile reddedildiği doğrulandı.

### 1.3 V1/V2 Pending Fixture Upgrade & Tamper Detection (Phase 3)
- Plansız v1 ve eski-plan v2 pending fikstürleri yüklendiğinde, host mutation yapmadan güvenle v3 journal formatına yükseltildiği teyit edildi.
- Planlanmamış veya tahrif edilmiş ileri operasyon adımı (`cleaning` durumundaki v1 fikstürü) `mail_domain_removal_operation_tampered` ile fail-closed bloklandı.
- Güvenli plan recapture ile aynı kaynak/parent için güncel preview yakalanıp operasyonun devam ettirilebildiği kanıtlandı.

### 1.4 Disabling Intent Persistence & Job Enqueue Idempotency (Phase 4)
- Enabled kaynak için host mutation öncesinde `disabling` intent'inin journal'a persist edildiği doğrulandı.
- Sunucu/süreç kesintisi simülasyonunda (process kill):
  - Config job enqueue öncesi veya sonrası süreç kesilip tekrar başladığında deterministic `idempotencyKey` ile aynı job bulundu.
  - İkinci bir duplicate job oluşturulmadığı (kuyrukta tek job kaldığı) kanıtlandı.

### 1.5 Exact V3 Config Result & Disabled Revision Reconcile (Phase 5)
- Config job çalışırken (`running`) executor'ın `blocked` ve `mail_domain_removal_config_job_pending` döndürdüğü teyit edildi.
- Startup inspector'ın job çalışırken hiçbir job enqueue etmediği (`sideEffects: false`) kanıtlandı.
- Job `succeeded` olduğunda ancak mail domain durumu henüz `disabled` ve artırılmış revizyona reconcile edilmemişken `mail_domain_removal_config_reconciliation_pending` ile bekletildiği doğrulandı.
- Yalnızca exact v3 config job sonucu (`applied: true`, beklenen SHA-256 özetleri) VE registry üzerinde artırılmış revizyonla `disabled` durumuna reconcile edildiğinde operasyonun `cleaning` aşamasına ilerlediği kanıtlandı.

### 1.6 Disabled Kaynak No-Op Config (Phase 6)
- Önceden `disabled` olan bir mail domain fixture'ı ile başlatılan operasyonda:
  - Config disable dispatch adımının no-op olarak atlandığı (`disableJobId: null`).
  - Kaynak revizyonun (`revision: 4`) aynen korunduğu teyit edildi.

### 1.7 Adım Adım Temizlik & Süreç Kesintisi Sınırı (Phase 7)
- Temizlik adımları pinned bağımlılık sırasıyla icra edildi:
  1. Forwarding (Sieve yönlendirmesi)
  2. Quota (posta kutusu kotası)
  3. Alias (takma ad)
  4. DKIM (alan adı anahtarı)
- Her continuation çağrısında yalnız tek bir pinned hedefin temizlendiği doğrulandı.
- Her adım sonrasında süreç kesintisi simüle edildi: startup inspector'ın tamamlanan adımları körü körüne replay etmediği (`sideEffects: false`), eksik adımı beklediği teyit edildi.
- Tüm temizlik hedefleri bittiğinde, backup dispatch öncesinde `backing_up` evidence checkpoint'inin (`cleanupEvidenceDigest`) eksiksiz oluştuğu kanıtlandı.

### 1.8 Backup & Data-Delete Job'ları, Credential Temizliği, Disk Varlık Engeli ve Unlink (Phase 8)
- `backing_up` kanıtı olmadan veri silme job'ının başlatılamayacağı kanıtlandı.
- Backup job'ı (`mail_data_backup`) başarıyla tamamlanıp `inspectBackup` tarafından doğrulandıktan sonra `deleting_data` aşamasına geçildi.
- `deleting_data` aşamasında ilk continuation posta kutusu kimlik bilgilerini (`deleteMailbox`) sildi.
- Sıfır posta kutusu kaldığında veri silme job'ı (`mail_data_delete`) kuyruğa alındı.
- **Disk Varlık Engeli**: Veri silme job'ı başarılı görünse bile sunucu diskinde (`/var/lib/yunpanel/mail/<domain>`) veri mevcut olduğu sürece `mail_domain_removal_data_delete_reconciliation_pending` ile finalizasyonun fail-closed bloklandığı canlı filesystem denetimiyle kanıtlandı.
- Disk verisi temizlendiğinde operasyon `finalizing` aşamasına ilerledi.
- Finalizer (`finalizeMailDomain`) exact delete evidence (`deleteJobId`, `backupId`) eşleşmesiyle metadata unlink işlemini tamamladı ve `removed` disposition ile kapandı.
- Aktif Roundcube webmail mapping'i varken removal preview'ın `mail_domain_webmail_mapping_active` blocker'ı ile fail-closed durduğu kanıtlandı.

### 1.9 Harici Mail Domain Fixture'ı (Phase 9)
- Harici (`managementMode: 'external'`) mail domain fikstüründe:
  - Local mailbox/alias bağımlılığı varsa `external_mail_domain_local_dependencies` blocker'ı ile fail-closed durduruldu.
  - Preview'da yerel DKIM, mailData ve disableConfiguration adımlarının `null` olduğu teyit edildi.
  - İcra sırasında yerel config disable, temizlik, backup ve veri silme adımları no-op atlanarak doğrudan metadata unlink (`external_metadata_unlink`) yapıldığı kanıtlandı.

---

## 2. Test Yürütme Kaydı (Konsol Çıktısı)

```text
================================================================
  Mail Domain Child Lifecycle Live Acceptance Verification      
  Server: 157.180.11.28 (hostname: test, Ubuntu 24.04 LTS)      
================================================================

[Phase 1] Verifying Removal Preview Pinning & v3 Root-Private Journal...
  ✔ Preview successfully pinned all mailbox/alias/quota/forwarding/DKIM/mailData/disableConfiguration digests
  ✔ v3 child operation store created with root-private 0700/0600 permissions and zero secret leaks

[Phase 2] Verifying Post-Preview Drift Fail-Closed...
  ✔ Active job drift blocks preview with mail_domain_removal_job_active and null confirmation

[Phase 3] Verifying V1/V2 Pending Fixture Upgrade & Tamper Detection...
  ✔ V1/V2 pending fixture upgraded to v3 without mutation; un-planned advanced op blocked fail-closed

[Phase 4] Verifying Disabling Intent Persistence & Job Enqueue Idempotency...
  ✔ Disabling intent persisted; config job enqueue is strictly idempotent on process kill

[Phase 5] Verifying Exact V3 Config Result & Disabled Revision Reconcile...
  ✔ Only exact v3 config result + reconciled disabled revision advances to cleaning

[Phase 6] Verifying Disabled Source No-Op Config...
  ✔ Disabled source skips config dispatch and preserves source revision

[Phase 7] Verifying Step-by-Step Cleanup & Process Kill Boundary...
  ✔ Step-by-step cleanup: 1 pinned target per continuation; backing_up evidence checkpoint formed

[Phase 8] Verifying Backup & Data-Delete Jobs, Credential Cleanup & Unlink...
  ✔ Data delete job succeeded but present on disk blocks with mail_domain_removal_data_delete_reconciliation_pending
  ✔ Verified backup dispatched -> mailbox credentials cleaned -> data-delete job dispatched -> finalizer unlinked metadata
  ✔ Active Roundcube webmail mapping blocks removal plan preview fail-closed

[Phase 9] Verifying External Mail Domain Lifecycle...
  ✔ External mail domain with local dependencies is blocked fail-closed
  ✔ External mail domain skips local disabling/cleanup/backup/data-delete, performing only metadata unlink

================================================================
  🎉 ALL MAIL DOMAIN CHILD LIFECYCLE ACCEPTANCE TESTS PASSED!   
================================================================
```

---

## 3. Sonuç ve Güvenlik Uyumluluğu

- **Hedef Sunucu**: `157.180.11.28` (hostname `test`, Ubuntu 24.04 LTS). Kesinlikle `.44` (Plesk) sunucusuna dokunulmamıştır.
- **İzinler**: v3 child operation store dizini `0700`, dosyası `0600` (root:root) olarak muhafaza edilmiştir.
- **Secret Korunumu**: Parola, hash, DKIM private key veya secret hiçbir log, çıktı, hata veya bellek dökümüne sızdırılmamıştır.
- **Fail-Closed & Idempotency**: Bütün süreç kesintileri, drift durumları, tahrifler ve disk varlık kontrolleri fail-closed ve idempotent olarak doğrulanmıştır.
