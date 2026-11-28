# YunPanel 0.3.0 Sürümlü TR/EN Dokümantasyon Paketi ve Üç Aylık Premium Entegrasyonu — Aktarım ve Kanıt Kaydı

24 Kasım 2026 · Aktif dal: `24-11-2026` · Eşzamanlı alt ajan üst sınırı: `1` (fiilî kullanılan: `0`) · Paket deploy / push: **YAPILMADI**

## 1. Sürüm ve Revizyon Ayrımı (Yanlış Sürüme Görüntü Bağlanmaz)

| Kaynak / Kanıt | Paket / Sürüm | Tam Commit SHA | Kapsam ve Sınır |
| :--- | :--- | :--- | :--- |
| `.28` doğrulanmış canlı Linux `.deb` (`2301`) | `0.3.0-2026112301` (`amd64`, SHA-256 `50276cee3e2e4ae6cb5438af6cf2214df37fe2bbb4c55243dabe6dbd91c68538`) | `f13b2b788d54133781485a7ac5e9a35af69eaa80` | Canlı `.28` Linux kabulü ve WordPress/Nginx ön-yedek doğrulaması. Bu paketteki ekran görüntüleri `2301`'e bağlanmaz. |
| Yerel UI/UX ve modal/dosya editörü adayı | `0.3.0` (yerel aday, deploy edilmedi) | `814ba17c3118d304704395a4c73d4718acc72462` | Ortak PanelKit modal/kirli form koruması, dosya editörü kapanışı, tema/akordiyon/mobil düzeltmeleri. |
| Sürümlü TR/EN dokümantasyon kuralı | Kural kaydı | `ee0631573dbc66b814c2df71f38fe43c92f89fd2` | Kod + test + TR/EN sürümlü dokümantasyon paralelliği kuralı. |
| **Bu dokümantasyon ve 3 aylık Premium derlemesi (`sourceCommit`)** | **`0.3.0`** (yerel doğrulanmış kaynak + `@yunpanel/web` üretim derlemesi, deploy edilmedi) | **`f30fd779293ad96f83e7a76846fa70e71562730b`** (`b91cadb4` + `f30fd779`) | İlk kurulum & Lisans 3 aylık Premium yönlendirmesi, ücretli/kalıcı hak koruması, tüm 17 Chromium ekran görüntüsü ve 30 TR/EN tarayıcı locale doğrulaması **doğrudan bu revizyondan** alınmıştır. |

## 2. Yunsoft Website Aktarım Paketi ve Arşiv Özeti

- **Kaynak paket dizini:** `docs/yunpanel-docs-0.3.0/` (`manifest.json`, `locales/tr/<slug>.md`, `locales/en/<slug>.md`, `assets/tr/*.png`, `assets/en/*.png`)
- **Hazır aktarım arşivi (tar.gz):** `.local/website-docs/yunpanel-docs-0.3.0.tar.gz` (arşiv kökü: `yunpanel-docs-0.3.0/`, 64 girdi, sıfır symlink, sıfır path traversal, sıfır `.DS_Store`)
- **Arşiv SHA-256:** `86942da4db7be1b16a6475372d7973cb46ade23c87eeed6ba67d1c437304d4a4`
- **Manifest sözleşmesi:** `schemaVersion: 1`, `product: "yunpanel"`, `version: "0.3.0"`, `sourceRepo: "Yunsoft-Software/yunpanel"`, `sourceCommit: "f30fd779293ad96f83e7a76846fa70e71562730b"`, `verifiedAt: "2026-11-24T19:44:58.502Z"`, `defaultPage: "installation-and-upgrade"`.
- **Görsel ve sayfa dili:** Tüm 22 Markdown kılavuzu kendi dilindeki `assets/<locale>/<image>.png` kaydına bağlanır. `screenshot:<manifest-id>` bağlantıları da aynı dil eşleşmesiyle desteklenir. İç bağlantılar `doc:<slug>` biçimindedir.
- **Kampanya bağlantıları** — İlk kurulum ve lisans kılavuzları Türkçe ve İngilizce canlı kampanya sayfalarına bağlanır. Kampanya ekran görüntüleri yerel `0.3.0` (`f30fd779`) aday derlemesinden alınmıştır.
- **Arayüz dili:** YunPanel `0.3.0` arayüzü Türkçedir. Pakette 17 gerçek Chromium görüntüsü, her kılavuz dili için ayrı alt metin ve açıklamayla toplam 34 görsel kaydında yer alır. İngilizce kılavuzlardaki görseller aynı Türkçe arayüzü gösterir. Kaynak arayüz dili her İngilizce görsel kaydının `capturedFrom` bilgisinde belirtilir. 15 ortak ekran `tr-TR` ve `en-US` tarayıcı ayarlarında doğrulandı. Toplam 30 kontrolde sayfa hatası veya yatay taşma görülmedi (`.local/website-docs/capture-report-0.3.0.json`).

