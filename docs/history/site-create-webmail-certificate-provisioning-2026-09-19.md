# Fresh Website dedicated webmail certificate provisioning progress — 2026-09-19

Bu kayıt, fresh local-mail Website provisioning zincirinde `webmail.<domain>` için ana Website sertifikasından bağımsız, operation-owned `purpose: webmail` ACME certificate lifecycle'ının durable operation'a bağlandığı kaynak dilimini özetler.

## Kaynakta tamamlananlar

- Local-mail planı artık `mail_dns_reapply` sonrasında required `webmail_certificate` step'ini üretir. Step exact Server/Website/Web Domain/Mail Domain kimliğini, `webmail.<domain>` hostname'ini ve beklenen Mail Domain revision'ını pinler.
- Webmail certificate handler yalnız ana Website HTTP route'unda exact `acmeOnlyHostnames` kanıtı ve operation-owned authoritative `mail_dns_reapply` evidence'ı varsa HTTP-01 issuance açar.
- Handler ana Domain'in aktif `purpose: web` certificate selection'ını değiştirmez. Yeni sertifika aynı Web Domain üzerinde `source: acme`, `purpose: webmail`, `provisioningOperationId` ve yalnız `webmail.<domain>` certificate names ile yaratılır.
- Başka lifecycle'a ait canlı `purpose: webmail` certificate fail-closed conflict üretir. Aynı operation'ın active certificate + unique successful `SSL_ISSUE` child job evidence'ı restart/lost-ack sırasında inspect ile ikinci ACME mutation olmadan reconcile edilir.
- Production Website provisioning runtime ve API bootstrap webmail certificate control plane'i certificate, Domain, Mail Domain ve durable job registry bağımlılıklarıyla bağlar.
- Shared Roundcube provisioning artık ana Website `certificate` step'ini değil exact succeeded `webmail_certificate` evidence'ını ister.
- Authoritative mail DNS desired-state'i `webmailHostname` bilgisini `mail_dns_reapply` içinde certificate issuance'tan önce publish eder. Eski post-Roundcube `webmail_dns_reapply` step'i fresh-create planından kaldırılmıştır.
- Website Nginx HTTP config'i ACME-only webmail hostname için challenge path'ini sahiplenir ve normal HTTP isteklerini HTTPS'e yönlendirir. Shared Roundcube Nginx mapping'i mapped webmail host için ikinci bir port-80 server block üretmez; böylece HTTP-01 ownership tek yerde kalır.
- Source-level plan/handler/runtime/Nginx/Roundcube regression testleri yeni ownership ve ordering contract'ına göre güncellenmiştir.

## İlgili commitler

- `bbdf15f` — dedicated `webmail_certificate` provisioning step'i.
- `7307812` — Roundcube'u exact webmail-certificate evidence'ına bağlama.
- `daac64e`, `f9c006a` — runtime ve production API bootstrap wiring.
- `9f8db2a` — authoritative webmail DNS'i certificate issuance öncesine alma ve eski `webmail_dns_reapply` step'ini kaldırma.
- `a7b5081`, `67eac50` — ACME-only webmail HTTP redirect davranışı ve testleri.
- `bb955ef`, `cbb2ad9` — mapped Roundcube HTTP ownership'ini Website Nginx'e bırakma ve regression testi.
- `c8b062e`, `ce2bf40` — Roundcube/provisioning dedicated webmail certificate evidence test wiring'i.

## Açık kalan sınır

Dedicated `purpose: webmail` certificate source lifecycle'ı artık fresh Website durable journal'ına bağlıdır. Bu dilimde ürün-complete sayılmayan kısım source contract'tan çok acceptance ve son health kapılarıdır:

- gerçek Ubuntu 24.04 + Certbot HTTP-01 + public authoritative DNS ile issuance/restart/lost-ack acceptance,
- gerçek shared Roundcube FPM/Nginx endpoint ve mailbox auth acceptance,
- final SMTP/IMAP/webmail cross-service health postcondition'larının Website `ready` kapısına bağlanması,
- autodiscover/autoconfig endpoint lifecycle'ı,
- downstream failure için operation-owned certificate/TLS compensation/retirement acceptance.

Bu sohbet ortamında repository checkout/Node 24 runner bulunmadığından hedefli testler ve full `npm run check` çalıştırılmadı; ilgili kapılar `todo.md` T-CODEX-SOURCE/T-MAIL altında açık tutulur.
