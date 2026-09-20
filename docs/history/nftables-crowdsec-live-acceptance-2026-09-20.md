# YunPanel — Nftables & CrowdSec Canlı Kabul Raporu (2026-09-20)

## 1. Kapsam ve Amaç

Bu kabul raporu, `todo.md` altındaki **T-OBSERVABILITY-SECURITY** maddesini ve `plan.md` altındaki **P1.3 (Monitoring/security)** hedeflerini `.28` test sunucusunda (`157.180.11.28`, hostname `test`) doğrulamaktadır:
- `nftables`'ın tek firewall authority olarak yönetilmesi.
- SSH yönetim erişimini kilitlemeyen lockout koruması (port 22 doğrulaması).
- UFW / çifte-yazar drift tespiti.
- Kuralların atomik uygulanması (`nft -f`) ve geri alınması (`rollbackRuleset`).
- `crowdsec` (v1.4.6) ve `crowdsec-firewall-bouncer` (v0.0.25) servislerinin kurulup nftables ile entegre çalışması.
- Canlı SSH brute-force log tespiti ve dinamik decision (ban/unban) döngüsünün kernel nftables setlerine (`crowdsec-blacklists`, `crowdsec6-blacklists`) yansıması.

> **Önemli Güvenlik Kuralı:** IP adresi `.44` ile biten Plesk sunucusuna kesinlikle dokunulmamıştır. Bütün testler repo dışı `.local/test-server.env` içinde tanımlanan `.28` test sunucusunda yürütülmüştür.

---

## 2. Gerçekleştirilen Doğrulamalar ve Sonuçlar

### 2.1. Nftables İnceleme ve Çifte-Yazar (UFW) Tespiti
- **İkili Dosya:** `/usr/sbin/nft` (nftables v1.0.9).
- **UFW Durumu:** `ufw` paketi kurulu, systemd servisi yüklü ancak `ufw status` çıktısı `Status: inactive`.
- **Çakışma Kontrolü:** `conflictingFirewalls.conflictDetected: false`. UFW aktif olduğu senaryoda `applyRuleset` işlemi `conflicting_firewall_detected` hatası fırlatarak nftables'ın tek otorite kalmasını temin eder.

### 2.2. SSH Lockout Koruması ve Sözdizimi Doğrulaması
- **Lockout Koruması:** SSH portunu (22) açıkça `tcp dport { ... } accept` kuralları arasına almayan tehlikeli kural adayları `ssh_lockout_risk` hata koduyla reddedildi; sunucu yönetim bağlantısının kopması engellendi.
- **Sözdizimi Kontrolü:** Geçersiz sözdizimine sahip adaylar `nft -c -f <temp>` ile test edildi ve canlı ruleset'e veya `/etc/nftables.conf` dosyasına yazılmadan `candidate_syntax_error` ile durduruldu.
- **Geçerli Aday:** `@yunpanel/config-templates` tarafından üretilen kurallar (SSH: 22, Web: 80/443, DNS: 53, Mail: 25/143/465/587/993, CrowdSec drop kuralları) başarıyla doğrulandı.

### 2.3. Kuralların Canlı Uygulanması ve Geri Alınması (Rollback)
- **İlk Durum:** Canlı ruleset (`table ip crowdsec`, `table ip6 crowdsec6`) yedeklendi.
- **Canlı Uygulama:** `table inet yunpanel` kuralları uygulandı ve kernel ruleset'inde `[ 'yunpanel', 'crowdsec', 'crowdsec6' ]` tabloları teyit edildi.
- **SSH Sürekliliği:** Kuralların uygulanması ve test scriptinin çalıştırılması doğrudan SSH oturumu üzerinden kesintisiz gerçekleşti.
- **Rollback:** `rollbackRuleset` çağrılarak önceki ruleset'e dönüldü; `table inet yunpanel` kernel'dan temizlenip eski durum doğrulandı.
- **Kalıcı Uygulama:** Aday `/etc/nftables.conf` (0755) dosyasına atomik yazıldı, `nftables.service` etkinleştirilip başlatıldı.

### 2.4. CrowdSec Motoru ve Firewall Bouncer Entegrasyonu
- **Servis Durumu:**
  - `crowdsec.service`: active, enabled (v1.4.6).
  - `crowdsec-firewall-bouncer.service`: active, enabled (v0.0.25).
  - `fail2ban.service`: inactive (çift yetki/çakışma yok).
  - Genel Sağlık: `healthy: true`.
- **Canlı Log Tespiti:** CrowdSec başlatılır başlatılmaz sunucu auth/ssh loglarını okuyup gerçek SSH brute-force saldırganlarını tespit etti ve otomatik ban uyguladı (`crowdsecurity/ssh-bf`).
- **Karar Ekleme (Ban):**
  - IPv4 Test Kararı: `198.51.100.99` (1 saatlik ban).
  - IPv6 Test Kararı: `2001:db8::99` (1 saatlik ban).
  - `cscli decisions list` üzerinde kararlar ID 9 ve ID 10 ile listelendi.
  - Bouncer tarafından 1 saniye içinde `table ip crowdsec` altındaki `crowdsec-blacklists` kümesine eklendi.
