# Database canlı envanter — 2026-09-17

Production Database GET akışı eski successful inspect-job snapshot'ı yerine aynı local root backend içindeki MySQL/MariaDB manager'dan canlı Unix-socket envanteri okur.

- Production composition tek `createDatabaseManager()` instance'ını hem read-only inventory provider'a hem durable create/drop executor'ına verir.
- `GET /api/servers/:serverId/databases` önce local-server scope'u doğrular, provider sonucunu mevcut strict database job-result sanitizer'ından geçirir ve `Cache-Control: no-store` ile yalnız engine, version, schema adı/boyutu ve `live=true` döndürür.
- Her schema satırı server-scope Website binding'i ve varsa encrypted registry'nin yalnız secret-free credential metadata'sıyla birleştirilir. Parola, ciphertext, IV/tag ve private path response'a taşınmaz.
- Socket/provider hatası, system schema, duplicate veya malformed inventory raw host ayrıntısı taşımadan `database_inventory_unavailable` olur. Duplicate binding, orphan credential, cross-server state veya okunamayan ownership registry ise `database_ownership_state_unavailable` ile fail-closed kalır.
- React Database ekranı açılışta ve Yenile eyleminde canlı GET kullanır; Website sahibi, site Unix user'ı ve credential varlığı schema yanında görünür. “Sunucuyu tara” job'u günlük yüzeyden çıkarılmıştır. Create/drop yine typed confirmation'lı durable job olarak kalır.
- Legacy explicit inspect route ve successful snapshot birleştirme kodu recovery/compatibility ve backup'ın durable inventory evidence ihtiyacı için korunur; backup manifest'i geçici canlı okumaya sessizce çevrilmez.

Odak API/web ve production wiring testleri ownership join, secret redaction ve orphan-state fail-closed vakalarını kapsar. Gerçek local socket GET/refresh kabulü `todo.md` T-DATABASE altında kalır.

Database binding, encrypted credential desired state, schema-only grants, rotation/revoke, backup/restore ve lost-ack recovery daha önce gerçek Ubuntu kabulünden geçmiştir; kanıt `docs/history/database-live-acceptance-2026-09-14.md` içindedir. Kalan P0 işi secure install baseline, Website create/delete entegrasyonu ve shared phpMyAdmin gateway'dir.
