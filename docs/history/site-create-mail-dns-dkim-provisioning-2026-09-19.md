# 2026-09-19 — Fresh Website local-mail DNS/DKIM provisioning ilerlemesi

Bu dilim, yeni bir Website `mail.mode=local` ile oluşturulurken Mail Domain config apply sonrasında DKIM anahtarı üretimi, authoritative PowerDNS mail desired-state re-apply'i ve DKIM signing config apply'ini aynı durable Website provisioning operation'ına bağlar.

## Kaynakta tamamlananlar

- `site-create-mail-provisioning.js` deterministic provisioning operation kimliğinden DKIM selector türetip `mail_dkim_key` ve `mail_dkim_config` step'lerini üretir.
- `site-create-dns-provisioning.js`, operation-owned DKIM key step'i olmadan local authoritative mail DNS adımı üretmez; `mail_dns_reapply` step'i exact Mail Domain revision/status, DKIM key revision ve selector kimliğini pinler.
- Website provisioning sırası local mail için certificate step'inden sonra `mail_config -> mail_dkim_key -> mail_dns_reapply -> mail_dkim_config` olacak şekilde kaynakta bağlıdır.
- DKIM key handler exact Website/Web Domain/Mail Domain ownership ve revision fence'iyle anahtarı üretir veya mevcut operation-owned anahtarı inspect eder; public evidence yalnız selector/revision ve DNS RR digest'i taşır.
- Mail DNS handler mevcut durable zone re-apply runtime'ını kullanır; exact desired mail state + DKIM TXT kaydını doğrular, apply sonrası digest/serial postcondition'ı ister ve yalnız child-operation evidence'ıyla rollback açar.
- DKIM config handler durable `MAIL_DKIM_APPLY` child job'larını operation/attempt idempotency kimliğiyle enqueue/reconcile eder; DNS desired state hazır değilse fail-closed bekler. Compensation önce sibling mail-config rollback'ini doğrular, ardından operation-owned DKIM cleanup job'ını yürütür.
- Production bootstrap'ta DKIM key, mail DNS ve DKIM config provisioning handler'ları Website provisioning runtime'a kayıtlıdır.
- Yeni source testleri site-create step sırasını, DKIM key lifecycle'ını, mail DNS desired-state/rollback akışını ve DKIM signing config apply/cleanup davranışını kapsayacak şekilde eklenmiştir.

## Bu dilimde tamamlanmayanlar

- Managed certificate provisioning handler hâlâ gerçek issue/select/activate işlemi yerine pending placeholder döndürmektedir.
- Fresh Website için shared Roundcube `webmail.<domain>` bind/apply step'i Website provisioning journal'ına henüz bağlı değildir.
- Cross-service SMTP/IMAP/webmail health gate ve Website `ready` finalization tamamlanmamıştır.
- Gerçek Ubuntu 24.04, PowerDNS, SMTP/IMAP ve browser acceptance bu ortamda çalıştırılmamıştır.
- DKIM rotation/retirement ve genel mail abuse/forwarding/SRS/autodiscover ürün işleri açık kalır.

Kaynak testlerini bu sohbet ortamında çalıştırma imkânı olmadığından ilgili Node 24 hedef testleri ve `npm run check` kapısı `todo.md` altında açık tutulur.
