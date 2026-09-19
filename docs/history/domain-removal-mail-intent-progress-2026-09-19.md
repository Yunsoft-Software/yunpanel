# Domain removal Mail Domain intent progress — 2026-09-19

Bu checkpoint P0.9 Domain removal journal'ının root ve descendant Mail Domain bağımlılıklarını exact lifecycle intent'iyle pinleyen kaynak dilimini kaydeder. Mail config/data/webmail/DKIM silme mutation'ı bu dilimde açılmamıştır.

## Resource impact ve removal plan

- Resource impact Mail Domain reference'ı artık id ve web-Domain bağının yanında canonical domain name, management mode, status, revision ve update timestamp'i taşır.
- Removal plan yalnız affected root/descendant Domain kümesine exact name ve web-Domain bağıyla bağlı Mail Domain kayıtlarını kabul eder.
- Local mail için yalnız `enabled/disabled`, external mail için yalnız `unverified/ready/degraded` state'leri geçerlidir. Invalid mode/status, duplicate mail identity, duplicate web-Domain binding ve foreign Domain reference fail-closed olur.
- Mail lifecycle revision veya update timestamp değişimi removal preview digest'ini değiştirir; stale confirmation yeni journal başlatamaz.

## Journal ve child delegation

- Yeni journal shape'i sorted `mailDomainIds` yanında exact `mailDomainIntents` saklar. Mail intent'i olmayan certificate-era persisted plan okunabilir kalır fakat `null` hydrate edilir; yeni mutation için evidence uydurulmaz.
- Parent journal yalnız root Domain'e bağlı `mail_domain` step'ini üretir. Descendant Mail Domain intent'i parent planında korunur ancak step yalnız ilgili parent-owned child removal journal'ında oluşur.
- Child preview parent'ta pinlenen descendant mail intent'lerinin tamamını ve yalnız onları exact taşımalıdır. Eksik, fazla veya drifted mail intent'i child journal ve child routing mutation başlamadan `domain_removal_child_preview_drift` ile bloklanır.
- Bu dilim `mail_domain` step'ini continuable yapmaz; mevcut mail delete impact/data-job/finalize zinciri operation-owned restart sözleşmesiyle bağlanana kadar step pending ve public delete apply kapalı kalır.

## Kaynak doğrulama

- Node 24.21 ile resource-impact ve Domain removal plan/registry/runtime hedef kümesinde **67 test geçti, 0 test başarısız**.
- `@yunpanel/api` test paketinin tamamında **2.531 test geçti, 0 test başarısız**.
- Tam repository `npm run check` kapısı Node 24.21 ile geçti: repository policy/lint, bütün workspace testleri ve web production build başarılıdır.
- Bu turda hiçbir sunucuya bağlanılmadı; `.44` production sunucusuna dokunulmadı.

## Sonraki kaynak dilimi

1. Local Mail Domain için disable/config-apply, mailbox/alias/DKIM/webmail cleanup ve verified mail-data delete/finalize sınırlarını tek durable child lifecycle'a bağla.
2. External Mail Domain kaydının provider-side mail/DNS ownership sınırını ayrı ve explicit tut; local destructive akışı external state'e uygulama.
3. Restartta queued/running data job'ı veya incomplete config apply'i replay etmeden inspect/reconcile eden `mail_domain` parent-step handler'ını ekle.
