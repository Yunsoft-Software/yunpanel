# YunPanel — Güvenlik ve veri koruma özeti

[Bağlayıcı kurallar](../agents.md), [devralınan sözleşme](policies/agents-inherited-1a45ded8.md), [kabul](../todo.md).

- .44 Plesk hostuna hiçbir erişim yok. Tek izinli test hedefi repo dışı .local/test-server.env'den ve adres eşleşmesinden doğrulanır. .28 geliştirme MFA politikası opsiyoneldir; açık yeni talimat olmadan etkinleştirilmez.
- API root, workload dedicated site Unix kullanıcısı. Owner root terminali ayrı; site terminali/dosya/cron/build site kapsamından çıkmaz. chmod -R 777, genel sahiplik veya auth kapatma çözüm değildir.
- Native auth: Argon2id, sunucu SQLite session, production Secure/HttpOnly/host-only/SameSite cookie, exact Origin+CSRF, bounded login rate limit, trusted proxy/IP sınırı. Ortak bootstrap token normal yönetim oturumu değildir.
- Backend RBAC tüm API/job/tool/gateway yollarında; logout/rotation/suspend/removal açık WS/stream/vendor oturumunu iptal eder. Frontend buton gizlemek izin kontrolü değildir. Son aktif Owner korunur.
- Password/key/token/cookie/MFA/private env repoya, URL'ye, genel loga, localStorage'a veya ekran görüntüsüne yazılmaz. Şifreli secret store/master key ayrı; rotation tüm bağlı secret yüzeyleriyle, doğrulanmış offline backup ve rollback kullanır.
- Website/Domain/Application ID, Unix user, certificate/binding/credential/mailbox ownership ve revision/digest exact doğrulanır. Eksik/bozuk/foreign state fail-closed; otomatik yeniden atama yok.
- Path canonicalization, symlink/traversal/SSRF kontrolü, upload/archive overwrite etkisi ve resource lock korunur. Form shell string birleştirmez; kontrollü argümanlarla mevcut adapter çağrılır.
- Destructive işlemde preview, protected backup, hedef adına göre açık onay, durable journal/receipt ve restart recovery. Partial sonuç tamamlandı olmaz; sister site/mailbox verisi korunur.
- Audit actor/action/resource/time/outcome metadata'sı; raw terminal tuş/çıktı/history ve secret değildir. Secret gösterimi gerekirse ayrı yetki, açık kullanıcı eylemi ve değeri içermeyen audit gerekir.
- Gerçek isolated OS user, SMTP/IMAP/TLS ve Restic çıktısı kendi testinde doğrulanır. Mock/regex/constant artifact veya katalog completed işareti güvenlik kabulü değildir.
