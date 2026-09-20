# OpenSSH internal-sftp Chroot, İzolasyon ve Güvenlik Canlı Kabul Raporu — 2026-09-20

## 1. Amaç ve Kapsam

Bu rapor, YunPanel test sunucusunda (`157.180.11.28`, hostname `test`, `YUNPANEL_LOCAL_SERVER_ID: 99bc760a-f0f5-467a-a4ea-7bcfa3d6fb60`) OpenSSH `internal-sftp` mimarisinin, chroot dizin yapısının, dosya izinlerinin, kullanıcı bazlı izolasyonunun ve varsayılan FTP servisinin dinlemediğinin canlı ortamda test edilip doğrulandığını belgeler.

Kapsam (`T-SITE-FEATURES-SETTINGS`):
- FTP servisinin varsayılan olarak hiçbir portta dinlemediğinin doğrulanması.
- İki farklı Website hesabı (`yunapp-a404896cf12e` - `webrich.news` ve `yunapp-71355c1cda8a` - `mailtest.webrich.news`) için OpenSSH `sshd_config.d` konfigürasyonlarının incelenmesi.
- `sshd -T -C` ile aktif sshd kurallarının teyidi: `ForceCommand internal-sftp -d /site -u 0027`, `ChrootDirectory`, `PubkeyAuthentication yes`, `PasswordAuthentication no`, `PermitTTY no`, `X11Forwarding no`, `AllowTcpForwarding no`.
- Chroot kök dizinlerinin `root:root 0755` olması (OpenSSH chroot güvenlik gereksinimi).
- `/site` mount noktasının `rw,nosuid,nodev,noexec` bind mount olması ve site kullanıcısına ait (`0750`) olması.
- Canlı SFTP oturumu ile `/site` dizinine iniş, dizin dışına çıkma (chroot escape) denemesi, interaktif SSH kabuk açma engeli ve hesaplar arası (cross-account) erişim reddi testi.

## 2. Test Adımları ve Çıktılar

### 2.1. FTP Dinleme Durumu
- Komut: `ss -tlpn | grep -E ':(21|ftp)\b'`
- Sonuç: `No FTP listening`. FTP portu dinlememektedir.

### 2.2. OpenSSH Match User Konfigürasyonu
`/etc/ssh/sshd_config.d/90-yunpanel-sftp-yunapp-a404896cf12e.conf`:
```
Match User yunapp-a404896cf12e
  ChrootDirectory /var/lib/yunpanel/sftp-chroots/a5e1f251-4594-5996-b402-47a2ad7f55a0
  ForceCommand internal-sftp -d /site -u 0027
  PubkeyAuthentication yes
  AuthorizedKeysFile /etc/ssh/yunpanel-authorized-keys/yunapp-a404896cf12e
  PasswordAuthentication no
  KbdInteractiveAuthentication no
  PermitTTY no
  X11Forwarding no
  AllowTcpForwarding no
  AllowAgentForwarding no

Match all
```
`sshd -T -C user=yunapp-a404896cf12e,host=localhost,addr=127.0.0.1` çıktısı:
- `pubkeyauthentication yes`
- `passwordauthentication no`
- `permittty no`
- `forcecommand internal-sftp -d /site -u 0027`
- `chrootdirectory /var/lib/yunpanel/sftp-chroots/a5e1f251-4594-5996-b402-47a2ad7f55a0`

### 2.3. Chroot ve Mount İzinleri
- Chroot dizinleri:
  - `/var/lib/yunpanel/sftp-chroots/a5e1f251-4594-5996-b402-47a2ad7f55a0`: `drwxr-xr-x root root` (`0755`)
  - `/var/lib/yunpanel/sftp-chroots/6e7d89a3-f363-5c78-a832-358f8ad0b8d8`: `drwxr-xr-x root root` (`0755`)
- `/site` bağlama noktaları:
  - `.../a5e1f251-4594-5996-b402-47a2ad7f55a0/site`: `drwxr-x--- yunapp-a404896cf12e yunapp-a404896cf12e` (`0750`)
  - `.../6e7d89a3-f363-5c78-a832-358f8ad0b8d8/site`: `drwxr-x--- yunapp-71355c1cda8a yunapp-71355c1cda8a` (`0750`)
- Mount seçenekleri (`findmnt`):
  - `ext4 rw,nosuid,nodev,noexec,relatime` (İkili çalıştırma ve yetki yükseltme donanımsal olarak engellidir).

### 2.4. Canlı SFTP Oturumu ve İzolasyon Testi
1. **Oturum ve Dizin Sınırı**:
   - `sftp` ile `yunapp-a404896cf12e@127.0.0.1` bağlandı:
     - `pwd` -> `Remote working directory: /site`
     - `ls` -> `logs tmp`
     - `cd ..` -> `pwd` -> `Remote working directory: /`
     - `ls` -> Yalnızca `site` görünür. Sistemin kök dizini (`/etc`, `/var`, `/home` vb.) kesinlikle görülemez ve erişilemez.
2. **Kabuk Açma Engeli**:
   - `ssh yunapp-a404896cf12e@127.0.0.1 'id'` komutu çalıştırıldı:
     - Yanıt: `This service allows sftp connections only.`
     - Bağlantı derhal sonlandırıldı.
3. **Siteler Arası Erişim Engeli (Cross-Account Isolation)**:
   - `yunapp-a404896cf12e` hesabına ait özel anahtar ile `yunapp-71355c1cda8a` hesabına bağlanma denendi:
     - Yanıt: `yunapp-71355c1cda8a@127.0.0.1: Permission denied (publickey).`
     - SFTP oturumu reddedildi.
4. **Temizlik**:
   - Test için oluşturulan geçici anahtar ve yetkili anahtar yedeği tamamen temizlendi.

## 3. Sonuç
OpenSSH `internal-sftp` chroot mimarisi, yetki kısıtlamaları (`nosuid,nodev,noexec`), salt-anahtarlı kimlik doğrulama (`PasswordAuthentication no`), kabuk yasağı ve iki site arasındaki karşılıklı izolasyon `.28` test sunucusunda başarıyla doğrulanmıştır.