### Sayfa, Slug, Dil ve Görsel Bağları (11 Sayfa × 2 Dil = 22 Kılavuz · 17 Doğrulanmış PNG)

| Sıra | Bölüm | Ortak Slug | TR Dosyası | EN Dosyası | Bağlı Görseller (`assets/tr/` ve `assets/en/`, `commit=f30fd779...`) |
| :---: | :--- | :--- | :--- | :--- | :--- |
| 1 | `getting-started` | `installation-and-upgrade` | `locales/tr/installation-and-upgrade.md` | `locales/en/installation-and-upgrade.md` | `18-tools-settings.png` (`64f6e865de69...`) |
| 2 | `getting-started` | `first-time-setup` | `locales/tr/first-time-setup.md` | `locales/en/first-time-setup.md` | `01-first-time-setup-dark.png` (`e21a70c62de5...`), `02-first-time-setup-light.png` (`0936ea5388d4...`), `03-login.png` (`138cd4e9b588...`) |
| 3 | `sites-and-access` | `sites-and-roles` | `locales/tr/sites-and-roles.md` | `locales/en/sites-and-roles.md` | `04-websites-hierarchy.png` (`e33af2e825e4...`), `05-new-website.png` (`e6239e042525...`), `06-site-overview.png` (`29240aa5bd33...`), `07-users-and-roles.png` (`3f6a79275f3d...`) |
| 4 | `sites-and-access` | `domains-and-ssl` | `locales/tr/domains-and-ssl.md` | `locales/en/domains-and-ssl.md` | `09-site-dns.png` (`a0e41dc0262d...`), `08-site-ssl.png` (`a9c76d9b8386...`) |
| 5 | `sites-and-access` | `wordpress` | `locales/tr/wordpress.md` | `locales/en/wordpress.md` | `06-site-overview.png` (`29240aa5bd33...`) *(Canlı Linux WP-CLI kanıtı `.28` `2301` ayrı tutulur)* |
| 6 | `sites-and-access` | `files` | `locales/tr/files.md` | `locales/en/files.md` | `11-files-editor.png` (`e81c2860e28f...`) |
| 7 | `services-and-data` | `docker` | `locales/tr/docker.md` | `locales/en/docker.md` | `12-docker-compose.png` (`2c015eac779f...`) |
| 8 | `services-and-data` | `databases` | `locales/tr/databases.md` | `locales/en/databases.md` | `13-databases.png` (`f65cd1fcf263...`) |
| 9 | `services-and-data` | `mail` | `locales/tr/mail.md` | `locales/en/mail.md` | `14-mail-domains.png` (`a051bbf476cc...`) |
| 10 | `services-and-data` | `backups-and-recovery` | `locales/tr/backups-and-recovery.md` | `locales/en/backups-and-recovery.md` | `15-site-backup.png` (`f39ac63393ea...`) |
| 11 | `licensing` | `licensing-and-premium` | `locales/tr/licensing-and-premium.md` | `locales/en/licensing-and-premium.md` | `16-license-free-offer.png` (`4c4653051632...`), `17-license-campaign-active.png` (`03080649298d...`) |

## 3. Üç Aylık Premium Kampanyası ve Lisans/Entitlement İncelemesi ve Hazırlığı

