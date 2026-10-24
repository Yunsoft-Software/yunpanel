# YunPanel — Geliştirici ve Kodlama Ajanı Kuralları

## Güncel kullanıcı kararı — 2026-09-23: development, sade reseller

9–10 Ekim 2026 son talimatı: derin analiz, kısa doküman/plan ve kapsamlı gerçek tarayıcı testleri. Kullanıcı `.28` izole kur/deneyip/kaldır testlerini açıkça onayladı; test kodu yazılabilir. 10 Ekim 2026 kullanıcı UI/UX ve planın tüm kaynak işlerini açıkça onayladı; ürün geliştirme başlayabilir. Deployment için ayrı hedef/scope izni kuralı korunur. Güncel hedef Plesk ekran/akış/özellik eşdeğerliğidir. Eski başarı raporları aktif talimat değildir.

Önce bu dosya, sonra [devralınan teknik kurallar](docs/policies/agents-inherited-1a45ded8.md), `plan.md`, `ui-plan.md`, `docs/plesk-feature-parity.md` ve ilgili kod okunur. Devralınan dosya önceki `agents.md` içeriğinin eksiksiz Git blob kopyasıdır. Aşağıdaki açık değişiklikler dışında bütün güvenlik, veri koruma, teknoloji, test ve operasyon kuralları geçerlidir.

### Geçerli ürün ve çalışma kararları

1. **Aktif dal `24-10-2026` (`development` tabanlı).** Bu işte `main`e commit/merge/deploy yapılmaz. Her yazımdan önce dal başı kontrol edilir; eşzamanlı değişiklikler ezilmez. Küçük commitler; force push, geçmiş silme ve GitHub Actions yok. Commit mesajlarına `[skip ci]` eklenir.
2. **Plesk görev düzeni korunur; reseller ilk sürümü sadeleşir.** Önceki aynı tarihli “bütün reseller/paket/abonelik özellikleri ilk sürümde zorunlu” kararı kullanıcının son isteğiyle değiştirilmiştir. İlk sürüm Owner → isteğe bağlı tek Reseller → Customer → mevcut Website ilişkisidir. Abonelik ve paket nesnesi site işlemleri için önkoşul değildir. Reseller kendi müşterileri ve onların siteleriyle sınırlıdır. Ayrıntı ve işaretli işler `docs/plesk-feature-parity.md` içindedir.
3. **Şimdi geliştirilmeyecek reseller işleri:** alt bayi zinciri, ayrı reseller paket motoru, add-on, abonelik sync/lock/customization, overselling, otomatik süre sonu/fatura, bayi markalama, müşteri↔reseller dönüşümü, toplu transfer ve login-as. Bunlar tamamlandı sayılmaz; sonraki fazdır. Basit müşteri/site adet sınırı yeterlidir; disk/CPU/RAM ölçümü veya gerçekten uygulanan site limitleri bu değişiklikle kaldırılmaz. Reseller dışındaki Plesk yol haritası iptal değildir.
4. **Önce görsel/UX onayı ve doküman, sonra kaynak dilimi.** UI sadeleştirme gerekçesiyle araç/rota/motor silinmez; Global Dosyalar ve domain File Manager girişleri kalır. Ancak eski Ember (bej/turuncu) renk/radius katmanı yerine, kullanıcı onaylı **Shadcn UI tabanlı, ufak mikro-animasyonlar ve ışık/spotlight efektleriyle modernleştirilmiş, sade ve domain→subdomain hiyerarşisini merkeze alan yeni UI/UX** uygulanır.
5. **Tamamlanma kaydı görev geçmişinde tutulur.** Kök `plan.md` mimari kararları ve açık işleri tutar; tamamlanan maddeler kontroller, bağımsız inceleme, gerekli staging ve Git birleştirmesi sonrasında çıkarılır. Ayrıntılı sonuç ve kabul kanıtları Code Factory görev/run/event kayıtlarında, önceki raporlar Git geçmişinde kalır. `done.md` yalnız kısa bir geçmiş açıklamasıdır; yeni iş raporu eklenmez. İlgili alt planlardaki kaynak işaretlerinin kanıtı ve sınırı belirtilir. Test edilmemiş entegrasyon, migration, tarayıcı veya host kabulü açık bırakılır. Saf politika modülü bütün reseller özelliği değildir; sadece menü gizlemek veya site_manager rolünü yeniden adlandırmak güvenli reseller uygulaması sayılmaz.
6. **Açık kaynak taban değişimi onaylanmadı.** Başka panel kurma, YunPanel'i onunla değiştirme, PHP/Perl backend'e geçme veya iki paneli aynı config dosyasına yazdırma. Kullanıcı kararı ve migration/rollback tasarımı gereklidir.

### 24 Ekim 2026 — Test, Domain/Subdomain Dosya Kökü, Çoklu Ubuntu ve Yeni Shadcn UI Kuralları

