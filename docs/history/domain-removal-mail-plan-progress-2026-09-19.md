# Domain removal Mail Domain removal plan — 2026-09-19

Bu dilim Mail Domain child runtime için side-effect-free, exact dependency snapshot'ı üreten removal-plan provider'ını ekledi.

## Tamamlanan kaynak işi

- Mail Domain id/web-Domain/domain name/management mode/status/revision/update evidence'ı exact local-server binding ile doğrulanıyor.
- Local mailbox, alias, quota, forwarding ve DKIM kayıtları stable kimlik + revision + update timestamp ile deterministic sırada cleanup planına alınıyor.
- Domain mail-data inspector çıktısındaki `present`, byte count ve snapshot SHA-256 evidence'ı plana bağlanıyor; host path, UID/GID ve benzeri ayrıntılar preview'a taşınmıyor.
- Cleanup plan digest'i parent operation kimliğine, removal yöntemine ve blocker setine bağlı preview digest/typed confirmation üretiyor. Dependency revision değişikliği hem planı hem confirmation'ı değiştiriyor.
- Queued/running Mail Domain job'ı start confirmation üretimini blokluyor; job payload veya kimliği public blocker'a kopyalanmıyor.
- External Mail Domain preview'ı local DKIM key veya mail filesystem inspector'ına girmiyor. External kayda bağlı local mailbox/alias/quota/forwarding state'i metadata unlink öncesi fail-closed blocker oluyor.
- Credential hash, DKIM public/private material, forwarding/alias destination, host path ve raw job payload cleanup planına alınmıyor.

## Doğrulama

- Removal-plan hedef testleri: 6 geçti.
- API test paketi: 2559 geçti, 0 başarısız.
- Repository lint ve `git diff --check`: geçti.
- Testler Node.js `v24.21.0` ile çalıştırıldı.

## Kalan sınır

Plan provider kaynakta hazır olsa da cleanup plan henüz durable Mail Domain child journal'a yazılmıyor. Registry schema migration, phase adapter'ları ve production bootstrap/parent-handler wiring'i tamamlanmadan hiçbir mail mutation'ı veya public Domain delete apply yüzeyi açılmaz.

Bu turda hiçbir sunucu bağlantısı veya deploy yapılmadı; `.44` ile biten production sunucusuna dokunulmadı.
