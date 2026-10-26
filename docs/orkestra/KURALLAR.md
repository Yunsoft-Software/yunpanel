# Orkestra — ortak çalışma kuralları

> Bu dosya kite aittir; `install.sh` her güncellemede üzerine yazar. **Düzenleme.** Projeye özel kurallar `docs/orkestra/PROJE.md`'de. İkisi çelişirse PROJE.md geçerlidir.

Hafızadan hiçbir şey varsayma; durum diskte. Her oturum şu sırayla okur: `BRIEF.md` → `DECISIONS.md` → `PROJE.md` → bu dosya.

## 1. Roller (araca değil göreve bağlı)
- **İNSAN (ürün sahibi):** ne yapılacağına karar verir, `Onay: İNSAN` görevlerini kabul eder. Başka hiçbir rol onun yerine onay veremez.
- **SENIOR (Claude, Codex veya başka bir araç):** isteği mimariyle birlikte değerlendirir, riskleri ve seçenekleri İNSAN'a anlatır, onaylanan kararları `DECISIONS.md`'ye yazar, görevleri §2 biçiminde açar, sonucu kanıta bakarak değerlendirir. Aynı anda tek senior olur; kim olduğu `BRIEF.md`'nin başında yazar. `Sahip: SENIOR` görevleri o yapar.
- **JUNIOR (Antigravity veya başka bir araç):** `/orkestra-devam` ile orkestratör olur ve `orkestra.json` → `slots` kadar alt ajanı (`AGENT_1…n`) yönetir. Alt ajanların sabit rolü yoktur. Boşalan yuva sıradaki işi alır: devam → inceleme → yeni görev → QA.

## 2. Görev biçimi (`docs/gorevler/*.md`)
```markdown
### T101 · Kısa başlık
- **Bağımlı:** T100, T099          (yoksa —)
- **Sahip:** SENIOR                 (isteğe bağlı; sadece o alabilir. İNSAN da olabilir)
- **Onay:** İNSAN                   (isteğe bağlı; inceleme sonrası İNSAN kabul eder)
- **Dosyalar:** `src/a.ts`, `tests/a.test.ts`   (sadece bunlara yazılır)
- **Kilit:** config                 (isteğe bağlı; paylaşılan dosya yazılırken `orkestra/lock.sh`)
- **İş:** Ne yapılacak, neden. Kapsam dışı olanlar. Değişmemesi gereken davranışlar.
- **Kabul:** Gözlenebilir başarı kanıtı: hangi komut, hangi çıktı, hangi davranış.
```
Bütün commit mesajlarının sonuna `orkestra.json` → `commit_suffix` (varsa) eklenir.

Kimlikler sabit kalır. İki görev aynı dosyaya yazıyorsa ya sıralıdır (`Bağımlı`) ya da aynı `Kilit`i paylaşır (`tasks.py lint` denetler).

## 3. Görev akışı
`open → claimed → review → (approval) → done`. Bağımlı görevler ancak **done** olunca açılır.
1. Al: `python3 orkestra/tasks.py claim <ID> <AGENT>` (veya `next <AGENT>`). `show <ID>` ile oku; yeniden açıldıysa nedeni altında yazar. Bağımlı görevlerin raporlarını (`tasks/done/<ID>.md`) oku.
2. Sinyal: en az 5 dakikada bir ve uzun bir komuttan önce `tasks.py heartbeat <ID> <AGENT>`. Sahip olduğun dosyaları düzenlemek de sinyal sayılır. `stale_claim_minutes` (varsayılan 20) boyunca hiç sinyal gelmezse claim geri alınır ve dosyaların yedeklenip geri döndürülür.
3. Hata düzeltmesi: önce tekrar üret, otomatik teste çevir, testin **doğru sebeple** kırıldığını gör, sonra düzelt. Testi geçirmek için beklentiyi gevşetmek veya gerçek servis yerine uydurma cevap koymak yasaktır.
4. Bitirmeden doğrula: `PROJE.md` §Doğrulama komutları ve görevin `Kabul` satırı. Kendi alanında kırmızı varsa görev bitmemiştir.
5. Teslim: `tasks.py done <ID> <AGENT>` → `tasks/review/<ID>.md` raporunu **doldur** (yapılanlar, dosyalar, doğrulama komutu ve çıktı özeti, sınırlamalar).
6. Hemen commit: `git add <sadece görev dosyaları> tasks/review/<ID>.md && git commit -m "<ID>: <başlık>"`. Commit olmadan yeni iş alma.
7. İki deneme başarısızsa kendi dosyalarını geri al, `tasks.py block <ID> <AGENT> "<sebep + denenenler>"`. Karar gerekiyorsa sebebe "SENIOR:" veya "İNSAN:" ile başlayan soruyu yaz.
8. Kota veya hız uyarısı: bitirebiliyorsan bitir ve commit et. Bitiremiyorsan `git diff -- <dosyaların> > tasks/recovery/<ID>-elle.patch`, dosyaları geri al, `tasks.py release <ID> <AGENT>`, dur.

## 4. İnceleme (yapan ile doğrulayan ayrıdır)
"Bitti" demek yetmez. Görevi yapan ajan kendi işini inceleyemez; araç buna izin vermez.
1. `tasks.py review <ID> <AGENT>` → raporu ve `git log --stat`/`git show` ile görevin commit'ini oku.
2. Rapora güvenme. `Kabul` satırındaki kanıtı **kendin yeniden üret**: komutları çalıştır, davranışı gör.
3. Kontrol et: sadece `Dosyalar`'a mı yazılmış, kapsam dışına taşmış mı, test gerçekten beklenen davranışı mı ölçüyor, güvenlik veya mimari sorunu var mı.
4. Geçtiyse `tasks.py accept <ID> <AGENT> "<ne çalıştırdın, ne gördün>"`. Geçmediyse `tasks.py reject <ID> <AGENT> "<tekrar üretme adımı + beklenen/gerçek>"`. İncelemede kod düzeltme; ret notu yeterli.
5. Commit (sadece bu görevin durum dosyaları): `git add --all -- 'tasks/*/<ID>.md' 'tasks/history/<ID>-*' && git commit -m "<ID>: inceleme <kabul|ret>"`.

Bütünü `orkestra/orchestrator.py verify` ayrıca doğrular. Kırılan kabul edilmiş görevler otomatik yeniden açılır.

## 5. Yasaklar (PROJE.md açıkça izin vermedikçe)
- Yol vermeden `git add -A`, `git add .`, `git reset --hard`, `git checkout .`, `git clean`, `git stash`, `git push`, dağıtım.
- Sahibi SENIOR veya İNSAN olan claim'e, kilide ve sahipsiz kaydedilmemiş değişikliğe dokunmak (bırakmak, kırmak, geri almak, commit etmek).
- `BRIEF.md`, `DECISIONS.md` ve `PROJE.md`'yi değiştirmek (senior'ın işi). Karar gerekiyorsa görevi engelle ve soruyu yaz.
- Sistem ayarı veya global araç zinciri değiştirmek. Uydurma API kullanmak: kullandığın her kütüphane fonksiyonunu kurulu kaynakta veya resmi belgede doğrula.

## 6. Ekip ve makine değişimi
Görevler, raporlar ve kararlar git'tedir. Claim'ler ve kilitler makineye özeldir. Başka bir makinede `/orkestra-devam` çalıştığında yerel claim yoktur: o makinede yarım kalan ve commit edilmeyen iş oraya taşınamaz. Bu yüzden her görev küçük tutulur ve bittiği anda commit edilir.
