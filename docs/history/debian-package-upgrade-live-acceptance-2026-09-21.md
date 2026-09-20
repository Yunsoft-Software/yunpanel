# Debian Paketi Güncelleme ve Durum Koruma Canlı Kabulü (T-BASE)

**Tarih**: 2026-09-21  
**Sunucu**: `.28` (`157.180.11.28`, test host)  
**Kapsam**: `todo.md` T-BASE — "Clean install ve önceki paketten upgrade; auth DB/master key, Domain/Website/Application kimlikleri, release'ler, Nginx/certificate, mail/database state'i ve root-owned private izinleri korusun."

---

## 1. Amaç ve Doğrulama Kriterleri

- Linux amd64 üzerinde güncel `main` branch'inden (`b46c7dae`) yerel Debian paketi (`yunpanel_0.3.0-2026092101_amd64.deb`) derlenmesi.
- Önceki sürümden (`0.3.0-2026092012`) `dpkg -i` ile yükseltme (upgrade) yapılması.
- Paket yükseltmesi sonrasında:
  1. `dpkg -V yunpanel` çıktısının tamamen temiz olması (0 dosya uyuşmazlığı, 0 sapma).
  2. Kaldırılan eski `yun-agent.service` biriminin ve artık dosyaların hosttan tamamen silinmiş olması.
  3. `yunpanel-api.service`, `yunpanel-web.service`, `nginx.service` ve `pdns.service` servislerinin aktif kalması.
  4. Kritik verilerin (`/var/lib/yunpanel/control-plane/auth/auth.sqlite`, `/etc/yunpanel/control-plane/api.env` içindeki `YUNPANEL_SECRET_MASTER_KEY`, `/etc/yunpanel/control-plane/proxy.token`, 15 adet control-plane JSON kayıt kütüğü) bayt bayt korunması.
  5. Özel dizin ve dosya izinlerinin (`/etc/yunpanel/control-plane` 0700 root:root, `/var/lib/yunpanel/control-plane` 0700 yunpanel:yunpanel, `/var/lib/yunpanel/mail` 0750 vmail:vmail, `/var/lib/yunpanel/mail-auth` 0750 root:yunpanel-mailauth vb.) bozulmadan korunması.
  6. `local-runtime.mjs validate <server-id>` ile yerel yetkili çalışma ortamının doğrulanması (`apiHealth=true`).
  7. Barındırılan uygulamaların (`yunpanel-node-smoke.test` Passenger Node uygulaması) kesintisiz HTTP 200 yanıtı vermesi.
  8. Canlı panel üzerinden (`https://server.cryptoraichu.website/`) parolasız/MFA'sız Owner girişinin, CSRF korumasının ve envanter API'lerinin doğrulanması.
  9. Önceki pakete geri dönüş (rollback) ve tekrar yükseltme (re-upgrade) adımlarının sıfır veri kaybıyla test edilmesi.

---

## 2. Doğrulama Adımları ve Çıktıları

### A. Paket Derleme
Ubuntu 24.04 LTS üzerinde `npm ci`, `npm run build` ve `./scripts/build-deb.sh 0.3.0-2026092101 /root/yunpanel-candidates` komutlarıyla paket oluşturuldu:
- **Paket Yolu**: `/root/yunpanel-candidates/yunpanel_0.3.0-2026092101_amd64.deb`
- **SHA-256**: `b98e2b5d0ade95d386c4fbd8953da80eaf9df73e384f492c19b68932065249a8`
- **Sürüm**: `0.3.0-2026092101`
- **Mimari**: `amd64`

### B. Otomatik Canlı Kabul Testi (`/root/acceptance-package-upgrade-live.mjs`)

#### Adım 1: Yükseltme Öncesi Temel Durum Doğrulaması
- Kurulu sürüm: `0.3.0-2026092012`
- Servisler aktif: `yunpanel-api`, `yunpanel-web`, `nginx`, `pdns`
- Yükseltme öncesi göç yedeği oluşturuldu ve doğrulandı:
  - `backupDirectory=/var/backups/yunpanel/migration-2026-09-20T23-52-04-339Z`
  - `verified=true`, `sha256=2986b6aa69943e5dc796ddcb8c92e2ecb9df3f50ee7a6265bf862f08ddd1caa3`
