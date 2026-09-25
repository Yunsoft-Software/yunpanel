# Website Removal — güvenli Owner önizlemesi ve kalan blockerlar

2026-09-25 · development · `b783ca7c` → `2455cc38`.

## Kaynak durumu

- [x] `b783ca7c`: removal runtime production composition incelendi. Kalıcı operation/step journal, preview digest, exact continuation confirmation ve interrupted-step fail-closed davranışı zaten vardı.
- [x] `d80c3357`: panel `data` zarfları eklendi. Ayrıca Application'a bağlı Website removal için `applicationRegistry.deleteApplication` zorunlu lifecycle dependency yapıldı. Böylece Application metadata cleanup uygulanmadan confirmation verilmez.
- [x] `befbe56f`: Owner Barındırma ayarlarında **Siteyi sil** güvenlik önizlemesi. Domain/DB/SFTP/cron/yedek etkisi, hard blockerlar ve önceki journal durumu okunur. İstemci GET-only'dir; destructive POST veya continue yolu yoktur.

## Güncel destructive kaynak durumu

Production composition Application cleanup, canonical file cleanup, provisioning receipt-owned Unix identity cleanup ve durable cron.remove job köprüsünü bağlıyor. Passenger/Static runtime cleanup gerçek binding ownership kanıtıyla çalışıyor. direct-systemd için live Application runtime evidence + deployment receipt + deterministic systemd unit/env/current-release ownership preflight'ı ve verified host removal lifecycle'ı eklendi; runtime-binding kaydı olmasa bile runtime cleanup adımı atlanmıyor. Owner typed confirmation, explicit journal-step continuation ve metadata silindikten sonra global recovery akışı da kaynakta mevcut.

Silme yine fail-closed kalır: receipt'siz legacy direct-systemd, legacy/unowned Unix identity, unsafe/symlink/foreign path, cron inventory/job mismatch veya eksik adapter/dependency confirmation üretmez. Source hazır olması host/browser kabulünün geçtiği anlamına gelmez.

## Tamamlanan kaynak işi

- [x] Application deletion lifecycle: environment/internal secret state purge + exact Application revision delete, Website metadata sonrasında ayrı journal adımı.
- [x] File cleanup adapter: yalnız canonical direct-child Website/Application path contract kökleri; foreign/shared/symlink state fail-closed; backup ve log scope retention doğrulanır.
- [x] Unix identity cleanup adapter: provisioning journal'daki operation-owned `unix_identity` evidence üzerinden compensation; receipt yoksa legacy identity korunur.
- [x] Owner destructive akışı: domain adıyla typed confirmation, aynı operation üzerinde explicit step continue, unknown-result durumda POST replay yerine global journal GET reconciliation.
- [x] Cron cleanup: planned task identity journal checkpoint'e yazılır; deterministic idempotent `cron.remove` job queued/running iken parent adım başarı sayılmaz, succeeded + metadata absence sonrası tamamlanır.
- [x] direct-systemd cleanup: Application runtime evidence preview digest'e pinlenir; deployment receipt + deterministic unit/env/current-release doğrulanır, stop/disable/remove/daemon-reload sonrası yokluk tekrar okunur; varsa owned binding exact revision ile kaldırılır.

## T-DEV-WEBSITE-REMOVE

- [ ] Node24/npm11 tam checkout: mevcut website-removal plan/runtime/cleanup/http testleri + yeni panel-contract/model/wiring testleri; tam npm ci/check/build.
- [ ] Owner/Site A/Site B: preview Owner-only UI; site_manager destructive removal UI görmemeli. API tenant boundary ayrıca doğrulanmalı.
- [ ] Real host: domain child removal, cron/SFTP/database/Passenger/Static/direct-systemd runtime cleanup, canonical file cleanup, receipt-owned Unix identity cleanup, Application cleanup ve final Website metadata yokluğu. Receipt'siz legacy direct-systemd blocker davranışı da doğrulansın.
- [ ] Interrupted/blocked/failed step restartı; explicit continue dışında host mutation replay olmamalı.
- [ ] `.44` Plesk hostuna dokunma.

## 2026-09-25 devam — destructive lifecycle kaynakta bağlandı

