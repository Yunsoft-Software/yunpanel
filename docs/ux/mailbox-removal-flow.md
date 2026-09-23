# MAILBOX-REMOVE — Posta kutusunu mevcut güvenli akışla silme

2026-09-24; başlangıç `development@d6c3dc34`. BUG-20260923-03 / UX-PL-06 alt işi. Kapsam `e135ab84` ile önce yazıldı. Posta kutuları listesine görünür silme girişi eklendi; mevcut mail data backup/delete job ve mailbox finalize motorları kullanıldı. Yeni silme, yedek veya root komut motoru eklenmedi.

## Tamamlanan kaynak

- [x] **MR-01 — `193c532a`:** `mailbox-removal-model.js`; posta kutusu/alan adı/adres/revizyon, güncel etki, yedek önizlemesi ve başarılı iş sonuçları doğrulanır. Kota, yönlendirme, takma ad, aktif iş ve bilinmeyen engel varken yazma açılmaz. Aynı posta kutusuna ait olmayan yedek/veri silme sonucu kabul edilmez; ham job payload veya hata modele taşınmaz.
- [x] **MR-02 — `59c4b8f3`:** `mailbox-removal-controller.js`; açık onaylarla yedekle → başarılı işi doğrula → veriyi sil → başarılı işi doğrula → kaydı kaldır. 202/queued/running başarı değildir. POST öncesi güncel etki ve önizleme yeniden okunur; hedef/snapshot değişirse onay geçersizdir. Aynı controller'da çift gönderim ve belirsiz yazmanın otomatik tekrarı yoktur. Yeni yazma gönderilirken eski iş izleme bileti temizlenir; önceki başarılı yedek, yenileme sırasında sonraki kayıp silme cevabını başarılı saydıramaz.
- [x] **MR-03 — `ed56f721`, `4cdd104f`:** `MailboxRemovalPanel.jsx` mevcut Posta kutuları listesinde Sil… eylemine bağlıdır. Kota/yönlendirme, takma ad ve Yapılandırma ekranlarına dönüş; salt GET ile job takibi, mevcut iş kimliğini okuyarak doğrulama ve hesap kaydı kaldırılana kadar ayrı kısmi sonuç görünümü. Kullanıcı/oturum/yetki/posta alan adı değişiminde eski seçim yeni ekrana taşınmaz. Sonuç kartı silinen kayıt listeden düşse de korunur. Mevcut oluştur/parola/policy/enable eylemleri kaldırılmadı.
- [x] **MR-01 ek backend düzeltmesi — `465bbc4f`, `8e41e85f`:** `mailbox-alias-references.js` ve mevcut `mail-delete-impact.js` bağlantısı. Başka posta alan adlarından gelen alias referansları da silmeyi engeller; yabancı alias kimlikleri/adresleri public sonuca girmez, yalnız toplam engel sayısına katılır. Yerel 50 kimlik sınırı korunur. Global alias okuma hatası boş liste kabul edilmez. Mevcut impact modülü farkı 4 ekleme / 2 silmedir; silme/yedek motorları yeniden yazılmadı.
- [x] **MR-04 — `c08a7bb1`, `e3014b1d`, `a4e58484`:** aşağıdaki seçili son koşuda **53 geçti / 0 başarısız / 0 atlandı**. 35 frontend model/controller davranışı, 12 backend helper/impact davranışı ve 6 kaynak bağlantısı kontrolü.

## Çalıştırılan kontrol ve kanıt sınırı

Node **22.16.0**, npm **10.9.2**:

```sh
node --test apps/web/test/mailbox-removal.test.js apps/web/test/mailbox-removal-wiring.test.js apps/api/test/mailbox-alias-references.test.js
```

Backend 12 testin üçü gerçek `createMailDeleteImpactService` ile yeni helper'ı beraber çalıştırır; registry ve filesystem inspector açık fixture'dır. Frontend request/job sonuçları kontrollü fixture'lardır. Altı wiring testi kaynak metnini denetler; React render testi değildir. Mevcut eski `mail-delete-impact.test.js` değiştirilmedi; yerelde yeniden oluşturulan kopyanın blob eşitliği doğrulanamadığından yardımcı koşudaki sekiz test bu 53'e veya doğrulanmış eski regresyon sayısına eklenmedi.

İki JSX dosyası (`MailboxesPanel`, `MailboxRemovalPanel`) ortamın hazır parser/dönüştürücüsüyle kontrol edildi; üretilen JavaScript ve dört kaynak JS dosyası `node --check` ile geçti. Bu Vite import çözümlemesi veya gerçek React/browser kabulü değildir. Repoya TypeScript, yeni bağımlılık veya lockfile değişikliği eklenmedi.

Test edilen dokuz kaynak/test dosyasının yerel Git blob SHA'sı `a4e58484` GitHub içeriğiyle birebir eşleşti:

