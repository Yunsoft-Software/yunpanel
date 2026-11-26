# İlk Kurulum

> **Sürüm:** YunPanel `0.3.0` · **Doğrulanmış kaynak revizyonu:** `c1a84a51` (`c1a84a5159add2f2f87fd6e21725f7c657cf98ec`) · **Doğrulanmış Linux `.deb` paket tabanı:** `0.3.0-2026112301` (`f13b2b78`) · **Arayüz dili:** Türkçe (`tr`)

YunPanel varsayılan parola veya herkese açık kayıt ekranı içermez. İlk **Owner (Sunucu Yöneticisi)** hesabı yalnızca sunucu üzerinde üretilen, tek kullanımlık ve 10 dakika geçerli bir kurulum anahtarı ile oluşturulur.

## 1. Tek kullanımlık kurulum anahtarını üretin

Sunucu kabuğunda paketli kimlik aracını çalıştırın:

```bash
# Paketli Linux kurulumu
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/auth.mjs setup-token

# Yerel kaynak geliştirme ortamı
npm run auth -- setup-token
```

Komut, yalnızca tek kullanımda geçerli olan ve 10 dakika sonra süresi dolan bir kurulum anahtarı üretir. Anahtar kullanıldığında veritabanından kalıcı olarak silinir.

## 2. Owner hesabını oluşturun

Tarayıcıdan panel adresinizi açtığınızda sistem henüz yapılandırılmadığı için **İLK KURULUM · Owner hesabını oluşturun** ekranı açılır.

![YunPanel ilk kurulum ekranı (koyu tema)](assets/tr/01-first-time-setup-dark.png)

Form alanları:

1. **Kurulum anahtarı:** Sunucuda ürettiğiniz tek kullanımlık anahtar.
2. **Kullanıcı adı:** İlk sunucu yöneticisi kullanıcı adı (en az 3 karakter).
3. **Kurtarma e-postası (isteğe bağlı):** Yalnızca yerel parola kurtarma akışı için saklanır; pazarlama veya bülten listesi olarak kullanılmaz.
4. **Parola ve parola tekrarı:** En az 12 karakter uzunluğunda güçlü parola.

Açık ve koyu tema arasında sağ üstteki tema düğmesiyle geçiş yapabilirsiniz:

![YunPanel ilk kurulum ekranı (açık tema)](assets/tr/02-first-time-setup-light.png)

## 3. İsteğe bağlı 3 aylık ücretsiz Premium teklifi

> Başvuru ve güncel koşullar için [Yunsoft'un üç aylık Premium kampanya sayfasına](https://yunsoft.com/kampanya/premium-3-ay) bakın. Kampanya görselleri yerel `0.3.0` (`c1a84a51`) aday derlemesinde alınmıştır.

İlk kurulum formunun altında isteğe bağlı **3 aylık ücretsiz Premium teklifi** kartı yer alır:

- **Tamamen isteğe bağlıdır:** Owner hesabını oluşturmak veya paneli ücretsiz sürümde kullanmak için bu bağlantıyı açmanız gerekmez.
- **Kredi kartı gerekmez** — Uygun başvurular için Yunsoft web sitesinde e-posta aboneliğini doğrulayarak üç aylık YunPanel Premium hakkı alabilirsiniz.
- **Gizlilik sınırı:** Müşteri paneli e-posta bülteni listesi saklamaz. Teklif bağlantısı (`referrerPolicy="no-referrer"`) sabit bir HTTPS adresidir; kurtarma e-postanız, alan adınız veya kurulum kimliğiniz bağlantıya eklenmez.
- **Tekil hak ve ortak kampanya** — Aynı e-posta adresi veya alan adı için kampanyadan bir kez yararlanılabilir. Tek başvuru YunPanel ve YunCMS haklarını birlikte kapsar. Aldığınız YunPanel anahtarını **Ayarlar → Lisans** ekranında doğrulanmış kurulumunuz için etkinleştirin.

Ayrıntılı lisans ve ücretli/kalıcı hak koruması kuralları için [Lisanslama ve Üç Aylık Premium](doc:licensing-and-premium) kılavuzuna bakın.

## 4. Giriş yapın ve iki adımlı doğrulamayı (MFA) etkinleştirin

Owner hesabını oluşturduktan sonra giriş ekranına yönlendirilirsiniz.

![YunPanel giriş ekranı](assets/tr/03-login.png)

Üretim HTTPS kurulumlarında (`YUNPANEL_OWNER_MFA_REQUIRED=true`), ilk giriş sonrasında **Hesap Güvenliği** ekranı açılır:

1. Doğrulayıcı uygulamanızla (TOTP, 6 hane, 30 saniye) kurulum anahtarını ekleyin.
2. Tek kullanımlık kurtarma kodlarını güvenli bir ortamda saklayıp onaylayın.
3. **Yönetim paneline geç** düğmesiyle [Temel Site ve Rol İşlemleri](doc:sites-and-roles) ekranına geçin.