- `b45a8830` / `82b268c4` / `18a18c8b`: Application cleanup ayrı journal adımıdır. Website metadata önce kaldırılır; ardından environment/internal secret state purge edilir ve Application kendi `desiredRevision` kanıtıyla silinir. Website revision Application revision yerine kullanılmaz.
- `effb126f` / `c5d43ba8` / `5f14abda`: Unix identity yalnız provisioning journal'daki exact `unix_identity` operation/evidence ile compensate edilir. Legacy/unowned user'a dokunulmaz. File cleanup yalnız path-contract'taki `/var/lib/yunpanel/apps/<id>`, `/var/lib/yunpanel/data/<id>`, `/var/lib/yunpanel/build/<id>`, `/var/www/yunpanel/apps/<id>` direct-child köklerini işler; symlink/non-directory root reddedilir. Backup artifact root silinmez.
- `aadc3319`: Passenger/Static runtime binding cleanup binding'in gerçek `sourceOperationId` + revision'ını kullanır. `53afe904` → `2455cc38`: direct-systemd Application state removal planına pinlenir; deployment receipt + deterministic service/unit/env/current-release doğrulanmadan host mutation başlamaz; verified cleanup sonrası varsa direct-systemd binding de ownership+revision ile kaldırılır. Log scope silinmez; receipt'te retained scope olarak doğrulanır.
- `9acd8ed5` / `02f53b36`: removal HTTP tamamen Owner-only. Domain/Website metadata silindikten sonra bile journal `GET /api/website-removal-operations` ve global operation/continue uçlarından erişilebilir.
- `a1cfbd77` / `94b3eac4`: Siteyi sil UI domain adını yazarak confirmation alır. Start bir journal oluşturur/ilk adımı ilerletir; her sonraki mutation için kullanıcı ayrı devam eder. `/websites` Owner ekranında yarım removal kurtarma paneli vardır. Network/5xx sonrası aynı POST tekrar edilmez; global journal GET ile reconcile edilir.

### Hâlâ açık

- Receipt'siz legacy direct-systemd Application otomatik temizlenmez; mevcut host state absent değilse veya deployment evidence eşleşmiyorsa fail-closed blocker kalır.
- Legacy site için owned Unix provisioning receipt yoksa `unix_cleanup_evidence_unavailable`; otomatik `userdel` yapılmaz.
- `2fa0a7bf` → `bbf4774f`: process-shared ortak site mutation lock artık site-create metadata, Website provisioning/retry/compensation, Website removal, PHP queue/worker ve cron worker yollarında aynı Application/Website identity ile kullanılır. Gerçek iki süreç/crash/permission kabulü çalıştırılmadı.
- `71f738bb` → `8267d036`: reseller/customer quota release yalnız verified Website/Application absence sonrası final removal journal adımında çalışır; release failure operation'ı removed yapmaz ve explicit continue ile tekrar edilir.
- `d67410f4` → `2bb7960e`, `f8db6dd5`, `c7c732a1`, `12de5caa`, `f4778c4f`: job/recovery/removal/provisioning durable JSON store'ları process-shared lock + reload modeline taşındı; cross-instance kaynak testleri var.
- `d97c4a51` → `4c4d5b62`: Website removal private Owner actor journal + her destructive continuation için live Owner/MFA reauthorization kaynakta bağlıdır; aynı Owner session rotation private evidence'ı günceller, farklı Owner takeover/revoke fail-closed.
- `d954417d` / `9a2cc2c6`: removal child cron `system_removal` artık kör bypass değildir; active removal journal + planned cron + live Owner authorization doğrulanmadan worker host remove yapmaz.
- `012e68bf` → `2eccf992`: hosted create reserve→attach lock boşluğu kapandı; hiç Website/planned Domain/Mail/operation-owned Application oluşmamış reserved hold explicit recovery ile incelenir. Attached/partial kaynak veya unsafe provisioning work varken kapasite bırakılmaz.
- `d78d62a0` / `101e9f4c` / `4702968e` / `9cdf1696`: provisioning continue/retry/compensate HTTP artık runtime site-lock + live Owner/site_manager Website authorization wrapper'ını bypass etmez.
- `e458c845` → `9c48eb7f`: pending ya da tamamen compensate edilmiş provisioning journal verified uncreated recovery sırasında durable `abandoned` terminal state'e alınır; abandoned journal yeniden apply/retry/compensate edilemez ve terminalization doğrulanmadan quota release yapılmaz. `d2cf8c2f`, `fcf3b466`, `a61c9b0c` kaynak regresyonları bu sınırı kapsar.
- `2f785673` → `57aa1f62` ve queue bağları `39df6327` → `c713c85d`: provisioning child host job'ları payload/idempotency'yi bozmayan private Website/operation/step scope taşır; local worker host adapter öncesi provisioning journal + local Website + exact live actor session/grant recheck yapar. `032b4830` / `ea12c16d` yalnız mutation başlamadan reddedilmiş auth-preflight job'larını güvenle requeue eder. Authorization'sız legacy queued job upgrade/recovery politikası ile gerçek iki OS process/lock crash-permission, write-failure/cold-restart ve Node24/npm11/host/browser kabulü hâlâ açıktır.
- Bu source değişikliklerin testleri bu oturumda gerçek checkout üzerinde çalıştırılmadı. Node24/npm11 tam suite ve izinli host/browser kabulü zorunludur.