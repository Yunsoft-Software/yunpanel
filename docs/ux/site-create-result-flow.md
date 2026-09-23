# CREATE-RESULT — Site kaydı ve kurulum sonucu sürekliliği

Başlangıç `development@e37f2cfb`, 2026-09-23. BUG-20260923-01 / UX-PL-06/07/08 alt dilimi. Mevcut site-create preview/apply, autoAdvance ve Site → Genel Bakış recovery motoru korunur. Yeni endpoint, tema veya host işlemi eklenmez.

## Kaynak işleri

- [ ] CREATE-RESULT-01: Preview, create ve sonraki provisioning aşamalarını ayır. Doğrulanmış Domain/Website kaydı create cevabından hemen sonra sonuçta kalsın; sonraki hata bunu silmesin. Preview ve cevap kimliklerini aynı işlem/site/sunucuya bağla.
- [ ] CREATE-RESULT-02: Aynı formda çift gönderim ve create isteğinin belirsiz sonucu sonrasında kör tekrar engellensin. Oturum/site bağlamı veya unmount sonrası eski cevaplar yeni ekrana taşınmasın. Parola/ham cevap kalıcı depoya veya sonuç modeline yazılmasın.
- [ ] CREATE-RESULT-03: Mevcut Yeni Website ekranında gerçek kayıt/kurulum durumunu göster. Hata ve durulan adımlar sonuç kartında görünür kalsın; Genel Bakış → mevcut recovery ve Dosyalar girişleri doğru Domain ID kullansın. Kayıt oluştu diye SSL/mail/Unix/çalışır site başarısı iddia edilmesin.
- [ ] CREATE-RESULT-04: Odaklı davranış/regresyon ve yapılabilen JSX kontrolleri. Gerçek React/router/API/host kabulü ayrı.

Paylaşılan Website yolu mevcut açık onay ve `/domains` API'sinde kalır; bu dilim yeni shared-site lifecycle motoru değildir. Manuel recovery panelinin stale kayıt/çift tıklama/yetki sınırları, backend güvenli otomatik retry ve süreçler arası kilit açık kaynak işleridir. `site-create-http.js` içindeki site-admin oluşturma hatasının yutulması ayrıca açık backend bütünlük sorunudur; bu arayüz bunu düzelttiğini veya yönetici hesabının hazır olduğunu iddia etmez.

## T-DEV-CREATE-RESULT — Codex gerçek kabulü

- [ ] Node24/npm11 tam checkout, npm ci, lint/test/build ve mevcut create/provisioning/session regresyonları. Bu ortamda GitHub ve npm registry DNS çözümlemesi başarısız oldu; tam checkout ve hedef bağımlılık kurulumu yapılamadı.
- [ ] Gerçek create 201/200 sonrası provisioning GET/POST 401/403/409/429/5xx/timeout: kayıt kartı ve doğru Genel Bakış bağlantısı kalsın; yeni create POST gönderilmesin. Yanlış Domain/Website/server/operation cevabı başarı göstermesin.
- [ ] Create POST cevabı kaybolursa mevcut sitelerden durum uzlaştırılsın; otomatik tekrar/cleanup yapılmasın. Preview hatasında yerel form düzeltilebilsin. Aynı anda iki gönderim yalnız bir oluşturma denemesi başlatsın.
- [ ] Logout/login, yetki değişimi, unmount, StrictMode ve abort sırasında geç cevaplar başka hesaba taşınmasın; host işinin iptal edilmediği açık olsun. Parola başarı veya belirsiz sonuç sonrasında form belleğinden temizlensin.
- [ ] Ready/partial/blocked/failed/interrupted, sıfır/eksik adım ve hatalı cevap; gerçek ilerleme görünürlüğü, Genel Bakış recovery, Dosyalar, mobil/klavye/koyu tema ve shared-site mevcut onay yolu doğrulansın. Yalnız izinli test hostu; `.44` kullanılmaz.

Üst BUG-01 ve UX-PL kabulleri kapanmaz. GitHub Actions ve canlı deploy yapılmaz.
