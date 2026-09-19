# Site-create local mail config provisioning progress — 2026-09-19

## Bu dilimde tamamlanan source işler

Fresh Website create akışındaki local mail intent'i, mevcut durable managed-mail apply/rollback primitive'lerine bağlandı.

- Local Mail Domain create hâlâ deterministic ID ile önce `disabled` metadata reserve eder.
- Enable preview artık zero-mailbox durumda bloklanmaz. Hiçbir default mailbox veya bilinen parola yaratılmaz; mailbox listesi boş kalabilir.
- Zero-mailbox config'te Dovecot `postmaster_address` operasyonel olarak `postmaster@<domain>` kullanabilir; bu bir login/account kaydı değildir ve SQL seed'e mailbox eklenmez.
- Production `createApp` wiring'i site-create route'una `mailDomainRegistry` geçirir.
- Site-create provisioning planı local mail için iki yeni durable adım taşır:
  - `mail_domain_metadata`: create metadata'sının operation-owned readiness kanıtı.
  - `mail_config`: certificate step'inden sonra zorunlu managed-mail enable/config apply.
- External mail yalnız `mail_domain_metadata` taşır; local Postfix/Dovecot mutation'ına girmez.
- `website-mail-provisioning-handler.js` exact Website/Web Domain/Mail Domain ownership ve revision intent'ini doğrular.
- Apply child job'ları Website operation'a özel public `type` ve attempt-bound idempotency key kullanır. Crash/lost-ack inspect aynı operation-owned job'ı bulur; enabled state operation evidence yoksa sahiplenilmez.
- Failed apply child job sonrası explicit Website step retry yeni deterministic attempt yaratabilir; önceki failed idempotency key'e kilitlenmez.
- Child apply success yalnız v3 exact result, backup/readiness/config digests ve Mail Domain `disabled@1 -> enabled@2` reconciliation kanıtıyla Website step'ini başarılı sayar.
- Compensation mevcut `MAIL_CONFIG_ROLLBACK` primitive'ini kullanır. Source apply daha yeni global mail config tarafından supersede edilmişse fail-closed kalır. Başarılı rollback `enabled@2 -> disabled@3` reconciliation kanıtını bekler.
- Website provisioning runtime production bootstrap'ta `jobRegistry + mailDomainRegistry + domainRegistry + mailConfigurationService` ile mail handler'ı init/restart recovery öncesinde configure eder.

## Source test kontratları

Yeni/güncellenen testler:

- `apps/api/test/mail-configuration-v2.test.js`
  - zero-mailbox enable preview/materialization
  - SQL domain seed var, virtual mailbox insert yok
  - preview/evidence içinde password hash/default mailbox sızıntısı yok
- `apps/api/test/site-create-mail-provisioning.test.js`
  - local metadata + compensatable config step
  - certificate -> mail_config order
  - pre-create metadata pending ile post-create succeeded state arasında immutable intent
  - external mail local stack'e girmez
  - mail none legacy step setini korur
- `apps/api/test/website-mail-provisioning-handler.test.js`
  - durable apply + reconciled enabled state
  - lost-ack inspect ownership recovery
  - managed rollback compensation
  - failed child sonrası yeni attempt
  - foreign enabled state/ownership drift fail-closed

Bu sohbet ortamında repository checkout/Node 24 runner olmadığı için testler burada yürütülmedi. Exact komutlar `todo.md` T-CODEX-SOURCE kapısına eklendi.

## Hâlâ açık kalan fresh Website local-mail zinciri

Bu dilim yalnız Mail Domain metadata + managed config enable/rollback katmanını bağlar. Aşağıdakiler hâlâ Website provisioning journal'ına eklenmelidir:

1. operation-owned DKIM generate/apply + DNS intent,
2. `webmail.<domain>` certificate coverage'ın exact kanıtı,
3. shared Roundcube mapping bind/apply,
4. mail/discovery/webmail DNS desired-state re-apply,
5. SMTP/IMAP/Roundcube/public DNS cross-service health gates,
6. bu son postcondition'lar tamamlanmadan Website `ready` olmaması,
7. gerçek Ubuntu failure-injection ve delivery/login kabulü.
