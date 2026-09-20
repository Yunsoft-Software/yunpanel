# rclone Remote Registry ve Uzak Depo Testi İlerlemesi (2026-09-20)

## 1. Kapsam ve Ürün Hedefi

2026-09-14 olgun hazır servis kararı ve `docs/architecture.md` doğrultusunda, YunPanel uzak yedekleme taşımacılığı (remote transport) için **rclone** kullanır ve restic'in rclone backend'i (`rclone:<remote>:<path>`) ile entegre olur.

`plan.md` P1.2 (Backup/restore) kapsamındaki ikinci alt madde tamamlandı:
- **rclone remote registry/test + encrypted credential**:
  - Düşük seviyeli rclone komut yöneticisi (`packages/host-runtime/src/rclone-manager.js`):
    - İkili dosya doğrulaması (`/usr/bin/rclone`, `/usr/local/bin/rclone`, `/bin/rclone`).
    - Uzak bağlantı testi (`testRemote`): `rclone lsd <remoteName>: --config <configFile> --contimeout 10s --timeout 15s`.
    - Tanımlı uzak depoları listeleme (`listRemotes`): `rclone listremotes --config <configFile>`.
    - Sürüm sorgusu (`version`): `rclone version --json`.
    - Güvenli `rclone.conf` dosyası üretimi (`writeConfigFile`): INI formatında, kök izinli `0600` kipinde atomik yazma.
    - Tipli hata haritalaması (`RcloneError`): `rclone_binary_missing`, `rclone_remote_unreachable`, `rclone_remote_auth_failed`, `rclone_remote_target_not_found`, `rclone_config_invalid`, `rclone_command_failed`.
  - API katmanı uzak depo kayıt defteri (`apps/api/src/rclone-remote-registry.js`):
    - Uzak depo tanımları (`s3`, `b2`, `sftp`, `webdav`).
    - Kimlik bilgileri (parola, gizli anahtarlar) master key ile AES-256-GCM şifrelenerek saklanır.
    - Genel görünümde (public view) gizli kimlik bilgileri asla sızdırılmaz.
    - CRUD operasyonları, tek sunucu (`serverId`) izolasyonu ve mükerrer isim engellemesi.
    - `testRemote`: İlgili deponun şifresini çözüp geçici izole konfigürasyonla `rcloneManager.testRemote` çalıştırır; başarıda durumu `verified` yapar, başarısızlıkta `error` olarak işaretler ve geçici konfigürasyon dosyasını temizler.
    - `materializeConfigFile`: Bir sunucuya ait tüm uzak depoları şifreleri çözülmüş halde tek bir `0600` yetkili `rclone.conf` dosyasına döker (restic rclone backend kullanımı için).

## 2. Doğrulama
- `node --test packages/host-runtime/test/rclone-manager.test.js`: 6 test geçti.
- `node --test apps/api/test/rclone-remote-registry.test.js`: 9 test geçti.
- Gerçek Ubuntu rclone uzak depo bağlantı testi kabulü `todo.md` T-SITE-FEATURES-SETTINGS altına eklendi.
