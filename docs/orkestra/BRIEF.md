# BRIEF — YunPanel

**Şu anki senior:** Claude Code (Opus 5.5) · 2026-10-26
**Junior:** Antigravity (6 yuva, `/orkestra-devam`)

## Amaç
Yunsoft'un kendi hosting ve sunucu yönetim paneli. Plesk Obsidian'ın ekran düzeni, görev akışları ve özelliklerinin mevcut Node/React altyapısında işlevsel eşdeğeri. Renk değişikliği ya da katalog eklemek kabul sayılmaz; kabul, gerçek host üzerinde fiziksel sonuçtur.

## Kapsam
- **Var:** Web Siteleri (domain → subdomain hiyerarşisi), dosya, DB, SSL, posta, DNS, runtime (PHP/Node Passenger/Python/Static), Docker/Compose ve port proxy, yedek, erişim/terminal, bildirim/görev merkezi, uygulama marketi. Sade rol modeli: Owner → isteğe bağlı tek Reseller → Customer → Website. Ubuntu + Debian + RHEL ailesi (`os-platform.js`).
- **Yok (şimdilik):** alt bayi zinciri, reseller paket/abonelik motoru, add-on, overselling, fatura, markalama, login-as, Windows/IIS (ayrı hat). Ayrıntı: `agents.md` madde 3, `docs/plesk-feature-parity.md`.

## Mimari haritası
- `apps/api` — Node backend, giriş `src/index.js`; root yetkisi yalnız burada. Testler `apps/api/test` (`node test/runner.js`).
- `apps/web` — React/JSX (Vite). Tasarım sistemi `src/workspace/design-system/` + `PanelKit.jsx`.
- `packages/host-runtime` (host motor adapterları), `protocol`, `shared`, `config-templates`.
- `e2e/` — gerçek `.28` hedefine Playwright; `playwright.live-audit.config.js` canlı denetim hatları.
- Kayıt: auth SQLite, diğer registry'ler JSON + process lock. Mutation zinciri ve kimlik kuralları: `docs/architecture.md`, güvenlik `docs/security.md`, operasyon `docs/operations.md`.
- Belge sırası: `agents.md` → `plan.md` (açık işler) → `ui-plan.md` → `todo.md` (gerçek kabul kapıları) → `docs/plesk-feature-parity.md` (162 özellik).

## Güncel durum
- 26-10-2026: orkestra kuruldu; aktif dal `26-10-2026` (`25-10-2026`'dan).
- Açık ana işler: `plan.md` YP2-19…YP2-23 (merkezi Shadcn UI ve domain ağacı, subdomain file root, çoklu Linux, sıfır mock test hattı, Docker/Compose proxy) ve `todo.md` T-* gerçek kabul kapıları.
- 1. dalga hazır (`docs/gorevler/G1-manuel-test.md`): T100 hazırlık → T101–T224 124 özelliğin gerçek tarayıcıda manuel testi → T299 özet. Yöntem `docs/manuel-test/YONTEM.md`, raporlar `docs/manuel-test/<ID>.md`. Kritik hatalar bulgu görevi (T800+) olup düzeltilir.
- Sıradaki: junior `/orkestra-devam` ile 1. dalgayı yürütür; senior ertesi gün `OZET.md` ve raporları inceler. 3. dalga için Plesk'te sık kullanılan özellik listesini İNSAN verecek.
- 3. dalga adayları not olarak `docs/plesk-eksikler.md` ve `plan.md` sonunda (wildcard domain, hosting'siz yönlendirme, ek FTP vb.). Göreve çevrilmedi.
