# T141 İnceleme Notu

- Görev: T141 — Manuel test: HSP-04 — Hesap altında domain, müşteri ve abonelik listeleri
- İnceleyen: AGENT_4
- Yapan: AGENT_3
- Tarih: 2026-10-27
- Durum: KABUL EDİLDİ

## İnceleme Bulguları
1. **Mock ve Sahte Veri Kontrolü:** `e2e/ozellik/hsp-04.spec.js` dosyasında `page.route` veya sahte/stub veri bulunmamaktadır. Gerçek backend API (`/api/panel/users/hosting/accounts`, `/api/panel/websites`) ve gerçek UI paneline karşı çalışmaktadır.
2. **Kapsam ve Eşdeğerlik:**
   - 01. Mutlu yol: Müşteri oluşturma, `/customers` listeleme, müşteri detayında "Web siteleri" (`/websites?customer=<id>`) filtreleme, arama kutusu ve "Tüm siteler" ile genel görünüme dönüş test edilmiştir.
   - 02. Yetki ve sınır: Bayi oluşturma, Bayi oturumuyla `/customers` ekranında yalnız kendi müşterisinin görünmesi, Owner'ın doğrudan müşterisinin listelenmemesi (0 kayıt), Bayi altında yeni müşteri oluşturulması ve siteler ekranına geçiş doğrulanmıştır.
   - 03. Fiziksel kanıt: Bayi oturumunda API üzerinden `/api/panel/users/hosting/accounts?kind=customer` ile yalnız kendi müşterisinin dönmesi, `/api/panel/users/hosting/accounts?kind=reseller` sorgusunun 403 Forbidden ile reddedilmesi, yabancı müşteri tekil sorgusunun engellenmesi ve `/api/panel/websites` tenant izolasyonu fiziksel olarak kanıtlanmıştır.
   - Abonelikler: Plesk eşdeğeri paket/abonelik nesneleri YunPanel MVP mimarisinde yer almadığından (PLN-01..PLN-07 ertelenmiş kapsamı) raporda ve testte doğru şekilde notlandırılmıştır.
3. **Temizlik (`afterAll`):** `test.afterAll` bloğunda açılan child customer, direct customer ve bayi hesapları (profil unregister + kullanıcı silme) API üzerinden eksiksiz temizlenmektedir.
4. **Dokümantasyon Kontrolü:** `docs/manuel-test/HSP-04.md` dosyası 28 satırdır (<= 40 satır kuralına uygundur).
5. **Test Koşusu:** `AGENT_N=4 npx playwright test e2e/ozellik/hsp-04.spec.js` koşturulmuş ve 3/3 senaryo başarıyla geçmiştir (21.7s).
6. **Sistem Doğrulaması:** `orchestrator.py verify --quick`, `tasks.py lint` ve `npm run lint` kontrolleri hatasız geçmiştir.