### Mevcut sözleşme bulguları ve uygulanan koruma/entegrasyonlar
1. **İlk kurulum ve Lisans yönlendirmesi (`b91cadb4`, `f30fd779`):**
   - `apps/api/src/yunsoft-links.js`: `YUNPANEL_PREMIUM_OFFER_URL` (varsayılan `https://yunsoft.com/kampanya/premium-3-ay`) ve `YUNPANEL_DOCS_URL` (varsayılan `https://yunsoft.com/docs/yunpanel`) için fail-closed HTTPS doğrulayıcı. Sorgu parametresi (`?`), parça (`#`), kimlik bilgisi (`user:pass@`), yol içi `@`/`%40`, `.44` adresi ve üretimde `http://` kesin olarak reddedilir.
   - `apps/api/src/auth-http.js`: Yalnızca kurulum tamamlanmamışken (`setupRequired: true`) `GET /api/auth/session` 401 yanıtında statik, gizlisiz `setupOffer` döner; kurulum sonrasında bu alan yanıt dışı kalır. `POST /api/auth/setup` yalnızca mevcut kurtarma e-postasını alır; müşteri panelinde bülten/abone listesi tutulmaz.
   - `apps/web/src/LoginForm.jsx` + `apps/web/src/AuthGate.jsx` + `apps/web/src/session-client.js`: İlk kurulumda isteğe bağlı **3 aylık ücretsiz Premium teklifi** kartı ve **Kurulum kılavuzu** bağlantısı (`target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"`). Kurtarma e-postası veya alan adı hiçbir zaman bağlantıya eklenmez.
   - `apps/web/src/workspace/LicenseSettingsPanel.jsx` + `apps/web/src/workspace/license-client.js`: Ücretsiz sürümde Owner için kampanya teklifi ve dokümantasyon bağlantısı gösterilir; herhangi bir aktif Premium lisans (`promotional`, `paid` veya `permanent`) etkinleştiğinde kampanya çağrı kartı otomatik gizlenir.
2. **Ortak kampanya kaydı ve ürün kapsamı:**
   - Mevcut `POST /v1/entitlements/activate` ve `POST /v1/entitlements/verify` çağrıları zaten `{ licenseKey, domain, instanceId, productCode: "yunpanel_premium" }` gönderir. Yunsoft Website tek kampanya kaydında YunPanel + YunCMS haklarını birlikte tutup her ürün için doğrulanmış kuruluma özgü imzalı Ed25519 `YUNSOFT-ENTITLEMENT+JWT` ürettiğinde YunPanel ek değişiklik olmadan çalışır; `yuncms_premium` jetonları `PRODUCT_MISMATCH` ile reddedilmeye devam eder.
   - Normalize e-posta ve alan adı tekilliği (ikinci hak engeli) Yunsoft Website kampanya kaydı tarafında yönetilir; müşteri paneli abone e-posta listesi saklamaz.
3. **Ücretli ve kalıcı hakların korunması (`license-entitlement-verifier.js`, `license-entitlement-service.js`):**
   - `billingModel` desteği: mevcut `monthly_term` yanında süreli kampanya için `promotional_term` (zorunlu `exp` + `periodMonths`) ve kalıcı haklar için `permanent` / `lifetime` (`exp: null` destekli, arayüzde `Kalıcı` / `Süresiz`) eklendi.
   - `assertPaidOrPermanentEntitlementProtected`: Aktif ücretli (`paid`) lisans varken kampanya (`promotional`) jetonu/anahtarıyla ezme `409 paid_or_permanent_entitlement_protected` (`PAID_ENTITLEMENT_PROTECTED`) ile reddedilir; aktif kalıcı (`permanent`) lisans varken süreli veya kampanya hakkıyla ezme `409` (`PERMANENT_ENTITLEMENT_PROTECTED`) ile reddedilir. Kampanyadan ücretli veya kalıcı lisansa yükseltme serbesttir.
4. **Website yayını ve kabul kanıtı**
   - Website ekibi 24 Kasım 2026 saat 23.21'de `XRSjtF4lwCPHmXV5lpCZI` derlemesinde YunPanel 0.3.0 ve YunCMS 2.1.3 kılavuzlarını iki dilde doğruladı. YunPanel'in 34 ve YunCMS'in 16 canlı görsel dosyasının özeti manifestlerle eşleşti.
   - Sabit kurulum adresi `/kampanya/premium-3-ay`, 308 ile Türkçe `/tr/kampanya/premium-3-ay` yoluna yönlendirir. İngilizce kampanya yolu `/campaign/premium-3-months` olarak doğrulandı. Türkçe ve İngilizce ilk kurulum ve lisans kılavuzları bu sayfalara bağlanır.
   - Uygulamaya özel mevcut posta taşıması için yerel `SmtpMailer.verify()` geçti. Gerçek dış gelen kutusuna teslim ve üretimde verilen hakkın ürün kurulumunda etkinleşmesi açık kabul olarak izlenir.

