# RS-01b — Basit reseller adet sınırları

2026-09-23; `development`. RS-01a sahiplik politikası `cd89f8d8` üzerine küçük ikinci kaynak dilimi.

- [x] `apps/api/src/reseller-limits.js`: açık `maxCustomers` / `maxWebsites`; `null` sınırsız, `0` yeni kayıt yok. Eksik/negatif/kesirli/string/bilinmeyen veri reddedilir. Ayrı paket veya ölçüm motoru eklenmedi.
- [x] Güvenilir tam snapshot'tan bayi toplam müşteri/site sayımı; pasif/askıdaki kayıtlar da sayılır. Diğer bayi ve doğrudan Owner müşterileri dahil edilmez. Duplicate/orphan kimliklerde kullanım sıfır varsayılmaz.
- [x] Saf ekleme kapasitesi kontrolü; limit azaltmak kayıt silmez, yeni eklemeyi engeller. Sayısal taşma ve geçersiz kaynak reddedilir.
- [x] `reseller-limits.test.js`: **66 geçti / 0 başarısız**. İki suite birlikte **107 geçti / 0 başarısız**, **Node v22.16.0**.
- [x] Her iki yeni kaynak dosyasında `node --check` geçti.
- [ ] Gerçek transaction/kilit içinde kontrol+insert, paralel istek yarışı, auth/state entegrasyonu ve canlı kabul: RS-02–05.

Çalıştırılan komut: `node --test apps/api/test/reseller-scope.test.js apps/api/test/reseller-limits.test.js`. İlk test koşusunda tek fixture yanlış hata kodu bekliyordu: kendine parent olan kaydı sınır sayımından önce model doğrulaması reddetti. Kimlik çakışması fixture'ı geçerli doğrudan müşteri ilişkisine düzeltilerek hedeflenen kontrol ayrı sınandı; son koşu 107/107 geçti.

Yalnız connector'dan okunan mevcut `auth-error.js` ve yeni kaynak/test dosyaları yerelde çalıştırıldı; tam depo bağımlılıkları kurulmadı. Node24/npm11 tam `npm run check`, React/Vite, DB migration ve host/browser testleri yapılmadı. Yeni API/UI/login açılmadı. Bu modül istekten gelen kullanım sayısını güvenilir yapmaz; liste pagination sonucu veya eski preview ile enforcement yapılamaz. Entegrasyon tek tutarlı snapshot ve atomik kayıt sağlayana kadar gerçek kota kontrolü tamamlanmış değildir.

Yerelde sınanan Git blob kimlikleri:
- `reseller-scope.js`: `08ec8e59d2de9998952db7bcdff8c8b5d668e731`
- `reseller-scope.test.js`: `252d9aac17dc217a81429576eb0ef175a3f5e7db`
- `reseller-limits.js`: `a07b533e6ce4f67ccb43874c107c8fa6cbc13ba6`
- `reseller-limits.test.js`: `e923a949084412ca5906050761226906875cc02a`
