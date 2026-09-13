# YunPanel — Kalan Geliştirme Planı

Bu dosya yalnız **kaynakta henüz tamamlanmamış geliştirme işlerini** tutar. Yapılmış işler burada tekrar listelenmez.

Bağlayıcı mimari ve güvenlik kuralları `agents.md` içindedir. Bu ortamda güvenilir biçimde yapılamayan gerçek Ubuntu, browser, package, DNS/provider, servis ve rollback kabulleri `todo.md` içinde tutulur. Geliştirme güncel `main` üzerinde küçük, tek amaçlı commitlerle ilerler; GitHub Actions kullanılmaz. Enterprise UI/UX polish backend functionality tamamlanana kadar ertelenmiştir.

## 1. Docker / Compose — mevcut ana öncelik

Compose desired-state, encrypted project/env/registry credential modeli, validation, build/pull/start/stop/restart durable job lifecycle, resource lock, receipt tabanlı lost-ack recovery, durable deploy history ve bounded/redacted project runtime health/log backend'i kaynakta hazırdır; aşağıdaki işler kalmıştır.

- [ ] Managed Compose projesini mevcut `external/unverified dockerWorkloadId` modeline zorlamadan ayrı ve explicit bir Website binding modeliyle ilişkilendir.
- [ ] Website registry migrationını managed Compose binding için versioned ve restart-safe yap; same-server, unique binding ve stale reference kontrollerini fail-closed uygula.
- [ ] Managed Compose Website için explicit Nginx target üret: yalnız doğrulanmış loopback/published port seçimine izin ver; otomatik container/port tahmini yapma.
- [ ] Compose runtime health, container absence/unhealthy/restart/exit ve Nginx target readiness sonuçlarından secret-free actionable diagnosis üret.
- [ ] Managed Compose binding değişikliği için preview/digest/typed-confirmation ve impact modelini Website/Domain resource graph'ına bağla.
- [ ] Volume/bind inventory modelini ekle; named volume, bind mount ve ephemeral storage ayrımını public metadata'da açık göster.
- [ ] Docker volume/bind için backup/restore politikasını genel backup manifestine bağlanabilecek şekilde tasarla; arbitrary host path backup'ını varsayılan olarak reddet.
- [ ] Docker/Compose backend yüzeyini gerçek panel arayüzüne bağla: project create/edit, env, registry credential metadata, validate, lifecycle preview/apply, history, runtime health ve log görünümü.

Gerçek Docker Engine/Compose host kabulü, crash/lost-ack provası ve secret/permission kontrolleri `todo.md` içinde kalır.

## 2. Website / Domain / Nginx kalanları

- [ ] Canlı state'teki Website'e bağlı olmayan external-proxy Domain kayıtlarını explicit create/bind migrationıyla eşleştir; otomatik tahmin yapma.
- [ ] Backup ve cron association registry'leri geldikten sonra Website/Domain impact preview'a gerçek dependency provider olarak bağla; gelene kadar blocker `unavailable` kalmalı.
- [ ] Managed Compose Website binding tamamlandığında Domain/Nginx lifecycle'ına explicit target kaynağı olarak ekle.

Gerçek DNS/Nginx/HTTPS, IDN, certificate ve provider acceptance işleri `todo.md` içindedir.

## 3. Agentless migration ve legacy agent temizliği

- [ ] Migration live-apply katmanına per-target replace, UID/GID drift çözümü, owner/mode/ACL/xattr policy, pre-apply backup, health gate ve deterministic rollback ekle.
- [ ] İzole migration/rollback kabul kapısı tamamlandıktan sonra retained heartbeat/command/environment/result transportunu, enrollment credential yüzeyini, agent storage kodunu, `yun-agent.service` ve package compatibility parçalarını fiziksel olarak kaldır.
- [ ] Yeni Git hook, cron, build ve runtime yüzeylerinde `yunapp-*` workload isolation invariantını koru; yalnız Owner Sunucu terminali root kalmalı.