## 4. Doğrulama Komutları ve Gerçek Çıktılar

Aşağıdaki tüm komutlar mock/stub olmadan gerçek SQLite, gerçek API, gerçek üretim `@yunpanel/web` derlemesi ve gerçek Playwright Chromium üzerinde koşturulmuştur:

1. **Derleme ve politika denetimi:**
   - `npm run build` → geçti (`@yunpanel/web` üretim derlemesi `dist/` üretildi).
   - `npm run lint` → `Repository policy validation passed.`
2. **Gerçek API / SQLite / Kriptografik Lisans & İlk Kurulum testleri:**
   - `(cd apps/api && node test/runner.js test/premium-campaign-entitlement.test.js test/license-entitlement.test.js test/auth-http.test.js)` → **30 / 30 PASS** (0 fail, 0 skip).
   - Aktif-lisans CTA düzeltmesi (`f30fd779`) sonrası tekrar: `(cd apps/api && node test/runner.js test/premium-campaign-entitlement.test.js test/license-entitlement.test.js)` → **9 / 9 PASS**.
3. **Gerçek `@yunpanel/web` ve Playwright Chromium testleri:**
   - `npm test --workspace @yunpanel/web` (`b91cadb4`) → **1960 / 1960 PASS** (0 fail, 0 skip).
   - Aktif-lisans CTA düzeltmesi (`f30fd779`) sonrası tekrar: `(cd apps/web && node --test --test-timeout=120000 test/setup-premium-offer-browser.test.js test/license-settings-panel.test.js)` → **4 / 4 PASS** (ilk kurulum `en-US` 390px mobil + `tr-TR` masaüstü, `no-referrer` + sıfır PII sızıntısı, yerel loopback Website teklif/doküman bağlantısı HTTP 200 tıklaması, `Kampanya · 3 ay` → `Yıllık · 12 ay` → promosyon ezme reddi 409 → `Kalıcı` / `Süresiz` koruması).
4. **Gerçek Chromium ekran görüntüsü yakalama ve TR/EN browser locale doğrulaması (`f30fd779`):**
   - `node scripts/capture-docs-screenshots.mjs` → **17 son doküman PNG'si** (`assets/tr/`), **30 / 30 TR (`tr-TR`) + EN (`en-US`) tarayıcı locale kontrolü**, **0 `pageerror`**, **0 yatay taşma (`overflowX=0`)**; kanıt `.local/website-docs/capture-report-0.3.0.json`.
5. **Website importer doğrulaması ve paketleme:**
   - `node scripts/verify-and-package-docs.mjs --bundle docs/yunpanel-docs-0.3.0 --package .local/website-docs/yunpanel-docs-0.3.0.tar.gz` → 11 sayfa, 22 kılavuz dosyası, 34 görsel kaydı, 50 iç bağlantı, 36 görsel bağlantısı ve 64 arşiv girdisiyle geçti.
   - `node --test apps/web/test/versioned-docs-package.test.js` → **3 / 3 geçti**. Sayfaya farklı dilde kayıtlı bir görselin hem dosya yoluyla hem `screenshot:<id>` ile bağlanması reddedilir.
   - Yunsoft Website'in `validateDocsBundle` ve `importDocsBundle` işlevleri paketi izole geçici dizinde uyarısız kabul etti. İçe aktarılan dizinde 34 görsel dosyasının varlığı doğrulandı.
   - Canlı kampanya sayfalarına bağlanan dört kılavuz güncellendikten sonra repo denetimi, üç paket testi ve Website'in kendi paket doğrulayıcısı tekrar geçti. Güncellenen arşiv 64 girdi içerir.

## 25 Kasım 2026 — Kampanya lisansının sınıflandırılması

