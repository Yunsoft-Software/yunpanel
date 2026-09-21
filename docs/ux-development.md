# UX development — uygulama ve birleştirme notları

Tarih: 21 Eylül 2026. Dal: `ux-development`.
Başlangıç: `main` / `b46c7daeba4b639d9e05e5bd138f46e76fe2b0f6`.

Kullanıcının bu dal için verdiği açık tasarım uygulama talebi esas alınmıştır. Antigravity'nin eşzamanlı backend/functionality çalışması devam eder. Bu dal `main`e birleştirilmedi, sunucuya deploy edilmedi; GitHub Actions kullanılmadı. Kod commitleri `[skip ci]` içerir. Bu belge yalnız bu UX dalının teslim durumudur; genel geliştirme sırasını veya güvenlik sözleşmelerini değiştirmez.

**Durum: `ui-plan.md` bütünü tamamlanmadı. Ortak görsel katman, ana navigasyon ve komut paletinin ilk uygulaması commitlendi. Canlı tarayıcı kabulü bekliyor.**

## Commitlenen değişiklikler

| Commit | Kapsam |
| --- | --- |
| `66ad9b6` | Sunum modeli, tercih doğrulama, izinli navigasyon, gerçek Website sayacı, arama bağlantıları ve 14 regresyon testi. |
| `e2a9057` | Semantik açık/koyu tema, Sistem tercihi, Rahat/Kompakt yoğunluk, responsive ve reduced-motion CSS katmanı. |
| `b2be0fb` | Gruplu ana menü, tercih kontrolleri, Ctrl/Cmd+K komut paleti ve ortak kabuk entegrasyonu. |

Mevcut kod dosyaları içinde yalnız `apps/web/src/workspace/WorkspaceLayout.jsx` değiştirildi. Eklemeler:

- `apps/web/src/workspace/ui/ux-model.js`
- `apps/web/src/workspace/ui/Preferences.jsx`
- `apps/web/src/workspace/ui/CommandPalette.jsx`
- `apps/web/src/workspace/ui/ux-theme.css`
- `tests/ux-presentation.test.js`
- Bu belge.

Görsel katman mevcut `workspace.css` sonrasında yüklenir. `--ws-*` uyumluluğu ve mevcut component export yüzeyi korunur. Tablo, kart, form, buton, bildirim, menü, başlık ve modal yüzeyleri ortak tokenlarla düzenlenir. Harici font, yeni UI/motion bağımlılığı veya TypeScript eklenmez.

Ana menü Günlük kullanım / Kaynaklar ve işlemler / Sistem olarak gruplanır. Salt okunur hesapta mevcut izinli rota kümesi korunur. Komut paleti yalnız navigasyon yapar; sunucu mutasyonu başlatmaz. Domain rota kimliği Website kimliğine sessizce çevrilmez; `/websites?q=...` arama sözleşmesi korunur.

Tercihlerde yalnız `theme` ve `density` saklanır. Tarayıcı depolaması engellendiğinde tercih mevcut oturumda uygulanır ve kalıcı kayıt yapılamadığı bildirilir. Sistem tema değişimi ve diğer sekmedeki tercih değişimi izlenir.

## Bilinen sınırlar

Website sayacı yalnız gerçek `/websites` koleksiyonu bu sayfada yüklenmişse gösterilir. Domain veya alias sayısı Website sayısı diye sunulmaz; yüklenmeyen envanter sıfır gösterilmez. Bu dal mevcut route-demand/polling haritasını değiştirmediği için sayaç her rotada görünmeyebilir.

Komut paletinin site önerileri o ekranda yüklenmiş, izinli domain envanteriyle sınırlıdır; en fazla sekiz öneri gösterilir. Daha fazla kayıt için Web siteleri arama bağlantısı vardır. Aynı nedenle üst bardaki aktif iş sayısı yalnız mevcut jobs koleksiyonu biliniyorsa gösterilir; sürekli global job polling eklenmedi.

`groupSiteTabs` yardımcı modeli testlidir, fakat SiteDetailPage'e bağlanmadı. CSS içindeki site grubu, skeleton, busy-button ve drawer kuralları hazırlık niteliğindedir; bu bileşenlerin çalışır olarak teslim edildiği anlamına gelmez.

PanelKit ve JobDrawer için bazı dosya güncelleme çağrıları araç tarafından engellendi. Bu güncellemeler commitlenmedi. Dalda `PanelKit.jsx`, `JobDrawer.jsx` ve `SiteDetailPage.jsx` hâlâ başlangıç sürümündedir. Özellikle job detayı henüz gerçek non-modal drawer değildir; ortak CollectionNotice hâlâ eski davranışındadır.

## Yapılan doğrulamalar

1. `node --test tests/ux-presentation.test.js`: 14 test geçti, 0 başarısız. Tercih whitelist'i, bozuk/engelli storage, salt okunur menü, gizli/erişilemeyen envanter, Domain rota kimliği, query encoding/sınırları, sayaç ve sekme gruplama modeli test edilir.
2. Commitlenen JS/JSX dosyaları TypeScript transpileModule ile yalnız sözdizimi açısından kontrol edildi; hata yok. Repoya TypeScript veya transpiler bağımlılığı eklenmedi.
3. `ux-theme.css` PostCSS ile parse edildi; sözdizimi hatası yok.
4. Yerelde test edilen altı kod/test dosyasının Git blob SHA değerleri GitHub'daki branch dosyalarıyla karşılaştırıldı ve eşleşti.

