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