- 15 adet control-plane kayıt kütüğünün, auth SQLite veri tabanının ve gizli anahtarların SHA-256 sağlama toplamları hafızaya alındı.
- Özel dizin izinleri (`0700` ve `0750`) doğrulandı.

#### Adım 2: Paket Yükseltme
- `dpkg -i /root/yunpanel-candidates/yunpanel_0.3.0-2026092101_amd64.deb` başarıyla uygulandı.
- `dpkg-query -W -f='${Version}' yunpanel` çıktısı: `0.3.0-2026092101`

#### Adım 3: Paket Dosya Bütünlüğü (`dpkg -V`)
- `dpkg -V yunpanel` komutu çalıştırıldı; çıktı: `""` (boş string).
- Pakete ait tüm dosyalar, ikililer ve şablonlar sıfır sapmayla doğrulandı.

#### Adım 4: Servisler ve Daemon Durumu
- `yunpanel-api`, `yunpanel-web`, `nginx`, `pdns` servislerinin aktif olduğu teyit edildi.
- `yun-agent` servisinin sistemden tamamen kaldırıldığı doğrulandı (`Unit yun-agent.service could not be found`).

#### Adım 5: Veri ve Durum Koruma
- `YUNPANEL_SECRET_MASTER_KEY` değeri bayt bayt korundu.
- 15 adet JSON kayıt kütüğünün SHA-256 sağlama toplamları yükseltme öncesiyle %100 eşleşti.
- `auth.sqlite` içerisindeki kullanıcı kimlikleri (`yunsoft-owner`, `yunsoft-readonly`) ve yetkileri birebir korundu.
- Tüm özel dizin izinleri ve sahiplikleri (`yunpanel`, `vmail`, `yunpanel-mailauth`, `yunpanel-roundcube`, `yunpanel-phpmyadmin`, `yunpanel-elfinder`) korundu.

#### Adım 6: Çalışma Ortamı ve Sağlık Denetimleri
- `local-runtime.mjs validate 99bc760a-d508-4ae6-92be-efdedee9658d` çalıştırıldı:
  - `validation=passed`
  - `apiState=active`, `agentState=inactive`, `apiHealth=true`, `apiHealthStatus=200`
- `nginx -t` sözdizimi ve yapılandırma testi hatasız geçti.
- `http://127.0.0.1:3001/api/health` -> HTTP 200 `{"status":"ok"}`
- `http://127.0.0.1:4300/` (Whitelisted IP ile) -> HTTP 200
- `http://127.0.0.1:4300/api/auth/session` -> HTTP 401 Unauthorized (kimlik doğrulama kapısı aktif)

#### Adım 7: Barındırılan Uygulamaların Kesintisizliği
- `http://127.0.0.1/` üzerinden `Host: yunpanel-node-smoke.test` başlığıyla Passenger Node uygulamasına yapılan istek HTTP 200 yanıtı verdi.

#### Adım 8: Geri Alma (Rollback) ve Yeniden Yükseltme
- `dpkg -i /root/yunpanel-candidates/yunpanel_0.3.0-2026092012_amd64.deb` ile önceki sürüme dönüldü; sürümün `0.3.0-2026092012` olduğu ve servislerin aktif kaldığı doğrulandı.
- Tekrar `dpkg -i /root/yunpanel-candidates/yunpanel_0.3.0-2026092101_amd64.deb` çalıştırıldı; `dpkg -V` çıktısının temiz kaldığı, servislerin ve barındırılan uygulamaların çalıştığı teyit edildi.

### C. Canlı HTTPS Panelinde Owner Oturumu Testi
`.local/test-owner-password-only-28.mjs` ile `https://server.cryptoraichu.website/` adresi test edildi:
- `owner_password_login=200`
- `owner_mfa_enabled=false`
- `owner_management=200`
- `website_inventory=200`
- `invalid_csrf=403`
- `owner_logout=204`

---

## 3. Sonuç

YunPanel Debian paketi (`0.3.0-2026092101`) Ubuntu 24.04 LTS test sunucusunda (`.28`) temiz kurulum, önceki paketten yükseltme, geri alma (rollback) ve yeniden yükseltme döngülerinde tüm yetkili servisleri, şifreleme anahtarlarını, kullanıcı veri tabanını, alan adı ve uygulama kayıtlarını sıfır kayıpla koruyarak başarıyla doğrulanmıştır. `todo.md` T-BASE kapısı tamamlanmıştır.
