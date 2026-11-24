# Lisanslama ve Üç Aylık Premium

> **Sürüm:** YunPanel `0.3.0` · **Doğrulanmış kaynak revizyonu:** `f30fd779` (`f30fd779293ad96f83e7a76846fa70e71562730b`) · **Doğrulanmış Linux `.deb` paket tabanı:** `0.3.0-2026112301` (`f13b2b78`) · **Arayüz dili:** Türkçe (`tr`)

YunPanel, temel sunucu ve sınırsız site yönetimini **Ücretsiz** sürümde kalıcı olarak sunar; çok kullanıcılı yönetim, bayi/müşteri hesapları ve AI yönetim araçları için çevrimdışı kriptografik doğrulamalı **YunPanel Premium** lisansını kullanır.

## Ücretsiz ve Premium yetenek karşılaştırması

| Yetenek | Ücretsiz | YunPanel Premium |
| :--- | :---: | :---: |
| Tek yönetici (Owner) ile sınırsız web sitesi ve alt alan adı | Açık | Açık |
| Site bazlı yalıtılmış Linux kullanıcısı, Site Terminali ve SFTP | Açık | Açık |
| Web sunucusu (Nginx), PHP/Node/Python/Statik, Docker, SSL, DNS, Posta, Veritabanı, Yedekleme | Açık | Açık |
| AI yönetim asistanı ve otomasyon araçları (`aiOperations`) | Premium | Açık |
| Bayi ve bayi müşterisi yönetimi (`resellerAccounts`) | Premium | Açık |
| Ayrı müşteri, site yöneticisi ve ek panel hesapları (`perSiteIsolatedUsers`) | Premium | Açık |

## Üç aylık ücretsiz Premium kampanyası (Yunsoft Website)

> **Canlı kampanya durumu:** Yunsoft Website üzerindeki 3 aylık ücretsiz Premium kampanyası şu an canlıda etkin değildir; Website tarafında SMTP doğrulaması ve kabul aşamasını beklemektedir. Aşağıdaki görünüm ve etkinleştirme adımları **kampanya Yunsoft Website'de açıldığında** geçerli olacaktır. Bu sayfadaki kampanya teklifi ve aktif kampanya ekran görüntüleri yerel `0.3.0` (`f30fd779`) aday derlemesinde alınan teknik doğrulama görselleridir; canlı kampanya kullanım kanıtı sayılmaz.

Kampanya Yunsoft Website'de etkinleştirildiğinde, yeni kurulumlar ve ücretsiz sürümdeki sunucular isteğe bağlı olarak Yunsoft e-posta aboneliğiyle **kredi kartı gerektirmeyen 3 aylık YunPanel Premium** teklifinden yararlanabileceklerdir:

- **İlk kurulum ve Lisans ekranı yönlendirmesi:** İlk kurulum formunda (bkz. [İlk Kurulum](doc:first-time-setup)) ve ücretsiz sürümdeki **Ayarlar → Lisans** (`/settings?section=license`) ekranında **Teklifi Yunsoft'ta incele** bağlantısı yer alır; kampanya Yunsoft Website'de açıldığında kayıt sayfasına yönlendirir.
- **Gizlilik ve veri sınırı:** Kampanya kaydı yalnızca **Yunsoft Website** tarafından yönetilir. Müşteri paneli hiçbir e-posta bülteni veya abone listesi saklamaz. Yönlendirme bağlantısı sorgu parametresi ve parça içermeyen sabit bir HTTPS adresidir (`referrerPolicy="no-referrer"`); e-posta, alan adı veya kurulum kimliği bağlantıya eklenmez.
- **Tekil hak kuralı:** Kampanya açıldığında aynı normalize e-posta adresi veya aynı alan adı ikinci kez 3 aylık kampanya hakkı alamaz.
- **Tek kampanya kaydı, iki ürün kapsamı:** Yunsoft Website üzerindeki tek kampanya kaydı YunPanel ve YunCMS haklarını birlikte taşır; kampanya etkinleştiğinde YunPanel etkinleştirme isteği (`productCode: "yunpanel_premium"`) yalnızca doğrulanmış YunPanel kurulumu için ilgili hakkı etkinleştirir. Başka bir ürüne ait (`yuncms_premium`) jetonlar YunPanel tarafından `PRODUCT_MISMATCH` ile reddedilir.

![Ayarlar Lisans ekranında ücretsiz sürüm ve yerel aday 3 aylık Premium teklifi görünümü](assets/tr/16-license-free-offer.png)

