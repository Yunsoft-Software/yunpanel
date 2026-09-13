# YunPanel — Kalan Geliştirme Planı

Bu dosya yalnız **kaynakta henüz tamamlanmamış geliştirme işlerini** tutar. Yapılmış işler burada tekrar listelenmez.

Bağlayıcı mimari ve güvenlik kuralları `agents.md` içindedir. Bu ortamda güvenilir biçimde yapılamayan gerçek Ubuntu, browser, package, DNS/provider, servis ve rollback kabulleri `todo.md` içinde tutulur. Geliştirme güncel `main` üzerinde küçük, tek amaçlı commitlerle ilerler; GitHub Actions kullanılmaz.

Öncelik, panelin gerçek kullanılabilirlik ve Plesk-benzeri ürün tamamlanma oranını en hızlı yükselten işleri bitirmektir. Plesk importer en son geliştirme işi olarak tutulur.

Managed Docker/Compose ve Mail gerçek panel rotalarına bağlıdır. Website detayında Domain/SSL, Application/runtime/env/log/file/terminal ile explicit database/mail/Managed Compose ilişkileri tek site kaynak hiyerarşisinde görünür. Job list/detail kaynak linki, yaşam döngüsü stage/progress, allowlist'li sonuç metadata, güvenli diagnosis/error code ve bounded/redacted deploy log görünümüne sahiptir; generic retry/force-success yolu yoktur. Managed Compose public desired-state artık named volume, proje içi bind, host bind ve ephemeral storage mountlarını ayrı sınıflandırıp kalıcı state'te ve panelde gösterir; host bind yolları otomatik backup adayı sayılmaz.

## 1. Docker / Compose — backup bağı

Compose desired-state, encrypted project/env/registry credential modeli, validation, durable lifecycle/recovery/history, service-scoped health/log, restart-safe Managed Compose Website binding, stage anında doğrulanmış loopback Nginx target, secret-free actionable diagnosis, Website/Domain impact graph, gerçek panel UI ve storage inventory kaynakta hazırdır. Kalan Docker backend işi storage'ı genel backup/restore ürününe güvenli biçimde bağlamaktır.

- [ ] Named volume ve proje içi bind için backup/restore politikasını versioned genel backup manifestine bağla; ephemeral storage'ı backup dışı bırak, arbitrary host bind path'lerini varsayılan olarak reddet ve restore/impact akışında aynı policy kimliğini koru.

Gerçek Docker Engine/Compose host kabulü, crash/lost-ack provası, storage mount sınıflandırmasının gerçek Compose fixture'larıyla doğrulanması ve secret/permission kontrolleri `todo.md` içinde kalır.

## 2. Website / Domain / Nginx kalanları

- [ ] Canlı state'teki Website'e bağlı olmayan external-proxy Domain kayıtlarını explicit create/bind migrationıyla eşleştir; otomatik tahmin yapma.
- [ ] Backup ve cron association registry'leri geldikten sonra Website/Domain impact preview'a gerçek dependency provider olarak bağla; gelene kadar blocker `unavailable` kalmalı.

Gerçek DNS/Nginx/HTTPS, IDN, certificate ve provider acceptance işleri `todo.md` içindedir.

## 3. Genel backup / restore ürünü

- [ ] Application release/config/env, database, managed Docker volume/bind ve mail verisini kapsayan versioned backup manifesti ekle.
- [ ] Local ve S3-compatible target, şifreleme, checksum, retention ve credential lifecycle ekle.
- [ ] Restore preview, veri kaybı etkisi, progress, pre-restore backup, health gate ve deterministic failure rollback ekle.
- [ ] Disk-full, bozuk archive/checksum, kesinti ve kısmi restore için mutation-safe recovery modelini ekle.
- [ ] Backup/restore kaynaklarını Website/Application/Database/Docker/Mail impact graph'ına bağla.
- [ ] Backup/restore backend'i hazır olur olmaz gerçek panel rotasını ve history/restore akışını bağla.

## 4. Cron

- [ ] Website/Application'a bağlı site-user cron registry ve CRUD ekle.
- [ ] Schedule, timezone, cwd, bounded env, enable/disable, last/next run ve bounded/redacted output ekle.
- [ ] Cron command'ını shell-string birleştirmeden doğrulanmış execution contract'ına bağla.
- [ ] System cron'u yalnız explicit Owner/Sunucu bağlamında ayrı kaynak türü olarak uygula.
- [ ] Cron association'larını Website/Application impact preview ve backup manifestine bağla.
- [ ] Cron backend'i hazır olur olmaz Website içindeki Scheduled Tasks UI yüzeyine bağla.

## 5. Metrik ve bildirimler

- [ ] CPU/RAM/load/disk/inode/service/Application/Docker metric history ve retention ekle.
- [ ] Disk/inode threshold, service/app/container, deploy, backup ve SSL event modelini ekle.
- [ ] Panel içi bildirim merkezi ve seçilecek dış kanallar için secret-safe delivery/retry ekle.

## 6. Agentless migration ve legacy agent temizliği

- [ ] Migration live-apply katmanına per-target replace, UID/GID drift çözümü, owner/mode/ACL/xattr policy, pre-apply backup, health gate ve deterministic rollback ekle.
- [ ] İzole migration/rollback kabul kapısı tamamlandıktan sonra retained heartbeat/command/environment/result transportunu, enrollment credential yüzeyini, agent storage kodunu, `yun-agent.service` ve package compatibility parçalarını fiziksel olarak kaldır.
- [ ] Yeni Git hook, cron, build ve runtime yüzeylerinde `yunapp-*` workload isolation invariantını koru; yalnız Owner Sunucu terminali root kalmalı.

## 7. Enterprise UI/UX son polish

- [ ] Enterprise layout/styling, navigation hierarchy, data-table/form polish, responsive ve accessibility aşamasını tamamla.
- [ ] Domain/subdomain/Website hiyerarşisini Plesk benzeri yönetim akışında son haline getir.
- [ ] Gerçek Chromium/Firefox headed browser, mobil viewport, klavye ve ekran okuyucu kabulünü `todo.md` kapılarıyla tamamla.

## 8. Plesk read-only importer — en son

- [ ] Plesk state'ini değiştirmeyen bounded ve secret-safe discovery/import preview ekle.
- [ ] Passenger/static/Node, Domain, database, Docker, cron ve mail kaynaklarını external-managed olarak modelle.
- [ ] Kaynak başına conflict, dependency, explicit confirmation, migration job ve deterministic rollback ekle.
- [ ] `.44` ile biten Plesk sunucusuna hiçbir geliştirme/test/deploy işleminde bağlanma; yalnız offline fixture veya açıkça onaylı `.44` olmayan test hostu kullan.

## Uygulama sırası

1. Docker storage backup policy contractını genel backup manifestiyle birlikte kapat.
2. Genel backup/restore ürünü + UI.
3. Cron + UI.
4. Metrik ve bildirim katmanı.
5. Kalan Website/Domain migration işi ve association provider bağları ilgili kaynaklar hazır oldukça kapatılır.
6. İzole migration/rollback kabulünden sonra legacy agent kod/paket yüzeyinin fiziksel temizliği.
7. Enterprise UI/UX polish ve gerçek browser kabulü.
8. Plesk read-only importer — **son iş**.

Her geliştirme diliminde ilgili source testleri aynı değişiklikle eklenir. Bu ortamda yapılamayan gerçek-host/browser/provider/package kabul işleri kod planına geri sokulmaz; `todo.md` içinde tutulur.
