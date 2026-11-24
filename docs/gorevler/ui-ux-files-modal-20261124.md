# UI/UX Görsel Denetim, Site Dosya Editörü ve Ortak Modal Davranışı (24 Kasım 2026)

24 Kasım 2026. Aktif dal `24-11-2026`, temel commit `2c635789`. Tüm değişiklikler yerel gerçek üretim derlemesi (`@yunpanel/web`), gerçek backend API, SQLite ve gerçek Playwright Chromium üzerinde mock/stub olmadan doğrulandı; push veya deploy yapılmadı.

## Görsel Denetim ve Ortak UI/UX Düzeltmeleri

- Kanonik menü ve router envanterinden erişilen **108 tekil ekran** için temiz `2c635789` **BEFORE** ve güncel **AFTER** PNG görüntüleri gerçek Chromium'da yakalandı ve her ekran tek tek görsel incelendi (0 sayfa hatası, 0 yatay taşma). Gizlisiz ekran görüntüleri ve eşleştirilmiş manifest: `.local/ui-ux-audit-20261124/manifest.md` ve `.local/ui-ux-audit-20261124/manifest.json` (`before/` ve `after/`).
- Kapsam: kimlik doğrulama akışları (`login` koyu/açık/mobil, `forgot`, `reset`, `setup`, gerçek yerel TOTP MFA doğrulama, gerçek yerel HTTPS `OwnerEnrollment`), tüm global menü ve 8 `/settings?section=` sekmesi, 20 site sekmesi (PHP, Node, taslak 409, desteklenmeyen proxy), `/applications/new`, `/docker/:id`, `/mail/:id`, modal/çekmece katmanları, 5 rol (`owner`, `reseller`, `customer`, `site_manager`, `read_only`) ve yetkisiz rol yönlendirme bildirimleri, koyu/açık mod ve `390×844` / `320×568` mobil görünümleri.
- **Tema kontrolü:** `WorkspaceLayout.jsx` ve `LoginForm.jsx` tema düğmeleri yalnız gün/gece ikonu + dinamik `aria-label`/`title` (`Açık temaya geç` / `Gece temasına geç`) kullanacak şekilde sadeleştirildi.
- **Site akordiyonu:** `WebsiteTaskCard.jsx` alt alan adı ve araç aç/kapat düğmeleri sabit sağ konumda belirgin tek yön okuna ve `aria-expanded` + `aria-label`/`title` yapısına geçirildi; alt alan adı sayısı bilgi olarak (`1 alt alan adı`) korundu.
- **Mobil menü ve ortak Shadcn/PanelKit düzeni:** Mobil çekmecede tek `Menüyü kapat` düğmesi bırakıldı. `theme.css` üzerinden Araçlar/Ayarlar kart boşlukları ve kolon simetrisi, açık tema Panel 1. KPI beyaz-üzeri-beyaz kontrastı, açık tema Dosyalar aktif görünüm ikonu, `CommandPalette` / `FilesPanel` / `SiteResourcesPanel` tek çerçeveli arama kutuları, tablo ilk sütun/başlık tutarlılığı, rozet sarma, PHP-FPM hedef etiketleri ve mükerrer hata şeritleri düzeltildi; hiçbir rota veya araç kaldırılmadı.

## Hata 1 — Site Dosya Editörünün Kapanınca Yeniden Açılması ve Tek-Onaylı Derin Bağlantı

