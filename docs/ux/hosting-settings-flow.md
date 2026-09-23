# Barındırma yönlendirme ayarları — kaynak devamı

Tarih: 2026-09-23. Dal: `development`. İlgili üst işler: UX-PL-04 / UX-PL-06. Bu rapor hosting formunun, UI bağlantısının veya canlı kabulün tamamlandığı anlamına gelmez.

## Önceki turun kontrolü

`plan.md` başındaki UX-PL-04c / 06d bölümü önceki alias kaynak aktarımını (`027b664f`, `e3ac0fc9`), kaydetme/yayına uygulama ayrımını ve seçili kaynak testlerini işaretli tutuyor. Gerçek Node24/npm11, API/browser/host ve T-DEV-DOMAIN-ALIASES kabulü açık. Önceki alias testlerinin bu tur yeniden çalıştırıldığı iddia edilmez; eski ZIP patchleri tekrar uygulanmaz.

## Bu dilimde tamamlanan kaynak

- [x] `apps/web/src/workspace/domain-hosting-model.js` — `cdd25bdd`: yalnız `httpsRedirect` ve `canonicalRedirect` boolean tercihleri için taslak, değişiklik farkı, SSL uyarısı ve önizleme doğrulaması. Ek alan adı, ana alan adı, HTTPS modu, Nginx ayarı, hedef, Website veya sertifika değişikliği bu dilimin kapsamı değildir. HTTPS kapalıyken HTTPS yönlendirmesi ve değişikliksiz/askıda/geçersiz kayıt engellenir.
- [x] `apps/web/src/workspace/domain-hosting-client.js` — `4fa4ac36`: mevcut `/domains/:id`, `/domains/:id/update-preview` ve PATCH sözleşmesiyle dar istemci. Önizleme ve kaydetme öncesinde güncel hedef/revizyon kontrolü, istemciye ait değiştirilemez önizleme, tek kullanımlık kaydetme, oturum/site değişimi ve eşzamanlı aynı-istemci isteği koruması. PATCH sonrası hem dönen Domain hem yeniden okunan kayıt doğrulanır. Belirsiz sonuç başarı sayılmaz; otomatik tekrar yoktur. Bu bir backend yetki veya süreçler arası kilit uygulaması değildir.
- [x] `apps/web/test/domain-hosting.test.js` — `e4575721`: seçili **49 test geçti / 0 başarısız / 0 atlandı**, Node **v22.16.0**. Yerel komut: `node --test apps/web/test/domain-hosting.test.js`. Testler saf model ve enjekte edilmiş transport/yanıtlarla çalışan istemci testleridir; gerçek Express/auth/CSRF, React render, Vite build veya canlı sunucu testi değildir.

Yerelde kullanılan mevcut `domain-alias-model.js` kopyasının Git blob SHA'sı `11c18e383847d64e4f0fb66ac3979cf023d0f975` ile dalda okunan dosyayla eşleşti. Mevcut alias kaynakları değiştirilmedi. Bu yeni 49 test önceki alias raporundaki 49 testin yeniden koşumu değildir; proje geneli test sayısı veya hazır olma yüzdesi üretilmez.

### Doğrulanan davranışlar

Yalnız değişen tercih PATCH'e girer. Yanlış domain/sunucu/Website, değişen revizyon/alias/sertifika, askı durumu ve beklenmeyen önizleme engellenir. Önizlemenin hash/onay, sonraki revizyon, korunan alanlar ve sertifika etkisi kontrol edilir. Ağ hatası veya sonuç doğrulama hatası aynı planı tekrar göndermeye izin vermez. Kaydetmek stage/activate, DNS, posta veya sertifika işi başlatmaz. Sertifika bağlı değilken HTTPS hazır mesajı verilmez.

## Kalan kaynak — üst kutular açık

- [ ] **HST-UI-01:** mevcut SiteDetailPage → Barındırma ve DNS → Barındırma alanına iki tercihli formu ortak Ember/PanelKit bileşenleriyle bağla. Mevcut bilgi görünümünü, domain/Website bağını, Files/SSL/alias girişlerini ve motorlarını kaldırma. Bu tur hiçbir JSX/rota dosyası değiştirilmedi; kullanıcıya görünür düzenleme formu henüz eklenmedi.
- [ ] **HST-UI-02:** güncel session generation + component ömrü + canlı yetki kontrolü ile `isCurrent`; `panelRequest` abort signal, güncel domain/job durumu, resourceBusy ve canManage korumalarını bağla. Aynı client instance'ını işlem boyunca koru. Form değiştiğinde eski review planını iptal et; UI onayı olmadan `save(plan)` çağırma.
- [ ] **HST-UI-03:** değişiklik önizlemesi/onay, iptal, kaydedilmemiş taslak uyarısı, site/oturum değişimi ve güncel kayıt yüklemesini uygula. Dış yenileme kullanıcının taslağını silmesin. `needsReload` sonucunda otomatik yeniden gönderme yapma. Kaydetme sonrası yeni baseline ve tüm site özetleri yenilensin.
- [ ] **HST-UI-04:** Kaydedildi ile Yayına uygulandı ayrımını görünür tut. Kaydetme sonrası mevcut stage/activate iş akışına açık kullanıcı eylemiyle devam ettir; ikinci kalıcı workflow veya yeni yayın motoru yazma. Alan adı/HTTPS modu/sertifika/Nginx ayrıntılı düzenlemesi bu dar dilimde tamamlandı sayılmasın.

## T-DEV-HOSTING — Codex / gerçek checkout kabulü

- [ ] Node >=24.11.1 ve npm >=11 ile gerçek checkout'ta paket kurulumu, repodaki tam lint/test/build ve yeni seçili test çalıştırılsın. Buradaki Node22 çalışması hedef araç zinciri kabulü değildir. GitHub Actions kullanılmasın.
- [ ] Gerçek Domain registry + HTTP/`panelRequest` zinciriyle iki yönlendirme değişikliği için preview/save response uyumu doğrulansın. Önizlemeden PATCH'e kadar kayıt/hiyerarşi/certificate/job değişimi ve backend digest kontrolü gerçek entegrasyonda test edilsin. Transport fixture'ı backend çalıştırma kanıtı değildir.
- [ ] UI bağlandıktan sonra Owner / Site A / Site B / salt-okunur hesapla yetki iptali, session rotation, doğrudan API, başka site kimliği, çift tıklama, timeout/403/409/500 ve PATCH sonrası başarısız GET denensin. Yerel client lock'u backend'in ortak resource lock açığını kapatmış sayılmasın.
- [ ] Yalnız izin verilen YunPanel test hostunda (asla `.44` Plesk sunucusunda değil) kaydetmenin tek başına Nginx'i değiştirmediği; kullanıcı onaylı mevcut stage/activate sonrası gerçek HTTP→HTTPS ve alias→primary davranışı, sertifika kapsamı ve yönlendirme döngüsü kontrol edilsin. Kaynak testi yayındaki davranışın kanıtı değildir.
- [ ] Gerçek React/Vite ile dar ekran, klavye/focus, error/review modal, refresh/back/forward, taslağın korunması ve mevcut Files/alias/SSL girişleri regresyon testinden geçsin. Tam hosting formu ve UX-PL-04/06 ancak ilgili kabul tamamlandıktan sonra kapatılabilir.

Main'e yazılmadı; GitHub Actions veya canlı host işlemi yapılmadı. Yeni kaynak bu dilimde arayüze import edilmediği için mevcut ekran akışları değişmedi.
