# Temel Site ve Rol İşlemleri

> **Sürüm:** YunPanel `0.3.0` · **Doğrulanmış kaynak revizyonu:** `c1a84a51` (`c1a84a5159add2f2f87fd6e21725f7c657cf98ec`) · **Doğrulanmış Linux `.deb` paket tabanı:** `0.3.0-2026112301` (`f13b2b78`) · **Arayüz dili:** Türkçe (`tr`)

YunPanel günlük iş akışının merkezi **Web Siteleri** (`/websites`) ekranıdır. Ana alan adları ve bunlara bağlı alt alan adları tek bir ağaç yapısında listelenir; her site kendi yalıtılmış Linux kullanıcısı (`yunapp-<ozet>`), dosya kökü, veritabanı ve servis araçlarıyla yönetilir.

## Web Siteleri ekranı ve alan adı hiyerarşisi

**Web Siteleri** ekranında ana alan adı ve alt alan adı sayıları (`X ana alan adı · Y alt alan adı`) açıkça gösterilir. Alt alan adları hem arayüzde ana alan adının altında gruplanır hem de dosya sisteminde ana alan adının çalışma alanı içinde (`<ana-domain-koku>/subdomains/<alt-alan>`) konumlanır; buna karşın her alt alan adı bağımsız olarak PHP, Node.js, Python, Statik site, veritabanı veya Docker proxy çalıştırabilir.

![Web Siteleri ana ekranı ve alan adı hiyerarşisi](assets/tr/04-websites-hierarchy.png)

## Yeni web sitesi veya alt alan adı ekleme

Sayfa başlığındaki **Web sitesi ekle** veya **Alt alan adı ekle** düğmesi ya da ana alan adı kartındaki **Alt alan adı** düğmesi `/websites/new` sihirbazını açar:

1. **Alan adı ve sahip:** Bağımsız ana alan adı veya mevcut bir alan adına bağlı alt alan adı seçin, `www` davranışını ve site sahibini belirleyin.
2. **Barındırma türü:** PHP-FPM, Node.js, Python, Statik site, Yönlendirme veya Docker proxy seçeneklerinden birini seçin.
3. **DNS, HTTPS ve Posta:** Kurulum sırasında DNS yönetimi, Let's Encrypt HTTPS ve posta desteğini yapılandırın.
4. **Önizleme ve onay:** Tüm mutasyonlar önizleme özeti ve açık onay sonrasında kalıcı iş kuyruğunda yürütülür.

![Yeni web sitesi oluşturma sihirbazı](assets/tr/05-new-website.png)

## Site genel bakış ve araç kartları

Herhangi bir sitenin **Yönet** bağlantısına tıkladığınızda **Site araçları** ekranı (`/websites/<id>`) açılır. Araçlar iki simetrik grupta sunulur:

- **Sık kullanılan araçlar:** Dosya Yöneticisi, Veritabanları, Site Kaynakları, SSL/TLS Sertifikaları, E-posta, Yedekleme ve Geri Yükleme, WordPress.
- **Geliştirici ve sunucu araçları:** Web Sunucusu & Nginx, Alan Adları & Yönlendirme, DNS, PHP Ayarları, Git / Yayınlama, Günlükler, İstatistikler, Zamanlanmış Görevler, Erişim Hesapları, Terminal.

![Site detay genel bakış ve araç kartları](assets/tr/06-site-overview.png)

Site kartı ve site ayarları üzerinden siteleri askıya alabilir (suspension) veya güvenli geri alma kayıtlarıyla kaldırabilirsiniz.

## Rol modeli ve erişim sınırları

YunPanel sade ve yalıtılmış bir rol hiyerarşisi uygular:

| Rol | Açıklama | Yetki ve lisans sınırı |
| :--- | :--- | :--- |
| **Sunucu Yöneticisi (Owner)** | Tam sunucu, servis, DNS, güvenlik duvarı, lisans ve kullanıcı yönetimi. | Ücretsiz sürümde tek Owner sınırsız site, site terminali ve SFTP yönetebilir. |
| **Bayi (Reseller)** | Kendi müşteri hesaplarını ve bu müşterilere bağlı siteleri belirlenen müşteri/site adet sınırlarıyla yönetir. | YunPanel Premium gerektirir. |
| **Müşteri (Customer)** | Kendisine atanan siteleri, dosyaları, veritabanlarını ve kotası dahilindeki kaynakları yönetir. | YunPanel Premium gerektirir. |
| **Site Yöneticisi (`site_manager`)** | Yalnızca kendisine atanan web sitelerinin günlük işlemlerini yönetir; başka sitelere veya sunucu root terminaline erişemez. | YunPanel Premium gerektirir. |
| **Salt Okunur (`read_only`)** | İzin verilen envanter ekranlarını değişiklik yapmadan görüntüler. | Ek panel hesabı olarak YunPanel Premium gerektirir. |

Her sitenin çalışma zamanı, cron görevleri, SFTP erişimi ve site terminali kendi dedicated Unix kullanıcısında çalışır; aynı müşteri veya bayi altındaki farklı siteler hiçbir zaman tek bir Unix kullanıcısında birleştirilmez.

![Kullanıcılar ve roller yönetim ekranı](assets/tr/07-users-and-roles.png)

## İlgili kılavuzlar

- Alan adı, DNS ve HTTPS yapılandırması için [Alan Adı, DNS ve SSL](doc:domains-and-ssl)
- Ücretsiz ve Premium rol sınırları için [Lisanslama ve Üç Aylık Premium](doc:licensing-and-premium)