- YunPanel 0.3.0 adayı doğrulanmış imzalı kampanya alanlarını kullanır. Eski türsüz jeton aynı lisans, alan adı, kurulum, dönem ve bitiş için daha yeni bir imzalı kampanya jetonuyla yenilenebilir. Önceden ücretliye geçmiş ve kalıcı haklar korunur.
- Son adayla `python3 orkestra/orchestrator.py verify` geçti. Lisans API ve tarayıcı regresyonları ile Website'in 25 birim ve gerçek geçici MySQL kullanan 6 kampanya testi geçti. Bağımsız inceleme kabul verdi. İlk tam koşuda kırılan eski modal testi [T950](../../tasks/done/T950.md) altında güncellendi.
- `.28` üzerindeki izole Linux örneğinde önceki kampanyanın gerçek, Yunsoft imzalı jetonu API'de `promotional` döndü. Chromium'da `Kampanya · 3 ay` etiketi yenileme sonrasında göründü. Yanlış kurulum için jeton 422 ile reddedildi. Önceki türsüz jeton ayrı kurulumda sınandı. Aynı kurulumdaki yenileme kaynak testinde doğrulandı. Sonuç `.local/campaign-live-20261125/dot28-campaign-verification.json` içinde.
- Test ortamı kaldırıldı ve kurulu `.28` ana panelinin API/web sağlık kontrolleri geçti. Ana panel paketi `0.3.0-2026112301` olarak kaldı. Yunsoft Website imzalayıcı düzeltmesi yerel kaynakta test edildi. Website yayını ve ana panel paket kurulumu ayrı dağıtım adımları olarak açık.

## 26 Kasım 2026 — Güncel arayüzle yenileme (T959)

- **Neden:** 25 Kasım üst bar ve kenar menü değişikliği ile 26 Kasım metin temizliği ([T953](../../tasks/review/T953.md), [T961](../../tasks/review/T961.md)) eski görüntülerden (`f30fd779`) sonra geldi.
- **Arayüz kaynağı (`sourceCommit`):** `c1a84a5159add2f2f87fd6e21725f7c657cf98ec` (`26-11-2026` dalı). Görüntüler bu commit'te temiz çalışma ağacıyla alındı. Metin ve manifest değişiklikleri `c81c332c` commit'indedir; bu commit arayüz kodunu değiştirmez. `verifiedAt`: `2026-11-26T05:57:22.971Z`.
- **Metin değişiklikleri (TR + EN):**
  - `docker`: **Compose / Stack Ekle** → **Compose projesi ekle**; **Inner Port** / **Outer Port** → **Konteyner portu** / **Sunucu portu**; **Depolama / Volumes** → **Depolama** ve **Kalıcı volume yönetimi**; geçmiş ve işlemler için **Konteyner günlükleri**, **Proje işlemleri**, **Dağıtım ve çalıştırma geçmişi**.
  - `sites-and-roles`: Ekleme düğmeleri sayfa başlığındadır; ana alan adı kartındaki düğme **Alt alan adı** olarak geçer.
  - `domains-and-ssl`: Sertifika uyarıları üst bardaki zil simgesiyle açılan **Bildirim ve Görev Merkezi** içindeki **Bildirimler** sekmesindedir.
  - `files`: Sunucu kök terminali **Araçlar ve Ayarlar → Sunucu ve servis yönetimi** (`/servers`) altında gösterilir.
  - Tüm 22 sayfada doğrulanmış kaynak revizyonu `c1a84a51` olarak güncellendi. Diğer kalın arayüz etiketleri `apps/web/src` ile karşılaştırıldı; kaldırılmış başka etiket bulunmadı.
- **Görseller:** `node scripts/capture-docs-screenshots.mjs` yerel örnek veri ve yerelde imzalanan deneme lisansıyla çalıştı: 17 PNG, 30 `tr-TR`/`en-US` kontrolü, 0 `pageerror`, 0 yatay taşma. Dosya adları aynı kaldı; `assets/en/` aynı dosyaların kopyasıdır. Tüm görseller tek tek açılıp eskileriyle karşılaştırıldı: yeni üst bar ve gruplu kenar menü görünüyor. Görsellerde yalnız `ornek.example` örnek verisi var; gerçek müşteri verisi, parola, jeton veya `.local` değeri yok. Yan not: yakalama sırasında `/websites/<id>/wordpress` locale kontrolü API günlüğüne yerel `/var/lib/yunpanel/...` yolu için `ENOENT` yazdı. Bu sayfanın görüntüsü pakette yoktur, tarayıcıda sayfa hatası oluşmadı.