1. **Paralel Test Yazımı, Sıfır Mock ve Geliştirme Sonrası Koşturma Kuralı:**
   - Testler geliştirmelere paralel olarak yazılır.
   - **Mock data, sahte servis, stub HTTP cevabı veya simüle edilmiş veri asla kabul edilmez ve kullanılmaz.** Tüm doğrulamalar gerçek veritabanı (DB), gerçek backend API ve gerçek Playwright tarayıcı testleriyle yapılır.
   - Testler her ufak kod adımında yapılır yapılmaz anında koşturulmaz; **ilgili geliştirme dilimi tamamlandıktan sonra** topluca koşturulur ve doğrulanır.
2. **Domain → Subdomain Hiyerarşisi, Ortak Domain İçi File Root ve Tam Subdomain Yetenekleri Kuralı:**
   - Domain ve subdomain'ler hem kullanıcı arayüzünde (açılır ağaç/hiyerarşi) hem de dosya sisteminde hiyerarşik olarak modellenir.
   - Subdomain'lerin ana domainden kopuk, tamamen ayrı üst dosya kökleri (separate top-level file roots) olmamalıdır; **subdomain dosya kökleri ana domainin çalışma alanı/dizini içinde** (ör. `<domain-root>/subdomains/<subdomain>` veya ana domain kökünün alt dizini olarak) açılır. Ana domainin Dosya Yöneticisi (File Manager) içinden alt alan adlarının klasörlerine doğrudan erişilebilir.
   - Buna karşın her subdomain kendi başına **Uygulama (PHP, Node.js, Python, Statik)**, **Veritabanı (DB)** ve **Docker (Container / Compose Stack / Inner↔Outer Port Proxy)** bağlama yeteneklerine tam olarak sahiptir.
3. **Ubuntu ve Popüler Linux Dağıtımları Desteği (`OsPlatformAdapter`):**
   - Sistem yalnızca Ubuntu 24.04 LTS ile sınırlı kalmaz; merkezi işletim sistemi soyutlama katmanı (`os-platform.js`) üzerinden **Ubuntu LTS (20.04 Focal, 22.04 Jammy, 24.04 Noble)**, **Debian (11 Bullseye, 12 Bookworm)** ve **RHEL / Enterprise Linux ailesini (AlmaLinux 8/9, Rocky Linux 8/9, RHEL 8/9)** destekleyecek şekilde OS tespiti, paket yöneticisi (`apt` / `dnf`), dinamik PHP-FPM sürüm çözümü, systemd servisleri ve kurulum/adapter katmanı uyumlu tutulur.
4. **Merkezi Tasarım Sistemi, Tak-Çıkar (Swappable) Ortak Bileşenler ve Shadcn + Mikro-Efektli UI/UX Kuralı:**
   - Arayüzde **Shadcn UI** tasarım dili (`zinc/slate` yüksek kontrastlı yüzeyler, `1px` keskin kenarlıklar, temiz tipografi) temel alınır; ufak mikro-animasyonlar, yumuşak geçişler, parıltı/spotlight kenarlık efektleri ve canlı durum rozetleriyle modern, cafcaflı ama gözü yormayan, sade ve kullanımı kolay bir UX sunulur.
   - **Tasarım tek bir merkezi sistemden (`apps/web/src/workspace/design-system/` ve `PanelKit.jsx`) gelmelidir.** Ekranlarda dağınık tema stilleri veya üst üste binen çoklu CSS katmanları kullanılmaz; tüm sayfalar ortak merkezi bileşenleri kullanır. İleride tasarım kütüphanesi veya tema değiştirilmek istendiğinde, sayfa ve iş mantığı kodlarına dokunmadan yalnızca bu merkezi bileşen/tema katmanı değiştirilerek hiçbir şeyi bozmadan geçiş yapılabilmelidir.
5. **Plesk Eşdeğeri Docker, Stack ve Inner/Outer Port Proxy Kuralı:**
   - Docker yönetimi; **Docker Hub'dan imaj arama ve tek container çalıştırma**, **Compose/Stack olarak çalıştırma (editöre yapıştırma, site/subdomain dizininden dosya seçme veya `.yml` yükleme; mevcut YAML düzenlenebilir şekilde görünür)** ve **Inner Port (Container) ↔ Outer Port (Host) eşlemesiyle Domain/Subdomain veya alt URL yoluna (`/api`) Proxy olarak bağlama** özelliklerini kapsar.
6. **Sıfır "AI Slop" / Gereksiz Geliştirici Notu Yasağı Kuralı:**
   - Kullanıcı arayüzünde (UI) geliştiriciye veya testlere yönelik iç mimari açıklamaları, savunmacı sorumluluk reddi metinleri veya anlamsız geliştirme notları (ör. *"En yeni oluşturulanlar önce"*, *"(Ürün Uzantısı)"*, *"Durumu yenile yalnızca kayıt okur; işlemi tekrar başlatmaz"*, *"Bu sayı deneme sınırı değildir"*, *"canlı servis sağlık testi değildir"*, *"fail-closed olarak yürütülür"*) **kesinlikle yazılmaz ve mevcut olanlar temizlenir.** Arayüzde yalnızca son kullanıcının işine yarayan sade, doğrudan ve önemli bilgilendirmeler yer alır.
