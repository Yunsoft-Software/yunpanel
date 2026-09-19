# Domain removal Mail Domain config disable — 2026-09-19

Bu dilim local Mail Domain removal lifecycle'ının ilk gerçek side-effect fazını, mevcut durable mail configuration job sistemi üzerinde hazırladı.

## Tamamlanan kaynak işi

- Enabled local kaynak için removal preview exact mail-configuration disable preview digest'i ve configuration SHA-256 evidence'ını cleanup planına ekliyor. Disable konfigürasyonu hazır değilse child start confirmation üretilmiyor.
- Child operation store v3 schema'sı pinned config intent'ini private cleanup planıyla doğruluyor. Enabled kaynak intent olmadan, disabled/external kaynak ise gereksiz local config intent'iyle yüklenemiyor.
- V1/v2 plansız veya eski-plan kayıtlar v3'e mutation-free migrate oluyor; yalnız untouched pending aynı source/parent intent güncel preview ile recapture edilebiliyor.
- Config phase enabled kaynakta ilk explicit çağrıda yalnız durable `disabling` intent'i üretiyor. Job sonraki explicit continuation'da deterministic `mail-domain-remove-disable:<operationId>` idempotency key ile dispatch ediliyor.
- Enqueue cevabı kaybolursa private job idempotency lookup exact request'i buluyor ve ikinci job üretmeden aynı job ID'sini child evidence'a bağlıyor.
- Startup inspector job enqueue etmiyor. Missing/pending/unreconciled job bounded blocker bırakıyor; exact v3 result digest'leri ve source+1 disabled revision doğrulanınca `cleaning` fazına geçiliyor.
- Başlangıçta disabled local kaynak config job oluşturmadan `cleaning` fazına geçiyor ve source revision'ını koruyor.

## Doğrulama

- Config-disable phase hedef testleri: 8 geçti.
- Removal plan + child registry + child runtime + config phase birleşik hedef testleri: 35 geçti.
- API test paketi: 2571 geçti, 0 başarısız.
- Repository lint ve `git diff --check`: geçti.
- Testler Node.js `v24.21.0` ile çalıştırıldı.

## Kalan sınır

Config-disable adapter kaynakta hazırdır fakat henüz tam phase router'a veya production bootstrap'a bağlanmamıştır. Mailbox/alias/quota/forwarding/DKIM/webmail cleanup, verified backup/data-delete, final local registry unlink ve external metadata unlink adapter'ları halen eksiktir; parent Mail Domain step'i production'da fail-closed kalır.

Bu turda hiçbir sunucu bağlantısı veya deploy yapılmadı; `.44` ile biten production sunucusuna dokunulmadı.
