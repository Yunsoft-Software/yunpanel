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
- `.28`'e dokunan her iş (SSH, Playwright, canlı API, kurulum/silme) **`sunucu-28` kilidi** altında yapılır: `bash orkestra/lock.sh acquire sunucu-28 AGENT_n` … `release`. Aynı anda tek ajan. Kilit 120 sn içinde alınamazsa kaynak işine devam et ve sonra tekrar dene; kilidi bekleyerek yuva boşa tutulmaz.
- Her ajan oluşturduğu test kaynaklarını kendi öneğiyle adlandırır (ör. `agent3-t512-*.webrich.news`), raporuna listeler ve normal panel akışıyla temizler. Başkasının veya kullanıcının verisine dokunulmaz.
- `.28`'de rutin yedek/snapshot alınmaz (agents.md 11 Ekim kuralı).

## Yasak alanlar ve sınırlar
- **`.44` ile biten Plesk sunucusuna hiçbir amaçla dokunulmaz.**
- Junior ajanlar **asla push etmez.** Push yalnız senior tarafından, değerlendirmeden sonra, İNSAN'ın açık onayıyla ve yalnız bugünün aktif dalına yapılır. `main`'e push, merge, force push ve geçmiş silme yok. GitHub Actions yok.
- Deployment (paket kurulumu, `.28` dışında herhangi bir hedef) ayrı İNSAN onayı ister.
- Parola, token, key, cookie, MFA ve private config repoya, loga, rapora veya ekran görüntüsüne yazılmaz.

## Teknik kurallar
- Commit mesajlarının sonuna `[skip ci]` eklenir: `git commit -m "T512: başlık [skip ci]"`.
- React + JavaScript/JSX; TypeScript veya yeni UI motoru yok. UI yalnız merkezi tasarım sisteminden (`apps/web/src/workspace/design-system/`, `PanelKit.jsx`).
- Mutation zinciri (RBAC → preview → onay → kilit → durable job → apply/configtest → health → reconcile) ve kimlik ayrımı (Website/Domain/Application) `docs/architecture.md`'deki gibi korunur.
- Çalışan motorlar (Files/elFinder, ttyd, phpMyAdmin, Roundcube, PowerDNS…) yeniden yazılmaz.
- Görev tamamlanınca `plan.md`/`todo.md` maddesi yalnız ilgili görevin `Kabul`'ü inceleme ve dalga sonu `verify` ile geçtikten sonra senior tarafından işaretlenir; junior bu dosyaları değiştirmez.
