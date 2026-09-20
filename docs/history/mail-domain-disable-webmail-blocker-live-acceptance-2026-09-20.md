# Mail Domain Disable ve Webmail Mapping Blocker/Teardown Canlı Kabulü (2026-09-20)

**Tarih:** 2026-09-20  
**Hedef Host:** `157.180.11.28` (.28 test sunucusu, Ubuntu 24.04 LTS)  
**Kapsam:** T-MAIL ve P0.4 `Mail Domain disable ve delete işlemlerinde aktif/in-flight webmail mapping blocker ve teardown kabulü`.  

---

## 1. Giriş ve Amaç

YunPanel mimarisinde (`docs/architecture.md`):
1. Bir Mail Domain üzerinde aktif veya işlem halindeki (`active`, `pending`, `removing`) Roundcube webmail mapping varken, posta alan adının devre dışı bırakılması (disable) veya silinmesi fail-closed olarak durdurulmalı (`mail_domain_webmail_mapping_active` engelleyicisi).
2. Webmail mapping silindiğinde (`POST /api/panel/mail-domains/:id/webmail/delete` ve `continue`), Nginx üzerindeki shared Roundcube yapılandırmasından (`/etc/nginx/sites-enabled/yunpanel-roundcube.conf`) yalnızca ilgili `webmail.<domain>` server bloğu kaldırılmalı, diğer alan adlarına ait bloklar (`cryptoraichu.website`) ve ortak PHP-FPM havuzu korunmalıdır.
3. Webmail mapping silinip `removed` tombstone oluştuktan sonra, Mail Domain disable veya delete işlemi engelleyici olmadan tamamlanabilmelidir.

---

## 2. Çalıştırılan Kabul Testleri ve Sonuçları

### 2.1. Aktif Webmail Varken Disable Blocker Doğrulaması

`mailtest.webrich.news` Mail Domain'i aktif webmail mapping'e sahipken:
- `POST /api/panel/mail-domains/:id/config-preview` (`status: 'disabled'`) çağrıldı.
- Sonuç: `readyToApply: false` ve `blockers: ['mail_domain_webmail_mapping_active']` döndü.
- İşlem fail-closed olarak engellendi.

### 2.2. Webmail Mapping Silme ve Nginx Teardown

1. `POST /api/panel/mail-domains/:id/webmail/delete-preview` çağrıldı.
2. `POST /api/panel/mail-domains/:id/webmail/delete` çağrıldı (`state: 'removing'` başladı).
3. `POST /api/panel/mail-domains/:id/webmail/continue` çağrılarak `roundcube.config.apply` işi kuyruğa alındı (`49f84f28-ec47-416f-90d3-04fcab041085`).
4. İş sunucuda tamamlandıktan sonra ikinci `continue` çağrısı yapıldı:
   - `mapping.state`: `removed`
   - `deleted`: `true`
   - Tombstone başarıyla oluşturuldu.

### 2.3. Sunucuda Nginx Yapılandırması Doğrulaması

`/etc/nginx/sites-enabled/yunpanel-roundcube.conf` kontrol edildi:
- `webmail.mailtest.webrich.news` server bloğunun tamamen kaldırıldığı doğrulandı.
- `cryptoraichu.website` server bloğunun ve PHP-FPM soket proxy direktiflerinin sağlam kaldığı doğrulandı.
- Yetim (orphan) webmail server bloğu kalmadığı teyit edildi.

### 2.4. Blocker'ın Kalkması ve Mail Domain Disable Uygulaması

1. Tekrar `POST /api/panel/mail-domains/:id/config-preview` (`status: 'disabled'`) çağrıldı:
   - `readyToApply: true`
   - `blockers: []` (`mail_domain_webmail_mapping_active` engelleyicisinin kalktığı kanıtlandı).
2. `POST /api/panel/mail-domains/:id/config-apply` ile disable uygulandı:
   - `job 9660bf4c-984a-4ce5-b245-7a941636a8f3` başarıyla tamamlandı.
   - Mail Domain `status: 'disabled', revision: 3` durumuna geçti.

---

## 3. Tamamlanan Kabul Maddeleri

- `Mail Domain disable ve delete işlemlerinde aktif veya in-flight Roundcube webmail mapping blocker ve teardown kabulü` (`todo.md` T-MAIL).
- `Domain ve Mail Domain disable/delete yalnız kendi Roundcube/webmail mapping'ini kaldırsın` (`plan.md` P0.4).
