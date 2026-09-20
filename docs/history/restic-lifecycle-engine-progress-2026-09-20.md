# restic Repository ve Snapshot Lifecycle Motoru İlerlemesi (2026-09-20)

## 1. Kapsam ve Ürün Hedefi

2026-09-14 olgun hazır servis kararı ve `docs/architecture.md` doğrultusunda, YunPanel özel aggregate archive formatı yerine **restic** motorunu yedekleme ve kurtarma veri düzlemi olarak benimsemiştir.

`plan.md` P1.2 (Backup/restore) kapsamındaki ilk alt madde tamamlandı:
- **restic lifecycle: init/test/check/unlock/snapshot/retention/forget/prune**:
  - Düşük seviyeli restic komut yürütücüsü (`packages/host-runtime/src/restic-manager.js`):
    - Komut satırı bağımsız değişkenleri yerine `RESTIC_REPOSITORY` ve `RESTIC_PASSWORD` çevre değişkenleriyle güvenli yürütme (parolanın process table veya loglara sızmasını engelleme).
    - Tüm komutlar için `--json` çıktısı ve çok satırlı akış ayrıştırma (özellikle `backup --json` içindeki özet nesnesi).
    - Kilitlenme (`restic_repo_locked`), parola hatası (`restic_password_invalid`), başlatılmamış repo (`restic_repo_not_initialized`), önceden başlatılmış repo (`restic_repo_already_initialized`), bulunamayan anlık görüntü (`restic_snapshot_not_found`) ve eksik binary (`restic_binary_missing`) için tipli hata haritalaması (`ResticError`).
    - `init`, `check` (opsiyonel `--read-data-subset`), `unlock` (opsiyonel `--remove-all`), `createSnapshot` (etiketler, hariç tutmalar, üst anlık görüntü desteği ile), `listSnapshots`, `forget` (retention politikaları: keepLast, keepHourly, keepDaily, keepWeekly, keepMonthly, keepYearly, keepTags ve opsiyonel prune), `prune` (kurtarılan bayt ve paket sayısı ayrıştırması), `restore` (hedef dizin, include/exclude filtreleri) ve `stats` fonksiyonları.
  - API katmanı repository kayıt defteri (`apps/api/src/restic-repository-registry.js`):
    - Depo tanımları, durumu (`uninitialized`, `ready`, `error`), konumu ve master key ile AES-256-GCM şifrelenmiş depo parolaları.
    - Depo CRUD işlemleri, sunucu izolasyonu ve mükerrer isim engellemesi.
    - Parolanın genel görünümde (public view) hiçbir zaman dışarı verilmemesi; dahili kullanım için güvenli `revealPassword` fonksiyonu.
    - `initResticRepository`, `checkResticRepository`, `unlockResticRepository`, `createSnapshot`, `listSnapshots`, `applyRetention`, `pruneResticRepository` ve `restoreSnapshot` yöntemleri ile restic manager yaşam döngüsü delegasyonu.

## 2. Doğrulama
- `node --test packages/host-runtime/test/restic-manager.test.js`: 11 test geçti.
- `node --test packages/host-runtime/test/*.test.js`: 685 test geçti.
- `node --test apps/api/test/restic-repository-registry.test.js`: 7 test geçti.
- Gerçek Ubuntu restic binary kabulü `todo.md` T-SITE-FEATURES-SETTINGS altına eklendi.
