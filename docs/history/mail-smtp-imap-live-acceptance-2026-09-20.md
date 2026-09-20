# Mail SMTP, IMAP, TLS ve LMTP Gerçek-Host Kabul Raporu (2026-09-20)

## Kapsam ve Amaç

Bu çalışma, `plan.md` P0.4 ve `todo.md` T-MAIL (satır 105) kapsamında belirtilen SMTP (25), Submission (587), SMTPS (465), IMAP (143) ve IMAPS (993) port listener, TLS el sıkışmaları, şifresiz kimlik doğrulama reddi, sender spoofing engellemesi, açık röle engellemesi ve LMTP ile Maildir teslimatının `.28` test sunucusu üzerinde uçtan uca doğrulanmasını belgeler.

## Yapılan Düzeltmeler

1. **Dovecot `first_valid_uid` ve `first_valid_gid` Tanımlaması**:
   - `packages/config-templates/src/mail.js`: Dovecot sanal kullanıcıları `vmail:vmail` (UID 108, GID 115) kimliğiyle çalıştığı için Dovecot'un varsayılan `first_valid_uid = 1000` kısıtlamasına takılıyordu. `renderDovecotMailConfig` içine `first_valid_uid = 100` ve `first_valid_gid = 1` eklendi.
   - `packages/config-templates/test/mail.test.js` testleri güncellendi.
2. **Postfix `smtpd_sender_login_maps` Proxymap Tanımlaması**:
   - `packages/config-templates/src/mail-sql.js`: Postfix `proxymap` servisi güvenlik gereği yalnız `main.cf:proxy_read_maps` içinde kayıtlı tabloları açar. `enableManagedMailSql` fonksiyonunda `smtpd_sender_login_maps` parametresi `postfixParameters` listesine eklenerek proxymap onayına dahil edildi.

## Canlı Test ve Doğrulama Kanıtları (`.28` Sunucusu)

Test Domain: `cryptoraichu.website`
Test Mailbox: `test@cryptoraichu.website`

1. **5 Port Listener Denetimi (`mail_protocol_health_inspector`)**:
   - Port 25 (SMTP): `0.0.0.0:25` ve `[::]:25` açık, dinliyor.
   - Port 587 (Submission): `0.0.0.0:587` ve `[::]:587` açık, dinliyor.
   - Port 465 (SMTPS): `0.0.0.0:465` ve `[::]:465` açık, dinliyor.
   - Port 143 (IMAP): `0.0.0.0:143` ve `[::]:143` açık, dinliyor.
   - Port 993 (IMAPS): `0.0.0.0:993` ve `[::]:993` açık, dinliyor.

2. **TLS ve Kimlik Doğrulama**:
   - **Port 587 (Submission)**:
     - Düz metin AUTH denendiğinde reddedildi: `SMTP AUTH extension not supported`.
     - `STARTTLS` sonrası AUTH PLAIN başarılı: `235 2.7.0 Authentication successful`.
   - **Port 465 (SMTPS)**:
     - Örtük TLS (TLSv1.3) bağlantısı kuruldu, AUTH PLAIN başarılı: `235 2.7.0 Authentication successful`.
   - **Port 143 (IMAP)**:
     - `STARTTLS` müzakeresi ve kimlik doğrulama başarılı.
   - **Port 993 (IMAPS)**:
     - Örtük TLS (TLSv1.3) ile kimlik doğrulama başarılı, INBOX klasörü seçildi.

3. **Gönderici Sahteciliği (Sender Spoofing) Koruması**:
   - Port 587 üzerinden `test@cryptoraichu.website` kimliğiyle oturum açılıp `other@cryptoraichu.website` adına gönderim denendi:
   - Sonuç: `553 5.7.1 <other@cryptoraichu.website>: Sender address rejected: not owned by user test@cryptoraichu.website`.

4. **Açık Röle (Open Relay) Koruması**:
   - Port 25 üzerinden harici adrese yetkisiz posta gönderimi denendi:
   - Sonuç: `554 5.7.1 <relay-test@example.com>: Relay access denied`.

5. **Uçtan Uca LMTP ve Maildir Teslimatı**:
   - Port 587 üzerinden kimlik doğrulamalı olarak `test@cryptoraichu.website` adresine test iletisi gönderildi.
   - Postfix, iletiyi `/var/spool/postfix/private/dovecot-lmtp` soketi üzerinden Dovecot LMTP'ye aktardı.
   - İleti `/var/lib/yunpanel/mail/cryptoraichu.website/test/Maildir/new/` dizinine yazıldı.
   - Dizin izinleri `drwx------`, sahiplik `vmail:vmail` olarak doğrulandı.
   - Port 993 IMAPS üzerinden oturum açılarak iletinin konu ve gövde bütünlüğü doğrulandı.