- **Tekrar üretim (`2c635789`):** `/websites/:id/files` üzerinde açılan `index.html` editörü kapatıldığında URL `?file=index.html` geçiş yarışında `FilesPanel` kapanan dosyayı kendiliğinden yeniden açıyordu; kirli `?file=index.html` derin bağlantısında `Değişiklikleri bırak` onayı ise `UnsavedChanges` yönlendirme engelleyicisini ikinci kez tetikliyordu.
- **Düzeltme:** `FilesPanel.jsx` içinde `closingFileParamRef`, `pendingOpenFileRef`, `editorReadRef` ve iptal sonrası `<textarea>` odak geri dönüşü eklendi; `UnsavedChanges.jsx` içinde aynı pathname arama parametresi güncellemesine özel kontrollü `useSamePathSearchBypass` eklendi.
- **Doğrulama:** Gerçek Chromium kabul testi (`apps/web/test/files-modal-ui-ux-browser.test.js`) ve bağımsız doğrulama betiği (`node .local/ui-ux-audit-20261124/codex-file-check.mjs --phase after`, çıkış `0`) ile kapatılan editörün yenileme/poll/gezinmeyle açılmadığı, tek `Değişiklikleri bırak` ile ikinci uyarı olmadan `?file=` parametresinin silindiği, gerçek SPA gezinmesinde (`history.back`) taslak korumasının sürdüğü, alt klasör (`?path=public&file=notes.txt`), global `/files?site=<websiteId>&file=index.html` bağlantıları ve siteler arası kapsam izolasyonu doğrulandı.

## Hata 2 — Ortak PanelKit Modal Dış Tıklama ve Kaydedilmemiş Değişiklik Koruması

- **Tekrar üretim (`2c635789`):** `PanelKit.jsx` modal dış tıklamada kapanmıyordu ve kirli form koruması ekranlar arasında dağınıktı; `AiSettingsPanel.jsx` içinde yerel `window.confirm` vardı.
- **Düzeltme:** `PanelKit.jsx` üzerinde yığın katman yönetimi (`modalLayerStack`), dış tıklama ve içeriden-dışarı sürükleme koruması (`pointerDownOutsideRef`), otomatik kirli-form izleyici (`useFormDirtyTracker` — başlangıç değerine dönüş ve radyo grupları dahil), ortak `ModalCloseButton` ve üst üste açılan ortak `ConfirmDialog` (`Kaydedilmemiş değişiklikler var` · `Düzenlemeye dön` / `Değişiklikleri bırak`) kuruldu. Tüm form modalları, `AccountDialog.jsx`, çekmeceler (`JobDrawer`, `AiDrawer`, `NotificationCenterDrawer`, `WebsiteRemovalRecoveryPanel`) ve `AiSettingsPanel.jsx` (sıfır `window.alert`/`confirm`/`prompt`) aynı sözleşmeye bağlandı.
- **Doğrulama:** Temiz dış tıklama, kirli dış tıklama / Escape / X / `Vazgeç` ortak uyarısı, `Düzenlemeye dön` / Escape / uyarı dış tıklamasıyla yalnız üst uyarının kapanıp taslak ve odağın korunması, ilk değere dönünce temiz kapanma, açıkça `Değişiklikleri bırak` ile ikisinin kapanması, gerçek uçuşta olan `POST /api/users` isteğinde `busy` kilidi ve `Tab` odak tuzağı gerçek Chromium'da doğrulandı.

## Doğrulama ve Sınırlar

- `npm run build`: geçti.
- `npm run lint`: geçti (`Repository policy validation passed.`).
- `npm test --workspace @yunpanel/web`: **1959 / 1959 geçti** (0 hata, 0 atlanan; `files-modal-ui-ux-browser.test.js` dahil).
- `node .local/ui-ux-audit-20261124/codex-file-check.mjs --phase after`: çıkış `0`, 0 sayfa hatası (`uriStillHasFileAfterSingleDiscard: false`, `layersAfterSingleDiscard: []`).
- Bağımsız kod incelemesi: ilk turdaki 6 bulgunun tamamı giderildi; ikinci tur sonucu **PASS**.
- **Açık sınırlar:** Bu çalışma yalnız yerel derleme ve yerel test ortamında doğrulandı; uzak sunucuya (`.28` dahil) deploy veya `.44`/`.14` erişimi yapılmadı. Yerel macOS geliştirme ortamında sistem servisleri (systemd, PowerDNS, Postfix/Dovecot, CrowdSec, yerel Docker daemon) çalışmadığından ilgili ekranlar gerçek yerel boş/servis-hazır-değil durumlarıyla yakalanıp manifestte işaretlendi.
