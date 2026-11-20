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

## Dış yedekten gelen arşivi yerelde doğrulama

Yetkili operatör, şifreli Restic deposu için mevcut rclone uzak hedeflerinden birini seçer. İlk provada bir uzak hedef ve bir saklama politikası kullanılır. Restic parolası, depo erişimi ve YunPanel ana şifreleme anahtarı için kaynak makineye bağımlı olmayan bir kurtarma yolu sağlanır.

Arşivin SHA-256 değeri, kaynak sunucu kimliği ve YunPanel paket sürümü yedek alınırken ayrı kurtarma kaydında saklanır. Restic ile geri alınan `state.tar` ve `manifest.json`, operatöre ait özel bir geçici dizine yerleştirilir. Arşivin yapısını ve kimliğini kayıtlara uygulamadan kontrol etmek için yerel kaynak ağacında aşağıdaki komut kullanılabilir.

```bash
node scripts/local-migration-backup.mjs preflight "$SNAPSHOT_DIR" \
  --expected-sha256 "$ARCHIVE_SHA256" --expected-server-id "$SOURCE_SERVER_ID"
```

Komut manifest sürümünü, arşivin SHA-256 değerini ve dosya listesinin kayıtlı kaynaklarla sınırlı olduğunu doğrular. Manifestte mevcut olarak işaretlenen her kaynak kökünün arşivde bir kez ve beklenen dosya türünde bulunduğunu kontrol eder. Arşivdeki yerel sunucu bağını kaydedilen kaynak kimliğiyle karşılaştırır. JSON sonuç yalnız kontrol durumunu ve arşivde doğrulanan kaynak sayısını içerir. Paket sürümü boş VM’de kurulumdan önce ayrı kurtarma kaydıyla eşleştirilir.

Bu kontrol panel durum arşivini kapsar. Boş VM kabulünde site dosyaları, gerçek SQL içeriği ve posta yedeği de geri alınır. Paketli `preview` ve özel `stage` adımlarından sonra HTTP, SQL, IMAP ve kullanıcı erişimi doğrulanır. Bu kabul, dış depoya erişim ve ayrı temiz Ubuntu ortamı gerektirir.