## 4. Genel backup / restore ürünü

- [ ] Application release/config/env, database, managed Docker volume/bind ve mail verisini kapsayan versioned backup manifesti ekle.
- [ ] Local ve S3-compatible target, şifreleme, checksum, retention ve credential lifecycle ekle.
- [ ] Restore preview, veri kaybı etkisi, progress, pre-restore backup, health gate ve deterministic failure rollback ekle.
- [ ] Disk-full, bozuk archive/checksum, kesinti ve kısmi restore için mutation-safe recovery modelini ekle.
- [ ] Backup/restore kaynaklarını Website/Application/Database/Docker/Mail impact graph'ına bağla.

## 5. Cron

- [ ] Website/Application'a bağlı site-user cron registry ve CRUD ekle.
- [ ] Schedule, timezone, cwd, bounded env, enable/disable, last/next run ve bounded/redacted output ekle.
- [ ] Cron command'ını shell-string birleştirmeden doğrulanmış execution contract'ına bağla.
- [ ] System cron'u yalnız explicit Owner/Sunucu bağlamında ayrı kaynak türü olarak uygula.
- [ ] Cron association'larını Website/Application impact preview ve backup manifestine bağla.

## 6. Job detail, metrik ve bildirimler

- [ ] Job detail'e stage/progress, resource link, safe error/log metadata, arama/filtre ve operasyon bazlı güvenli retry policy ekle.
- [ ] Retry yalnız operation-specific idempotency/recovery kanıtı bulunan işler için açılsın; ambiguous mutation için generic retry/force-success yolu ekleme.
- [ ] CPU/RAM/load/disk/inode/service/Application/Docker metric history ve retention ekle.
- [ ] Disk/inode threshold, service/app/container, deploy, backup ve SSL event modelini ekle.
- [ ] Panel içi bildirim merkezi ve seçilecek dış kanallar için secret-safe delivery/retry ekle.

## 7. Plesk read-only importer

- [ ] Plesk state'ini değiştirmeyen bounded ve secret-safe discovery/import preview ekle.
- [ ] Passenger/static/Node, Domain, database, Docker, cron ve mail kaynaklarını external-managed olarak modelle.
- [ ] Kaynak başına conflict, dependency, explicit confirmation, migration job ve deterministic rollback ekle.
- [ ] `.44` ile biten Plesk sunucusuna hiçbir geliştirme/test/deploy işleminde bağlanma; yalnız offline fixture veya açıkça onaylı `.44` olmayan test hostu kullan.

## 8. UI/UX ve son entegrasyon

- [ ] Mail, managed Docker/Compose, Backup, Cron, metric/notification ve Plesk importer backend functionality'si tamamlandıkça gerçek UI rotalarını bağla; placeholder/inert kontrol bırakma.
- [ ] Backend functionality tamamlandıktan sonra enterprise layout/styling, navigation hierarchy, data-table/form polish, responsive ve accessibility aşamasını yap.
- [ ] Domain/subdomain/Website hiyerarşisini Plesk benzeri yönetim akışında netleştir; Website içine Node/runtime/env/log/file/terminal, mail, SSL ve ilgili kaynak erişimlerini bağla.

## Uygulama sırası

1. Managed Compose → Website/Nginx explicit binding + diagnosis.
2. Docker volume/bind inventory ve backup policy.
3. Genel backup/restore ürünü.
4. Cron.
5. Job detail/metrik/bildirim.
6. Plesk read-only importer.
7. İzole migration/rollback kabulünden sonra legacy agent kod/paket yüzeyinin fiziksel temizliği.
8. Bütün backend functionality tamamlandıktan sonra enterprise UI/UX polish.

Her geliştirme diliminde ilgili source testleri aynı değişiklikle eklenir. Bu ortamda yapılamayan gerçek-host/browser/provider/package kabul işleri kod planına geri sokulmaz; `todo.md` içinde tutulur.
