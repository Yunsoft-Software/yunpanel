# UX-PL-01f — Files yol ve editör taslağı sürekliliği

## Dar kaynak dilimi

Girişler değişmez: global Dosyalar ve Site → Dosya Yöneticisi. Mevcut `FilesPanel`, API, dosya adapter'ı ve Ember bileşenleri korunur. Bu çalışma yeni dosya motoru veya kalıcı tarayıcı taslak deposu eklemez.

Sorun: `SiteFilesPanel` güncel Domain/Website envanteri doğrulanana kadar `FilesPanel`i kaldırıyor. Bu doğru erişim kapısı, yalnız çocuk bileşende tutulan klasör yolu ve editör taslağını da sıfırlıyor. Erişim kapısı gevşetilmeden durum üstte, tek bir doğrulanmış site/oturum bağlamında tutulmalıdır.

- [ ] FILES-CONT-01: Saf durum modeli; aynı bağlamdaki geçici envanter yenilemesinde yol/taslak korunur. Kullanıcı/oturum/yetki, Domain→Website, sunucu veya runtime değişiminde eski taslak yeni hedefe taşınmaz.
- [ ] FILES-CONT-02: Site dosya girişinde bellekte durum sağlayıcısı; stale envanterle Files mount edilmez. Yetki kaybı veya doğrulanmış bağlantı değişimi eski durumu temizler.
- [ ] FILES-CONT-03: Mevcut FilesPanel bağlantısı; başarılı listelemede yol hatırlanır, editör taslağı ve özgün expectedSha256 korunur. Sayfa/site geçişi ve tarayıcı yenilemesi mevcut UnsavedChanges mekanizmasını kullanır.
- [ ] FILES-CONT-04: Odaklı model/regresyon ve yapılabilen JSX kontrolleri; gerçek ortam kabulü ayrı raporlanır.

Dosya içeriği localStorage/sessionStorage/URL/log'a yazılmaz. Devam eden mutasyonlar, yükleme kuyruğu veya onaylanmış silme talepleri yeniden mount sırasında otomatik tekrarlanmaz. Browser refresh uyarısı kalıcı taslak yedeklemesi değildir; kullanıcı ayrılmayı onaylarsa veya süreç kapanırsa bellek taslağı kaybolur.

## T-DEV-FILES-CONT — Codex gerçek kabulü (açık)

- [ ] Repo pinleriyle Node24/npm11 tam lint/test/build; mevcut Files ve site erişim regresyonlarını yeniden çalıştır.
- [ ] Owner ve Site A hesabıyla alt klasörde dosya düzenle; global kaynak yenilemesi sırasında Files kapanırken taslak uyarısı kalsın, aynı bağ doğrulanınca aynı yol/içerik/hash geri gelsin.
- [ ] Yenileme hatası, forbidden/unauthorized, silinen/değişen Website ilişkisi, sunucu/runtime değişimi ve Site A→B/oturum değişiminde yanlış hedefe içerik taşınmadığını doğrula.
- [ ] Sekme/site geçişi, geri/ileri ve sayfa yenilemede ayrılma uyarısını dene; vazgeçme taslağı korusun, açıkça bırakma eski bağlamı kapatsın.
- [ ] Sunucudaki dosya eşzamanlı değişirse korunmuş eski expectedSha256 ile yazma reddedilsin; taslak hata sonrası silinmesin. Başarılı kayıt sonrası dirty durumu temizlensin.
- [ ] Yeniden mount sonrası mkdir/rename/delete/upload/save işlemi kendiliğinden başlamasın. Listeleme hatası sessizce site köküne düşmesin.

Üst UX-PL-01, T-DEV-FILES ve production kabulü bu kaynak dilimiyle kapanmaz. GitHub Actions ve canlı deploy yok; `.44` Plesk sunucusuna dokunulmaz.
