# AI Yönetim Katmanı Foundation İlerlemesi

**Tarih:** 2026-09-21  
**Branch:** `ai-development`

## Mimari sınır

- AI ayrı privileged daemon, ayrı root transport veya raw shell açmaz.
- Model yalnız server-side Tool Registry'de **bound + policy-allowed** capability şemalarını görebilir.
- Tool input'ları bounded ve schema-validated'dir; modelin uydurduğu/unavailable capability fail-closed reddedilir.
- Mutasyonlar YunPanel'in mevcut durable job, resource-lock, audit, recovery ve rollback sınırlarını kullanır.
- Destructive `always-confirm` tool'lar policy override ile auto-allow yapılamaz.

## Kaynak ilerlemesi

- 20-tool başlangıç kataloğu, `read / reversible_write / destructive` risk sınıfları ve `allow / confirm / deny` policy motoru eklendi.
- SHA-256 digest-bound action preview + exact confirmation sözleşmesi eklendi.
- Provider adapter contract ve provider'ın yalnız izinli capability setinden action proposal üretebildiği orchestrator eklendi. Orchestrator tool çağrısını doğrudan host mutation'a çevirmiyor.
- Production auth/audit zincirine bağlı `/api/ai/tools`, tool preview ve execute HTTP yüzeyi eklendi.
- Root-private `0600` revisioned AI policy store eklendi. Policy update current revision + preview digest + exact confirmation gerektiriyor; destructive global auto-allow ve `backup.restore=allow` reddediliyor.
- Owner-only `/api/ai/policy`, `/api/ai/policy/preview` ve policy apply rotaları production bootstrap'a bağlandı.
- Aşağıdaki tool'lar gerçek control-plane/runtime dependency'lerine bağlandı:
  - read: `server.health`, `website.list`, `website.inspect`, `application.inspect`, `job.inspect`
  - read: `dns.inspect`, `certificate.inspect`, `mail.inspect`, `database.inspect`
  - write: `website.restart`, `service.restart`
- `website.restart` mevcut Node/Python restart operation'ını; `service.restart` mevcut managed-service allowlist + `SYSTEM_SERVICE_CONTROL` durable job'ını kullanır. Public AI response job payload'ını taşımaz.

## Kalan kaynak işi

Provider credential registry + somut provider adapter'ları, conversation/streaming loop, bounded logs/backup inspect, kalan deploy/DNS/certificate/backup write adapter'ları ve global/contextual AI UI açık kalır. Bunlar `plan.md` P1 altında tutulur.

## Kabul sınırı

Gerçek provider credential'ı, gerçek model prompt-injection davranışı, canlı host kill/timeout recovery ve gerçek Chromium/Firefox UI kabulü bu source diliminin kanıtı değildir; `todo.md` içindeki `T-AI` kapısında tutulur.

Bu çalışma sırasında ilk core/runtime/HTTP dilimleri izole Node testleriyle doğrulandı; sonraki branch dilimleri için test dosyaları eklendi. Bu tool ortamında repository checkout/package dependency ağı bulunmadığı için güncel branch üzerinde tam `npm run check` çalıştırılamadı. Bu geçici tool ortamı kısıtı ürün TODO'su değildir; merge öncesi normal local/CI dışı geliştirme akışında tam check çalıştırılmalıdır.
