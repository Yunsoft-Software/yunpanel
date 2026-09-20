# Static Website Site User Identity & Routing Live Acceptance — 2026-09-20

## Özet

Ubuntu 24.04 LTS kurulu YunPanel test sunucusunda (`157.180.11.28` — `.28`, hostname `test`), `todo.md` altındaki şu P0 maddesi canlı ortamda uçtan uca doğrulanmıştır:

> Static Website gerçek provisioned site user altında build/deploy/rollback etsin; process environment `HOME=/var/lib/yunpanel/data/<applicationId>` olsun, build workspace ayrı `/var/lib/yunpanel/build/<applicationId>` altında kalabilsin ve deploy motoru ikinci Unix identity yaratmasın. Eski build-home identity yalnız kanıtlı migration fallback olarak kabul edilsin; fresh/unproven identity için fallback user yaratmasın veya rollback symlink mutation'ı yapmasın.

---

## Test Ortamı ve Canlı Çalıştırma

- **Hedef Sunucu**: `157.180.11.28` (Ubuntu 24.04 LTS, hostname `test`)
- **Yürütülen Script**: `/tmp/acceptance-static-identity-routing.mjs`
- **Tarih**: 2026-09-20T19:31:17Z
- **Sonuç**: `satisfied: true`

---

## Doğrulanan Adımlar ve Güvenlik Sınırları

### 1. Canonical Site Kullanıcısı ve Çevre Değişkeni İzolasyonu
- `identityManager.apply` ile canonical site kullanıcısı oluşturuldu (`yunapp-d128dfc86d88`, UID 989, GID 989).
- Home dizini `/var/lib/yunpanel/data/db90bce8-12f1-4038-8445-f7f6a3720548` olarak doğrulandı.
- Deploy 1 (`b7c1fdd8-d5f9-4f17-836e-d8a48ae850f2`) ve Deploy 2 (`9e62c659-87f4-47e9-b70a-124a1f15265e`) canonical site kullanıcısı altında başarıyla tamamlandı; `current` symlink'i `releases/9e62c659...` hedefine bağlandı.
- Rollback (`b7c1fdd8-d5f9-4f17-836e-d8a48ae850f2`) başarıyla tamamlandı; `current` symlink'i `releases/b7c1fdd8...` hedefine bağlandı.
- `homeBefore` ve `homeAfter` değerlerinin `/var/lib/yunpanel/data/<applicationId>` olarak korunduğu teyit edildi.

### 2. İkinci Unix Identity Yaratılmaması (No Unintended Useradd)
- Deploy motorunun (`static-deployment-router`) asla ikinci bir Unix kullanıcısı yaratmadığı (`managerUseraddExecutions: 0`) kanıtlandı.

### 3. Fail-Closed Drift Koruması
- **Home Dizini Drifti**: Kullanıcının home dizini `/var/lib/yunpanel/data/canonical-home-drift` olarak değiştirildiğinde deploy ve rollback `website_static_identity_drift` koduyla fail-closed reddedildi; `current` symlink'i korunarak mutasyon engellendi. Home dizini eski haline getirildi.
- **Grup Üyeliği Drifti**: Kullanıcıya ikincil grup (`nobody`) eklendiğinde deploy ve rollback `website_static_identity_drift` koduyla fail-closed reddedildi; `current` symlink'i korunarak mutasyon engellendi. Grup üyeliği temizlendi.

### 4. Legacy Build-Home Identity Migration Fallback
- Home dizini `/var/lib/yunpanel/build/<applicationId>` olan legacy kimlik altında deploy ve rollback çalıştırıldı; migration fallback'i olarak başarıyla tamamlandı ve `current` symlink'i doğru hedeflere bağlandı.

### 5. Eksik / Kanıtlanmamış Kimlik Koruması
- Fresh / unproven veya eksik kimlik fixture'ında (`missing`):
  - Deploy denemesi `website_static_identity_missing` koduyla fail-closed reddedildi.
  - Sisteme fallback kullanıcısı eklenmedi, buildRoot veya webRoot dizinleri yaratılmadı.
- Kimlik kaybı simülasyonunda (`loss`):
  - Deploy sırasında kullanıcı silindiğinde işlem `deployment_command_failed` ile fail-closed kaldı; `current` symlink'i mutasyona uğramadı.
  - Rollback sırasında kullanıcı eksikken işlem `website_static_identity_missing` koduyla reddedildi; `current` symlink'i mutasyona uğramadı.

### 6. Backup Kök İzni
- `/var/lib/yunpanel/backups/resources` dizini UID 0 (root), GID 0 (root) ve mode `0700` (`privateRootControlPlane: true`) olarak doğrulandı.

---

## Sonuç

`todo.md` içerisindeki **Static Website gerçek provisioned site user altında build/deploy/rollback** maddesi Ubuntu 24.04 LTS test sunucusunda (`157.180.11.28`) eksiksiz olarak doğrulanmış ve tamamlanmıştır.
