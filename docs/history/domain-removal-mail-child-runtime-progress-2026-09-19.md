# Domain removal Mail Domain child runtime — 2026-09-19

Bu dilim, önceki root-private Mail Domain removal child registry'sinin üstüne side-effect adapter'larından bağımsız durable orchestration sözleşmesini ekledi.

## Tamamlanan kaynak işi

- Exact `mail_domain_remove` preview digest ve typed confirmation yeniden doğrulanmadan child operation başlatılmıyor.
- Preview mutation öncesi durable registry'ye yazılıyor; aynı parent intent'i idempotent, farklı intent veya aktif foreign parent operation fail-closed kalıyor.
- `start` ve `retry` çağrıları en fazla bir durable faz çalıştırıyor. Blocked/failed operation yalnız exact operation/update/digest'e bağlı retry confirmation ile resume ediliyor.
- Executor ve inspector çıktıları exact alan listesi, operation identity, source status, `updatedAt` fence'i ve side-effect işaretiyle doğrulanıyor. Genişletilmiş/secret taşıyabilecek sonuçlar kabul edilmiyor.
- Executor hatası bounded `failed` child state'e; belirsiz veya geçersiz restart inspection sonucu bounded `blocked` state'e yazılıyor.
- Startup yalnız interrupted `disabling`, `cleaning`, `deleting_data` ve `finalizing` fazlarını side-effect-free inspector ile inceliyor. `pending`, `blocked` ve `failed` işler otomatik yürütülmüyor; startup hiçbir phase executor çağrısı yapmıyor.
- Local akışın config-disable, cleanup, backup/data-delete ve finalization evidence zinciri ile external metadata-unlink ayrımı registry kontratı üzerinden korunuyor.

## Doğrulama

- Mail Domain child runtime hedef testleri: 9 geçti.
- Parent handler + child registry + child runtime birleşik hedef testleri: 52 geçti.
- API test paketi: 2553 geçti, 0 başarısız.
- Repository lint ve `git diff --check`: geçti.
- Testler Node.js `v24.21.0` ile çalıştırıldı.

## Kalan sınır

Bu runtime gerçek Postfix/Dovecot/Rspamd/Roundcube veya mail data mutation'ı yapmaz. Config disable, mailbox/alias/DKIM/webmail cleanup, verified backup-bound data delete, final registry unlink, external metadata unlink phase adapter'ları ve production bootstrap/parent-handler wiring'i halen `plan.md` kapsamındadır. Gerçek Ubuntu/mail failure-injection kabulü `todo.md` içinde kalır.

Bu turda hiçbir sunucu bağlantısı veya deploy yapılmadı; `.44` ile biten production sunucusuna dokunulmadı.
