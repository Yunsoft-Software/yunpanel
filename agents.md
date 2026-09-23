# YunPanel — Geliştirici ve Kodlama Ajanı Kuralları

## Güncel kullanıcı kararı — 2026-09-23: development, sade reseller

Önce bu dosya, sonra [devralınan teknik kurallar](docs/policies/agents-inherited-1a45ded8.md), `plan.md`, `ui-plan.md`, `docs/plesk-feature-parity.md` ve ilgili kod okunur. Devralınan dosya önceki `agents.md` içeriğinin eksiksiz Git blob kopyasıdır. Aşağıdaki açık değişiklikler dışında bütün güvenlik, veri koruma, teknoloji, test ve operasyon kuralları geçerlidir.

### Geçerli ürün ve çalışma kararları

1. **Aktif dal `development`.** Başlangıç `main@1a45ded8697d640b87c149143613454fac1fa94d`. Bu işte `main`e commit/merge/deploy yapılmaz. Her yazımdan önce dal başı kontrol edilir; eşzamanlı değişiklikler ezilmez. Küçük commitler; force push, geçmiş silme ve GitHub Actions yok. Commit mesajlarına `[skip ci]` eklenir.
2. **Plesk görev düzeni korunur; reseller ilk sürümü sadeleşir.** Önceki aynı tarihli “bütün reseller/paket/abonelik özellikleri ilk sürümde zorunlu” kararı kullanıcının son isteğiyle değiştirilmiştir. İlk sürüm Owner → isteğe bağlı tek Reseller → Customer → mevcut Website ilişkisidir. Abonelik ve paket nesnesi site işlemleri için önkoşul değildir. Reseller kendi müşterileri ve onların siteleriyle sınırlıdır. Ayrıntı ve işaretli işler `docs/ux/plesk-full-scope.md` içindedir.
3. **Şimdi geliştirilmeyecek reseller işleri:** alt bayi zinciri, ayrı reseller paket motoru, add-on, abonelik sync/lock/customization, overselling, otomatik süre sonu/fatura, bayi markalama, müşteri↔reseller dönüşümü, toplu transfer ve login-as. Bunlar tamamlandı sayılmaz; sonraki fazdır. Basit müşteri/site adet sınırı yeterlidir; disk/CPU/RAM ölçümü veya gerçekten uygulanan site limitleri bu değişiklikle kaldırılmaz. Reseller dışındaki Plesk yol haritası iptal değildir.
4. **Önce doküman, sonra dar kaynak dilimi.** Mevcut Files iyileştirmeleri ve Plesk UX işleri korunur; UI sadeleştirme gerekçesiyle araç/rota/motor silinmez. Aynı Ember renkleri/fontları/radius ve ortak bileşenlerle devam edilir. Global Dosyalar ve domain File Manager girişleri kalır.
5. **Tamamlanan kaynak alt işleri `[x]` işaretlenir.** Kanıtı ve sınırı belirtilir. Test edilmemiş entegrasyon, migration, tarayıcı veya host kabulü açık bırakılır. Saf politika modülü bütün reseller özelliği değildir; sadece menü gizlemek veya site_manager rolünü yeniden adlandırmak güvenli reseller uygulaması sayılmaz.
6. **Açık kaynak taban değişimi onaylanmadı.** Başka panel kurma, YunPanel'i onunla değiştirme, PHP/Perl backend'e geçme veya iki paneli aynı config dosyasına yazdırma. Kullanıcı kararı ve migration/rollback tasarımı gereklidir.

### Değişmeyen güvenlik ve veri sınırları

- `.44` ile biten Plesk sunucusuna SSH, salt okunur inceleme, test, deploy veya başka amaçla dokunulmaz. Canlı işlemler yalnız repo dışı `.local/test-server.env` içindeki açık izinli YunPanel test hedefinde ve adres teyidinden sonra yapılır.
- React + JavaScript/JSX; TypeScript veya yeni paralel UI motoru eklenmez. Mevcut Node/npm gereksinimleri düşürülmez. Ubuntu mevcut ilk çalışma hedefidir; Windows eşdeğerliği ayrı adapter/kurulum/test hattıdır ve Ubuntu koduyla tamamlandı denmez.
- Root yönetim yetkisi authenticated backend'dedir; frontend'e veya barındırılan siteye verilmez. Site build/runtime/cron/dosya/terminal dedicated site Unix kullanıcısında çalışır. Owner root terminali ile müşteri/site terminali ayrıdır.
- Auth/session/CSRF, backend RBAC, WebSocket reauthorization, secret masking, izinli yerel host, preview/confirmation, resource lock, durable job, idempotency ve rollback korunur. Reseller kapsamını sadeleştirmek tenant izolasyonunu, audit veya oturum iptalini sadeleştirmek değildir.
- Website/Domain/Application kimlikleri birbirinin yerine kullanılamaz. Mevcut veri/Unix kullanıcı/sertifika ilişkileri açık migration ve geri dönüş olmadan yeniden atanmaz. Müşteri veya reseller altındaki siteler aynı Unix kullanıcısına birleştirilmez.
- Parola/token/key/cookie/MFA/private config repoya, genel loga veya ekran görüntüsüne yazılmaz. Mevcut test hostundaki isteğe bağlı MFA kararı devralınan dosyada aynen geçerlidir.
- Uygun mevcut adapter, FilesPanel, ttyd, phpMyAdmin, Roundcube, backup/DNS/mail/runtime motorları yeniden yazılmaz. Fallback ancak gerçek replacement kabulünden sonra kaldırılır. `chmod -R 777`, genel sahiplik değişimi veya güvenlik kapatma çözüm değildir.
- Çalıştırılmamış test, deployment veya canlı sonuç yapılmış diye yazılmaz. Bu turun ek gerçek ortam işleri `docs/ux/development-todo.md`; kök `todo.md` ve mevcut T-PL/T-SITE-WORKSPACE kapıları da geçerlidir.

## Uygulama sırası

Güncel dal/kod/kurallar → sade kapsam dokümanı → küçük kaynak dilimi → çalıştırılabilen test → `plan.md` ve ilgili alt planda kaynak işareti / açık kabul → küçük commit. Reseller erişimi bütün hedef API/job/tool/gateway yollarında güvenli kapsam uygulanmadan etkinleştirilmez. Tarihsel tam-parity reseller satırları yeni MVP'nin yayın engeli değildir; ertelenmiş kalır.
