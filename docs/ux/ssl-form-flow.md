# UX-PL-06/07 — SSL formu ve kullanıcı e-postası

2026-09-23; başlangıç `development@bed0cafd`. Kapsam `7fdad05a`, taslak modeli `36a46185`, gerçek form bağlantısı `96db8b9b`. Site kartları ve görünür SSL/TLS girişi korunur. Bu dilim kök plandaki BUG-20260923-04/05'in kaynak düzeltmesidir; yeni sertifika motoru veya farklı menü değildir.

## Kaynakta doğrulanan sorun

Önceki `SslOperations`, `session` alanını `useWorkspace()` içinden alıyordu; `WorkspaceContext` bu alanı sunmuyor. Gerçek oturum `usePanelSession()` içinde. Kullanıcı adresi yerine genel `getPanelSettings().dnsSsl.acmeEmail` yolu çalışabiliyordu. `Boolean(email.trim()) && !requested`, otomatik dolan adresi değişiklik sayıyor; kapsam kutuları tek başına izlenmiyor ve başarılı talepten sonra yeni kapsam değişiklikleri gözden kaçıyordu.

## Tamamlanan kaynak alt işleri

- [x] **BUG-20260923-05a:** SSL formu gerçek `usePanelSession()` verisine bağlandı. Geçerli kullanıcı e-postası, yoksa aynı kullanıcının e-posta biçimindeki login adı kullanılır; ikisi de yoksa alan boş ve açıklamalıdır. Bu form artık global ayar/e-posta isteği yapmaz. Adres düzenlenebilir; doğrulama ilk mutation'dan önce de yapılır.
- [x] **BUG-20260923-04a:** e-posta ve beş kapsam/posta atama seçeneği baseline ile karşılaştırılır. İlk dolum dirty değildir. Kullanıcı değişikliği dirty'dir; eski değere dönme ve açık Değişiklikleri sıfırla temiz duruma döner. Başarıdan sonraki yeni değişiklikler de izlenir.
- [x] **BUG-20260923-04b/05b:** geç gelen hesap adresi elle yazılanı veya kasıtlı boş bırakılan alanı ezmez. Form kimliği Domain/server/actor/role/session generation'a bağlıdır; farklı bağlam aynı taslağı devralmaz. CSRF token'ı bu kimliğe dahil edilmez, taslak kalıcı depoya yazılmaz. Bu sınır form içindir; devam eden backend işini iptal etmez.
- [x] **UX-PL-06c:** onaydan vazgeçmek taslağı korur. E-posta, kapsam ve posta atama tercihi async hazırlıktan önce snapshot alınır. Sadece gerçek talebin mevcut akıştaki başarılı bitişi baseline günceller; staging testi veya kuyruk cevabı bu işareti vermez. Yenileme ekranında görünmeyen başvuru formu yanlış çıkış uyarısı üretmez. SSL sertifikası al ve Korunacak alan adları etiketleri kullanılır; kapsama otomatik eklenen aliaslar görünürdür.
- [x] **Seçili testler:** 19 model + 8 kaynak bağlantısı testi, **27 geçti / 0 başarısız / 0 atlandı**. JSX sözdizimi/JavaScript dönüşümü de kontrol edildi.
- [ ] **Üst BUG-04/05 ve UX-PL-06/07 kabulü:** gerçek React, API session, tarayıcı ve host ACME kontrolleri aşağıda açıktır. Kaynak alt işleri üst üretim kabulünü kapatmaz.

## Çalıştırılan kontroller ve sınır

Ortam Node **22.16.0**, npm **10.9.2**. Seçili kaynaklar kullanıldı; tam checkout, `npm ci`, hedef Node24/npm11 `npm run check` yapılmadı.

```sh
node --test apps/web/test/ssl-request-draft.test.js apps/web/test/ssl-form-wiring.test.js
```

Model testleri gerçek reducer/varsayılan/snapshot işlevlerini yürütür. Sekiz wiring testi JSX kaynak metnini inceler; React render veya HTTP listener testi değildir. Ortamın hazır JSX ayrıştırıcısı/dönüştürücüsüyle `SiteOperations.jsx` sözdizimi ve üretilen JavaScript `node --check` kontrolü geçti; modül çözümleme, Vite build veya görsel kabul değildir. Projeye yeni dil/bağımlılık eklenmedi.

