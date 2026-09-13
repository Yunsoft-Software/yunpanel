# YunPanel — Kalan Geliştirme Planı

Bu dosya yalnız **kaynakta henüz tamamlanmamış geliştirme işlerini** tutar. Yapılmış işler burada tekrar listelenmez.

Bağlayıcı mimari ve güvenlik kuralları `agents.md` içindedir. Bu ortamda güvenilir biçimde yapılamayan gerçek Node 24, Ubuntu, browser, package, DNS/provider, storage ve rollback kabulleri `todo.md` içinde tutulur. Geliştirme güncel `main` üzerinde küçük, tek amaçlı commitlerle ilerler; GitHub Actions kullanılmaz.

Öncelik, panelin gerçek kullanılabilirlik ve Plesk-benzeri ürün tamamlanma oranını en hızlı yükselten işleri bitirmektir. Plesk importer en son geliştirme işi olarak tutulur.

Genel backup preview; Application, Database, Mail Data ve Managed Compose storage kaynaklarını canlı registry/inventory state'inden deterministic plana bağlar. Website/Domain dependency revision kanıtı preview digestine dahildir. Database ve Mail kendi mevcut private backup/restore motorlarını kullanır; bunlar için ikinci dump motoru yazılmaz.

Aggregate execution için versioned execution plan doğrulaması, durable parent operation/step state'i, DB/Mail child dispatcher, Application/Docker local executorları, private local resource artifact manager, Docker managed-volume inspector ve persisted parent state'ten türetilen Compose backup lock kaynakta bulunmaktadır. Managed Compose project-relative bind'ler kalıcı private project workspace'e taşınmıştır; secret compose/config staging geçici kalır. Bu parçalar henüz tek production execution lifecycle'ı olarak tamamen wire edilmediği için aşağıdaki backup işleri en yüksek önceliktir.

## 1. Genel backup / restore ürünü

- [ ] Execution orchestrator'ını yeni **intent-before-verify** sözleşmesine geçir: step dispatch intent'i önce durable parent state'e yazılsın; ardından source snapshot/consistency doğrulansın ve child/local executor çalışsın. Verification/execution hatası parent step'i terminal failed yapıp bütün resource lock'larını bırakmalı. DB/Mail child replay aynı deterministic idempotency key ile mevcut işi reconcile etmeli; kör retry yapmamalı.
- [ ] Orchestrator, child dispatcher ve Application/Docker executor source testlerini yeni intent akışına hizala; crash pencerelerini özellikle `intent persisted -> enqueue/archive öncesi`, `child succeeded -> parent evidence öncesi` ve `parent terminal write` sınırlarında kilitle.
- [ ] Durable backup operation registry, child dispatcher, Application/Docker local executor, Docker volume inspector ve `projectBackupLocked()` provider'ını production bootstrap/runtime'a bağla. Compose lifecycle service gerçek parent backup lock callback'ini kullanmalı.
- [ ] Owner-only execution/history API ekle: fresh preview digest + typed confirmation ile aggregate backup başlatma, operation detail/list/progress ve güvenli resource evidence görünümü. Public state artifact filesystem path'i, env value, credential, mail body veya provider raw output taşımamalı.
- [ ] External/custom Docker named-volume sınıflandırmasını bütün zincirde tamamla: inventory'de görünür kalsın fakat yalnız Compose-managed default local volume `include` olsun; external/custom-name/custom-driver/driver-opts kaynakları fail-closed `reject` policy alsın.
- [ ] Çalışan Managed Compose storage için deterministic consistency lifecycle ekle. Tercih edilen model durable quiesce/stop → backup → önceki runtime state'e dönüş olmalı; ara kesintide project kilidi ve önceki runtime state recovery evidence ile çözülsün. Bu tamamlanana kadar running workload backup'ı açıkça blocker olarak kalmalı, sessiz live tar yapılmamalı.
- [ ] Local target için versioned **aggregate** manifest/finalization katmanı ekle: child/local artifact evidence, per-resource checksum, aggregate checksum, operation/preview/execution digestleri, private permissions, atomic commit ve retention lifecycle aynı backup kimliğine bağlansın.
- [ ] Disk-full/read-only, bozuk receipt/archive/checksum, eksik child artifact, process interruption ve partial aggregate finalization için mutation-safe recovery/fail-closed modeli ekle.
- [ ] S3-compatible target ekle: encrypted credential registry, target preview/test, upload verification, aggregate manifest/object identity, retry/idempotency, retention ve local staging cleanup.
- [ ] Genel restore preview/selection katmanını mevcut Database/Mail restore preview'ları ve yeni Application/Docker restore contractlarıyla bağla; veri kaybı etkisi, pre-restore backup, exact manifest/resource/dependency revision gate ve typed confirmation ekle.
- [ ] Application restore executor'ına release/config/env restore + health gate + deterministic rollback; Docker restore executor'ına project-bind/named-volume restore + runtime health gate + deterministic rollback ekle. Database/Mail'in mevcut restore/recovery zincirini yeniden yazma.
- [ ] Aggregate restore crash/lost-ack recovery ekle; kısmi restore'da hangi resource mutationının gerçekleştiği durable evidence olmadan yeniden mutation yapma.
- [ ] Backup operation association'larını Website/Application/Database/Docker/Mail impact provider'ına bağla; active backup/restore işleri move/delete impact içinde gerçek blocker olarak görünsün.
- [ ] Backend tamamlanınca gerçek Backup panelini bağla: preview/resource selection, target, retention, progress/history, artifact/evidence özeti ve restore akışı.

