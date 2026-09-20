# Mail Sender-Login, Relay, Rate Abuse ve Rspamd Policy — 2026-09-20

Bu doküman, P0.4 kapsamında Postfix ve Dovecot e-posta altyapısında sender-login mismatch, açık röle engelleme (anti-open-relay), hız/kötüye kullanım koruması (rate abuse / anvil) ve Rspamd Milter makro entegrasyonu kaynak kod yaşam döngüsünü özetler.

## Yapılan Değişiklikler

1. **Sender-Login Mapping & Aliases**:
   - `packages/config-templates/src/mail-submission.js`: `renderPostfixSenderLoginMap(mailboxes, aliases)` fonksiyonuna alias desteği eklendi. Kullanıcıların sahip oldukları alias adresleri (`source`) üzerinden de (`destinations` eşleşmesiyle) kimlik doğrulayıp e-posta gönderebilmesi sağlandı. `enableManagedMailSubmission` ve `previewManagedMailSubmissionConfiguration` boru hattına `aliases` aktarımı bağlandı.
   - `packages/config-templates/src/mail-sql.js`: `renderPostfixSqlSenderLoginLookup` sorgusu güncellendi:
     `SELECT address FROM virtual_mailboxes WHERE address = '%s' AND enabled = 1 UNION ALL SELECT destinations FROM virtual_aliases WHERE source = '%s' AND enabled = 1`
     böylece SQLite virtual-mail modunda hem posta kutusu sahipleri hem de alias sahipleri yetkili gönderici olarak doğrulandı.

2. **Açık Röle (Relay) ve Alıcı (Recipient) Politikası**:
   - `packages/config-templates/src/mail-security.js`:
     - `smtpd_relay_restrictions = 'permit_mynetworks, reject_unauth_destination'` (korundu).
     - `smtpd_recipient_restrictions = 'permit_mynetworks, reject_unauth_destination'` eklendi; port 25 üzerinden gelen e-postalarda yetkisiz hedeflere teslim kesin olarak engellendi.
     - `smtpd_helo_required = 'yes'` ve `smtpd_helo_restrictions = 'permit_mynetworks, reject_invalid_helo_hostname, permit'` ile geçersiz HELO/EHLO komutları sınırlandı.
     - `smtpd_sasl_auth_enable = 'no'` (port 25'te düz metin kimlik doğrulama kapalı).

3. **Hız ve Kötüye Kullanım Koruması (Rate Abuse / Anvil)**:
   - `packages/config-templates/src/mail-security.js`: Postfix `anvil` servisine bağlı hız sınırlama parametreleri tanımlandı:
     - `anvil_rate_time_unit = '60s'`
     - `smtpd_client_connection_rate_limit = '30'` (dakikada istemci IP başına azami bağlantı)
     - `smtpd_client_message_rate_limit = '100'` (dakikada istemci IP başına azami mesaj)
     - `smtpd_client_recipient_rate_limit = '200'` (dakikada istemci IP başına azami alıcı)
     - `smtpd_client_connection_count_limit = '50'` (eşzamanlı azami bağlantı)
     - `smtpd_client_new_tls_session_rate_limit = '30'` (dakikada azami yeni TLS oturumu)
     - `smtpd_error_sleep_time = '1s'` (hata durumunda yavaşlatma)
     - `smtpd_soft_error_limit = '10'`
     - `smtpd_hard_error_limit = '20'`

4. **Rspamd Milter Entegrasyon Makroları**:
   - `milter_mail_macros = 'i {mail_addr} {client_addr} {client_name} {auth_authen}'` parametresi tanımlandı. Postfix, Rspamd Milter'a istemci IP'si, gönderen adresi ve kimliği doğrulanmış kullanıcıyı (`{auth_authen}`) aktararak Rspamd'nin kullanıcı bazlı hız sınırlarını, anti-spam kurallarını ve DKIM imzalamayı doğru bağlamda uygulamasını sağladı.

5. **Readiness Denetimi**:
   - `packages/host-runtime/src/mail-readiness-inspector.js`: `candidateRelayPolicySatisfied` fonksiyonu, `smtpd_recipient_restrictions`, `smtpd_helo_required`, `smtpd_helo_restrictions`, `milter_mail_macros` ve tüm `anvil` hız sınırlama parametrelerini doğrulayacak şekilde genişletildi.

## Doğrulama
- Tüm workspace testleri (`npm test`) ve tip/lint kontrolleri (`npm run check`) Node 24 üzerinde çalıştırıldı ve %100 başarıyla tamamlandı.
