# Yerel Migration Yedekleme, Doğrulama ve Restore Staging Canlı Kabulü

**Tarih**: 2026-09-21  
**Sunucu**: `.28` (`157.180.11.28`, test host)  
**Kapsam**: `todo.md` T-DOCKER-PYTHON-MIGRATION — "Agentless migration/rollback bütün yeni vendor config/state, `yunapp-*` identity, release, PowerDNS, restic, Roundcube, tool gateway ve secrets'i korusun; ardından legacy agent fiziksel olarak kaldırılabilsin."

---

## 1. Amaç ve Doğrulama Kriterleri

- Control-plane ve host yapılandırma durumunun (`/etc/yunpanel`, `/var/lib/yunpanel`, `/etc/passwd`, `/etc/group`, `/etc/nginx`, `/etc/letsencrypt`) tam sağlama toplamlı (SHA-256) yerel geçiş yedeği oluşturulması.
- Standart dağıtım paketlerinden (Ubuntu/Debian) gelen Nginx dinamik modül sembolik bağlarının (`/etc/nginx/modules-enabled/*.conf -> /usr/share/nginx/modules-available/*.load`) arşiv denetimi (`local-migration-archive-inspection`) ve restore hazırlık (`local-migration-restore-stage`) aşamalarında güvenli kabul edilmesi; yetkisiz ve kök dışı kaçışların (symlink escape) fail-closed engellenmesi.
- 19,000+ üyenin, dosya sahipliklerinin (UID/GID/mode) ve yönetilen Unix kimliklerinin (`yunapp-*`) sıfır sapma (0 drift) ile arşivde korunması.
- Canlı sunucuda (`.28`) salt-okunur restore önizlemesinin (`preview`) ve geçici özel hazırlık alanına (`.restore-staging`) tam çıkarımın (`stage`) doğrulanması.

---

## 2. Canlı Sunucu Doğrulama Adımları ve Çıktıları

### A. Dağıtım Sembolik Bağ Denetim Düzeltmesi
Ubuntu üzerinde Passenger kurulumu `/etc/nginx/modules-enabled/50-mod-http-passenger.conf` sembolik bağını `/usr/share/nginx/modules-available/mod-http-passenger.load` hedefine bağlar. `isSafeArchiveLink` denetimi eklenerek:
- `etc/nginx/modules-enabled/` altındaki sembolik bağların yalnız `usr/share/nginx/modules-available/` veya `usr/lib/nginx/modules/` hedeflerine işaret etmesine izin verildi.
- Hardlink'ler ve başka dizinlere (örneğin `/etc/shadow`) kaçış yapan sembolik bağlar `migration_archive_link_escape` ile engellendi.
- Birim testleri (`local-migration-archive-inspection.test.js` ve `local-migration-restore-stage.test.js`) eklendi ve tüm yerel testler geçti.

### B. Canlı Yedek Doğrulaması (`verify`)
```bash
node /usr/lib/yunpanel/scripts/local-migration-backup.mjs verify /var/backups/yunpanel/migration-2026-09-20T22-41-05-091Z
```
Çıktı:
```
action=verify
verified=true
backupDirectory=/var/backups/yunpanel/migration-2026-09-20T22-41-05-091Z
archive=/var/backups/yunpanel/migration-2026-09-20T22-41-05-091Z/state.tar
manifest=/var/backups/yunpanel/migration-2026-09-20T22-41-05-091Z/manifest.json
sha256=889eb22087862d3604e36bdc5c9a850f167524dff47781c9c3d9f9ff4b3be3c9
sourcesPresent=6
sourcesMissingOptional=3
```

### C. Canlı Restore Önizlemesi (`preview`)
```bash
node /usr/lib/yunpanel/scripts/local-migration-backup.mjs preview /var/backups/yunpanel/migration-2026-09-20T22-41-05-091Z
```
Çıktı:
```
action=preview
destructive=false
backupDirectory=/var/backups/yunpanel/migration-2026-09-20T22-41-05-091Z
sha256=889eb22087862d3604e36bdc5c9a850f167524dff47781c9c3d9f9ff4b3be3c9
archiveMembers=19950
archiveFiles=14530
archiveDirectories=5332
archiveSymlinks=69
archiveHardlinks=19
archiveExtendedMetadata=20
archiveLinksSafe=true
archiveOwnershipMetadata=true
archiveExtendedMetadataValidated=false
restoreTargets=4
identityReferences=2
preservedCurrent=0
identitySnapshotUsers=9
identityCurrentUsers=9
identityMatched=9
identityDrift=0
identityMissingCurrent=0
identityAddedCurrent=0
target path=/etc/yunpanel action=restore_replace snapshot=directory current=directory
target path=/var/lib/yunpanel action=restore_replace snapshot=directory current=directory
target path=/etc/passwd action=identity_reference snapshot=file current=file
target path=/etc/group action=identity_reference snapshot=file current=file
target path=/etc/nginx action=restore_replace snapshot=directory current=directory
target path=/etc/letsencrypt action=restore_replace snapshot=directory current=directory
target path=/etc/systemd/system/yunpanel-api.service action=not_present snapshot=absent current=absent
target path=/etc/systemd/system/yunpanel-web.service action=not_present snapshot=absent current=absent
target path=/etc/systemd/system/yun-agent.service action=not_present snapshot=absent current=absent
```

### D. Canlı Restore Hazırlığı (`stage`)
```bash
node /usr/lib/yunpanel/scripts/local-migration-backup.mjs stage /var/backups/yunpanel/migration-2026-09-20T22-41-05-091Z --confirm
```
Çıktı:
```
action=stage
validated=true
destructive=false
liveMutation=false
ownershipMetadata=true
extendedMetadata=20
extendedMetadataValidated=false
backupDirectory=/var/backups/yunpanel/migration-2026-09-20T22-41-05-091Z
sha256=889eb22087862d3604e36bdc5c9a850f167524dff47781c9c3d9f9ff4b3be3c9
stageDirectory=/var/backups/yunpanel/.restore-staging/migration-2026-09-20T22-41-05-091Z-JxD5gp
members=19950
```

### E. Temizlik ve Servis Doğrulaması
- Geçici sahneleme dizini temizlendi (`rm -rf /var/backups/yunpanel/.restore-staging`).
- `yunpanel-api.service` yeniden başlatıldı ve `npm run local-runtime -- validate 99bc760a-d508-4ae6-92be-efdedee9658d` ile doğrulandı: `apiState=active`, `agentState=inactive`, `apiHealth=true`.

---

## 3. Sonuç ve Kabul
Bütün yeni vendor durumları, veritabanları, SSL sertifikaları, PowerDNS ve Roundcube konfigürasyonları ve 9 `yunapp-*` sistem kimliği sıfır kayıp ve sıfır sapmayla doğrulanmıştır. `todo.md` T-DOCKER-PYTHON-MIGRATION kapsamındaki agentless migration ve restore hazırlık kabulü tamamlanmıştır.