Gerçek Docker Engine/Compose volume/bind, Application filesystem/env, Database/Mail aggregate orchestration, local/S3 target, disk-full/corrupt archive, restart/lost-ack ve restore/rollback kabulleri `todo.md` içindedir.

## 2. Website / Domain / Nginx kalanları

- [ ] Canlı state'teki Website'e bağlı olmayan external-proxy Domain kayıtlarını explicit create/bind migrationıyla eşleştir; otomatik tahmin yapma.
- [ ] Backup operation association provider'ı ve ileride cron association registry geldikçe Website/Domain move-delete impact preview'a gerçek dependency provider olarak bağla; bulunmayan provider için blocker `unavailable` kalmalı.

Gerçek DNS/Nginx/HTTPS, IDN, certificate ve provider acceptance işleri `todo.md` içindedir.

## 3. Cron

- [ ] Website/Application'a bağlı site-user cron registry ve CRUD ekle.
- [ ] Schedule, timezone, cwd, bounded env, enable/disable, last/next run ve bounded/redacted output ekle.
- [ ] Cron command'ını shell-string birleştirmeden doğrulanmış execution contract'ına bağla.
- [ ] System cron'u yalnız explicit Owner/Sunucu bağlamında ayrı kaynak türü olarak uygula.
- [ ] Cron association'larını Website/Application impact preview ve backup manifestine bağla.
- [ ] Cron backend'i hazır olur olmaz Website içindeki Scheduled Tasks UI yüzeyine bağla.

## 4. Metrik ve bildirimler

- [ ] CPU/RAM/load/disk/inode/service/Application/Docker metric history ve retention ekle.
- [ ] Disk/inode threshold, service/app/container, deploy, backup ve SSL event modelini ekle.
- [ ] Panel içi bildirim merkezi ve seçilecek dış kanallar için secret-safe delivery/retry ekle.

## 5. Agentless migration ve legacy agent temizliği

- [ ] Migration live-apply katmanına per-target replace, UID/GID drift çözümü, owner/mode/ACL/xattr policy, pre-apply backup, health gate ve deterministic rollback ekle.
- [ ] İzole migration/rollback kabul kapısı tamamlandıktan sonra retained heartbeat/command/environment/result transportunu, enrollment credential yüzeyini, agent storage kodunu, `yun-agent.service` ve package compatibility parçalarını fiziksel olarak kaldır.
- [ ] Yeni Git hook, cron, build ve runtime yüzeylerinde `yunapp-*` workload isolation invariantını koru; yalnız Owner Sunucu terminali root kalmalı.

## 6. Enterprise UI/UX son polish

- [ ] Enterprise layout/styling, navigation hierarchy, data-table/form polish, responsive ve accessibility aşamasını tamamla.
- [ ] Domain/subdomain/Website hiyerarşisini Plesk benzeri yönetim akışında son haline getir.
- [ ] Gerçek Chromium/Firefox headed browser, mobil viewport, klavye ve ekran okuyucu kabulünü `todo.md` kapılarıyla tamamla.

## 7. Plesk read-only importer — en son

- [ ] Plesk state'ini değiştirmeyen bounded ve secret-safe discovery/import preview ekle.
- [ ] Passenger/static/Node, Domain, database, Docker, cron ve mail kaynaklarını external-managed olarak modelle.
- [ ] Kaynak başına conflict, dependency, explicit confirmation, migration job ve deterministic rollback ekle.
- [ ] `.44` ile biten Plesk sunucusuna hiçbir geliştirme/test/deploy işleminde bağlanma; yalnız offline fixture veya açıkça onaylı `.44` olmayan test hostu kullan.

## Uygulama sırası

1. Backup intent-before-verify orchestration + production wiring.
2. Aggregate local target/finalization + Docker consistency lifecycle.
3. Backup execution/history API + panel; ardından S3-compatible target + retention.
4. Aggregate restore orchestration/executor/recovery + UI.
5. Cron + UI.
6. Metrik ve bildirim katmanı.
7. Kalan Website/Domain migration işi ve association provider bağları ilgili kaynaklar hazır oldukça kapatılır.
8. İzole migration/rollback kabulünden sonra legacy agent kod/paket yüzeyinin fiziksel temizliği.
9. Enterprise UI/UX polish ve gerçek browser kabulü.
10. Plesk read-only importer — **son iş**.

Her geliştirme diliminde ilgili source testleri aynı değişiklikle eklenir. Güncel Node 24/full workspace ve gerçek-host kabulleri çalıştırılmadıysa geçmiş source testlerinin varlığı "geçti" diye raporlanmaz. Bu ortamda yapılamayan gerçek-host/browser/provider/package/storage kabul işleri kod planına geri sokulmaz; `todo.md` içinde tutulur.
