# Managed Mail SMTP 25, Submission 587, SMTPS 465 ve IMAPS 993 TLS Policy

**Tarih:** 2026-09-20  
**Kapsam:** `P0.4` Mail — SMTP 25, Submission 587, SMTPS 465 ve IMAPS 993 policy; plain auth yalnız TLS altında.

## 1. Değişiklik Özeti

- `packages/config-templates/src/mail.js`:
  - Dovecot `renderDovecotMailConfig` içine `service imap-login` eklendi (`inet_listener imap { port = 143 }` ve `inet_listener imaps { port = 993, ssl = yes }`).
  - Dovecot auth (`disable_plaintext_auth = yes`) ve TLS prefix (`ssl = required`, `ssl_min_protocol = TLSv1.2`) ile birleşerek IMAP 143 üzerinde plain auth yalnız STARTTLS sonrasında, IMAPS 993 üzerinde ise bağlantı anından itibaren zorunlu TLS ile çalışması sağlandı.
- `packages/config-templates/src/mail-submission.js`:
  - `POSTFIX_SUBMISSIONS_SERVICE` (port 465, `submissions inet n - n - - smtpd`) tanımlandı: `smtpd_tls_wrappermode = yes`, `smtpd_tls_security_level = encrypt`, `smtpd_sasl_auth_enable = yes`, `smtpd_tls_auth_only = yes`, `smtpd_tls_mandatory_protocols = >=TLSv1.2`, `smtpd_relay_restrictions = permit_sasl_authenticated,reject`, `smtpd_sender_restrictions = reject_sender_login_mismatch`.
  - `POSTFIX_MASTER_SERVICES` ile hem `submission` (587) hem de `submissions` (465) servisleri master konfigürasyonuna eklendi; `mailSubmissionTemplatePolicy.services` export edildi.
- `packages/config-templates/src/mail-sql.js`:
  - `sqlMasterServices` transformer'ı hem `submission` hem de `submissions` servislerindeki `smtpd_sender_login_maps` parametrelerini SQLite lookup (`proxy:sqlite:/etc/postfix/yunpanel-sql/sender-login.cf`) ile güncelleyecek şekilde genişletildi.
- `packages/config-templates/src/mail-apply-plan.js`:
  - `canonicalMasterServices` hem `submission` hem de `submissions` servislerini doğrulayıp `postconf -M` ve `postconf -P` komutlarını deterministic sırayla üretecek şekilde güncellendi.
- `packages/host-runtime/src/mail-protocol-health-inspector.js`:
  - `PROTOCOLS` listesine `submissions` (port 465) ve `imaps` (port 993) eklendi.
- `apps/api/src/website-mail-health-provisioning-handler.js`:
  - Mail health protocol listener doğrulamasında 5 protokolün (`smtp:25`, `submission:587`, `submissions:465`, `imap:143`, `imaps:993`) kanıtı zorunlu kılındı.
- Testler:
  - `packages/config-templates/test/`: `mail.test.js`, `mail-submission.test.js`, `mail-apply-plan.test.js`, `mail-sql.test.js`, `mail-teardown.test.js`.
  - `packages/host-runtime/test/`: `mail-protocol-health-inspector.test.js`, `mail-config-activator.test.js`, `mail-srs-activator.test.js`, `mail-config-evidence-inspector.test.js`, `mail-srs-evidence.test.js`, `mail-empty-managed-set.test.js`.
  - `apps/api/test/`: `website-mail-health-provisioning-handler.test.js`, `mail-configuration-empty-disable.test.js`, `mail-empty-managed-set-http.test.js`, `mail-empty-managed-set.test.js`.

## 2. Doğrulama ve Kabul

- `npm test` ve `npm run check` (tüm paketler ve workspace'ler) Node 24 ortamında %100 başarıyla tamamlandı.
- Gerçek Ubuntu sunucusu üzerinde port 25/587/465/143/993 listener ve TLS handshake doğrulaması `todo.md` T-MAIL altına kaydedildi.
