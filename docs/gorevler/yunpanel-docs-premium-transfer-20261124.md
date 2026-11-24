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
- **Arşiv SHA-256:** `ab98ad9e0ccd33ad26ba1577a405f6573748332879f2e68a909a25705cfcaa23`
- **Manifest sözleşmesi:** `schemaVersion: 1`, `product: "yunpanel"`, `version: "0.3.0"`, `sourceRepo: "Yunsoft-Software/yunpanel"`, `sourceCommit: "f30fd779293ad96f83e7a76846fa70e71562730b"`, `verifiedAt: "2026-11-24T19:44:58.502Z"`, `defaultPage: "installation-and-upgrade"`.
- **Görsel ve sayfa dili:** Tüm 22 Markdown kılavuzu kendi dilindeki `assets/<locale>/<image>.png` kaydına bağlanır. `screenshot:<manifest-id>` bağlantıları da aynı dil eşleşmesiyle desteklenir. İç bağlantılar `doc:<slug>` biçimindedir.
- **Canlı kampanya sınırı:** Yunsoft Website üzerindeki 3 aylık ücretsiz Premium kampanyası şu an canlıda etkin değildir; Website tarafında SMTP doğrulaması ve kabul aşamasını beklemektedir. İlk kurulum ve lisans kılavuzlarındaki (`01-first-time-setup-dark.png`, `02-first-time-setup-light.png`, `16-license-free-offer.png`, `17-license-campaign-active.png`) kampanya görselleri yerel `0.3.0` (`f30fd779`) aday derlemesinden alınmış teknik doğrulama görüntüleridir; **canlı kampanya kullanım kanıtı sayılmaz**. Metinlerde 3 aylık teklifin görünümü ve etkinleştirme akışı açıkça Website'de kampanya açıldığında geçerli olacak biçimde anlatılmıştır.
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
4. **Açık kalan ortak Website bağımlılığı ve canlı sınırlar:**
   - **Website kampanyası henüz canlı değil:** Yunsoft Website kampanyası SMTP doğrulaması ve yayın kabulünü beklemektedir; canlı kampanya açılmadan müşteri kaydı veya canlı 3 aylık kampanya dağıtımı gerçekleşmez. Yerel aday derlemesinden alınan kampanya görselleri (`01-first-time-setup-*.png`, `16-license-free-offer.png`, `17-license-campaign-active.png`) yalnızca yerel entegrasyon doğrulamasıdır, canlı kullanım kanıtı sayılmaz.
   - **URL / claim eşlemesi:** Yunsoft Website'ın kesin nihai kampanya/doküman URL slug'ı ve Commerce `promotional_term` / `campaignCode` claim alan adları kesinleştiğinde gerekirse yalnız `YUNPANEL_PREMIUM_OFFER_URL` / `YUNPANEL_DOCS_URL` varsayılanları veya claim eşlemesi güncellenir; diğer projelerin dosyalarına dokunulmamıştır.

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
