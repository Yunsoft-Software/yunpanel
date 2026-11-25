# 22 Kasım 2026 · Kaynak kapalıyken YunPanel kurtarma

YunPanel `0.3.0-2026112104` kurulu Debian 12 `217.216.33.14` kaynak ve Ubuntu 24.04 `46.250.231.212` hedef olarak kullanıldı. Hedefte başta test sitesi, veritabanı ve panel hesabı yoktu.

Yedek, YunPanel’in paketli taşıma komutuyla üretildi ve `644f1be111c9` Restic snapshot’ı ayrı bir makinedeki rclone WebDAV deposuna yazıldı. İki VPS depoya SSH tüneli üzerinden erişti. Restic parolası ve YunPanel ana şifreleme anahtarı arşiv dışında saklandı. Contabo, hedef kurtarması başlarken ve doğrulama biterken Debian kaynağı `Stopped` gösterdi. Her iki anda da kaynak SSH uç noktası erişilemezdi.

| Kontrol | Doğrulanan sonuç |
| --- | --- |
| Yedek ve arşiv | `restic check --read-data`, doğrulamalı restore ve paketli `preflight`, `verify`, `preview`, `stage` geçti. SHA-256 ve kaynak kimliği eşleşti. |
| WordPress 7.1.5 | Türkçe yazı HTTP 200 döndü ve yanıt özeti kaynakla birebir eşleşti. Geri yüklenen yönetici hesabı giriş yaptı, profil ve statik stil dosyası HTTP 200 döndü. |
| MariaDB ve posta | Yayındaki kaydın UTF-8 verisi ve IMAP üzerinden okunan RFC822 ileti özeti kaynakla birebir eşleşti. |
| YunPanel hesapları | İzole paketli API örneğinde geri yüklenen Owner ve site yöneticisi HTTP 200 ile giriş yaptı. Owner yönetim erişimi 200, site yöneticisinin aynı yönetim talebi 403, yanlış parola 401 döndü. Yöneticinin site kapsamı ve iki hesabın kimlikleri korundu. |
| Anahtar | Kaynaktan bağımsız saklanan anahtar ile YunPanel’in şifreli işlem kaydı açıldı. Yanlış anahtar reddedildi. |

Hedefin geri yükleme süresi **241,33 saniye** sürdü. Bu süre depo bütünlüğünü, geri yüklemeyi, ilk HTTP 403 sonrasında WordPress’in Nginx erişim izinlerinin düzeltilmesini ve son doğrulamaları içerir. WordPress ve posta verisi alınan snapshot’la eşleşti. Yedek tamamlandıktan sonra yeni yazı üretilmediği için sürekli RPO veya yedekleme takvimi bu ölçümün kapsamında değildir.

Geri yüklemede hedefin PHP 8.3 ve Unix kimlikleriyle doğrulanmış site, SQL, posta ve hesap verisi uygulandı. Arşiv canlı kök dizinine açılmadı. Hesap yetkisi ayrı bir paketli API örneğinde doğrulandı. Test verileri ve depo erişim bilgileri temizlendi. Debian yeniden açıldı ve her iki sunucuda kurulu YunPanel sağlık kontrolü geçti. Bu prova işletilen bağımsız bir WebDAV hedefinde yürütüldü. Contabo nesne deposu aboneliği bulunmuyordu.

Yerel kanıt dizini `.local/contabo-cross-restore/dr-20261122/evidence/`. Ana kayıtlar `source-recovery-receipt.json`, `source-power-off.json`, `cold-restore.json`, `recovered-panel-auth-http.json`, `source-cleanup.json`, `target-cleanup.txt` ve `offsite-cleanup.json`.
