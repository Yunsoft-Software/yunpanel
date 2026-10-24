# Agentless migration ve rollback özeti

Packaged Node /usr/local/bin/node ve root CLI; bağımsız console/SSH recovery korunur. Production control-plane stores /var/lib/yunpanel/control-plane altında absolute/private; API env /etc/yunpanel/control-plane/api.env. Website/Application/Domain/Server kimliği değiştirilmez, aynı master key korunur.

Sıra: exact status → aktif işler drain → iki consumer stop → durable recovery clear → migration backup create/verify → nondestructive preview/private stage → exact ownership create/bind/release --backup-dir <snapshot> --confirm → yalnız local API start → local-runtime.mjs validate <server-uuid> → fiziksel hizmet/rol kontrolleri. Create yeni host, bind korunan mevcut identity; release yalnız açık rollback tasarımıyla.

validate exact ID/hostname/local binding, API active, yun-agent inactive, zero active/recovery jobs, fresh matching snapshot, runtime/package version ve bounded loopback health ister. Eski enrolled agent rollback hattı yeni normal kurulum değildir.

Recovery operation-specific host evidence/private receipt; generic force-success yok. Custom certificates sibling custom-certificates/<uuid>, auth.sqlite/sidecars, environment/DNS/DB/mailbox encrypted stores ve master key snapshotta birlikte korunur. Host/API startup eşliği backup crash recovery'nin bağlandığını kanıtlamaz.

YunPanel dururken hosted workload devam etmeli. Passenger health-gated cutover ve direct-systemd fallback gerçek replacement/rollback kabulünden önce kaldırılmaz. Yeni canlı migration/restore/rollback bu tur yürütülmedi. [Operasyon](operations.md), [backup](local-migration-backup.md), [kabul](../todo.md).

Ownership mutation engeli: a `queued` or `running` job exists; unresolved recovery de aynı şekilde engeldir. Örnek private store yolları ve explicit komutlar; onay olmadan çalıştırılmaz:

```text
YUNPANEL_SERVER_STORE=/var/lib/yunpanel/control-plane/server-registry.json
YUNPANEL_JOB_STORE=/var/lib/yunpanel/control-plane/job-registry.json
systemctl stop yunpanel-api.service yun-agent.service
local-migration-backup.mjs create --confirm
local-migration-backup.mjs verify /var/backups/yunpanel/migration-<timestamp>
local-runtime.mjs bind <server-uuid> --backup-dir /var/backups/yunpanel/migration-<timestamp> --confirm
local-runtime.mjs release <server-uuid> --backup-dir /var/backups/yunpanel/migration-<rollback-timestamp> --confirm
```
