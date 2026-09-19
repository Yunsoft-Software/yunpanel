# Domain removal Mail Domain metadata cleanup — 2026-09-19

Bu dilim local Mail Domain removal child lifecycle'ında config disable sonrasındaki pinned metadata cleanup fazını ekledi.

## Uygulanan sözleşme

- Durable faz modeli `cleaning` ile `deleting_data` arasına `backing_up` checkpoint'ini ekledi. Cleanup digest'i artık backup job kimliği oluşmadan ayrı ve exact kaydedilebilir.
- Cleanup adapter'ı disabled Mail Domain kimliği/revision'ı ile plan digest'ini doğruluyor; pinned mailbox envanteri eksik veya değişmişse hiçbir dependency mutation'ı yapmıyor.
- Alias, quota, forwarding ve DKIM envanterinde yeni, değişmiş veya yabancı kayıt mutation öncesi fail-closed kalıyor.
- Explicit continuation çağrı başına deterministic sırada yalnız bir forwarding, quota, alias veya DKIM kaydı temizliyor. Mailbox credential kaydı ve mail data backup/data-delete tamamlanana kadar korunuyor.
- Restart inspector delete çağırmıyor. Kalan exact target varsa typed explicit retry istiyor; bütün pinned target'lar yoksa deterministic cleanup digest'iyle `backing_up` fazına geçiyor.
- Mevcut modelde domain-başına ayrı Roundcube mapping kaydı bulunmadığından uygulanmamış bir webmail cleanup mutation'ı uydurulmuyor.

## Doğrulama

- Hedef registry/runtime/domain-parent test kümesi: **55 test geçti**.
- Cleanup adapter hedef testleri: **6 test geçti**.
- API workspace tam testi: **2.577 test geçti**.
- Repository policy validation geçti.

## Kalan sınır

Mailbox credential removal, verified backup/data-delete, final local registry unlink, external metadata unlink, phase router ve production bootstrap wiring henüz hazır değildir. Parent Mail Domain handler production'da dependency yokken fail-closed kalmaya devam eder. Gerçek Ubuntu/mail failure-injection kabulü `todo.md` içindedir.
