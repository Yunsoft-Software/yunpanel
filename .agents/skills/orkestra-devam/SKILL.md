---
name: orkestra-devam
description: Projede junior orkestratör olarak işi başlatır veya bir kesintiden (kota bitmesi, internet kopması, uygulama kapanması, yeni hesap, başka makine) sonra kaldığı yerden sürdürür. Yarım işi kurtarır, son işi doğrular, alt ajanları başlatır ve bütün görevler bitene kadar yönetir. Kullanıcı "devam", "başlat", "kaldığın yerden" dediğinde veya /orkestra-devam yazdığında kullan.
---

# /orkestra-devam — Junior orkestratör

Sen ORKESTRATÖRSÜN. Görev yapmazsın; ajanları yönetirsin. Her adımı sırayla yap, atlama. Bu beceri ilk başlatmada ve her kesintiden sonra aynıdır. Çalışma klasörü: bu deponun kökü.

## 0. Ön kontrol (her seferinde)
1. Oku: `docs/orkestra/BRIEF.md`, `docs/orkestra/DECISIONS.md`, `docs/orkestra/PROJE.md`, `docs/orkestra/KURALLAR.md`. Bağlayıcıdırlar.
2. `PROJE.md` §Ön kontrol maddelerini uygula. Biri tutmuyorsa dur ve kullanıcıya ne yapması gerektiğini söyle.
3. `git status --short`, `python3 orkestra/tasks.py lint` ve `python3 orkestra/tasks.py status` çıktısını oku. Lint hatası varsa görev başlatma; hatayı kullanıcıya ve senior'a bildir (görev dosyaları senior'ındır).

## 1. Kurtarma (alt ajan başlatmadan ÖNCE)
1. `python3 orkestra/orchestrator.py recover`.
   - Sinyali `stale_claim_minutes` (varsayılan 20 dk) geçmiş claim'leri `tasks/recovery/`'ye yedekler, dosyalarını geri alır ve bırakır. SENIOR ve İNSAN'a dokunmaz.
   - "Sahipsiz değişiklikler" listesine **dokunma**. Çoğunlukla senior'ın veya insanın süren işidir; sadece LOG'a not düşülür.
2. Az önce başladıysan ve önceki oturumun claim'leri hâlâ taze görünüyorsa, süre dolmadan onlara yeni ajan atama. 3. adımdan devam et ve süre dolunca `recover`'ı tekrar çalıştır.

## 2. Son işi doğrula
1. `python3 orkestra/orchestrator.py verify --quick`.
2. Son tam doğrulamadan beri 10'dan fazla görev kabul edildiyse veya kesinti bir görevin ortasında olduysa tam `verify` çalıştır (zaman aşımını uzun ver).
3. `verify` kırılan kabul edilmiş görevleri yeniden açar, sahibi bulunamayan hataları bulgu görevi olarak yazar ve commit eder. Ayrıca bir şey yapma.

## 3. Yuvaları doldur
1. `python3 orkestra/orchestrator.py slots` → yuva başına bir satır: `AGENT_n  DEVAM|İNCELE|GÖREV|QA|BOŞ  <iş>`.
2. `DUR` satırı: proje duraklatıldı (`tasks.py pause`). O yuvaya ajan başlatma; çalışan ajanlar elindeki işi bitirip çıksın. Bütün yuvalar `DUR` olunca kullanıcıya "duraklatıldı: <gerekçe>" de ve dur. `tasks.py resume` sonrası `/orkestra-devam` ile devam edilir.
3. BOŞ ve DUR olmayan her satır için aynı anda bir alt ajan başlat. Alt ajana §5'teki İŞÇİ talimatını, kendi AGENT_n adını ve yuvasındaki işi ver.
4. Bir alt ajan bitince hemen `slots` çalıştır ve boşalan yuvaya yeni ajan başlat. Tek bir yuvanın bitmesi için diğerlerini bekleme.

## 4. Döngü (bütün görevler bitene kadar)
- **Her 10 dk:** `python3 orkestra/orchestrator.py tick`. Kurtarma, durum ve yuvaları tek komutta verir, LOG'a satır yazar. BOŞ olmayan ama ajanı çalışmayan yuvayı doldur.
  - Bir alt ajanın sessiz olması tek başına takıldığı anlamına gelmez. `tick` sinyali ve dosya düzenlemesini birlikte sayar. Sadece `recover` geri aldıysa yuvayı yeniden doldur.
  - Kendi başlattığın bir komutu beklerken çıkış kodunu kontrol et. Bitmiş bir komutu çalışıyor sanma.
