# Migration yedeği ve restore sınırı

Packaged scripts/local-migration-backup.mjs: create --confirm → verify <snapshot> → preview <snapshot> → stage <snapshot> --confirm. Snapshot /var/backups/yunpanel/migration-<timestamp>; directory 0700, archive/manifest 0600. Sabit source allowlist, SHA-256, required source, symlink/member/link-escape/type/mode/owner kontrolleri korunur.

/etc/yunpanel ve /var/lib/yunpanel; passwd/group kimlik referansı; varsa Nginx/Let's Encrypt/systemd. /etc/shadow veya kör Unix identity restore yok. Absent optional kaynak preserve_current; güncel dosya sessizce silinmez.

Metadata plan for future live apply: ACL/xattr, privileged mode, identity drift ve target-type blocker'ları ayrı doğrulanır. preview/stage canlı restore değildir; stage yalnız private .restore-staging altında çalışır. Generic live apply/recovery tamamlanmış kabul edilmez.

Exact verified snapshot create/bind/release için zorunlu --backup-dir'dir. Secret master key ve tüm bağlı stores/version/user/certificate material birlikte korunur. Çalışma komutları ve rollback kapısı [operasyon](operations.md) / [migration](local-runtime-migration.md); gerçek DR kabulü [todo.md](../todo.md)'de açık.

Packaged komut özeti; çalıştırma için operasyon izni gerekir:

```text
local-migration-backup.mjs create --confirm
local-migration-backup.mjs verify /var/backups/yunpanel/migration-<timestamp>
local-migration-backup.mjs preview /var/backups/yunpanel/migration-<timestamp>
local-migration-backup.mjs stage /var/backups/yunpanel/migration-<timestamp> --confirm
```
