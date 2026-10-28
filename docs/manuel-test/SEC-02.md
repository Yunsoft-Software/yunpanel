# SEC-02 — IP erişim kısıtları, brute-force koruması ve ban/unban
Sonuç: KISMİ
Ajan: AGENT_4 · Tarih: 2026-10-28 12:25 · Senaryo: `e2e/ozellik/sec-02.spec.js` · Koşu: 3/3, test.fail 2

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| mutlu yol: arayüzden CrowdSec ban yönetimi alanı görüntülenir ve ban/unban akışı doğrulanır | bilinen hata (test.fail) | Sunucuda cscli/fail2ban kurulu değil, IP ban motoru fiziksel olarak aktifleşemiyor |
| hatalı girdi: geçersiz IP formatı ve eksik parametre reddedilir | geçti | HTML5 required denetimi, arayüz hata kutusu, API 400 invalid_ip ve missing_ip |
| fiziksel kanıt: sistem güvenlik servisi ve brute-force bouncer durumu denetimi | bilinen hata (test.fail) | systemctl is-active crowdsec/fail2ban inactive |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| NORMAL | Sunucuda cscli (CrowdSec) veya fail2ban binary/servis kurulu değil | — |
| NORMAL | Plesk Fail2ban eşdeğeri IP Adres Engelleme (Jail yönetimi, Trusted IPs) paneli eksik | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| apps/api/test/firewall-http.test.js | GEÇERLİ | CrowdSec karar ekleme/silme ve ban API birim testleri |
| packages/host-runtime/test/crowdsec-manager.test.js | GEÇERLİ | Host-runtime IP/CIDR/süre doğrulama ve cscli sarmalayıcı testleri |
| apps/api/src/firewall-service.js | GEÇERLİ | Firewall ve CrowdSec entegrasyon servisi |

## Panelde olmayan
Plesk IP Address Banning (Fail2ban) eşdeğeri: Jail yönetimi (ssh, nginx, postfix kuralları), Güvenilen IP'ler (Whitelist/Trusted IPs) listesi ve log izleme UI.

## Temizlenemeyen kaynaklar
—
