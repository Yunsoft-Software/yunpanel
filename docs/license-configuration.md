# YunPanel Lisans ve İmza Doğrulama Yapılandırması

YunPanel aylık (`periodMonths: 1`), yıllık (`periodMonths: 12`), kampanya/süreli (ör. 3 aylık ücretsiz Premium teklifi, `periodMonths: 3`) ve kalıcı (`billingModel: "permanent"` / `"lifetime"`) lisansları `YUNSOFT-ENTITLEMENT+JWT` sözleşmesiyle **Ed25519** açık anahtar imzası üzerinden yerel ve çevrimdışı olarak doğrular. Özel imzalama anahtarı (`PRIVATE KEY`) veya ödeme sağlayıcısı anahtarları YunPanel sunucusunda asla bulunmaz.

## 1. Standart Müşteri Kurulumu (Ek Dosya Kopyalama Gerekmez)

Standart `.deb` kurulumlarında ve varsayılan kaynak çalıştırmalarında müşterinin veya sistem yöneticisinin elle Ed25519 açık anahtar dosyası kopyalaması **gerekmez**:

1. Resmi Yunsoft Commerce açık anahtarı (`kid: 1cbcc4d3173d0c15`) paket içinde `/usr/share/yunpanel/trust/entitlement-public.pem` ve `apps/api/src/vendor-entitlement-public.pem` olarak hazır gelir.
2. Paket kurulum betiği (`postinst`), `/etc/yunpanel/control-plane/entitlement-public.pem` dosyası henüz mevcut değilse bu resmi açık anahtarı otomatik olarak (`0644`, `root:root`) yerleştirir.
3. İlk `Owner` kurulum ekranı (`setupRequired: true`) isteğe bağlı olarak Yunsoft web sitesindeki kredi kartsız 3 aylık Premium teklifine yönlendirme sunar. E-posta aboneliği müşteri panelinde tutulmaz ve bağlantıya e-posta veya alan adı eklenmez.
4. İlk `Owner` hesabıyla panele giriş yapıldığında **Araçlar ve Ayarlar → Ayarlar → Lisans** (`/settings?section=license`) ekranından doğrudan lisans anahtarı veya imzalı lisans jetonu girilerek etkinleştirme tamamlanır.

Canlı sunucularda lisans alan adı eşleşmesinin doğrulanabilmesi için `/etc/yunpanel/control-plane/api.env` (ve `web.env`) içinde `YUNPANEL_PUBLIC_ORIGIN=https://panel.ornekalanadi.com` değerinin panelin gerçek HTTPS adresine ayarlanmış olması yeterlidir.

## 2. Ortam Değişkenleri

| Değişken | Varsayılan Değer | Açıklama |
| :--- | :--- | :--- |
| `YUNPANEL_LICENSE_STORE` | Paketli: `/var/lib/yunpanel/control-plane/license/entitlement.json`<br>Kaynak: `.data/license/entitlement.json` | İmzalı lisans jetonunun, sürüm su izinin (`licenseWatermarks`) ve `YUNPANEL_SECRET_MASTER_KEY` ile AES-256-GCM şifrelenmiş lisans anahtarının tutulduğu dosya (`0600`). |
| `YUNPANEL_LICENSE_COMMERCE_URL` | `https://yunsoft.com/api/commerce` | Lisans anahtarı etkinleştirme, yenileme ve kaldırma işlemleri sırasında çağrılan HTTPS Commerce kök adresi. Rutin panel isteklerinde uzak çağrı yapılmaz. |
| `YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE` | Paketli: `/etc/yunpanel/control-plane/entitlement-public.pem` (yoksa yerleşik resmi anahtar) | İsteğe bağlı özel veya yerel geliştirme Ed25519 SPKI `PUBLIC KEY` PEM dosya yolu. |
| `YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM` | *(boş)* | İsteğe bağlı satır içi Ed25519 SPKI `PUBLIC KEY` PEM metni (anahtar rotasyonu için birden fazla `PUBLIC KEY` bloğu içerebilir). |
| `YUNPANEL_PREMIUM_OFFER_URL` | `https://yunsoft.com/kampanya/premium-3-ay` | İlk kurulum ve lisans ekranında gösterilen statik HTTPS kampanya yönlendirme adresi. Sorgu parametresi (`?`), parça (`#`), kimlik bilgisi ve `@` yasaktır. |
| `YUNPANEL_DOCS_URL` | `https://yunsoft.com/docs/yunpanel` | Resmi YunPanel dokümantasyonuna yönlendiren statik HTTPS adresi. Sorgu parametresi (`?`), parça (`#`), kimlik bilgisi ve `@` yasaktır. |

## 3. Üç Aylık Kampanya ve Ücretli / Kalıcı Hak Koruması

- **Website merkezli kampanya:** Üç aylık ücretsiz Premium kampanyası Yunsoft Website tarafından yönetilir. Müşteri paneli bülten aboneliği listesi tutmaz ve yönlendirme bağlantısına e-posta, alan adı veya kurulum kimliği eklemez.
- **Tekil hak ve ürün kapsamı:** Yunsoft Website aynı normalize e-posta veya alan adına ikinci kampanya hakkı vermez. Tek kampanya kaydı YunPanel ve YunCMS haklarını birlikte taşıyabilir; YunPanel etkinleştirme isteği `productCode: "yunpanel_premium"` ile yalnız doğrulanmış YunPanel kurulumu için hak alır ve başka ürüne ait (`yuncms_premium`) jetonları `PRODUCT_MISMATCH` ile reddeder.
- **Ücretli ve kalıcı hakların korunması:** Aktif bir ücretli (`grantKind: "paid"`) lisans, kampanya (`grantKind: "promotional"`) jetonu veya anahtarıyla değiştirilemez (`409 paid_or_permanent_entitlement_protected`). Aktif bir kalıcı (`grantKind: "permanent"`) lisans, süreli veya kampanya hakkıyla ezilemez. Kampanya hakkından ücretli veya kalıcı lisansa yükseltme kesintisiz çalışır.

## 4. Operatör Özel Güven Anahtarı ve Yerel Geliştirme (Source-Dev)

YunPanel operatörün özel güven yapılandırmasını paket yükseltmelerinde korur:

- **Özel Dosya Koruması:** Operatör `/etc/yunpanel/control-plane/entitlement-public.pem` dosyasını kendi Ed25519 açık anahtarıyla değiştirmişse `postinst` mevcut dosyayı **ezmez**.
- **Özel Ortam Değişkeni Koruması:** `api.env` içinde `YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE=/ozel/yol/public.pem` veya `YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM=...` tanımlıysa `postinst` bu ayara dokunmaz ve servis yalnız operatörün tanımladığı anahtar(lar)a güvenir. Belirtilen özel dosya okunamazsa veya eksikse sistem sessizce başka anahtara geçmez; etkinleştirmeyi güvenli biçimde reddeder ve okuma yollarında mevcut siteleri kesmeden ücretsiz sürüme döner.
- **Yerel Kaynak Geliştirme (`npm run dev`):**
  - Değişken verilmezse yerleşik resmi açık anahtar (`kid: 1cbcc4d3173d0c15`) kullanılır.
  - Yerel test Commerce imzalayıcısı kullanılıyorsa `.env` içinde ayrı açık anahtar dosyası verilebilir:
    ```dotenv
    YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE=.local/dev-commerce-public.pem
    YUNPANEL_LICENSE_COMMERCE_URL=http://127.0.0.1:8055/api/commerce
    ```
  - Loopback (`localhost` / `127.0.0.1`) geliştirme modunda lisans ekranı etkinleştirilecek hedef alan adını ayrıca sorar.