| Görsel (`assets/tr/` = `assets/en/`) | Yeni SHA-256 |
| :--- | :--- |
| `01-first-time-setup-dark.png` | `4b1e04253bf8427205f6a7c99272a4986b1ea42822fe473cd4253505fe09601d` |
| `02-first-time-setup-light.png` | `e793213753005cafb7cd4636936e9d64f26314ffa67365771cb98cce4a13cb16` |
| `03-login.png` | `88e6fd75e6308c53ceab2af9998727a96313f9952840c72e61a591f2bebd0a4e` |
| `04-websites-hierarchy.png` | `8df6248763b18cf4defdaf1b2db92829d5656ecb66c19e6b85b3196b8e03fafc` |
| `05-new-website.png` | `e5d0c7b900f7b20d4605e71773ac8e27fa057f881327ab00a567e352fd8fa31d` |
| `06-site-overview.png` | `ea6d4d2af8d44f00bd59befc2baeb478a8a3ddfa17c4d2958b814e4759cfe6d2` |
| `07-users-and-roles.png` | `815dd7f021ee1ae58ed53c68f424d1655c5fe521a8e8051047969b1ce7bcfeb6` |
| `08-site-ssl.png` | `b677d5c8582e892f6adfc2ea41436efef7fee520777f9d67f4cd6c27038c2019` |
| `09-site-dns.png` | `f2825e18f625980b60f219f45e78557db0d5c0b93d99034c8e15cc281216c760` |
| `11-files-editor.png` | `a7ccb231911c076388aaf238ed6a18ff46b06fd36c0242e3c84ab1a3aa6f9cf9` |
| `12-docker-compose.png` | `dd7a5261151584ae07d4a1803bfdc300a28d493ae28247015a5b03cae44b9432` |
| `13-databases.png` | `89568e8ce5a7939b93e651dcb7c4e1fd0f9c0118346245569e77f24a05add72b` |
| `14-mail-domains.png` | `1d7dc5c3112b548b8e9c79d187108192d39e7d35041588520337ee9b2dbac03d` |
| `15-site-backup.png` | `9fee6475754bb8da2862f0426c5b6c7c1282c7e001c49adde4610bfe4930f041` |
| `16-license-free-offer.png` | `5897b88173ad3ccd5a39f4cfdb941fb57df50dc7f1a18b638165d97fe62da348` |
| `17-license-campaign-active.png` | `296898340d699380814fc93df4aabb754ed4173e74b734aac538e35724bc384d` |
| `18-tools-settings.png` | `0b43ce08b49fad1715078da99020765633f0595fe0d155c859c935cea1a29784` |

- **Doğrulama:** `node scripts/verify-and-package-docs.mjs --bundle docs/yunpanel-docs-0.3.0 --package .local/website-docs/yunpanel-docs-0.3.0.tar.gz` geçti: 11 sayfa, 22 kılavuz, 34 görsel kaydı, 50 iç bağlantı, 36 görsel bağlantısı, 64 arşiv girdisi. `node --test apps/web/test/versioned-docs-package.test.js` → 3/3 geçti; test artık kampanya görsellerinin kaynağını sabit commit yerine manifestteki `sourceCommit` ile karşılaştırır. `npm run lint` geçti.
- **Arşiv:** T959 worktree'sinde `.local/website-docs/yunpanel-docs-0.3.0.tar.gz`, SHA-256 `c28c1a7630802b8471f3518c1d4d59bf72d9baba0409a70817febef1b34b190d`. Yakalama raporu aynı klasörde `capture-report-0.3.0.json`. Website'e aktarım ve yayın yapılmadı.

## 26 Kasım 2026 — yunsoft.com yayını (T959)

