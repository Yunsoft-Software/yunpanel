# YunPanel — Geliştirme özeti

Node >=24.11.1 ve npm >=11. React/JavaScript/JSX; TypeScript/GitHub Actions yok. Önce agents.md, plan.md, ui-plan.md, gerçek audit ve ilgili kod. Aktif dal development; main'e yazma/deploy yok; her yazımdan önce HEAD/status kontrol edilir ve eşzamanlı değişiklik korunur. Commit mesajı [skip ci].

- Kurulum: npm ci. Normal yerel çalışma: npm run dev veya ilgili dev:web/dev:api workspace komutu.
- Local auth: npm run auth -- setup-token; API ile aynı env/state kullanılır. .env.example private production env değildir, otomatik yüklendiği varsayılmaz.
- Kontrol: npm run lint, anlamlı odak testleri, uygulama diliminde npm run check (lint + workspace test + build).
- Browser acceptance gerçek authenticated üretim bundle ve görev sonucuyla; unit/model/source regex ayrı raporlanır. Mock ve sabit artifact URL'leri canlı test değildir.
- New enrollment is retired. Production tek yerel host + privileged API; eski agent development yalnız offline rollback uyumluluğu. Yeni enrollment/backdoor/parallel privileged daemon kurulmaz.
- .local/test-server.env ve private data Git dışındadır. .44 hiçbir testte kullanılmaz; live mutation/deploy için açık hedef/scope izni gerekir.
- Yeni iş: tek kullanıcı sonucu → dar source slice → test → bağımsız review → .28 gerçek kabul → Git integration → plan maddesini kapat. 10 Ekim kullanıcı bütün yeni source işlerini onayladı; deployment ayrı hedef/kapsam onayıyla yapılır.

[Operasyon/kurtarma](operations.md) · [Mimari](architecture.md) · [Güvenlik](security.md).

Live audit: `YUNPANEL_AUDIT_RUN_DIR=.local/browser-audit/<fresh-run> YUNPANEL_AUDIT_LANE=read npx playwright test --config=playwright.live-audit.config.js 01-route 02-critical 03-responsive`. Gerçek `.28` HTTPS/DNS hedefi zorunlu; auth yalnız private `.local/yunpanel-owner-password-only.json`, AI yalnız mevcut private env token. Her lane ayrı sonuç dizini; mutation lane'leri aynı manifest üzerinde sırayla çalıştırılır. 04/06/07/09/10/11 mutation ve 05 gerçek provider çağrısıdır, açık hedef/scope izni gerektirir. Tüm dosyaları koşmak mutasyonları da başlatır; baseline verilerini fixture yerine kullanma. Setup yeni run envanterini kaydeder; eski run tekrarında kurulum 409'ları ürün hatası sayılmaz.
