# YunPanel — Kalan Geliştirme Planı

Bu dosya yalnız **kaynakta henüz tamamlanmamış geliştirme işlerini** tutar. Yapılmış işler burada tekrar listelenmez.

Bağlayıcı mimari ve güvenlik kuralları `agents.md` içindedir. Bu ortamda güvenilir biçimde yapılamayan gerçek Ubuntu, browser, package, DNS/provider, servis ve rollback kabulleri `todo.md` içinde tutulur. Geliştirme güncel `main` üzerinde küçük, tek amaçlı commitlerle ilerler; GitHub Actions kullanılmaz.

Öncelik, panelin gerçek kullanılabilirlik ve Plesk-benzeri ürün tamamlanma oranını en hızlı yükselten işleri bitirmektir. Plesk importer en son geliştirme işi olarak tutulur.

Managed Docker/Compose ve Mail gerçek panel rotalarına bağlıdır. Website detayında Domain/SSL, Application/runtime/env/log/file/terminal ile explicit database/mail/Managed Compose ilişkileri tek site kaynak hiyerarşisinde görünür. Job list/detail kaynak linki, yaşam döngüsü stage/progress, allowlist'li sonuç metadata, güvenli diagnosis/error code ve bounded/redacted deploy log görünümüne sahiptir; generic retry/force-success yolu yoktur.

Genel backup preview artık canlı state'ten üretilir. Managed Compose storage için stable versioned resource kimliği ve fail-closed policy hazırdır: named volume/proje bind `include`, ephemeral `exclude`, arbitrary host bind `reject`. Application release/config/env safe snapshot resource modeli, son doğrulanmış database inventory resource modeli ve mevcut guarded Mail Data backup preview'ından türetilen domain-level mail resource modeli aynı deterministic planda birleşir. Preview authenticated Owner management rotasında expose edilir; explicit seçim, policy ve exact source snapshot state preview digestine bağlanır. Database inventory hiç doğrulanmamışsa genel backup preview sessizce database'i atlamaz, yeni inspect ister.

Database ve Mail için ayrı bir genel-backup dump motoru yazılmayacaktır: database private dump/restore lifecycle ile mail data backup/restore lifecycle kaynakta zaten durable job, checksum/evidence, preview/recovery ve local execution sınırlarına sahiptir. Genel backup ürünü bunları orkestre eder; mevcut operation-specific recovery'yi bypass etmez.

## 1. Genel backup / restore ürünü

- [ ] Backup planına Website/Application/Database/Docker/Mail dependency/impact metadata'sını ekle; resource list/state değişiminde eski digest fail-closed kalmalı.
- [ ] Genel backup execution orchestrator'ını ekle: Database ve Mail için mevcut güvenli backup motorlarını reuse et; Application release/config/env ve Managed Docker named-volume/project-bind için eksik executor'ları ekle. Ephemeral storage'ı atla, arbitrary host bind'i varsayılan reddet.
- [ ] Local target için versioned aggregate backup manifest/artifact layout, per-resource checksum, aggregate checksum, private permissions ve retention lifecycle ekle.
- [ ] S3-compatible target, encrypted credential lifecycle, transfer verification ve local staging cleanup ekle.
- [ ] Aggregate backup job progress/history ve crash/lost-ack recovery ekle; child resource işi successful olmuşsa kör retry yapma, exact durable evidence ile reconcile et.
- [ ] Genel restore preview/selection katmanını mevcut Database/Mail restore preview'ları ve yeni Application/Docker restore contractlarıyla bağla; veri kaybı etkisi, pre-restore backup, exact manifest/resource revision gate ve typed confirmation ekle.
- [ ] Application ve Docker restore executor'larına health gate ve deterministic rollback ekle; Database/Mail'in mevcut restore/recovery zincirini yeniden yazma.
- [ ] Disk-full, bozuk aggregate/per-resource checksum, kesinti ve kısmi restore için mutation-safe recovery modelini ekle.
- [ ] Backup/restore association'larını Website/Application/Database/Docker/Mail impact graph'ına gerçek dependency provider olarak bağla.
- [ ] Backend hazır olur olmaz gerçek Backup panel rotasını, history, target/retention ve restore akışını bağla.

Gerçek Docker Engine/Compose volume/bind backup-restore kabulü, Database/Mail mevcut motorlarının aggregate orchestrator altında gerçek host kabulü, gerçek S3/local target, disk-full/corrupt archive ve secret/permission kontrolleri `todo.md` içinde kalır.

## 2. Website / Domain / Nginx kalanları

- [ ] Canlı state'teki Website'e bağlı olmayan external-proxy Domain kayıtlarını explicit create/bind migrationıyla eşleştir; otomatik tahmin yapma.
- [ ] Backup ve cron association registry'leri geldikten sonra Website/Domain impact preview'a gerçek dependency provider olarak bağla; gelene kadar blocker `unavailable` kalmalı.

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

1. Backup dependency/impact metadata; ardından aggregate execution + local target.
2. Backup panel/history/target UI; S3-compatible target + retention.
3. Aggregate restore orchestration + UI.
4. Cron + UI.
5. Metrik ve bildirim katmanı.
6. Kalan Website/Domain migration işi ve association provider bağları ilgili kaynaklar hazır oldukça kapatılır.
7. İzole migration/rollback kabulünden sonra legacy agent kod/paket yüzeyinin fiziksel temizliği.
8. Enterprise UI/UX polish ve gerçek browser kabulü.
9. Plesk read-only importer — **son iş**.

Her geliştirme diliminde ilgili source testleri aynı değişiklikle eklenir. Bu ortamda yapılamayan gerçek-host/browser/provider/package kabul işleri kod planına geri sokulmaz; `todo.md` içinde tutulur.
