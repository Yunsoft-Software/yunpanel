# YunPanel — Kalan Geliştirme Planı

Bu dosya yalnız **kaynakta henüz tamamlanmamış geliştirme işlerini** tutar. Yapılmış işler burada tekrar listelenmez.

Bağlayıcı mimari ve güvenlik kuralları `agents.md` içindedir. Bu ortamda güvenilir biçimde yapılamayan gerçek Ubuntu, browser, package, DNS/provider, servis ve rollback kabulleri `todo.md` içinde tutulur. Geliştirme güncel `main` üzerinde küçük, tek amaçlı commitlerle ilerler; GitHub Actions kullanılmaz.

Öncelik, panelin gerçek kullanılabilirlik ve Plesk-benzeri ürün tamamlanma oranını en hızlı yükselten işleri bitirmektir. Plesk importer en son geliştirme işi olarak tutulur.

## 1. Yüksek etkili panel entegrasyonları — mevcut ana öncelik

Managed Docker/Compose artık gerçek panel rotasında project create/replace, encrypted env, registry credential metadata/rotation, validation, build/pull/start/stop/restart preview+apply, history, service-scoped runtime health, actionable target diagnosis ve bounded log görünümüne bağlıdır. Sıradaki en yüksek etkili ürün işleri aşağıdadır.

- [ ] Mail backend lifecycle'ını gerçek panel yüzeyine bağla: domain, mailbox, alias, quota, forwarding, DKIM, diagnostics, queue/log ve Roundcube yönetimi.
- [ ] Website detayında Domain/SSL, Application/runtime/env, log, file, terminal, database, mail ve Docker ilişkilerini Plesk-benzeri net bir hiyerarşide birleştir.
- [ ] Mevcut Job ekranını kaynak linki, stage/progress ve safe error/log metadata ile kullanılabilir hale getir; generic retry/force-success ekleme.

## 2. Docker / Compose — kalan storage ve backup bağı

Compose desired-state, encrypted project/env/registry credential modeli, validation, durable lifecycle/recovery/history, service-scoped health/log, restart-safe Managed Compose Website binding, stage anında doğrulanmış loopback Nginx target, secret-free actionable diagnosis, Website/Domain impact graph ve gerçek panel UI kaynakta hazırdır. Kalan Docker backend işi storage/backup tarafıdır.

- [ ] Volume/bind inventory modelini ekle; named volume, bind mount ve ephemeral storage ayrımını public metadata'da açık göster.
- [ ] Docker volume/bind için backup/restore politikasını genel backup manifestine bağlanabilecek şekilde tasarla; arbitrary host path backup'ını varsayılan olarak reddet.

Gerçek Docker Engine/Compose host kabulü, crash/lost-ack provası ve secret/permission kontrolleri `todo.md` içinde kalır.

## 3. Website / Domain / Nginx kalanları

- [ ] Canlı state'teki Website'e bağlı olmayan external-proxy Domain kayıtlarını explicit create/bind migrationıyla eşleştir; otomatik tahmin yapma.
- [ ] Backup ve cron association registry'leri geldikten sonra Website/Domain impact preview'a gerçek dependency provider olarak bağla; gelene kadar blocker `unavailable` kalmalı.

Gerçek DNS/Nginx/HTTPS, IDN, certificate ve provider acceptance işleri `todo.md` içindedir.

## 4. Genel backup / restore ürünü

- [ ] Application release/config/env, database, managed Docker volume/bind ve mail verisini kapsayan versioned backup manifesti ekle.
- [ ] Local ve S3-compatible target, şifreleme, checksum, retention ve credential lifecycle ekle.
- [ ] Restore preview, veri kaybı etkisi, progress, pre-restore backup, health gate ve deterministic failure rollback ekle.
- [ ] Disk-full, bozuk archive/checksum, kesinti ve kısmi restore için mutation-safe recovery modelini ekle.
- [ ] Backup/restore kaynaklarını Website/Application/Database/Docker/Mail impact graph'ına bağla.
- [ ] Backup/restore backend'i hazır olur olmaz gerçek panel rotasını ve history/restore akışını bağla.

