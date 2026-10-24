# YunPanel — Operasyon ve kurtarma özeti

Bu belge çalışma talimatıdır; komutların yazılması çalıştırıldıkları veya dağıtımın onaylandığı anlamına gelmez. Mutating host işinden önce izin, doğru hedef, güncel sürüm, doğrulanmış backup ve rollback gerekir. [Güvenlik](security.md) ve [kabul](../todo.md).

## Host ve sürüm

Production API ve web systemd ile tek yerel hostta. Tipik state /var/lib/yunpanel/control-plane, private env /etc/yunpanel/control-plane, paket /usr/lib/yunpanel. Code Factory release aktif symlink ile çalışabilir; dpkg sürümü tek başına çalışan source SHA değildir. WorkingDirectory, gerçek symlink, release manifest, API/web kaynak ve served asset ayrı karşılaştırılır. .28 kontrolünde /usr/lib/yunpanel-codefactory-current kullanıldı; bu yol değişebilir.

Read-only tanılama: systemctl show/is-active, release manifest'in yalnız kimlik alanları, kaynak SHA-256, loopback health, nginx -t ve protected state'in yalnız gerekli public metadata projeksiyonu. Env/key/cookie/password bütünlüğünü genel çıktı üretmeden incele. .44 yasak.

## İlk Owner ve kurtarma

İlk setup yerel yönetici tarafından tek kullanımlık/süreli tokenla; default parola/public kayıt yok. Auth CLI ile API aynı YUNPANEL_AUTH_DB kullanır. Private auth dizini 0700, DB/sidecar 0600; root owner ve symlink kontrolü. Password minimum 12 karakter; password değişimi bütün ilgili oturumları sonlandırır. Password reset MFA enrollment'ını kendiliğinden kaldırmaz.

Yerel geliştirme: npm run dev; API workspace ile aynı env üzerinde npm run auth -- setup-token. Packaged CLI: /usr/local/bin/node /usr/lib/yunpanel/scripts/auth.mjs setup-token veya reset-password <username>. Parola gizli stdin/terminalden; argüman veya logdan verilmez. MFA recovery gerektiğinde ayrı açık reset-mfa işlemi ve kayıtlı politika kullanılır.

## Migration yedeği

Önce aktif işleri drain et; bağımsız console/SSH recovery erişimini koru. Backup script sabit allowlist'i kullanır: /etc/yunpanel, /var/lib/yunpanel, /etc/passwd ve /etc/group; varsa Nginx/Let's Encrypt/systemd. /etc/shadow alınmaz; passwd/group kimlik referansıdır, kör restore hedefi değildir.

- Oluştur: /usr/local/bin/node /usr/lib/yunpanel/scripts/local-migration-backup.mjs create --confirm.
- Doğrula: aynı script verify /var/backups/yunpanel/migration-<timestamp>.
- Önizle: aynı script preview /var/backups/yunpanel/migration-<timestamp>.
- Private stage: aynı script stage /var/backups/yunpanel/migration-<timestamp> --confirm; canlı uygulama değildir.

Snapshot directory 0700, state.tar/manifest 0600; SHA-256/source allowlist/member graph/link escape/mode/ownership doğrulanır. Required missing source, symlink veya unsafe archive blocker'dır. ACL/xattr genişletilmiş metadata kabulü ayrıca gerekir. Preserve-current kaynaklar kayıp diye silinmez. Backup doğrulaması gerçek restore/DR kabulü değildir.

## İş kurtarma

Packaged job-recovery.mjs status ile exact job/operation ve host evidence incelenir. reconcile/recover-* komutu yalnız desteklediği operation ve aynı server/job kimliğiyle, gerekli açık onaydan sonra çalışır. Generic force-success yok. Job kayıtları/attempt budget/evidence silinmez. Unknown/lost-ack önce inspect; kör replay yok. Background backup recovery'nin startup'a bağlı olduğu varsayılmaz; 9 Ekim audit'inde açık bulundu.

Local identity kontrolü: local-runtime.mjs validate <server-uuid>. Create/migration öncesi doğrulanmış backup zorunlu; create --backup-dir /var/backups/yunpanel/migration-<timestamp> --confirm. Legacy ownership veya host ID canlı kayıtta tahmin edilmez. Passenger cutover health-gated; direct-systemd rollback kabul edilmeden kaldırılmaz.

## Secret anahtarı ve servisler

Master-key rotation offline yapılır: API durur; eski key ayrı protected secret store'da tutulur; rotate-secret-master-key.mjs ile tüm encrypted stores preflight/rewrap, manifest ve rollback snapshot. Yalnız env key değiştirmek mevcut secrets'ı okunamaz yapar. Recovery sonrası decrypt/login/TOTP/env/DNS/mail ve bağlı tüm secret yüzeyleri doğrulanır; gerçek sürüm CLI help'i izlenir. Key değerini argüman/log/chat'e yazma.

Deploy/package/update: candidate kaynak+build doğrulama, exact .28 hedef, backup/checksum, guarded install, dpkg/Nginx/systemd/HTTP/API/web eşleşmesi, gerçek rol görevleri ve rollback. Test edilmemiş migration veya eski deploy bugünkü kabul değildir. Panel durduğunda hosted Nginx/runtime/mail çalışmayı sürdürmelidir.
