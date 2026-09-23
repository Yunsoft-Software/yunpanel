# UX-PL-01f — Files yol ve editör taslağı sürekliliği

## Tamamlanan dar kaynak dilimi

Girişler değişmez: global Dosyalar ve Site → Dosya Yöneticisi. Mevcut `FilesPanel`, API, dosya adapter'ı ve Ember bileşenleri korunur. Yeni dosya motoru veya kalıcı tarayıcı taslak deposu eklenmedi.

Sorun: `SiteFilesPanel` güncel Domain/Website envanteri doğrulanana kadar `FilesPanel`i kaldırıyor. Bu doğru erişim kapısı, yalnız çocuk bileşende tutulan klasör yolu ve editör taslağını da sıfırlıyordu. Erişim kapısı gevşetilmeden durum üstte, tek bir doğrulanmış site/oturum bağlamında tutuldu.

- [x] FILES-CONT-01: `file-session-state.js`; aynı bağlamdaki geçici envanter kesintisinde yol/taslak korunur. Yetki kaybı, doğrulanmış Domain→Website, sunucu veya runtime değişimi eski içeriği yeni hedefe taşımaz. Gecikmiş eski bağlam callback'i yeni bağlamı değiştiremez. Kaynak `38c0004d`, model testleri `9ac8c94b`.
- [x] FILES-CONT-02: `FileWorkspaceSession.jsx` ve `SiteFilesPanel.jsx`; oturum nesli, kullanıcı/rol, yönetim yetkisi ve Domain ID ile anahtarlanmış bellek durumu. Stale envanterle Files hâlâ mount edilmez; geçici kesintide dirty kaydı üstte kalır ve taslak korunma mesajı gösterilir. Eksik provider/kimlik eşleşmesi güvenli biçimde reddedilir. `123a4a50`, `e34170f0`, `2e10eed2`.
- [x] FILES-CONT-03: `FilesPanel.jsx`; yalnız doğrulanmış güncel listelemeden sonra yol hatırlanır. Yeniden açılışta aynı yol, editör metni ve özgün expectedSha256 kullanılır. Mevcut UnsavedChanges mekanizması sayfa/site geçişi ve tarayıcı yenilemesinde uyarır; açıkça vazgeçme/başarılı kayıt mevcut akışı kullanır. Website/sunucu/runtime değişimi bekleyen işleri ve eski çocuk durumunu sıfırlar. `7ed7c7fb`.
- [x] FILES-CONT-04: `file-session-state.test.js` ve `file-session-wiring.test.js`; Node22.16.0 altında **43 geçti / 0 başarısız / 0 atlandı**. 35 saf model + 8 kaynak bağlantısı kontrolü; React render değildir. `FilesPanel`, `SiteFilesPanel`, `FileWorkspaceSession` JSX sözdizimi/dönüşüm kontrolünden geçti. Kaynak bağlantısı testleri `5c0974c1`.

Altı yeni/değişmiş kaynak/test dosyası ile iki değişmemiş test bağımlılığının yerel Git blob SHA'ları GitHub içeriğiyle birebir eşleştirildi. Eski hosting/alias veya tüm repo testleri bu tur yeniden çalıştırılmış sayılmaz. Kontrol için kullanılan parser aracı repo dilini/bağımlılıklarını değiştirmedi; TypeScript kaynak eklenmedi.

Dosya içeriği localStorage/sessionStorage/URL/log'a yazılmaz. Devam eden mutasyonlar, yükleme kuyruğu veya onaylanmış silme talepleri yeniden mount sırasında otomatik tekrarlanmaz. Browser refresh uyarısı kalıcı taslak yedeklemesi değildir; kullanıcı ayrılmayı onaylarsa veya süreç kapanırsa bellek taslağı kaybolur. Yeni dosya/yeniden adlandırma formu ve upload kuyruğu sürekliliği bu editör diliminin dışındadır. Kaydetme esnasında bağlantı koparsa sunucudaki sonuç belirsiz olabilir; otomatik yeniden yazma yapılmaz ve özgün hash korunur.

## T-DEV-FILES-CONT — Codex gerçek kabulü (açık)

Bu ortamda hedef React paketleriyle doğrulama kurulumu denendi; npm registry DNS çözümlemesi `EAI_AGAIN` ile başarısız oldu. Node24/npm11, gerçek React/Vite/router/browser ve host kabulü yapılmadı. Depo paket pinleri veya lockfile değiştirilmedi.

- [ ] Repo pinleriyle Node24/npm11 tam lint/test/build; `node --test apps/web/test/file-session-state.test.js apps/web/test/file-session-wiring.test.js` ve mevcut Files/site erişim regresyonlarını yeniden çalıştır.
- [ ] Owner ve Site A hesabıyla alt klasörde dosya düzenle; envanterin stale/loading/error durumunda Files kapanırken taslak uyarısı kalsın, aynı bağ doğrulanınca aynı yol/içerik/hash geri gelsin. Gerçek React StrictMode ve hook davranışını doğrula.
- [ ] Yenileme hatası, forbidden/unauthorized, silinen/değişen Website ilişkisi, sunucu/runtime değişimi ve Site A→B/oturum değişiminde yanlış hedefe içerik taşınmadığını doğrula.
- [ ] Sekme/site geçişi, geri/ileri ve sayfa yenilemede ayrılma uyarısını dene; vazgeçme taslağı korusun, açıkça bırakma eski bağlamı kapatsın. Router dışı gezinme ve mobil browser sınırlamalarını ayrıca doğrula.
- [ ] Sunucudaki dosya eşzamanlı değişirse korunmuş eski expectedSha256 ile yazma reddedilsin; taslak hata sonrası silinmesin. Başarılı kayıt sonrası dirty durumu temizlensin. Kayıt yanıtı kaybı/abort sonrasında dosyayı yeniden okuyarak sonucu uzlaştır.
- [ ] Yeniden mount sonrası mkdir/rename/delete/upload/save işlemi kendiliğinden başlamasın. Listeleme hatası sessizce site köküne düşmesin; kullanıcı köke kendisi dönebilsin. Mevcut liste/ağaç, klavye, mobil ve tema regresyonlarını doğrula.

Üst UX-PL-01/05/08, T-DEV-FILES ve production kabulü bu kaynak dilimiyle kapanmaz. Kök `todo.md` ve `docs/ux/development-todo.md` kapıları korunur; bu liste T-DEV-FILES için ek kabul kapsamıdır. GitHub Actions ve canlı deploy yok; `.44` Plesk sunucusuna dokunulmadı.
