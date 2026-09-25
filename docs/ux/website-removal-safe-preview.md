# Website Removal — güvenli Owner önizlemesi ve kalan blockerlar

2026-09-25 · development · `b783ca7c` → `befbe56f`.

## Kaynak durumu

- [x] `b783ca7c`: removal runtime production composition incelendi. Kalıcı operation/step journal, preview digest, exact continuation confirmation ve interrupted-step fail-closed davranışı zaten vardı.
- [x] `d80c3357`: panel `data` zarfları eklendi. Ayrıca Application'a bağlı Website removal için `applicationRegistry.deleteApplication` zorunlu lifecycle dependency yapıldı. Böylece Application metadata cleanup uygulanmadan confirmation verilmez.
- [x] `befbe56f`: Owner Barındırma ayarlarında **Siteyi sil** güvenlik önizlemesi. Domain/DB/SFTP/cron/yedek etkisi, hard blockerlar ve önceki journal durumu okunur. İstemci GET-only'dir; destructive POST veya continue yolu yoktur.

## Güncel destructive kaynak durumu

Production composition artık Application cleanup, canonical file cleanup ve provisioning receipt-owned Unix identity cleanup adapterlarını bağlıyor. Passenger/Static runtime cleanup gerçek binding ownership kanıtıyla çalışıyor; Owner typed confirmation, explicit journal-step continuation ve metadata silindikten sonra global recovery akışı da kaynakta mevcut.

Silme yine fail-closed kalır: `direct-systemd` binding için doğrulanmış service/process cleanup lifecycle'ı bulunmadığında `runtime_cleanup_adapter_unsupported`; legacy/unowned Unix identity için sahiplik receipt'i yoksa `unix_cleanup_evidence_unavailable`; unsafe/symlink/foreign path preflight'ında cleanup blocker üretilir.

## Tamamlanan kaynak işi

- [x] Application deletion lifecycle: environment/internal secret state purge + exact Application revision delete, Website metadata sonrasında ayrı journal adımı.
- [x] File cleanup adapter: yalnız canonical direct-child Website/Application path contract kökleri; foreign/shared/symlink state fail-closed; backup ve log scope retention doğrulanır.
- [x] Unix identity cleanup adapter: provisioning journal'daki operation-owned `unix_identity` evidence üzerinden compensation; receipt yoksa legacy identity korunur.
- [x] Owner destructive akışı: domain adıyla typed confirmation, aynı operation üzerinde explicit step continue, unknown-result durumda POST replay yerine global journal GET reconciliation.

## T-DEV-WEBSITE-REMOVE

- [ ] Node24/npm11 tam checkout: mevcut website-removal plan/runtime/cleanup/http testleri + yeni panel-contract/model/wiring testleri; tam npm ci/check/build.
- [ ] Owner/Site A/Site B: preview Owner-only UI; site_manager destructive removal UI görmemeli. API tenant boundary ayrıca doğrulanmalı.
- [ ] Real host: domain child removal, cron/SFTP/database/runtime cleanup, canonical file cleanup, receipt-owned Unix identity cleanup, Application cleanup ve final Website metadata yokluğu.
- [ ] Interrupted/blocked/failed step restartı; explicit continue dışında host mutation replay olmamalı.
- [ ] `.44` Plesk hostuna dokunma.

## 2026-09-25 devam — destructive lifecycle kaynakta bağlandı

- `b45a8830` / `82b268c4` / `18a18c8b`: Application cleanup ayrı journal adımıdır. Website metadata önce kaldırılır; ardından environment/internal secret state purge edilir ve Application kendi `desiredRevision` kanıtıyla silinir. Website revision Application revision yerine kullanılmaz.
- `effb126f` / `c5d43ba8` / `5f14abda`: Unix identity yalnız provisioning journal'daki exact `unix_identity` operation/evidence ile compensate edilir. Legacy/unowned user'a dokunulmaz. File cleanup yalnız path-contract'taki `/var/lib/yunpanel/apps/<id>`, `/var/lib/yunpanel/data/<id>`, `/var/lib/yunpanel/build/<id>`, `/var/www/yunpanel/apps/<id>` direct-child köklerini işler; symlink/non-directory root reddedilir. Backup artifact root silinmez.
- `aadc3319`: runtime binding cleanup artık binding adapterına göre Passenger/Static çağırır ve binding'in gerçek `sourceOperationId` + revision'ını kullanır. direct-systemd için doğrulanmış service cleanup yoktur ve preview blocker üretir. Log scope silinmez; receipt'te retained scope olarak doğrulanır.
- `9acd8ed5` / `02f53b36`: removal HTTP tamamen Owner-only. Domain/Website metadata silindikten sonra bile journal `GET /api/website-removal-operations` ve global operation/continue uçlarından erişilebilir.
- `a1cfbd77` / `94b3eac4`: Siteyi sil UI domain adını yazarak confirmation alır. Start bir journal oluşturur/ilk adımı ilerletir; her sonraki mutation için kullanıcı ayrı devam eder. `/websites` Owner ekranında yarım removal kurtarma paneli vardır. Network/5xx sonrası aynı POST tekrar edilmez; global journal GET ile reconcile edilir.

### Hâlâ açık

- direct-systemd Application'lar `runtime_cleanup_adapter_unsupported` ile bilinçli bloklanır; systemd service/process cleanup lifecycle eklenmeden destructive removal açılmaz.
- Legacy site için owned Unix provisioning receipt yoksa `unix_cleanup_evidence_unavailable`; otomatik `userdel` yapılmaz.
- Bu source değişikliklerin testleri bu oturumda gerçek checkout üzerinde çalıştırılmadı. Node24/npm11 tam suite ve izinli host/browser kabulü zorunludur.