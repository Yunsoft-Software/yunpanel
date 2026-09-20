# rclone Uzak Depo ve Restic Entegrasyonu Canlı Kabulü — 2026-09-20

## 1. Kapsam ve Doğrulama Ortamı
- **Hedef Sunucu:** Yalnız `.local/test-server.env` içindeki `157.180.11.28` YunPanel test sunucusu (Ubuntu 24.04 LTS). `.44` Plesk sunucusuna hiçbir bağlantı kurulmadı.
- **İkili Sürümler:**
  - `rclone v1.60.1-DEV` (Ubuntu 24.04 standart paketi)
  - `restic 0.16.4` (Ubuntu 24.04 standart paketi)

## 2. Tespit Edilen ve Düzeltilen Hususlar
1. **`rclone version` Plain-Text Çıktı Desteği (`packages/host-runtime/src/rclone-manager.js`):**
   - Ubuntu 24.04'teki rclone 1.60.1 sürümünde `rclone version --json` bayrağı bulunmamaktadır (`unknown flag: --json`).
   - `rcloneManager.version()` metoduna `--json` hatası durumunda düz metin çıktıyı (`rclone vX.Y.Z`, `- os/version: ...`, `- os/type: ...`, `- os/arch: ...`) parse eden güvenli geri çekilme (fallback) eklendi.
2. **`rclone` Parola Karartma (Obscure) Desteği (`packages/host-runtime/src/rclone-manager.js`):**
   - `rclone` konfigürasyon dosyasında `webdav` ve `sftp` için `pass` ile `key_file_pass` alanlarının karartılmış (`obscured`) olmasını şart koşar; aksi takdirde `couldn't decrypt password: base64 decode failed when revealing password - is it obscured?` hatası fırlatır.
   - `rcloneManager.obscure(password)` metodu eklendi (`rclone obscure <pass>`).
   - `writeConfigFile` metodu yapılandırmadaki `pass` ve `key_file_pass` alanlarını otomatik olarak `obscure` ederek `0600` yetkili INI dosyasına yazar.
3. **Restic Rclone Backend Çağrısı:**
   - Restic'in rclone backend'ine özel konfigürasyon dosyası aktarırken `-o rclone.args="serve restic --stdio --config <materializedConfig>"` parametresi kullanılır.

## 3. Canlı Test ve Kabul Kanıtı
Geçici test sürücüsü ile `.28` sunucusunda aşağıdaki adımlar uçtan uca çalıştırıldı ve doğrulandı:
1. `rcloneManager.version()` ile ikili dosya başarıyla tespit edildi (`v1.60.1-DEV`, `linux`, `amd64`).
2. İzole loopback WebDAV sunucusu (`127.0.0.1:18456`) başlatıldı.
3. `createRcloneRemoteRegistry` ile uzak depo kaydı oluşturuldu:
   - Kimlik bilgileri AES-256-GCM ile şifrelendi, kalıcı depoda düz parola saklanmadığı doğrulandı.
   - `publicRemote` çıktısında kimlik bilgilerinin asla sızdırılmadığı teyit edildi.
4. `testRemote`:
   - Şifrelenmiş kimlik bilgileri çözülerek geçici `0600` izinli dosya oluşturuldu.
   - `rclone lsd` testi başarıyla tamamlandı, depo durumu `verified` oldu.
   - Test bitiminde geçici konfigürasyon dosyasının silindiği doğrulandı.
5. Hata Senaryosu:
   - Yanlış parola ile `testRemote` çalıştırıldı; beklenen `rclone_remote_auth_failed` (401) hatası alındı.
   - Depo durumu `error` olarak güncellendi.
   - Hata durumunda dahi geçici `0600` dosyanın derhal temizlendiği teyit edildi.
6. `materializeConfigFile`:
   - Depolar çözülerek `0600` yetkili kalıcı konfigürasyon dosyasına yazıldı.
7. Restic Rclone Backend Doğrulaması:
   - `restic init -r rclone:test_webdav:/restic-repo -o rclone.args="serve restic --stdio --config <conf>"` ile depo oluşturuldu.
   - `restic backup` ile test verisi WebDAV deposuna başarıyla yedeklendi.
   - `restic check` ile depo bütünlüğü doğrulandı (`no errors were found`).
8. Test tamamlandığında tüm geçici dosyalar ve test depoları temizlendi.
