# Domain removal Mail Domain cleanup-plan journal — 2026-09-19

Bu dilim side-effect-free Mail Domain removal preview'ının exact cleanup planını durable child operation journal'ına taşıdı.

## Tamamlanan kaynak işi

- Mail Domain removal operation store schema'sı v2 oldu; cleanup plan ve SHA-256 digest'i operation intent'inin private parçası olarak `0700/0600` store'a yazılıyor.
- Mailbox/alias/quota/forwarding/DKIM ve mail-data plan shape'i restartta yeniden doğrulanıyor. Duplicate identity, cross-domain address, external kayda local dependency, eksik local data snapshot veya digest tamper state load'u fail-closed bırakıyor.
- Public child operation view cleanup plan içeriğini taşımıyor; yalnız plan digest'i ve bounded recovery metadata'sı yayınlanıyor.
- Runtime start, registry'deki plan digest'inin güncel preview ile aynı olduğunu doğruluyor. Plansız operation executor veya inspector'a verilmeden bounded `mail_domain_removal_plan_missing` state'ine bloklanıyor.
- V1 store migration plansız operation'ları v2'ye kayıpsız okuyor ve mutation replay etmiyor. Hiçbir faza başlamamış aynı source/parent pending intent güncel preview ile güvenli recapture edilebiliyor; ilerlemiş veya farklı intent otomatik sahiplenilmiyor.

## Doğrulama

- Removal plan + child registry + child runtime hedef testleri: 26 geçti.
- API test paketi: 2562 geçti, 0 başarısız.
- Repository lint ve `git diff --check`: geçti.
- Testler Node.js `v24.21.0` ile çalıştırıldı.

## Kalan sınır

Journal artık adapter'ların kullanacağı exact cleanup planını taşır; fakat config disable, mailbox/alias/quota/forwarding/DKIM/webmail cleanup, backup/data delete, final metadata unlink adapter'ları ve production bootstrap wiring henüz yoktur. Bu nedenle parent Mail Domain handler production'da fail-closed kalmaya devam eder.

Bu turda hiçbir sunucu bağlantısı veya deploy yapılmadı; `.44` ile biten production sunucusuna dokunulmadı.
