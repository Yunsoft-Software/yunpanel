# T181 İnceleme Notu — Manuel test: EML-02

- **İncelenen Görev:** T181 (Manuel test: EML-02 — Alias, forwarding ve yerel kopya tercihleri)
- **Görevi Yapan:** AGENT_4
- **İnceleyen:** AGENT_1
- **Tarih:** 2026-10-27
- **Karar:** KABUL (Onaylandı)

## İnceleme Özeti
1. **Rapor Formatı ve İçerik Kontrolü:**
   - `docs/manuel-test/EML-02.md` raporu 25 satır uzunluğunda (kural: ≤ 40 satır).
   - Alias CRUD işlemleri, forwarding modları (`copy` ve `redirect`) ile döngüsel/kendine yönlendirme engelleme senaryoları açık ve net belgelenmiş.
   - Herhangi bir KRİTİK hata tespit edilmemiştir.

2. **Playwright Senaryosu (`e2e/ozellik/eml-02.spec.js`):**
   - Mock veri, `page.route` veya sahte API cevabı kullanılmamış; gerçek backend, Postfix SQLite (`virtual-mail.sqlite3`), Dovecot Sieve (`yunpanel-forwarding.sieve`) ve `.28` test sunucusuna karşı çalışmaktadır.
   - Önceki ret gerekçesi olan `afterAll` içerisindeki SSH tırnak/escaping hatası AGENT_4 tarafından `node - "${prefix}" <<'EOF'` stdin heredoc yapısına dönüştürülerek giderilmiş.
   - Mutlu yol senaryosu: Mail domain yönetimi -> Alias oluşturma, SQLite doğrulaması (`virtual_aliases`), düzenleme ve silme. Ardından hedef ve kaynak posta kutularının oluşturulması, forwarding `copy` modunun ayarlanması ve Sieve dosyasında `redirect :copy` ile `keep;` kontrolü; forwarding `redirect` moduna geçiş ve Sieve dosyasında doğrudan `redirect` kontrolü; son olarak forwarding'in kaldırılıp Sieve dosyasından temizlendiğinin teyidi.
   - Hatalı girdi senaryosu: Alias kendine yönlendirme (`source == destination`) teşebbüsünde UI doğrulama uyarısı ve engelleme teyit edilmiştir.
   - Test bağımsız olarak çalıştırılmış ve başarıyla geçmiştir: `2 passed (1.3m)`.
   - Test sonrasında sunucuda test kaynaklarının tamamen temizlendiği (virtual_aliases: 0, virtual_mailboxes: 0, sieve: 0) fiziksel olarak teyit edilmiştir.

3. **Orkestra ve Proje Doğrulamaları:**
   - `python3 orkestra/orchestrator.py verify --quick` → `doğrulama: ok; yeniden açılan: -; bulgu: -` başarıyla tamamlandı.
   - `python3 orkestra/tasks.py lint` → `133 tasks, lint OK`.

4. **Sonuç:**
   - Görev kabul kriterlerini eksiksiz karşılamaktadır.
