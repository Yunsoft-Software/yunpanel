# restic ve rclone Yedekleme Motoru Canlı Kabulü (2026-09-20)

## Kapsam ve Amaç

Bu test, `todo.md` altındaki `T-BACKUP` (P1 restic/rclone) gereksinimlerinin `.28` test sunucusu (`157.180.11.28`) üzerinde canlı olarak doğrulanmasını kapsar:
1. `restic` ve `rclone` ikili dosya köken (provenance), dosya izinleri ve sürüm doğrulaması (`verifyProvenance`).
2. Kök-özel (root-private, `0700`) restic depo başlatma (`init`).
3. Dışlama kuralları (exclusion patterns: `node_modules`, `.git`, `cache`, `tmp`) ile anlık görüntü (snapshot) oluşturma (`createSnapshot`).
4. Depo bütünlük kontrolü (`check`), istatistikler (`stats`) ve kilit açma (`unlock`).
5. Geri yükleme (`restore`) ve dışlanan dosyaların geri yüklenmediğinin kanıtlanması.
6. Saklama politikası (`forget`) ve veri budama (`prune`).
7. `rclone` parola gizleme (`obscure`), `0600` izinli konfigürasyon üretimi (`writeConfigFile`) ve uzak nokta listeleme (`listRemotes`).

## Gerçekleştirilen Doğrulamalar ve Sonuçlar

### 1. İkili Dosya Köken ve Sürüm Doğrulaması
- **restic**: `/usr/bin/restic`, sürüm `0.16.4`, sahip UID `0`, dünya-yazılabilir değil (`mode: 33261`). Minimum sürüm `0.16.0` gereksinimini karşılıyor.
- **rclone**: `/usr/bin/rclone`, sürüm `v1.60.1-DEV`, sahip UID `0`, dünya-yazılabilir değil (`mode: 33261`). Minimum sürüm `1.60.0` gereksinimini karşılıyor.

### 2. Kök-Özel Depo Başlatma
- Depo `/var/lib/yunpanel/backups/test-acceptance-.../repo` altında `0700` izinleriyle oluşturuldu.
- `resticManager.init(...)` çağrıldı; depo başarıyla başlatıldı ve `id` üretildi.

### 3. Kaynak Dizin ve Dışlama Kuralları ile Snapshot
- Kaynak dizin içeriği:
  - Kod: `releases/r1/server.js`
  - Veri: `data/uploads/image.png`
  - Ortam: `data/env`
  - Dışlanacak klasörler: `node_modules/dummy-pkg/index.js`, `.git/config`, `cache/app.cache`, `tmp/scratch.tmp`
- `resticManager.createSnapshot(...)` çağrıldı (`excludes: ['**/node_modules/**', '**/.git/**', '**/cache/**', '**/tmp/**']`).
- Snapshot oluşturuldu (`filesNew: 3`, `bytesAdded: 4648`, `totalFiles: 3`).

### 4. Depo Sağlığı, İstatistik ve Kilit Açma
- `resticManager.check(...)`: `healthy: true`, `no errors were found`.
- `resticManager.stats(...)`: `totalFiles: 13` (dizinler + dosyalar), `totalBytes: 66`.
- `resticManager.unlock(...)`: `unlocked: true`.

### 5. Geri Yükleme ve Dışlama Bütünlüğü
- `resticManager.restore(...)` ile hedef dizine geri yükleme yapıldı.
- `releases/r1/server.js`, `data/uploads/image.png`, `data/env` dosyaları içerikleriyle eksiksiz doğrulandı.
- `node_modules`, `.git`, `cache`, `tmp` dizinlerinin ve dosyalarının geri yükleme hedefinde kesinlikle yer almadığı (`ENOENT`) kanıtlandı.

### 6. Saklama Politikası (Retention Policy) ve Budama (Prune)
- İkinci snapshot oluşturuldu.
- `resticManager.forget({ policy: { keepLast: 1 }, prune: true })` çağrıldı.
- Sonuç: `keptSnapshots: 1`, `removedSnapshots: 1`, `pruned: true`.
- `listSnapshots` çağrısı depoda yalnızca en son snapshot'ın kaldığını doğruladı.

### 7. rclone Konfigürasyonu ve Uzak Depo Listeleme
- `rcloneManager.obscure(...)` ile ham şifre (`VerySecretRemotePassword123!`) şifrelendi/gizlendi (59 karakter).
- S3 ve SFTP uzak noktalarını içeren rclone konfigürasyonu `/var/lib/yunpanel/backups/.../rclone.conf` dosyasına `0600` izinleriyle yazıldı. Ham parolanın konfigürasyonda yer almadığı teyit edildi.
- `rcloneManager.listRemotes(...)`: `['remote-backup-s3', 'remote-backup-sftp']` olarak başarıyla listelendi.

## Sonuç
`T-BACKUP` kapsamındaki restic depo yaşam döngüsü, kök-özel izinler, snapshot oluşturma, dışlama kuralları, bütünlük denetimi, kilit açma, geri yükleme, saklama politikası (forget/prune) ve rclone uzak konfigürasyon yönetimi `.28` test sunucusunda eksiksiz doğrulanmıştır.
