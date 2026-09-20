# Fresh Website Local-Mail, Dedicated Webmail TLS ve Shared Roundcube Canlı Kabulü (2026-09-20)

**Tarih:** 2026-09-20  
**Hedef Host:** `157.180.11.28` (.28 test sunucusu, Ubuntu 24.04 LTS)  
**Kapsam:** P0.4 Mail ve P0.8 Transactional Website Provisioning kabul kapıları.  

---

## 1. Giriş ve Amaç

YunPanel mimarisinde (`docs/architecture.md`), her local mail domain'in kendine ait `webmail.<domain>` adresi üzerinden sunucu başına tek ve paylaşımlı Roundcube webmail örneğine erişmesi hedeflenmiştir.

Bu kabul testinde:
1. Fresh Website (`mailtest.webrich.news`) oluşturulması:
   - `source.kind: 'new_php'`
   - `dns.mode: 'local'` (PowerDNS gsqlite3)
   - `httpsMode: 'managed'` (Let's Encrypt ACME)
   - `mail.mode: 'local'` (Postfix + Dovecot + Rspamd + Roundcube)
2. 21 adımlı durable transactional provisioning zincirinin başarıyla tamamlanması.
3. Dedicated `purpose: webmail` Let's Encrypt sertifikasının `webmail.mailtest.webrich.news` için üretilmesi.
4. Shared Roundcube Nginx yapılandırmasına (`/etc/nginx/sites-enabled/yunpanel-roundcube.conf`) `webmail.mailtest.webrich.news` vhost'unun eklenmesi ve dedicated PHP-FPM havuzuna (`/run/php/yunpanel-roundcube.sock`) bağlanması.
5. Mailbox oluşturulması (`admin@mailtest.webrich.news`), Dovecot `passdb sql` kimlik doğrulaması ve Roundcube webmail arayüzüne oturum açma (login) testi.

---

## 2. Çalıştırılan Kabul Testleri ve Sonuçları

### 2.1. 21 Adımlı Transactional Provisioning

`.local/acceptance-site-create-local-mail.mjs` üzerinden `POST /api/panel/sites/create-preview` ve `POST /api/panel/sites` çağrıldı. Tüm 21 adım eksiksiz tamamlandı:

| Adım | State | Açıklama |
|---|---|---|
| `application_metadata` | `succeeded` | Application kaydı oluşturuldu |
| `website_metadata` | `succeeded` | Website kaydı oluşturuldu |
| `primary_domain_metadata` | `succeeded` | Primary domain kaydı oluşturuldu |
| `mail_domain_metadata` | `succeeded` | Mail Domain kaydı oluşturuldu (`disabled` başlangıç) |
| `unix_identity` | `succeeded` | Dedicated Unix user/group ve ev dizini oluşturuldu |
| `elfinder` | `succeeded` | elFinder site connector hazırlandı |
| `php_bootstrap` | `succeeded` | PHP container dizinleri ve index.php hazırlandı |
| `php_runtime` | `succeeded` | PHP-FPM havuzu ve soketi oluşturuldu |
| `sftp` | `sftp` | SFTP dizinleri ve OpenSSH Match bloğu hazırlandı |
| `dns_zone` | `succeeded` | PowerDNS authoritative zone oluşturuldu |
| `nginx` | `succeeded` | Nginx HTTP vhost oluşturuldu |
| `domain_activation` | `succeeded` | Domain trafiğe açıldı |
| `certificate` | `succeeded` | Let's Encrypt sertifikası alındı (`mailtest.webrich.news`) |
| `tls_activation` | `succeeded` | Nginx HTTPS vhost aktif edildi ve HTTP->HTTPS redirect kuruldu |
| `mail_config` | `succeeded` | Mail Domain `disabled -> enabled` geçişi ve SQLite seed uygulandı |
| `mail_dkim_key` | `succeeded` | Deterministic DKIM anahtarı üretildi |
| `mail_dns_reapply` | `succeeded` | Authoritative DNS'e MX, SPF, DKIM TXT ve `webmail` A kaydı işlendi |
| `webmail_certificate` | `succeeded` | Let's Encrypt sertifikası alındı (`webmail.mailtest.webrich.news`) |
| `mail_dkim_config` | `succeeded` | Rspamd DKIM signing yapılandırması bağlandı |
| `roundcube_mapping` | `succeeded` | Shared Roundcube vhost'u `webmail.mailtest.webrich.news` için yapılandırıldı |
| `mail_health` | `succeeded` | 5'li port denetimi (25, 587, 465, 143, 993) ve autodiscover kontrolü doğrulandı |

**Sonuç:** `Provisioning Status: ready, Ready: true`.

### 2.2. Canlı Endpoint Doğrulaması

1. `https://mailtest.webrich.news` -> `HTTP/1.1 200 OK` (PHP runtime canlı).
2. `https://webmail.mailtest.webrich.news` -> `HTTP/1.1 200 OK` (Roundcube arayüzü canlı, `roundcube_sessid` cookie verildi).

### 2.3. Mailbox Oluşturma ve Dovecot Kimlik Doğrulaması

1. `POST /api/panel/mailboxes` ile `admin@mailtest.webrich.news` oluşturuldu.
2. `POST /api/panel/mail-domains/:id/config-apply` ile Postfix/Dovecot SQLite veri tabanına senkronize edildi (`job cbe132ee-51cd-482e-bc4c-48b3d93b83c4` başarılı).
3. Dovecot kimlik doğrulaması:
   ```bash
   doveadm auth test admin@mailtest.webrich.news 'SecureMailPassword123!'
   # Çıktı: passdb: admin@mailtest.webrich.news auth succeeded
   ```
4. Hatalı parola ve var olmayan kullanıcı denetimi:
   ```bash
   doveadm auth test admin@mailtest.webrich.news 'WrongPassword123'
   # Çıktı: passdb: admin@mailtest.webrich.news auth failed (exit code 77)

   doveadm auth test nonexist@mailtest.webrich.news 'SomePassword'
   # Çıktı: passdb: nonexist@mailtest.webrich.news auth failed (exit code 77)
   ```

### 2.4. Roundcube Webmail Oturum Açma (Login) Doğrulaması

Roundcube web arayüzünden `_user=admin@mailtest.webrich.news` ve parolasıyla POST yapıldı:
- HTTP Yanıt Kodu: `302 Found`
- Redirect: `/?_task=mail&_token=...`
- Yeni Oturum Çerezi: `roundcube_sessauth=SaktWEa2lZgtQHfWdZnvf5HA8H-1789882500`
- Sonuç: Oturum başarıyla açıldı, kullanıcı doğrudan gelen kutusuna yönlendirildi.

---

## 3. Tamamlanan Kabul Maddeleri

- `Fresh Website local-mail provisioning kabulü` (todo.md T-MAIL).
- `Shared Roundcube mapping gerçek Ubuntu kabulü` (todo.md T-MAIL).
- `Local mail seçilen Website provisioning'i` (todo.md T-MAIL).
- `Shared Roundcube package + dedicated PHP-FPM pool/socket` (todo.md T-MAIL).
- `Roundcube login'i gerçek Dovecot IMAP ile geçerli enabled mailbox'ta çalışması` (todo.md T-MAIL).