## 5. Cron

- [ ] Website/Application'a bağlı site-user cron registry ve CRUD ekle.
- [ ] Schedule, timezone, cwd, bounded env, enable/disable, last/next run ve bounded/redacted output ekle.
- [ ] Cron command'ını shell-string birleştirmeden doğrulanmış execution contract'ına bağla.
- [ ] System cron'u yalnız explicit Owner/Sunucu bağlamında ayrı kaynak türü olarak uygula.
- [ ] Cron association'larını Website/Application impact preview ve backup manifestine bağla.
- [ ] Cron backend'i hazır olur olmaz Website içindeki Scheduled Tasks UI yüzeyine bağla.

## 6. Metrik ve bildirimler

- [ ] CPU/RAM/load/disk/inode/service/Application/Docker metric history ve retention ekle.
- [ ] Disk/inode threshold, service/app/container, deploy, backup ve SSL event modelini ekle.
- [ ] Panel içi bildirim merkezi ve seçilecek dış kanallar için secret-safe delivery/retry ekle.

## 7. Agentless migration ve legacy agent temizliği

- [ ] Migration live-apply katmanına per-target replace, UID/GID drift çözümü, owner/mode/ACL/xattr policy, pre-apply backup, health gate ve deterministic rollback ekle.
- [ ] İzole migration/rollback kabul kapısı tamamlandıktan sonra retained heartbeat/command/environment/result transportunu, enrollment credential yüzeyini, agent storage kodunu, `yun-agent.service` ve package compatibility parçalarını fiziksel olarak kaldır.
- [ ] Yeni Git hook, cron, build ve runtime yüzeylerinde `yunapp-*` workload isolation invariantını koru; yalnız Owner Sunucu terminali root kalmalı.

## 8. Enterprise UI/UX son polish

- [ ] Enterprise layout/styling, navigation hierarchy, data-table/form polish, responsive ve accessibility aşamasını tamamla.
- [ ] Domain/subdomain/Website hiyerarşisini Plesk benzeri yönetim akışında son haline getir.
- [ ] Gerçek Chromium/Firefox headed browser, mobil viewport, klavye ve ekran okuyucu kabulünü `todo.md` kapılarıyla tamamla.

## 9. Plesk read-only importer — en son

- [ ] Plesk state'ini değiştirmeyen bounded ve secret-safe discovery/import preview ekle.
- [ ] Passenger/static/Node, Domain, database, Docker, cron ve mail kaynaklarını external-managed olarak modelle.
- [ ] Kaynak başına conflict, dependency, explicit confirmation, migration job ve deterministic rollback ekle.
- [ ] `.44` ile biten Plesk sunucusuna hiçbir geliştirme/test/deploy işleminde bağlanma; yalnız offline fixture veya açıkça onaylı `.44` olmayan test hostu kullan.

## Uygulama sırası

1. Hazır Mail backend'ini gerçek panel UI'sine bağla; aynı turda Website içi kaynak hiyerarşisini güçlendir.
2. Job detail'i kaynak linki/stage/progress/safe log metadata ile kullanılabilir hale getir.
3. Docker volume/bind inventory ve backup policy.
4. Genel backup/restore ürünü + UI.
5. Cron + UI.
6. Metrik ve bildirim katmanı.
7. Kalan Website/Domain migration işi ve association provider bağları ilgili kaynaklar hazır oldukça kapatılır.
8. İzole migration/rollback kabulünden sonra legacy agent kod/paket yüzeyinin fiziksel temizliği.
9. Enterprise UI/UX polish ve gerçek browser kabulü.
10. Plesk read-only importer — **son iş**.

Her geliştirme diliminde ilgili source testleri aynı değişiklikle eklenir. Bu ortamda yapılamayan gerçek-host/browser/provider/package kabul işleri kod planına geri sokulmaz; `todo.md` içinde tutulur.