- **Kapsam:** Yalnız YunPanel `0.3.0` dokümanları: `content/docs/yunpanel/0.3.0/`, `public/docs-assets/yunpanel/0.3.0/` ve `content/docs/registry.json` içindeki YunPanel kaydı. `.44` erişimi DECISIONS 2026-11-26 istisnasıyla, yalnız senior.
- **Paket:** `yunpanel-docs-0.3.0.tar.gz` SHA-256 `c28c1a7630802b8471f3518c1d4d59bf72d9baba0409a70817febef1b34b190d`, manifest `sourceCommit` `c1a84a5159add2f2f87fd6e21725f7c657cf98ec`. Yerelde ve sunucuda website doğrulayıcısı geçti (11 sayfa, 34 görsel).
- **Yedek:** Önceki üç yer `/var/www/vhosts/yunsoft.com/.backups/docs-yunpanel-0.3.0-20261126/before/` altında (4,6 MB). Yayın paketi aynı klasörde.
- **Yayın:** Sitedeki `scripts/docs-bundle.mjs import` (yereldekiyle aynı hash) Node 24 ile çalıştırıldı: `imported: true`, uyarı ve hata yok. Sürüm klasörleri yine `yunsoft.com_qdablo7xeh9:psacln`, `registry.json` yine `root:root 644`. YunCMS 2.1.4 ve 2.1.3 kayıtları korundu. Build, servis veya backend değişmedi; yeniden başlatma gerekmedi.
- **Doğrulama:** 22 sayfa (TR/EN) HTTP 200. Docker sayfası iki dilde yeni etiketleri gösteriyor, eski etiket yok, sayfa revizyonu `c1a84a51`. 34 görselin canlı SHA-256 değeri paketle aynı. YunCMS doküman sayfası ve ana sayfa 200.
- **Docker görseli (aynı gün, kapandı):** Uyarının nedeni ekran görüntüsü ortamının Docker API yollarını kurmamasıydı (`/api/docker/projects` 404). `scripts/capture-docs-screenshots.mjs` artık Docker yollarını gerçek kayıtlarla kuruyor ve örnek `n8n_stack` Compose projesi gösteriyor (`677a2d5e`). Yalnız `12-docker-compose.png` (TR/EN, SHA-256 `9d5282e8…3738`) ve manifest özetleri değişti; arayüz kaynağı `c1a84a51` ile aynı olduğundan `sourceCommit` korunur.
- **Yeniden yayın:** Paket SHA-256 `c5b18afefe8f658345451ba3025c78252d7c93c7050663e60e3f5b164e6a8a2a`. Önceki durum `…/docs-yunpanel-0.3.0-20261126/before-docker/` altında yedeklendi (4,4 MB). Sunucu doğrulayıcısı ve `import` hatasız; sahiplikler aynı. Doğrulama: 22 sayfa 200, 34 görselin canlı SHA-256 değeri paketle aynı, YunCMS ve ana sayfa 200.

## 28 Kasım 2026 — Docker volume seçimi yayını (T969)

- **Neden:** T969 ile **Projeyi kaldır** önizlemesine volume seçimi (**Volume'ları koru** / **Volume'ları da sil**) geldi; TR/EN `docker.md` paragrafı `adf0c3bb` commit'inde eklendi. Görsel ve manifest değişmedi.
- **Onay:** İNSAN, 28-11-2026 ([DECISIONS](../orkestra/DECISIONS.md)); kapsam T959 istisnasıyla aynı, yalnız senior.
- **Paket:** `yunpanel-docs-0.3.0-t969.tar.gz` SHA-256 `1df403a194402a87ec5d14898fff94996877aef65281617bace183e92ec21160`. Yerelde doğrulayıcı (11 sayfa, 22 kılavuz, 34 görsel, 50 iç bağlantı) ve `versioned-docs-package.test.js` 3/3 geçti.
- **Yedek:** Önceki durum `/var/www/vhosts/yunsoft.com/.backups/docs-yunpanel-0.3.0-20261126/before-t969/` altında (4,4 MB).
- **Yayın:** Sunucuda `docs-bundle.mjs validate` ve `import` hatasız, uyarı yok. Sahiplikler aynı (`yunsoft.com_qdablo7xeh9:psacln`, `registry.json` `root:root 644`). YunCMS 2.1.4 / 2.1.3 kayıtları korundu. Build veya servis değişmedi.
- **Doğrulama:** TR `/tr/dokumanlar/yunpanel/0.3.0/<sayfa>` ve EN `/docs/yunpanel/0.3.0/<sayfa>` 22 sayfa 200. Docker sayfası TR'de yeni Türkçe paragrafı (`lang="tr"`), EN'de İngilizce paragrafı (`lang="en"`) gösteriyor. 34 görselin canlı SHA-256 değeri paketle aynı. Ana sayfa ve YunCMS doküman sayfası 200.
