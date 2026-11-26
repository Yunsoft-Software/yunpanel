# Kurulum ve Yükseltme

> **Sürüm:** YunPanel `0.3.0` · **Doğrulanmış kaynak revizyonu:** `c1a84a51` (`c1a84a5159add2f2f87fd6e21725f7c657cf98ec`) · **Doğrulanmış Linux `.deb` paket tabanı:** `0.3.0-2026112301` (`f13b2b78`) · **Arayüz dili:** Türkçe (`tr`)

YunPanel, tek bir yerel Linux sunucusunda çalışan kimlik doğrulamalı Node.js yönetim API'si, yetkili yerel yürütme katmanı ve React tabanlı yönetim arayüzünden oluşur. Barındırılan web siteleri, ayrı sistem kullanıcıları (`yunapp-<ozet>`) altında yalıtılmış olarak çalışır; panel servisleri durdurulsa bile Nginx, PHP-FPM, veritabanı ve posta servisleri kesintiye uğramadan çalışmayı sürdürür.

## Desteklenen Linux dağıtımları ve gereksinimler

Merkezi işletim sistemi katmanı (`os-platform`) aşağıdaki 64 bit (`amd64` ve `arm64`) Linux dağıtımlarını destekler:

| Aile | Dağıtımlar | Paket yöneticisi | Varsayılan PHP-FPM |
| :--- | :--- | :--- | :--- |
| Ubuntu LTS | Ubuntu 20.04 (Focal), 22.04 (Jammy), 24.04 (Noble) | `apt` | 7.4 / 8.1 / 8.3 |
| Debian | Debian 11 (Bullseye), Debian 12 (Bookworm) | `apt` | 7.4 / 8.2 |
| Enterprise Linux | AlmaLinux 8/9, Rocky Linux 8/9, RHEL 8/9 | `dnf` | 7.4 / 8.1 |

- **Çalışma zamanı gereksinimleri:** Node.js `>= 24.11.1` ve npm `>= 11.0.0`.
- **Debian paket bağımlılıkları:** `adduser`, `ca-certificates`, `certbot`, `curl`, `git`, `nginx`, `openssh-client`, `python3-certbot-dns-cloudflare`, `xz-utils`.
- **Ağ ve TLS:** Üretim kurulumlarında `YUNPANEL_PUBLIC_ORIGIN` geçerli bir `https://` kök adresi olmalıdır (sondaki `/` olmadan). Loopback `http://127.0.0.1` yalnızca yerel geliştirme içindir.

## `.deb` paketi ile kurulum

Resmi veya yerel olarak derlenmiş `.deb` paketi kurulduğunda `postinst` betiği şu adımları otomatik ve güvenli biçimde tamamlar:

1. Paket içi kod ve statik varlıkları (`/usr/lib/yunpanel`, `/usr/share/yunpanel`) doğru izinlerle (`0755`/`0644`) yerleştirir.
2. Servis hesaplarını ve yalıtılmış dizinleri oluşturur (`yunpanel`, `vmail`, `yunpanel-mailauth`, `yunpanel-roundcube`, `yunpanel-phpmyadmin`, `yunpanel-elfinder`).
3. Resmi Yunsoft lisans doğrulama açık anahtarını (`kid: 1cbcc4d3173d0c15`) `/etc/yunpanel/control-plane/entitlement-public.pem` yoluna yerleştirir; operatör kendi özel anahtarını yerleştirdiyse üzerine yazmaz.
4. Dahili API ↔ web geçidi belirtecini (`/etc/yunpanel/control-plane/proxy.env`) ve eksik varsayılan store değişkenlerini `/etc/yunpanel/control-plane/api.env` içine ekler.
5. `yunpanel-api.service`, `yunpanel-web.service` ve `yunpanel-sentinel.timer` systemd birimlerini etkinleştirir.

```bash
sudo dpkg -i yunpanel_0.3.0-2026112301_amd64.deb
sudo apt-get -f install
```

Kurulum sonrasında yerel sunucu kimliğini doğrulayın ve API / web servislerinin çalıştığını kontrol edin:

```bash
systemctl is-active yunpanel-api.service yunpanel-web.service yunpanel-sentinel.timer
/usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs status
```

## Temel ortam değişkenleri

Üretim ortam dosyaları `/etc/yunpanel/control-plane/api.env` (`0600`, `root:root`) ve `/etc/yunpanel/web/web.env` yollarında saklanır:

- `YUNPANEL_PUBLIC_ORIGIN`: Panelin gerçek HTTPS adresi (ör. `https://panel.ornek.example`).
- `YUNPANEL_LOCAL_SERVER_ID`: Yerel sunucu UUID kimliği (`local-runtime.mjs` ile oluşturulur ve doğrulanır).
- `YUNPANEL_SECRET_MASTER_KEY`: Uygulama gizli değişkenleri, MFA sırları, DNS/posta kimlik bilgileri ve lisans anahtarı şifrelemesi için 32 baytlık kök anahtar. Yükseltmelerde aynı tutulur; değişimi yalnız çevrimdışı rotasyon aracıyla yapılır.
- `YUNPANEL_OWNER_MFA_REQUIRED`: Üretimde varsayılan `true`.
- `YUNPANEL_LICENSE_COMMERCE_URL`: Varsayılan `https://yunsoft.com/api/commerce`.

## Yükseltme akışı

Yükseltme öncesi aktif işlemlerin tamamlandığını kontrol edin ve gerektiğinde kontrol düzlemi yedeği alın (bkz. [Yedekleme ve Kurtarma](doc:backups-and-recovery)):

```bash
/usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs status
/usr/local/bin/node /usr/lib/yunpanel/scripts/local-migration-backup.mjs create --confirm
```

Panel arayüzünden yükseltme için **Araçlar ve Ayarlar → YunPanel güncellemeleri** (`/settings?section=updates`) ekranını açın:

1. **Güncellemeleri denetle** düğmesiyle APT deposundaki aday sürümü kontrol edin.
2. Yeni sürüm bulunduğunda **YunPanel'i güncelle** ve ardından açık onay adımıyla (`upgrade-yunpanel`) yükseltmeyi başlatın.
3. Yükseltme tamamlandığında `yunpanel-api` ve `yunpanel-web` yeniden başlatılır; özel `/etc/yunpanel/control-plane/` yapılandırmanız ve mevcut siteleriniz korunur.

![YunPanel Araçlar ve Ayarlar dizini](assets/tr/18-tools-settings.png)

## Sonraki adım

Kurulum tamamlandıktan sonra ilk `Owner` hesabını oluşturmak için [İlk Kurulum](doc:first-time-setup) kılavuzuna geçin.
