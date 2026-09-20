# Mail Forwarding, Alias and SRS Lifecycle

Tarih: 2026-09-20

## 1. Kapsam ve Amaç

YunPanel e-posta mimarisinde (P0.4) posta kutusu yönlendirmeleri (Dovecot Sieve), posta takma adları (Postfix virtual_aliases) ve SRS (Sender Rewriting Scheme / PostSRSd) bileşenlerinin yaşam döngüleri, bağımlılık kontrolleri ve karşılıklı yönlendirme döngüsü (cross-routing cycle) korumaları tamamlanmıştır.

## 2. Yapılan Değişiklikler

### Posta Kutusu ve Takma Ad Yaşam Döngüsü Bağımlılık Korumaları (`apps/api`)
1. **Takma Ad Referans Koruması (`apps/api/src/mailbox-http.js`)**:
   - `assertDeleteDependenciesCleared(mailboxId, mailboxAddress)` fonksiyonuna `mailAliasRegistry` entegre edildi.
   - Silinmek istenen posta kutusu adresi herhangi bir aktif takma adın (`mailAlias`) hedef listesinde (`destinations`) yer alıyorsa, silme işlemi `mailbox_delete_alias_reference_configured` (409) koduyla durdurulur.
   - Böylece yetim/askıda kalan (dangling) takma ad hedeflerinin oluşması engellenmiştir.

2. **Yönlendirme ve Takma Ad Çapraz Döngü Koruması (`apps/api/src/mail-configuration.js`)**:
   - `assertNoMailRoutingCycles(forwardings, aliases)` eklendi ve `materializeConfiguration` adımı içine entegre edildi.
   - Aynı adresin hem yönlendirme kaynağı (`forwarding source`) hem de takma ad kaynağı (`alias source`) olması durumunda `mail_configuration_state_invalid` (409) fırlatılır.
   - Sieve yönlendirmeleri ile Postfix takma adları arasında çapraz yönlendirme döngüleri (`A -> B` ve `B -> A`) tespit edilerek `mail_configuration_routing_cycle` (409) ile fail-closed engellenir.
   - `assertNoMailRoutingCycles` fonksiyonu `mailConfigurationInternals` üzerinden dışa aktarıldı.

### Test ve Doğrulama
1. `apps/api/test/mail-configuration-srs.test.js`:
   - Çapraz yönlendirme döngüsü test senaryosu eklendi (`cross-routing cycle between mailbox forwarding and alias fails closed`).
   - Aynı adresin hem yönlendirme hem takma ad kaynağı olması durumunun engellenmesi test edildi (`address cannot be both a forwarding source and a mail alias source`).
2. `apps/api/test/mailbox-http.test.js`:
   - Takma ad referansı bulunan bir posta kutusunun silinmeye çalışıldığında `mailbox_delete_alias_reference_configured` hatası döndüğü doğrulandı.

## 3. Doğrulama

- `@yunpanel/config-templates` testleri: 100% başarılı.
- `@yunpanel/api` testleri: 2871 testin tamamı başarılı (0 fail).
- Gerçek Ubuntu host üzerindeki uçtan uca teslimat ve SRS rewrite kontrolleri `todo.md` T-MAIL altında izlenmektedir.
