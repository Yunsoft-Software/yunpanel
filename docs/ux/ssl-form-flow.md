# UX-PL-06/07 — SSL formu ve kullanıcı e-postası

2026-09-23; başlangıç `development@bed0cafd`. Site kartları ve görünür SSL/TLS girişi korunur. Bu dilim, kök plandaki BUG-20260923-04/05'i mevcut site SSL ekranında ele alır; yeni sertifika motoru veya farklı menü kurulmaz.

## Kaynakta doğrulanan sorun

`SslOperations`, `session` alanını `useWorkspace()` içinden almaya çalışıyor; `WorkspaceContext` bu alanı sunmuyor. Gerçek oturum `usePanelSession()` içinde. Sonuçta kullanıcı adresi yerine genel `getPanelSettings().dnsSsl.acmeEmail` yolu çalışıyor. `Boolean(email.trim()) && !requested` denetimi otomatik dolan adresi değişiklik sayıyor; kapsam kutuları tek başına izlenmiyor ve başarılı talepten sonra yeni kapsam değişiklikleri gözden kaçabiliyor.

## Dar uygulama sözleşmesi

- [ ] SSL varsayılan e-postasını gerçek kullanıcı oturumuna bağla; bu form için genel sunucu/ACME e-postası isteğini kaldır. Geçerli kullanıcı e-postası yoksa boş ve düzenlenebilir alan göster; başka hesabın adresini tahmin etme.
- [ ] E-posta ve tüm kapsam/posta atama seçeneklerini başlangıç değerleriyle karşılaştır. İlk yükleme ve otomatik varsayılan güncellemesi dirty değildir; kullanıcı değişikliği dirty'dir. Eski değere dönme ve açık sıfırlama temiz duruma döner.
- [ ] Geç gelen oturum adresi elle yazılanı ezmesin; farklı kullanıcı/site bağlamı taslağı devralmasın. Onay penceresinden vazgeçmek taslağı kaydetmez veya silmez. Başarı baseline'ı yalnız gönderilen değerlerle güncellensin; test talebi gerçek sertifika başvurusu gibi taslağı kapatmasın.
- [ ] Model ve kaynak bağlantı testleri; mümkünse JSX sözdizimi kontrolü. Gerçek React/oturum/browser ve host ACME kabulü ayrı açık tutulur.

## Bu dilimin dışında

Sertifika süre yenileme senkronizasyonu (BUG-20260923-06), mail identity yan etkileri, işlem motorunun backend'e taşınması, bütün provisioning/retry/silme işleri ve alias/hosting formları tamamlanmış sayılmaz. Var olan durable jobs, preview/onay, CSRF, API yetkisi, Files motoru ve tema korunur. Saf form modeli sunucu yetkilendirmesi değildir.

Gerçek kabul: Node >=24.11.1/npm >=11 tam check; Owner/site hesabında otomatik e-posta, boş adres, elle düzenleme, geç gelen session, kapsam kutuları, vazgeçme/sıfırlama, başarı/hata, site/oturum değiştirme ve geri/ileri/reload. Bu kayıt kök `todo.md` ve `docs/ux/development-todo.md` kabullerini tamamlar. Yalnız development, küçük commit ve `[skip ci]`; GitHub Actions ve canlı host işlemi yok.