## Çevrimdışı Ed25519 doğrulama ve etkinleştirme

YunPanel lisansları `YUNSOFT-ENTITLEMENT+JWT` sözleşmesiyle yerel olarak **Ed25519** açık anahtar imzasıyla doğrular:

- **Sıfır elle anahtar kopyalama:** Resmi Yunsoft Commerce açık anahtarı (`kid: 1cbcc4d3173d0c15`) paket içinde hazır gelir (`/usr/share/yunpanel/trust/entitlement-public.pem`) ve kurulumda `/etc/yunpanel/control-plane/entitlement-public.pem` yoluna otomatik yerleştirilir (operatör özel anahtar tanımladıysa üzerine yazılmaz).
- **Özel anahtar yasaktır:** İmzalama özel anahtarı (`PRIVATE KEY`) veya ödeme sağlayıcısı anahtarı YunPanel sunucusunda asla bulunmaz.
- **İki etkinleştirme yolu:** **Ayarlar → Lisans** ekranında yalnızca `Owner` rolü:
  1. **Lisans anahtarı** ile (`POST /v1/entitlements/activate` üzerinden alan adı ve kurulum kimliğiyle imzalı jeton değişimi; anahtar diskte `AES-256-GCM` ile şifrelenir), veya
  2. **İmzalı jeton** yapıştırarak (tamamen çevrimdışı) etkinleştirme yapabilir.
- **Sıfır rutin dış ağ çağrısı:** Etkinleştirme sonrası tüm yetki kontrolleri yerel diskteki imzalı jeton üzerinden çevrimdışı çalışır; uzak servis geçici olarak erişilemez olsa bile geçerli lisansınız çalışmayı sürdürür.

![Ayarlar Lisans ekranında yerel aday 3 aylık kampanya Premium görünümü (canlı kampanya açıldığında geçerli akış)](assets/tr/17-license-campaign-active.png)

## Ücretli / kalıcı hak koruması ve kesintisiz yaşam döngüsü

- **Ücretli ve kalıcı hakların korunması:** Aktif bir ücretli (`paid`, aylık/yıllık) lisans, kampanya (`promotional`) hakkıyla değiştirilemez (`409 paid_or_permanent_entitlement_protected`). Aktif bir kalıcı (`permanent` / `lifetime`) lisans hiçbir süreli veya kampanya hakkıyla ezilemez. Kampanya hakkından ücretli veya kalıcı lisansa yükseltme ise kesintisiz çalışır; aktif Premium varken kampanya tanıtım kartı otomatik gizlenir.
- **Sürüm geri alma koruması (anti-rollback):** Daha eski `entitlementVersion` veya daha kısa bitişli eski jetonların tekrar oynatılması `licenseWatermarks` ile reddedilir (`409 stale_license_token`).
- **Veri koruyan süre sonu ve kaldırma:** Lisans süresi dolduğunda, iptal edildiğinde veya Owner tarafından açık onayla (`deactivate-license`) kaldırıldığında mevcut web siteleriniz, veritabanlarınız, SSL sertifikalarınız, dosyalarınız ve site Unix kullanıcılarınız **silinmez ve kesintiye uğramaz**; panel güvenli biçimde ücretsiz sürüm yetkilerine döner.

## İlgili ortam değişkenleri

| Değişken | Varsayılan | Açıklama |
| :--- | :--- | :--- |
| `YUNPANEL_LICENSE_STORE` | `/var/lib/yunpanel/control-plane/license/entitlement.json` | İmzalı jeton, su izi ve şifreli anahtar deposu (`0600`). |
| `YUNPANEL_LICENSE_COMMERCE_URL` | `https://yunsoft.com/api/commerce` | Etkinleştirme/yenileme HTTPS Commerce kökü. |
| `YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE` | `/etc/yunpanel/control-plane/entitlement-public.pem` | İsteğe bağlı özel Ed25519 SPKI açık anahtar dosyası. |
| `YUNPANEL_PREMIUM_OFFER_URL` | `https://yunsoft.com/kampanya/premium-3-ay` | Sorgusuz sabit HTTPS kampanya yönlendirme adresi. |
| `YUNPANEL_DOCS_URL` | `https://yunsoft.com/docs/yunpanel` | Sorgusuz sabit HTTPS dokümantasyon adresi. |

## İlgili kılavuzlar

- İlk kurulumdaki teklif yönlendirmesi için [İlk Kurulum](doc:first-time-setup)
- Bayi, müşteri ve site yöneticisi rolleri için [Temel Site ve Rol İşlemleri](doc:sites-and-roles)