Dört değişen kaynak/test dosyası GitHub `96db8b9b` blob SHA'larıyla yerelde sınanan içerik bakımından birebir eşleşti. `useOperation`, `ApplicationOperations` ve `DomainOperations` gövdeleri değişmedi. Önceki 51 kart, 49 gezinme, Files, reseller ve removal testleri bu tur yeniden çalıştırılmadı ve 27'ye eklenmedi.

## T-DEV-SSL-FORM — gerçek ortam TODO

- [ ] Node >=24.11.1/npm >=11 tam checkout'ta `npm ci`, `npm run check`; yeni iki test ve mevcut SSL/session/unsaved/UI regresyonları birlikte çalışsın. Gerçek React/Vite import çözümlemesi ve üretim bundle'ı doğrulansın.
- [ ] Owner ve Site A/Site B hesabıyla kart → SSL/TLS → geri. Kullanıcı e-postası ve e-posta biçimindeki username senaryolarında doğru adres gelsin; adres yoksa global Owner/ACME adresine düşmeden boş alan açıklansın. Network'te bu form için global settings isteği bulunmasın.
- [ ] Hiç değişiklik yokken geri/sekme değişimi/reload uyarısız olsun. E-posta veya her kapsam kutusu değişince uyarı gelsin; eski değere dönme/sıfırlama kaldırmalı. Yalnız kutu değişikliği ve boş e-posta da dirty sayılmalı. Yenileme ekranı gizli başvuru taslağı yüzünden uyarmamalı.
- [ ] Geç gelen kullanıcı adresi, elle yazılan/temizlenen adres, aynı kullanıcının profil güncellemesi, logout/login/MFA rotation ve site değişimi. Taslak başka kullanıcıya/siteye taşınmamalı; onaydan vazgeçme taslağı korumalı. Native browser beforeunload ve React blocker ayrı sınansın.
- [ ] Staging, gerçek issuance, failed/cancelled/timeout, çift tıklama ve durum güncellemesi. Staging sonrası gerçek talep taslağı temizlenmemeli. Gönderilen email/kapsam snapshot'ı formdan gelmeli; sonradan gelen default payload'ı değiştirmemeli. Bu kaynak testleri gerçek Let's Encrypt işlemi yapmadı.
- [ ] Çok adımlı mevcut `issue()` akışında sayfadan ayrılma ve oturum/izin değişimi ayrıca sınansın. React form key'i mevcut istemci orkestrasyonunun veya sunucu job'unun cancellation/tenant güvenliğini tamamlamaz; backend'e bağlı tek görev ve güvenli retry/yeniden yetkilendirme işleri açık kalır.
- [ ] 320/390/834/1440 px, %200 zoom, Chromium/Firefox, klavye/ekran okuyucu; e-posta açıklaması, kapsam kutuları, onay ve sıfırlama eylemi. Mevcut tasarım dili ve görünür Files/SSL/DB/mail girişleri korunsun.

## Bu dilimin dışında kalan mevcut işler

BUG-20260923-06 sertifika süresi/fingerprint/UI senkronizasyonu; mevcut mail identity atamasının hata/kısmi başarı/revizyon işleyişi; teknik stage/activate adımlarının tek kullanıcı görevine dönüştürülmesi; backend orkestrasyonu; alias/hosting formları ve genel tenant/host kabulü. Bunlar tamamlanmış sayılmaz. Form baseline'ının temiz olması Nginx/Postfix/Dovecot canlı sağlığına dair yeni bir kanıt değildir.

`ui-plan.md` bu kaynak işaretlerine ve kabul listesine bağlanır. Kök `plan.md` BUG-04/05 üst kutuları gerçek kabul beklediği için açık kalır. Bu ek, kök `todo.md` ve `docs/ux/development-todo.md` kabullerini kaldırmaz. Yalnız development, küçük commit, `[skip ci]`; main/Actions/Files motoru/tema/deploy/canlı host işlemi yapılmadı.
