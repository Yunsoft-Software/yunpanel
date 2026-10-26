# Proje kuralları — YunPanel

> Senior doldurur ve günceller. `KURALLAR.md` ile çelişirse bu dosya geçerlidir. **Kök `agents.md` bağlayıcıdır ve her şeyin önündedir**; bu dosya onu orkestra akışına bağlar, tekrar etmez. Her ajan işe başlamadan `agents.md`'yi ve görevinin işaret ettiği belgeleri okur.

## Ön kontrol
1. **Aktif dal = bugünün tarihi** `DD-MM-YYYY` (Europe/Istanbul; `TZ=Europe/Istanbul date +%d-%m-%Y`).
   - `git branch --show-current` bugünün dalıysa devam.
   - Değilse ve `tasks/claims/` boşsa: `git switch -c <bugün>` (yerelde varsa `git switch <bugün>`). Yeni dal bir önceki aktif daldan, yani o an bulunulan daldan açılır. LOG'a yaz.
   - Değilse ama aktif claim varsa: dal değiştirme (çalışan ajanların ağacı bozulur). Mevcut dalda devam et, kullanıcıya bildir; claim'ler bitince değiştir.
   - `main`, `development` veya başka bir dala asla geçme, commit atma, merge etme.
2. `node -v` ≥ 24.11.1 ve `npm -v` ≥ 11; `node_modules` yoksa `npm ci`.
3. `.local/test-server.env` var mı? Yoksa canlı test işleri (`sunucu-28` kilidi gerektirenler) başlatılmaz; sadece kaynak/birim işleri yürür.

## Doğrulama
- **Görev teslimi (zorunlu):** `npm run lint` + değiştirdiğin alanın birim/API testleri (`npm test --workspace <ilgili>` veya ilgili test dosyası). Görevin `Kabul` satırı ayrıca ne istiyorsa.
- **Dalga sonu / tam:** `python3 orkestra/orchestrator.py verify` → lint, tüm testler (~100 sn), `npm run build` ve `sunucu-28` kilidiyle Playwright e2e. agents.md 25 Ekim §9'daki "toplu koşturma" bu adımdır. Kullanıcıya "tamamlandı" yalnız bu geçtikten sonra söylenir.
- Testler mock, stub HTTP cevabı veya sahte veri kullanmaz (agents.md 24 Ekim §1). Sadece kaynak metninde regex arayan test, test sayılmaz.

## İzinli test hedefleri
- **Yalnız** `.local/test-server.env` ile doğrulanan `.28` YunPanel test sunucusu; adres her oturumda bu dosyadan teyit edilir. Dosyanın içeriği (adres, kullanıcı, parola) rapora, loga, commit'e yazılmaz.
- **Panel girişi (tarayıcıdan manuel test):** adres, Owner kullanıcı adı ve parola `.local/yunpanel-owner-password-only.json` içinde (`url`, `username`, `password`; gitignore'da, izin 600). Ajan tarayıcıda bu bilgilerle giriş yapar ve oturum düşerse yeniden girer. Parola, cookie ve token sohbete, rapora, loga, ekran görüntüsüne veya commit'e yazılmaz. Reseller/Customer testleri için gereken hesapları Owner olarak panelden, ajan önekiyle oluşturur ve test sonunda siler; o hesapların parolaları yalnız `.local/manuel-test/` altında tutulur.
- `.28`'de **aynı anda en fazla 3 ajan** çalışır. Canlı işe başlamadan `sunucu-28-1`, `sunucu-28-2`, `sunucu-28-3` kilitlerinden boş olanı al (`bash orkestra/lock.sh acquire sunucu-28-1 AGENT_n`; 120 sn'de alınamazsa sıradakini dene), iş bitince bırak. Üçü de doluysa canlı gerektirmeyen hazırlığı yap (kodu ve akışı oku, senaryoları yaz) ve sonra tekrar dene.
- **Sunucu geneli işlemler** (firewall, sunucu ayarları, PHP sürümü kurma/kaldırma, servis veya paket restart, Nginx ana yapılandırması, DNS sunucu ayarı, kullanıcıları etkileyen genel ayar) ayrıca **`sunucu-28-genel`** kilidiyle, tek ajan tarafından yapılır ve aynı oturumda eski haline döndürülür.
- Her ajan oluşturduğu test kaynaklarını kendi öneğiyle adlandırır (ör. `agent3-t512-*.webrich.news`), raporuna listeler ve normal panel akışıyla temizler. Başkasının veya kullanıcının verisine dokunulmaz.
- `.28`'de rutin yedek/snapshot alınmaz (agents.md 11 Ekim kuralı).

## Yasak alanlar ve sınırlar
- **`.44` ile biten Plesk sunucusuna hiçbir amaçla dokunulmaz.**
- Junior ajanlar **asla push etmez.** Push yalnız senior tarafından, İNSAN'ın açık onayıyla, yalnız bugünün aktif dalına ve yalnız `python3 orkestra/orchestrator.py push` ile yapılır (KURALLAR §6). Push isteği agents.md 25 Ekim §9 toplu test koşturmasını tetiklemez; komut gerekiyorsa `verify --quick` çalıştırır. `main`'e push, merge, force push ve geçmiş silme yok. GitHub Actions yok.
- Deployment (paket kurulumu, `.28` dışında herhangi bir hedef) ayrı İNSAN onayı ister.
- Parola, token, key, cookie, MFA ve private config repoya, loga, rapora veya ekran görüntüsüne yazılmaz.

## Teknik kurallar
- Commit mesajlarının sonuna `[skip ci]` eklenir: `git commit -m "T512: başlık [skip ci]"`.
- React + JavaScript/JSX; TypeScript veya yeni UI motoru yok. UI yalnız merkezi tasarım sisteminden (`apps/web/src/workspace/design-system/`, `PanelKit.jsx`).
- Mutation zinciri (RBAC → preview → onay → kilit → durable job → apply/configtest → health → reconcile) ve kimlik ayrımı (Website/Domain/Application) `docs/architecture.md`'deki gibi korunur.
- Çalışan motorlar (Files/elFinder, ttyd, phpMyAdmin, Roundcube, PowerDNS…) yeniden yazılmaz.
- Görev tamamlanınca `plan.md`/`todo.md` maddesi yalnız ilgili görevin `Kabul`'ü inceleme ve dalga sonu `verify` ile geçtikten sonra senior tarafından işaretlenir; junior bu dosyaları değiştirmez.