- **Her 60 dk:** `verify --quick`. Bir görev dalgası bitince veya 3 saatte bir tam `verify`.
- **Engellenen görev** (`tasks/blocked/*.md`): çözülebilir bir ön iş eksikse `python3 orkestra/orchestrator.py finding "<başlık>" "<ne gerekiyor>" <dosyalar>`. Karar, tasarım veya kapsam sorusuysa görevi bekleyen bırak ve kullanıcıya "senior kararı gerekiyor: <soru>" de.
- **`approval` bekleyen görevler** İNSAN'ındır. Listeyi kullanıcıya bildir; onları sen kabul etme.
- **Bitiş:** open, claimed, review ve reviewing 0 (SENIOR ve İNSAN sahipli görevler hariç) ve son tam `verify` ok olduğunda `docs/orkestra/RAPOR.md` yaz: ne bitti, ne kaldı, SENIOR ve İNSAN bekleyenler, bilinen riskler. Push yapma.

## 5. İŞÇİ talimatı (her alt ajana aynen ver, AGENT_n ve İŞ'i doldur)

```text
Sen AGENT_n'sin. Proje kökü: <bu deponun yolu>
Önce oku: docs/orkestra/KURALLAR.md ve docs/orkestra/PROJE.md (bağlayıcı). Yuvandaki iş: <DEVAM Txxx | İNCELE Txxx | GÖREV Txxx | QA <iş>>

GÖREV veya DEVAM ise (KURALLAR §3):
 1. GÖREV: `python3 orkestra/tasks.py claim <ID> AGENT_n`. Başarısızsa `next AGENT_n` ile başka görev al; NONE veya PAUSED ise orkestratöre bildir ve çık.
    DEVAM: claim zaten sende. `tasks/recovery/<ID>-*` varsa incele; işe yarıyorsa kullan ve kabul ölçütüne göre baştan doğrula.
 2. `python3 orkestra/tasks.py show <ID>`. Bağımlı görevlerin raporlarını oku. Sadece görevin işaret ettiği belge bölümlerini oku.
 3. En az 5 dakikada bir ve her uzun komuttan önce `python3 orkestra/tasks.py heartbeat <ID> AGENT_n`.
 4. Hata düzeltmesiyse önce tekrar üret ve otomatik teste çevir, sonra düzelt.
 5. PROJE.md §Doğrulama ve görevin Kabul satırı. Kendi alanında kırmızı varsa görev bitmemiştir.
 6. `python3 orkestra/tasks.py done <ID> AGENT_n`, `tasks/review/<ID>.md` raporunu DOLDUR, sonra
    `git add <görev dosyaları> tasks/review/<ID>.md && git commit -m "<ID>: <başlık>"`.
 7. Orkestratöre "<ID> incelemeye gönderildi, commit <sha>" de ve çık.

İNCELE ise (KURALLAR §4; kod DÜZELTME):
 1. `python3 orkestra/tasks.py review <ID> AGENT_n`, ardından `show <ID>` ve `tasks/review/<ID>.md`.
 2. `git log --oneline -- <görev dosyaları>` ve `git show <commit>` ile değişikliği oku.
 3. Kabul satırındaki kanıtı kendin yeniden üret. Kapsam, test kalitesi, güvenlik ve mimariyi kontrol et.
 4. `accept <ID> AGENT_n "<ne çalıştırdın, ne gördün>"` ya da `reject <ID> AGENT_n "<tekrar üretme + beklenen/gerçek>"`.
 5. `git add --all -- 'tasks/*/<ID>.md' 'tasks/history/<ID>-*' && git commit -m "<ID>: inceleme <kabul|ret>"`, orkestratöre bildir, çık.

QA ise (düzeltme YAPMA, sadece bulgu yaz; 20 dk'yı geçme):
 - İşin tanımı `orkestra.json` → `qa_jobs.<iş>` içinde (`slots` çıktısında da yazar).
 - Her yeni sorun için: `python3 orkestra/orchestrator.py finding "<kısa başlık>" "<tekrar üretme adımı + hata çıktısı>" <ilgili dosyalar>`.
 - `git add docs/gorevler/ && git commit -m "QA <iş>: <n> bulgu"`, orkestratöre bildir, çık.
```

## 6. Kesinti olursa
Hiçbir şey yapma. Kullanıcı geri geldiğinde `/orkestra-devam` yazar. Bu beceri 0. adımdan başlar ve kaldığın yeri diskten bulur.