**Bu doğrulamalar production build veya uçtan uca test değildir.** Ortam Node 22.16.0 içeriyor; repo Node >=24.11.1 ve npm >=11 gerektiriyor. Tam repo kurulumu, `npm ci`, `npm run check`, Vite build, gerçek React ekranlarının tarayıcı testi ve canlı sunucu kabulü yapılmadı. Tam tema kapsamı, kontrast, klavye/screen-reader davranışı ve layout taşmaları canlı tarayıcıda ayrıca doğrulanmalıdır. Bu test dosyası kök workspace test komutundan bağımsızdır; yukarıdaki komut açıkça çalıştırılmalıdır.

## Henüz tamamlanmayan işler

- Site detayında mevcut URL/runtime/yetki sınırlarını koruyarak altı gruplu navigasyonu bağlamak; site başlığı ve kısayolları bütünleştirmek.
- Mevcut job observer'ı koruyarak masaüstünde non-modal sağ panel, mobilde erişilebilir modal ve mevcut job sonuçlarıyla işlem merkezi.
- PanelKit busy button, ayrıntılı durum rozetleri, ortak skeleton/resource boundary ve form davranışlarını uygulamak.
- Site listesi/domain ağacı, oluşturma wizard'ı, DNS/SSL, mail, DB, yedek, Docker ve entegre araç sayfalarının `ui-plan.md` içindeki ekran bazlı UX revizyonları.
- Mevcut sayfalardaki sabit/inline renklerin tema kapsamı; auth ve entegre araç çevresinin görsel kabulü. Vendor iframe içeriği bu CSS ile yeniden temalanmış sayılmaz.
- Gerçek Owner/salt okunur oturumlar, mobil/desktop, uzun domainler, stale/error durumları, dirty form, logout ve site değişimi regresyonları.

Genel `plan.md`, `todo.md`, `agents.md` ve `ui-plan.md` eşzamanlı düzenleme riskini azaltmak için bu dalda değiştirilmedi. `ui-plan.md` üstündeki eski “yalnız plan” ifadesinin yanında uygulama durumunu belirlemek için bu belge okunmalıdır; tamamlanmamış maddeler tamamlandı olarak işaretlenmedi.

## Eşzamanlı main kontrolü

Bu çalışma sırasında main `e477fb5e9162085a19a2d842dee1d30de016bc9d` noktasına ilerledi. Başlangıçtan bu SHA'ya fark: `docs/history/debian-package-upgrade-live-acceptance-2026-09-21.md`, `plan.md`, `todo.md`. UX değişiklikleriyle dosya örtüşmesi yoktu. Bu yalnız belirtilen SHA'ların incelemesidir; gelecekteki commitlerin çakışmayacağını garanti etmez. Otomatik merge, rebase veya force-push yapılmadı.

## Güvenli birleştirme prosedürü

Antigravity'nin açık çalışma klasöründe branch değiştirmeyin. Entegrasyonu ayrı worktree ve geçici dalda hazırlayın. Aşağıdaki komutlar bu teslim sırasında çalıştırılmış değildir:

```sh
git fetch origin
git worktree add -b integration/ux-review ../yunpanel-ux-review origin/main
cd ../yunpanel-ux-review
git merge --no-ff --no-commit origin/ux-development
```

Çakışma çıkarsa özellikle WorkspaceLayout'ta iki dalın davranışını birlikte koruyun: yeni backend/provider/yetki bağlantıları kaybolmamalı; UI dosyaları ve CSS import sırası korunmalı. Toplu `ours/theirs` seçimi, eski dosyayı bütünüyle yeni main üstüne kopyalama veya force-push kullanmayın. İptal için, merge devam ederken `git merge --abort` kullanılabilir; Antigravity worktree'sini etkilemez.

Repo `.nvmrc` ve package engines gereksinimlerini karşılayan Node/npm ortamında:

```sh
npm ci
node --test tests/ux-presentation.test.js
npm run check
```

Tarayıcıda en az 1440, 1024, 768 ve 390 px genişlik; Sistem/Açık/Koyu; Rahat/Kompakt; mobil menü Tab/Escape/focus dönüşü; Ctrl/Cmd+K arama ve eski deep linkler; Owner ve salt okunur görünüm; açık form/işlem sırasında navigasyon kontrol edilmelidir. Tema değişimi formu veya araç oturumunu yeniden kurmamalıdır. Bilinmeyen sayaçlar sıfır olmamalıdır.

Tüm kontrollerden sonra entegrasyon dalında merge commit'i oluşturun:

```sh
git commit -m "merge: integrate ux-development after manual validation [skip ci]"
```

Main bu sırada yeniden ilerlediyse güncel main ile entegrasyonu tekrar doğrulayın. Main'e alma kararı ve deployment kullanıcıya aittir; bu belgede test sunucusu veya production için otomatik deploy talimatı yoktur.
