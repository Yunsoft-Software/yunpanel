# Website Removal — güvenli Owner önizlemesi ve kalan blockerlar

2026-09-25 · development · `b783ca7c` → `befbe56f`.

## Kaynak durumu

- [x] `b783ca7c`: removal runtime production composition incelendi. Kalıcı operation/step journal, preview digest, exact continuation confirmation ve interrupted-step fail-closed davranışı zaten vardı.
- [x] `d80c3357`: panel `data` zarfları eklendi. Ayrıca Application'a bağlı Website removal için `applicationRegistry.deleteApplication` zorunlu lifecycle dependency yapıldı. Böylece Application metadata cleanup uygulanmadan confirmation verilmez.
- [x] `befbe56f`: Owner Barındırma ayarlarında **Siteyi sil** güvenlik önizlemesi. Domain/DB/SFTP/cron/yedek etkisi, hard blockerlar ve önceki journal durumu okunur. İstemci GET-only'dir; destructive POST veya continue yolu yoktur.

## Neden gerçek Sil hâlâ kapalı?

Production removal composition'da doğrulanabilir `fileCleanupHandler` ve `unixIdentityCleanupHandler` henüz bağlı değil. Unix kimliği için host-runtime receipt tabanlı `website-identity-manager` reuse edilebilir; legacy/unowned kimlik silinmemelidir. Daha önemlisi Application Registry'de güvenli Application metadata/env/release silme lifecycle'ı yoktur. Canonical app/data dizinlerini silip Application kaydını bırakmak kırık control-plane state üretir.

Bu nedenle backend `application_cleanup_unavailable`, `file_cleanup_unavailable` ve gerektiğinde `unix_cleanup_unavailable` blockerlarıyla `readyToStart=false` kalır. UI bu durumu gösterir ama silme eylemi sunmaz.

## Sıradaki kaynak işi

- [ ] Application deletion lifecycle: Application kaydı, environment/secrets, release metadata/runtime-specific state ve varsa retain policy birlikte preview/journal/cleanup ile ele alınmalı. Basit `deleteApplication()` eklemek yeterli kanıt sayılmaz.
- [ ] File cleanup adapter: yalnız canonical Website/Application path contract kökleri; foreign/symlink/shared state reddi; retained backup kapsamı korunmalı; exact receipt dönmeli.
- [ ] Unix identity cleanup adapter: provisioning journal'daki operation-owned `unix_identity` intent/evidence üzerinden compensation; receipt yoksa legacy identity korunmalı/fail-closed.
- [ ] Bunlar tamamlandıktan sonra Owner typed confirmation + aynı removal operation explicit step continue + unknown-result GET reconciliation açılabilir.

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