| Dosya | Blob SHA |
| --- | --- |
| web mailbox-removal-model.js | 3932d4049f85746b316f471ef6dc85586b53a042 |
| web mailbox-removal-controller.js | d8649f0ecd4edaf98649fe2599f4e86fc2f2327b |
| web MailboxRemovalPanel.jsx | f978474a29570b1fe2b106340df21ec26a3b1b99 |
| web MailboxesPanel.jsx | 5e3a1f5784183f827a80461d8cf433958b8bc629 |
| api mailbox-alias-references.js | 962dc6c5119e47ebc19a49816e1f154b16b2aa81 |
| api mail-delete-impact.js | 13770cb3016a767fa7483855d293834f4a2df355 |
| web mailbox-removal.test.js | 4ed19ba3276bb9e3131f21b19f0e2b447676dbfd |
| web mailbox-removal-wiring.test.js | 33ac3ae785cbcca6cbb5e6d04882e6b9f5cba080 |
| api mailbox-alias-references.test.js | 091a7fffc1073dcba35d670862b2c4e8e812e598 |

## Korunan sınırlar ve açık kod işleri

Mevcut `mail-data-operations.js` silmeden önce ilgili posta alan adının disabled olmasını ister. Bu diğer posta kutularını da etkiler. Arayüz alan adını kendiliğinden durdurmaz/açmaz; kullanıcı etkiyi görüp mevcut Yapılandırma ekranında açık onayla uygular. Kota, forwarding ve alias bağımlılıkları otomatik silinmez. Yedeksiz silme veya yalnız metadata silen alternatif çağrı yoktur. Veri silindikten sonra yeni yedek/silme zinciri otomatik başlatılmaz; bilinen işi okumak yazma tekrarı değildir.

Bu tur kesintisiz tek-posta-kutusu silme altyapısını tamamlamadı. Diğer hesapları durdurmadan yalnız seçilen posta kutusunun gerçek SMTP/IMAP/Roundcube erişimini kapatan backend akışı, aktif oturum sonlandırma ve tekrar etkinleştirme davranışı ayrı kaynak/kabul işi olarak açık. Site yöneticisi alan adını kapatmaya yetkili değilse Owner müdahalesi gerekir; yetki genişletilmedi.

İstemci ön okuması süreçler arası atomik kilit değildir. Alias envanterinin iki okuması muhafazakâr birleştirilir; eşzamanlı alias ekleme ve worker mutation sınırı ayrıca doğrulanmalıdır. Kayıp finalize cevabı sonrasında mailbox 404 tek başına bütün silme zincirinin başarı kanıtı değildir. Sekme yeniden açılınca mevcut iş kimliği elle doğrulanabilir; yeni kalıcı UI işlem deposu yoktur. Gerçek posta hizmetleri veya dosyalar bu tur değiştirilmedi.

## T-DEV-MAILBOX-REMOVE — Codex gerçek kabulü (açık)

- [ ] Node24/npm11 tam checkout/npm ci/lint/test/build; yeni üç testle birlikte mevcut mail-client/mailbox/impact/data/finalizer ve site-scope testleri. Doğrudan Git erişimi bu ortamda DNS hatasıyla engellendi; hedef tam kontrol yapılmadı.
- [ ] Gerçek SessionProvider/React/router ve Owner/Site A/Site B: başka sitenin mailbox/mail-domain/backup/job kimliği, yetki kaybı, logout/login, scope değişimi ve geç cevap reddi. Gerçek HTTP/auth/CSRF ayrıca doğrulansın.
- [ ] Alan adı kapatma ve yeniden açmanın diğer hesaplara etkisi; gerçek Postfix/Dovecot/SMTP/IMAP/Roundcube ve aktif oturum davranışı. Disabled kayıt tek başına canlı erişimin kapandığının kanıtı değildir. Tek-kutu kesintisiz silme backend işi bitmeden bu sınırlama kapanmaz.
- [ ] Doğrulanmış yedek, değişen veri/revizyon, yerel/yabancı alias, forwarding/quota/aktif iş engelleri; 409/429/5xx/yanıt kaybı, çift tıklama, yeniden giriş ve doğru iş kimliğiyle devam. İki tarayıcı/prosesin aynı kaynakta yarışını ve backend mutation anı yetkisini test et.
- [ ] Veri silme başarılı olsa bile finalize başarısızken başarı gösterilmemesi; kayıp finalize cevabı/404 uzlaştırması, korunmuş yedekten gerçek geri dönüş ve kalan hesapların çalışması. Mobil/klavye/odak/koyu tema kabulü. `.44` hostu kapsam dışı; GitHub Actions/canlı deploy yok.

Üst BUG-03, UX-PL-06 ve production kabulü kapanmaz. Website silme/askı, Files, hosting/alan adı alias düzenleyicileri ve backend ortak kilit işleri bu posta kutusu diliminden ayrıdır. `main` değişmedi.
