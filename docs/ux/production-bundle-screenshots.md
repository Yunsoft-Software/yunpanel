# Gerçek Üretim Web Bundle'ından Masaüstü, Tablet ve Mobil Ekran Görüntüleri ve Görsel Kabul Kanıtı

**Tarih:** 2026-10-06  
**Aktif Dal:** `development` (çalışma dalı: `code-factory/task/62c73dd9-4c01-4199-8b46-49b6d3417291-f939aa6b6b6f`)  
**Görev:** Son kullanıcı onayı için gerçek üretim bundle'ından masaüstü/tablet/mobil ekran görüntüleri üretimi  
**Yetkili Staging Hedefi:** 157.180.11.28, HTTPS `https://server.cryptoraichu.website`  
**Yasaklı Sunucu (.44):** Kesinlikle hariç tutulmuştur; hiçbir bağlantı veya dağıtım yapılmamıştır.

---

## 1. Mevcut Uygulama ve Üretim Derleme Yapılandırmasının İncelenmesi

Düzenleme yapılmadan önce `apps/web` uygulama ve build mimarisi detaylı olarak incelenmiştir:

1. **Bağımlılıklar ve Sürümler:**
   - React `19.2.8`, ReactDOM `19.2.8`, React Router `8.3.0`.
   - Vite `8.2.2`, `@vitejs/plugin-react` `6.1.1`.
   - Node `v24.21.0`, npm `11.19.0`.
   - `@xterm/xterm` `6.0.0`, `@xterm/addon-fit` `0.11.0`.

2. **Derleme Süreci (Build Pipeline):**
   - `npm run fonts`: `scripts/prepare-ui-fonts.mjs` üzerinden Manrope ve Outfit fontlarını sabit boyut ve Git blob hash'leriyle doğrular.
   - `npm run build`: `prebuild` (`npm run fonts`) ardından `vite build` çalıştırarak `apps/web/dist` içerisine dağıtım paketini üretir.
   - Üretilen gerçek üretim bundle'ı:
     - `dist/index.html` (HTML dokümanı ve derlenmiş chunk referansları)
     - `dist/assets/index-BoFHo-wT.js` (ana React/Router uygulama kodu)
     - `dist/assets/index-CZYKJULk.css` (Ember tema tokenları ve layout stilleri)
     - `dist/assets/TerminalPanel-*.js` / `dist/assets/TerminalPanel-*.css` (dinamik terminal chunk'ı)
     - `dist/fonts/ember/` (doğrulanmış Manrope ve Outfit font varlıkları)

3. **Görsel Tasarım Tokenları (Ember Visual Language):**
   - Koyu tema grafit zemin: `#171816`
   - Koyu tema çalışma yüzeyi: `#222320`
   - Mandalina marka/vurgu rengi: `#f77749`
   - Sıcak kâğıt açık tema zemini: `#f2f0eb`
   - Kart köşe yuvarlatma (border-radius): `22px`
   - Kontrol yükseklik ve dokunma alanları: mobilde min `44px`

---

## 2. Gerçek Üretim Bundle'ından Üretilen Özgün Ekran Görüntüleri

Staging ortamında çalışan gerçek uygulama ve üretim bundle'ı üzerinden `workspace_browser` Playwright denetleyicisi ile aşağıdaki özgün ekran görüntüleri üretilmiştir:

| Görünüm Türü | Viewport (CSS px) | Ekran Görüntüsü Artefakt Referansı | Doğrulanan Düzen Özellikleri |
| :--- | :--- | :--- | :--- |
| **Masaüstü (Desktop)** | 1440 × 900 | `artifact://local/browser/ddff9ce3-6906-48a0-af19-70107470f9f8/e332d123-c844-404e-ae4a-ec3a1045d1e5-screen-1440.png` | 232px sabit sol navigasyon çubuğu, 4 kolonlu metrik kartları, genişletilmiş veri tabloları |
| **Tablet (Tablet)** | 834 × 900 | `artifact://local/browser/ddff9ce3-6906-48a0-af19-70107470f9f8/78e2e002-904a-4cdd-beea-3cd6d3c3199f-screen-834.png` | Ekran dışına katlanan (`translateX(-100%)`) çekmece menü, 2 kolonlu metrik grid, taşmayan modal |
| **Mobil (Mobile)** | 390 × 900 | `artifact://local/browser/ddff9ce3-6906-48a0-af19-70107470f9f8/a9f0050f-1b98-49c6-a87a-7351da3302c2-screen-390.png` | Dikey yığılan başlıklar, kart düzenine dönüşen tablolar, 44px minimum dokunma alanları |
| **Dar Mobil (Narrow)** | 320 × 900 | `artifact://local/browser/ddff9ce3-6906-48a0-af19-70107470f9f8/195b01fc-ea96-48c4-a634-bf44eacf7c3f-screen-320.png` | `min-width: 320px` sınır güvenliği, tek kolon filtreleme, taşmasız modal pencereleri |
| **Genel Bakış (Smoke)** | - | `artifact://local/browser/ddff9ce3-6906-48a0-af19-70107470f9f8/fe9856eb-cdc8-4a6c-a16a-bd4417cf18d6-smoke-success.png` | Başarılı oturum açma (`.auth-sessionbar`), Owner sunucu yönetimi paneli doğrulaması |

---

## 3. Önceden Üretilen Tasarım Kolajlarının ve Yapay Örnek Verili Görüntülerin Reddi

Aşağıdaki sentetik veya geliştirme amaçlı temsili görseller canlı sunucu veya üretim paketi kanıtı olarak **kabul edilmemiştir**:

1. `docs/history/ember-visual-language-2026-09-22.md` kapsamında üretilen 14 temsili HTML tasarım kolajı görüntüsü (temsili HTML düzenleri, yedek fontlu statik fixture'lar).
2. `docs/history/site-workspace-files-mail-db-2026-09-22.md` kapsamında üretilen 15 örnek-verili bileşen testi ekranı (`sample-data-component-screen-*.png`).
3. Tarayıcı veya sunucu render'ı içermeyen mockup veya CSS kaynak regex eşleşmeleri.

Tüm görsel kabul çıktıları yalnızca `workspace_browser` üzerinden staging sunucusunda gerçek çalışan üretim bundle'ından elde edilen doğrulanmış native ekran görüntüleriyle kanıtlanmıştır.

---

## 4. Güvenlik, İzolasyon ve Belgesel Bütünlük Sınırları

- **.44 Sunucu Yasağı:** `.44` ile biten hiçbir adrese bağlanılmamış; `assertNoDot44Host` kapısıyla 403 / `forbidden_host_dot44` istisnası korunmuştur.
- **Canlı Dağıtım Kapsamı:** Bu aşamada production deploy veya yetkisiz canlı kabul yapılmamıştır. Dağıtım kanıtları bağımsız Code Factory kapılarına bırakılmıştır.
- **Kabul Maddeleri:** Kök `todo.md` dosyasındaki ilgili canlı ortam kabul maddesi (`- [ ]`), Code Factory işletim kuralları gereği mekanik doğrulama öncesinde açık tutulmuştur.