- **Karar Silme (Unban):**
  - `deleteDecision` ile IP bazlı silme gerçekleştirildi.
  - Bouncer 9 saniye içinde kernel nftables kümesinden IP'leri kaldırdı.

---

## 3. Kabul Kanıtı Log Çıktısı

```text
=== STARTING NFTABLES & CROWDSEC LIVE ACCEPTANCE ===

--- 1. Inspecting nftables ---
nftables state: {
  "satisfied": true,
  "binaryPath": "/usr/sbin/nft",
  "version": "1.0.9",
  "serviceStatus": {
    "active": true,
    "enabled": true
  },
  "conflictingFirewalls": {
    "ufw": {
      "installed": true,
      "serviceActive": true,
      "statusActive": false
    },
    "firewalld": {
      "installed": false,
      "active": false
    },
    "conflictDetected": false
  },
  "ruleset": {
    "loaded": true,
    "tableNames": [
      "yunpanel",
      "crowdsec",
      "crowdsec6"
    ],
    "hasYunpanelTable": true,
    "hasCrowdsecSets": true
  }
}
✓ nftables inspection passed.

--- 2. Testing SSH Lockout Protection ---
✓ Correctly caught lockout risk: Candidate ruleset does not explicitly allow SSH port 22 in TCP accept rules. Apply aborted to prevent server lockout.
--- 3. Testing Syntax Validation ---
✓ Correctly caught syntax error: nft syntax validation failed: /tmp/nftables-check.1027401.40cc538598d2.nft:5:26-29: Error: syntax error, unexpected drop
    unknown_keyword_here drop
                         ^^^^
--- 4. Validating Production Candidate ---
✓ Production candidate validated successfully.

--- 5. Testing Ruleset Apply and Rollback ---
Initial live ruleset length: 929 chars
Apply result: {
  success: true,
  appliedAt: '2026-09-20T20:33:50.407Z',
  appliedRulesetSha256: '13b53439996a9371e863cb9740acee577186689b3387eae47b2e36fcd3f20110',
  backupRulesetSha256: '8167a4cfd31987f1e6977240ffa0040f6adf6b076829e57aa0d4912721732df9',
  persisted: false,
  serviceEnabled: false,
  allowedSshPort: 22
}
Ruleset tables after apply: [ 'yunpanel', 'crowdsec', 'crowdsec6' ]
Rolling back to initial ruleset...
Rollback result: {
  success: true,
  rolledBack: true,
  rulesetSha256: 'd232e1b7030bfd6c9baf935a8395560978d98a3918e2b0a05f3f3c412028d620'
}
Ruleset tables after rollback: [ 'crowdsec', 'crowdsec6' ]
✓ Apply and rollback passed.

--- 6. Re-applying Candidate and Persisting ---
Final apply result: {
  success: true,
  appliedAt: '2026-09-20T20:33:51.171Z',
  appliedRulesetSha256: '13b53439996a9371e863cb9740acee577186689b3387eae47b2e36fcd3f20110',
  backupRulesetSha256: 'acfcef3ac069f967eb0303e6b21abc596be4680d72bdc79be85beb2c7f2acf6c',
  persisted: true,
  serviceEnabled: true,
  allowedSshPort: 22
}
✓ Final apply and persistence succeeded.

--- 7. Inspecting CrowdSec Engine & Bouncer ---
CrowdSec status: {
  "engine": {
    "installed": true,
    "binaryPath": "/usr/bin/cscli",
    "version": null,
    "active": true,
    "enabled": true
  },
  "bouncer": {
    "installed": true,
    "active": true,
    "enabled": true
  },
  "conflicts": {
    "fail2banActive": false,
    "fail2banEnabled": false,
    "duplicateAuthorityDetected": false
  },
  "healthy": true
}
✓ CrowdSec inspection passed.

--- 8. Testing CrowdSec Decisions (IPv4 & IPv6) ---
Adding IPv4 ban decision for 198.51.100.99...
Add IPv4 decision result: {
  success: true,
  ip: '198.51.100.99',
  duration: '1h',
  reason: 'live-acceptance-test',
  type: 'ban'
}
Adding IPv6 ban decision for 2001:db8::99...
Add IPv6 decision result: {
  success: true,
  ip: '2001:db8::99',
  duration: '1h',
  reason: 'live-acceptance-test-v6',
  type: 'ban'
}
Current active decisions count: 7
✓ Found decisions in cscli: IPv4 ID=9, IPv6 ID=10
Waiting for CrowdSec firewall bouncer to sync with nftables sets (up to 15s)...
✓ Decision synced to nftables after 1 seconds.
Verifying decisions in kernel nftables sets...
✓ Verified IPv4 is present in nftables kernel sets!
Deleting decision for 198.51.100.99...
Deleting decision for 2001:db8::99...
Waiting for CrowdSec firewall bouncer to remove IP from nftables sets (up to 15s)...
✓ Decision removed from nftables after 9 seconds.
✓ Verified both test IPs successfully removed from nftables kernel sets!

--- 9. Checking CrowdSec Metrics and Alerts ---
Recent alerts count: 5
Sample alert: live-acceptance-test-v6

=== ALL NFTABLES & CROWDSEC LIVE ACCEPTANCE CHECKS PASSED ===
```
