# YunPanel — Geliştirici ve Kodlama Ajanı Kuralları

## Güncel kullanıcı kararı — 2026-09-23, development ve tam Plesk eşdeğerliği

Bu dosya aktif giriş kuralıdır. Önce bu dosya, sonra [devralınan teknik kurallar](docs/policies/agents-inherited-1a45ded8.md), `plan.md`, `ui-plan.md`, `docs/plesk-feature-parity.md` ve ilgili kod okunur. Devralınan dosya önceki `agents.md` içeriğinin eksiksiz Git blob kopyasıdır. Aşağıdaki açık değişiklikler dışında bütün güvenlik, veri koruma, teknoloji, test ve operasyon kuralları geçerlidir.

### Önceki kararlara göre değişenler

1. **Aktif dal `development`.** Kullanıcının açık isteğiyle `main@1a45ded8697d640b87c149143613454fac1fa94d` üzerinden açıldı. Bu işte `main`e commit/merge/deploy yapılmaz. Yeni değişikliklerden önce `development` başı okunur; eşzamanlı değişiklikler ezilmez. Küçük commitler; force push, geçmiş silme ve GitHub Actions yok.
2. **Hedef tam Plesk işlevsel eşdeğerliği.** Yönetici Service Provider/Power User, reseller, müşteri, ek kullanıcı, hizmet paketi, add-on, abonelik, kota, kaynak aşımı ve ticari entegrasyonlar kapsam içindedir. Önceki `agents.md`, `ui-plan.md`, `docs/architecture.md`, UX atlas/matris veya tarihsel raporlardaki reseller/customer/subscription/Windows/toolkit kapsam dışı ifadeleri bu ürün kapsamı bakımından geçersizdir. Mevcut backend'in bu yetenekleri uyguladığı varsayılmaz.
3. **İlk iş yine Files ve Plesk UX.** Mevcut Ember renkleri/fontları/radius ve ortak bileşenler korunur. Plesk'in görev yerleşimi alınır; marka/CSS/kaynak kodu kopyalanmaz. Hem global Dosyalar hem domain File Manager bulunabilir kalır. Global giriş aynı gerçek site dosya yüzeyine bağlanır; mevcut motor UX gerekçesiyle kaldırılmaz.
4. **Tamamlanan kaynak alt işleri `[x]` işaretlenir.** Kullanıcının son isteği önceki yalnız-açık-liste kuralının bu kısmını değiştirir. Her işaret kaynak/test kanıtını ve sınırını belirtir. Kaynak alt işi kapansa bile gerçek host/browser kabulü yapılmayan üst özellik açık kalır. Sırf dosya yazıldı diye tüm özellik veya production-ready işaretlenmez.
5. **Açık kaynak taban değişimi henüz onaylanmadı.** ISPConfig/Hestia/Froxlor/Virtualmin araştırması uygulanmış mimari kararı değildir. Başka paneli sunucuya kurma, YunPanel'i onunla değiştirme, PHP/Perl backend'e geçme veya iki paneli aynı config dosyasına yazdırma. Kullanıcı kararı ve migration/rollback tasarımı gereklidir.

### Değişmeyen güvenlik ve veri sınırları

- `.44` ile biten Plesk sunucusuna SSH, salt okunur inceleme, test, deploy veya başka amaçla dokunulmaz. Canlı işlemler yalnız repo dışı `.local/test-server.env` içindeki açık izinli YunPanel test hedefinde ve adres teyidinden sonra yapılır.
- React + JavaScript/JSX; TypeScript veya yeni paralel UI motoru eklenmez. Mevcut Node/npm gereksinimleri düşürülmez. Ubuntu mevcut ilk çalışma hedefidir; Windows eşdeğerliği ayrı adapter/kurulum/test hattıdır ve Ubuntu koduyla tamamlandı denmez.
- Root yönetim yetkisi authenticated backend'dedir; frontend'e veya barındırılan siteye verilmez. Site build/runtime/cron/dosya/terminal dedicated site Unix kullanıcısında çalışır. Owner root terminali ile müşteri/site terminali ayrıdır.
- Auth/session/CSRF, backend RBAC, WebSocket reauthorization, secret masking, izinli yerel host, preview/confirmation, resource lock, durable job, idempotency ve rollback korunur. Yeni reseller rolü yalnız menü gizleme değildir; bütün kaynaklar ve API'ler hiyerarşik yetkiyle sınanır.
- Website/Domain/Application kimlikleri birbirinin yerine kullanılamaz. Mevcut veri/Unix kullanıcı/sertifika ilişkileri açık migration ve geri dönüş olmadan yeniden atanmaz. Abonelik modeli başına siteleri sessizce tek Unix kullanıcısına birleştirme.
- Parola/token/key/cookie/MFA/private config repoya, genel loga veya ekran görüntüsüne yazılmaz. Mevcut test hostundaki isteğe bağlı MFA kararı devralınan dosyada aynen geçerlidir.
- Uygun mevcut adapter, FilesPanel, ttyd, phpMyAdmin, Roundcube, backup/DNS/mail/runtime motorları yeniden yazılmaz. Fallback ancak gerçek replacement kabulünden sonra kaldırılır. `chmod -R 777`, genel sahiplik değişimi veya güvenlik kapatma çözüm değildir.
- Çalıştırılmamış test, deployment veya canlı sonuç yapılmış diye yazılmaz. Bu turun ek gerçek ortam işleri `docs/ux/development-todo.md`; kök `todo.md` ve mevcut T-PL/T-SITE-WORKSPACE kapıları da geçerlidir.

## Uygulama sırası

Güncel dal/kod/kurallar → küçük kaynak dilimi → çalıştırılabilen test → `plan.md` kaynak alt işareti ve açık kabul → küçük commit. Özellik envanterindeki açık kutu eksik eşdeğerlik kabulüdür; var olan motorun yok sayılması değildir. Marketplace/OS/premium sağlayıcı farkları `docs/plesk-feature-parity.md` içinde ayrı izlenir ve kapsamdan sessizce çıkarılmaz.