7. **Simetrik Masaüstü Kart Düzeni, Ortak Durum Bileşenleri ve Sade Bilgi Mimarisi Kuralı:**
   - Yan yana duran kartlar (`.ws-equal-columns`, `.ws-two-columns`, `.ws-metrics`, `.yp-docker-catalog-grid`) masaüstünde her zaman **eşit yükseklikte (`align-items: stretch`, `height: 100%`)** hizalanır; içeriğe göre biri uzun biri kısa asimetrik kart görüntüsü oluşturulmaz.
   - Çalışan worker/işlem/SSL animasyonları ve durum metinleri (`StatusBanner`, `.ws-loading`, `p[role="status"]`) ortak merkezi bileşen ve boşluk (`gap`) kurallarıyla render edilir; ikon/spinner ve metinler asla birbirine altlı-üstlü veya yan yana yapışık kalmaz.
   - Ana menüde ve sayfa başlıklarında "Web Siteleri ve Alan Adları" yerine sade **"Web Siteleri"** kullanılır; site kartlarındaki araç akordiyonu ve site detay ekranı tekrar eden karmaşık buton yığınları yerine simetrik grid kartlar ve sekmeli (tab) yapıyla sadeleştirilir.

### 11 Ekim 2026 — Test/geliştirme sunucusunda yedek kuralı

`.local/test-server.env` ile doğrulanan `.28` YunPanel test/geliştirme sunucusunda kurulum, deploy, migration, ayar değişikliği veya geliştirme öncesinde rutin/tedbir amaçlı yedek, snapshot ya da arşiv alınmaz. Yalnız yedek alma/geri yükleme özelliğini açıkça test etmek için yedek alınabilir; başarılı içerik ve geri yükleme doğrulamasından sonra testin oluşturduğu yedek/snapshot ve geçici arşivler silinir, temizliği doğrulanır. İlgisiz yedekler bu gerekçeyle topluca silinmez. Bu güncel kullanıcı kararı, devralınan belgelerdeki işlem öncesi yedek zorunluluğunu yalnız bu test hedefinde geçersiz kılar. Ürün yedekleme işlevi, işlem içi config rollback/idempotency kayıtları ve diğer sunucuların politikaları korunur.

### Değişmeyen güvenlik ve veri sınırları

- `.44` ile biten Plesk sunucusuna SSH, salt okunur inceleme, test, deploy veya başka amaçla dokunulmaz. Canlı işlemler yalnız repo dışı `.local/test-server.env` içindeki açık izinli YunPanel test hedefinde ve adres teyidinden sonra yapılır.
- React + JavaScript/JSX; TypeScript veya yeni paralel UI motoru eklenmez. Mevcut Node/npm gereksinimleri düşürülmez. Ubuntu mevcut ilk çalışma hedefidir; Windows eşdeğerliği ayrı adapter/kurulum/test hattıdır ve Ubuntu koduyla tamamlandı denmez.
- Root yönetim yetkisi authenticated backend'dedir; frontend'e veya barındırılan siteye verilmez. Site build/runtime/cron/dosya/terminal dedicated site Unix kullanıcısında çalışır. Owner root terminali ile müşteri/site terminali ayrıdır.
- Auth/session/CSRF, backend RBAC, WebSocket reauthorization, secret masking, izinli yerel host, preview/confirmation, resource lock, durable job, idempotency ve rollback korunur. Reseller kapsamını sadeleştirmek tenant izolasyonunu, audit veya oturum iptalini sadeleştirmek değildir.
- Website/Domain/Application kimlikleri birbirinin yerine kullanılamaz. Mevcut veri/Unix kullanıcı/sertifika ilişkileri açık migration ve geri dönüş olmadan yeniden atanmaz. Müşteri veya reseller altındaki siteler aynı Unix kullanıcısına birleştirilmez.
- Parola/token/key/cookie/MFA/private config repoya, genel loga veya ekran görüntüsüne yazılmaz. Mevcut test hostundaki isteğe bağlı MFA kararı devralınan dosyada aynen geçerlidir.
- Uygun mevcut adapter, FilesPanel, ttyd, phpMyAdmin, Roundcube, backup/DNS/mail/runtime motorları yeniden yazılmaz. Fallback ancak gerçek replacement kabulünden sonra kaldırılır. `chmod -R 777`, genel sahiplik değişimi veya güvenlik kapatma çözüm değildir.
- Çalıştırılmamış test, deployment veya canlı sonuç yapılmış diye yazılmaz. Gerçek ortam işleri kök `todo.md` içinde; T-PL/T-PARITY ve T-SITE-WORKSPACE kapıları geçerlidir.

## Uygulama sırası

Güncel dal/kod/kurallar → sade kapsam dokümanı → küçük kaynak dilimi → çalıştırılabilen test → `plan.md` ve ilgili alt planda kaynak işareti / açık kabul → küçük commit. Reseller erişimi bütün hedef API/job/tool/gateway yollarında güvenli kapsam uygulanmadan etkinleştirilmez. Tarihsel tam-parity reseller satırları yeni MVP'nin yayın engeli değildir; ertelenmiş kalır.
