# Domain/Website removal backup impact inventory — 2026-09-19

Bu kayıt P0.9 delete impact graph içindeki `backups` dependency provider boşluğunun kaynak ilerlemesini özetler.

## Kaynak sınırı

Mevcut genel backup altyapısı yeniden yazılmadı. Provider mevcut:

- durable `backupOperationRegistry`,
- persisted execution plan step'leri,
- succeeded step artifact evidence'ı,
- Website/Application,
- Database binding,
- Managed Compose project,
- Mail Domain -> web Domain

ilişkilerini kullanır.

## Uygulanan provider

`domain-removal-backup-impact.js`:

- affected Domain setini canlı Domain registry'den yeniden doğrular;
- root veya descendant Domain'e bağlı bütün affected Website kimliklerini toplar;
- Website Application ve Managed Compose project kimliklerini çıkarır;
- current database binding'lerinden affected Website database adlarını çıkarır;
- affected Domain'lere bağlı Mail Domain kimliklerini çıkarır;
- aynı local Server'a ait persisted backup operation'larını tarar;
- yalnız durable `succeeded` step + artifact evidence taşıyan backup parçalarını dependency olarak raporlar;
- application/database/docker_storage/mail_data kaynaklarını kendi canonical ilişki modeliyle affected scope'a bağlar;
- pending veya unrelated backup work'ü retained backup dependency saymaz;
- stale Domain/Website/inventory state'inde boş liste uydurmak yerine fail-closed kalır;
- 500 reference sınırı ve duplicate identity kontrolü uygular.

Backup reference identity operation ID + execution step ID ile deterministic tutulur; state resource tipini `retained_<type>` olarak taşır. Raw backup path veya secret response'a girmez.

## Wiring

- Production Domain removal runtime `backups` additional provider'ına bu envanter bağlandı.
- Normal resource-impact HTTP surface aynı provider'ı kullanıyor.
- Böylece panel impact preview ile durable delete orchestrator farklı backup dependency sonucu üretmiyor.
- Production wiring mevcut `backupOperationRegistry` ve `databaseBindingRegistry` üzerinden yapılır.
- Bu dependency'ler yoksa generic/test createApp fixture'ları eski fail-closed `unavailable` davranışını korur.

## Küçük commitler

- `69faeb4f` — removal backup impact provider.
- `60d53495` — application/database/Docker/mail + stale-state source test kontratları.
- `3bc38934` — provider'ı production Domain removal preview'a bağla.
- `6a462d32` — backup/database registries'i production runtime factory'ye geçir.
- `a8809247` — aynı provider'ı resource-impact HTTP surface'e bağla.
- `79b97339` — Codex source validation kapısını genişlet.

## Doğrulama

Bu sohbet ortamında Node test runner çalıştırılmadı. Hedefli test ve resource-impact regresyon kontrolü `todo.md` T-CODEX-SOURCE bölümüne bırakıldı. Full `npm run check` kapısı açık kalır.

## Kalan blocker

Site-user cron/systemd timer ürünü ve registry'si henüz mevcut değildir. Bu nedenle `crons` impact bucket'ı bilerek `unavailable` kalır; sırf Domain delete preview açılsın diye sahte boş provider eklenmedi.

Ayrıca backup retention/delete policy üst delete operation'a bağlanmadığı sürece bulunan retained backup'lar dependency blocker olmaya devam eder. Bu güvenli ve bilinçli davranıştır.
