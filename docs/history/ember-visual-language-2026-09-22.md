# Ember — YunPanel görsel dil değişimi

22 Eylül 2026. Başlangıç `f468ab9376b358d916299310639bd6792215ed12`; eşzamanlı `952072d1566c7c690500198ffd9c83839decfa2e` değişiklikleri korunarak birleştirildi. Kullanıcının bu turdaki kararı: UX akışları korunacak; renk, font, çizgi yoğunluğu, köşeler ve yüzey dili değişecek. Bu kayıt canlı dağıtım veya tüm UI kabulünün tamamlandığı anlamına gelmez.

## Görsel karar

İlk Dribbble referansı incelendi: sıcak siyah zemin, açık seçili öğe, büyük köşeler ve tek güçlü turuncu alan. İkinci PNG bağlantısı araçlarda açılmadı; incelenmiş sayılmadı. Referansların logosu, görselleri, verileri veya sayfa düzeni kopyalanmadı.

Ember renkleri: koyu grafit `#171816`, çalışma yüzeyi `#222320`, yazı `#F3F0E8`, mandalina ana işlem `#F77749`. Açık görünüm sıcak kâğıt `#F2F0EB` / kırık beyaz yüzey kullanır. Başarı adaçayı, uyarı altın ve hata gül kırmızısıdır; marka turuncusu hata durumuna dönüştürülmez.

Kartlar 22 px, dosya çalışma yüzeyi 24 px, modal 25 px, kontroller 13 px köşelidir. Çoğu kart başlığı, tablo satırı, yan menü ve bilgi listesi çizgisi kaldırıldı. Hiyerarşi ayrı zemin tonu, boşluk ve hover ile kurulur. Odak çerçevesi, form kontrolleri, önemli uyarılar ve forced-colors sınırları korunur. Geniş ekranlarda köşeler yumuşar; mobilde mevcut kayıt düzeni ve dokunma alanları kalır.

## Kod kapsamı

- `ember-theme.css`, `main.jsx` içinde mevcut console katmanının ardından yüklenir; dosyalar, dashboard, global/site DB, site mail, sekmeler, menü, tablo, modal ve editör çevresi için sunum kuralları içerir.
- `ember-typography.css`: normal arayüz metninde Manrope, başlıklarda ve büyük sayılarda Outfit; kod/editör/terminal bağlamında monospace korunur.
- `scripts/prepare-ui-fonts.mjs`: font ve OFL lisanslarını sabit Google Fonts commit'inden alır; boyut ve Git blob hash doğrulaması, sınırlı indirme, atomik yazma ve doğrulanmış offline cache desteği vardır. Font dosyaları repoya eklenmez; çalışma zamanında kullanıcının tarayıcısı Google/CDN'ye gitmez. CSP gevşetilmez.
- `apps/web/package.json` yalnız `fonts`, `fonts:check`, `predev`, `prebuild` scriptlerini ekler. Mevcut dependency ve Node/React sürümleri değiştirilmedi; yeni çalışma zamanı paketi yoktur.
- Site dosya/mail/DB component işlevleri, URL'ler, API, auth, rol politikası ve phpMyAdmin güvenlik kapısı bu görsel değişimle değiştirilmedi. Önceden açık olan site-manager phpMyAdmin işi kapanmadı.

Commitler: `45c8df7` font hazırlığı; `d7b74b6` görsel katman; `f6fe9d9` eşzamanlı değişiklikleri koruyan birleştirme ve açık tema kontrast düzeltmesi. GitHub Actions veya force-push kullanılmadı; yeni branch açılmadı. Eşzamanlı app.js, server.js, FilesPanel, test ve dev değişiklikleri korunmuştur.

## Tipografi kurulumu

```sh
npm run fonts --workspace @yunpanel/web
npm run fonts:check --workspace @yunpanel/web
npm run build --workspace @yunpanel/web
```

`predev`/`prebuild` hazırlığı otomatik çağırır. İlk hazırlıkta upstream erişimi gerekir; doğrulanmış dosyalar varsa tekrar indirilmez. İnternetsiz build için aynı doğrulanmış dosyaların bulunduğu repo dışı klasör `YUNPANEL_FONT_CACHE_DIR` ile verilir. Vite public dosyalarını çıktı paketine almalıdır; üretimde font HTTP/MIME/CSP kontrolü T-EMBER'de açık kalır.

Bu ortamda gerçek font indirme komutu denendi ve ağ hatasıyla durdu. Bu yüzden **önizleme görüntülerinde Manrope/Outfit değil Lato yedek fontu vardır**. Yalnız font-family adı yazılmış olması font dosyasının yüklendiği kanıtı değildir. Yeni gerçek fontlarla son üretim görünümü henüz doğrulanmadı.

## Çalıştırılan sınırlı kontroller

Yerel ortam Node 22.16.0 ve Chromium'dur; üretim Node 24/npm 11/React 19/Vite bağımlılık kurulumu burada yoktur.

- `ui-fonts.test.js` ve `ember-theme.test.js`: **14/14** test geçti. Font indirme testleri sentetik veri kullanır; upstream fontların burada indirildiğini iddia etmez. Diğer testler CSS yükleme sırası, kapsam, font yolları, tokenlar ve kontrastı kontrol eder.
- Temsilî HTML görsel test sayfalarında yeni gerçek Ember CSS'i kullanılarak **45/45** kontrol geçti: 320/390/834/1440 genişlik, açık/koyu zemin, örnek dosya/DB/mail/dashboard, native modal, odak, reduced-motion ve forced-colors/touch yüzeyleri.
- Açık/koyu toplam **26 seçili metin–zemin renk çifti** en az 4.5:1 eşiğini geçti. Bu bütün arayüzün WCAG uyumluluk sertifikası değildir; font geometrisi, semantik tablo/ekran okuyucu ve tüm etkileşimler ayrıca test edilmelidir.
- 14 PNG üretildi: dört ekranın masaüstü/tablet/mobil örnekleri, açık dosya görünümü ve dosya modalı. Görüntülerde örnek veri, üretim paketi olmadığı ve yedek font kullanıldığı görünür biçimde yazılıdır.

**Önemli sınır:** Bu turdaki görsel fixture'lar temsilî HTML düzenleridir. Tam React component ağacı, uygulamanın bütün önceki CSS katmanları, gerçek router, API veya canlı server render edilmedi. Testlerdeki temel yerleşim dosyası production layout yerine geçmez. Görüntüler yeni CSS dilini değerlendirmek içindir; çalışan canlı YunPanel ekranı veya tamamlanmış uygulama kabulü olarak sunulamaz.

Tam `npm ci`, Vite production build, gerçek yeni font yüklemesi, Firefox/ekran okuyucu, tüm uzman ekranlar ve host deploy yapılmadı. `.44` sunucuya veya başka canlı sunucuya bağlantı kurulmadı. `plan.md` YP-04/15/16 ve önceki güvenlik/kabul işleri kapatılmadı. Kalan dış doğrulamalar `todo.md > T-EMBER` içinde.
