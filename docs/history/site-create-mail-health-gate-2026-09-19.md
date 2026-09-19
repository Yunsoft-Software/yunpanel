# Fresh Website local-mail health gate progress — 2026-09-19

Bu kayıt, fresh local-mail Website provisioning zincirinde Website'in mail stack'i gerçekten gözlenmeden `ready` olmasını engelleyen source health-gate dilimini özetler.

## Kaynakta tamamlananlar

- Local-mail planı artık shared Roundcube mapping'den sonra required `mail_health` step'ini taşır.
- Final source sırası authoritative DNS wrapper ile birlikte:
  `certificate → tls_activation → mail_config → mail_dkim_key → mail_dns_reapply → webmail_certificate → mail_dkim_config → roundcube_mapping → mail_health`.
- `mail_health` side-effect-free ve inspect-first çalışır; compensation gerektirmez. Adım başarılı olmadan generic Website provisioning planı `ready` olamaz.
- Handler exact operation-owned `mail_config`, `mail_dkim_config` ve `roundcube_mapping` sibling evidence'ını zorunlu tutar.
- Canlı Mail Domain state'i tekrar doğrulanır ve apply sırasında kullanılan exact `configurationSha256` ile `mailConfigurationService.materializeCurrent(...)` yeniden materialize edilir.
- Mevcut `MailReadinessInspector` current private preview üstünde tekrar çalıştırılır; Postfix/Dovecot/Rspamd service/config/TLS/relay/storage readiness'i başarısızsa Website bloklu kalır.
- Yeni read-only `MailProtocolHealthInspector` SMTP 25, submission 587 ve IMAP 143 listener'larını `ss` üzerinden kontrol eder. Public evidence socket address/output taşımaz; yalnız bounded protocol readiness + SHA-256 digest taşır.
- Shared Roundcube endpoint resolver current mapping revision, successful apply job ve HTTPS endpoint evidence'ını tekrar üretmeden health step tamamlanmaz.
- Runtime ve production bootstrap mail, DKIM ve Roundcube control-plane'lerinden sonra `mail_health` handler'ını bağlar.
- Plan, handler, host inspector, runtime wiring ve authoritative-DNS ordering için source regression testleri eklenmiştir.

## İlgili commitler

- `e3cefe9`, `3ef11e0` — required `mail_health` plan step'i ve plan testi.
- `2c28592`, `a2d08d5`, `d7581ab`, `53a497f`, `e1786fd` — read-only SMTP/submission/IMAP listener inspector ve test düzeltmeleri.
- `329ce5a`, `d3fc32f` — cross-service health handler ve fail-closed testleri.
- `9d9511a`, `c07e7ca`, `9f8801d` — runtime/production wiring ve dependency-order testi.
- `79fc046` — authoritative DNS planında Roundcube sonrası health ordering regression testi.

## Açık kalan sınır

Bu source gate gerçek public-network veya mailbox credential login kabulünün yerine geçmez. Fresh Website bilinçli olarak default mailbox/parola yaratmadığı için site-create anında mailbox-auth E2E yapılmaz.

Açık acceptance işleri:

- gerçek Ubuntu 24.04 hostta SMTP 25, submission 587 STARTTLS/auth ve IMAP listener/service davranışı,
- explicit oluşturulmuş enabled mailbox ile Dovecot auth, Postfix submission ve Roundcube login E2E,
- public HTTPS `webmail.<domain>` browser/Certbot/Nginx kabulü,
- inbound/outbound teslim, LMTP/Maildir, Rspamd/DKIM/SPF/DMARC acceptance,
- autodiscover/autoconfig endpoint lifecycle'ı,
- failure-injection ve restart sınırlarının gerçek host doğrulaması.

Bu sohbet ortamında repository checkout/Node 24 runner olmadığı için hedefli testler ve full `npm run check` çalıştırılmadı; bunlar `todo.md` T-CODEX-SOURCE/T-MAIL kapılarında açık tutulur.
