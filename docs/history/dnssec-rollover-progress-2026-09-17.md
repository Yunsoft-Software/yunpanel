# DNSSEC rollover adapter ilerlemesi — 2026-09-17

PowerDNS DNSSEC host adapter'ı rollover için secret-safe ve optimistic-concurrency korumalı cryptokey primitive'leri kazandı.

- Inspect yalnız cryptokey collection'ın public alanlarını okur; private key içerebilen tek-key endpoint'i kullanılmaz. PowerDNS yanıtında `privatekey` bulunsa bile public state'e taşınmaz.
- Normalize edilmiş public key kümesi deterministik SHA-256 `keySetDigest` üretir. Duplicate key ID, malformed DS/algorithm/bits ve stale preview state'i mutation'dan önce reddedilir.
- KSK/CSK create yalnız `keytype`, `active`, `published`, `algorithm` ve `bits` gönderir; private key content kabul etmez. Baseline key ID kümesi ve digest, lost-ack retry'da yeni anahtarı yeniden gözleyerek ikinci key üretimini engeller.
- Publish/activate/deactivate primitive'i exact before/after digest'leriyle çalışır. Hedef state'e ulaşılmış belirsiz mutation restart/retry'da yeniden doğrulanıp rectification tamamlanır.
- Delete primitive'i exact remaining-key digest'i gerektirir ve başka bir active+published DS taşıyan key yoksa fail-closed kalır. Lost-ack delete yeniden gönderilmeden authoritative key koleksiyonuyla uzlaştırılır.
- Her cryptokey mutasyonu sonrasında zone rectification ve public collection post-condition kontrolü zorunludur.

Bu dilim host mutation temelidir; durable rollover operation journal'ı, SOA/secondary propagation kapıları, parent DS change/retirement aşamaları ve authenticated HTTP/audit yüzeyi `plan.md` içinde açık kalır. Gerçek PowerDNS ve process-kill kabulü `todo.md` T-DNS kapsamındadır.
