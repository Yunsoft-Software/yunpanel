# Plesk'te olup YunPanel'de olmayan özellikler (3. dalga adayları)

> 2026-10-26 · senior (Claude) kod incelemesi. **Not, onaylı görev değil.** 3. dalgada İNSAN'ın vereceği "Plesk'te sık kullandıklarımız" listesiyle birleştirilip göreve çevrilir (`docs/orkestra/DECISIONS.md` 2026-10-26 iş sırası).
>
> Yöntem: Plesk'in sık kullanılan özellikleri YunPanel'in `apps/api/src`, `apps/web/src`, `packages/*/src` kodunda anahtar kelimeyle arandı. Ayrıca kendi yetenek kataloğu `apps/api/src/non-reseller-capabilities.js` (95 özellik: 70 completed, 13 partial, 9 deferred) okundu. Sınırlar: Plesk tarafı resmî belgeyle tek tek doğrulanmadı; farklı isimle yazılmış bir özellik kaçmış olabilir. Katalogdaki "completed" işareti çalıştığı anlamına gelmez; gerçek durum 1. dalga manuel test raporlarında (`docs/manuel-test/`).

## Gerçek Plesk envanteri ve öncelik sırası (2026-10-27)
Senior, İNSAN'ın açtığı oturumda Yunsoft'un canlı Plesk Obsidian 18.0.81 sunucusuna salt okunur baktı (DECISIONS 2026-10-27 istisnası; hiçbir ayar değiştirilmedi, müşteri/site adı kaydedilmedi). Sunucuda 177 domain, kurulu 29 eklenti, sunucu düzeyinde 66 araç var. Aynı üst domain altında tek tek açılmış onlarca subdomain bulunuyor; wildcard ihtiyacı gerçek.

**Sıralama:** Önce Yunsoft'un Plesk'inde kurulu olup site ekranında günlük görünen ve YunPanel'de olmayanlar.

| # | Plesk'te (nerede) | YunPanel'de | Not |
|---|---|---|---|
| 1 | **Hosting türü: yönlendirme / hosting'siz domain** ve **wildcard subdomain** (Add Domain/Subdomain, Hosting & DNS) | Yok; wildcard kodda reddediliyor | Bu sunucudaki kullanım biçiminde en çok iş kazandıracak madde |
| 2 | **WP Toolkit 6.11** (kurulu, menüde) | Yarım/ertelendi (WP-03, WP-04, WP-07) | Akıllı güncelleme, toplu yönetim, güvenlik, klon/staging |
| 3 | **Website Copying** (site Dashboard) | Yok | Siteyi başka domaine kopyalama |
| 4 | **Password-Protected Directories** (site Dashboard) | Yok | |
| 5 | **Site Import, Mail Importing, Plesk Migrator** (kurulu) | Yok/yarım (MIG-*) | Başka sunucudan site ve posta taşıma; YunPanel'e geçişte de lazım |
| 6 | **Notifications** (Araçlar) ve **Watchdog** eklentisi | E-posta bildirimi yok; watchdog yalnız arka uçta, arayüzü yok | SSL/disk/servis uyarısı |
| 7 | **Performance Booster** (nginx önbellek/sıkıştırma; site ve sunucu) | Yok | |
| 8 | **Smarthost** (posta relay; sunucu ve site Mail sekmesi) | Yok | |
| 9 | **Log Browser** (canlı log) | Log sayfası var, canlı akış yok | |
| 10 | **Google Drive Backup** (kurulu) | Yok | Restic/rclone var; Drive hedefi eklenebilir |
| 11 | **Imunify** (kurulu; malware tarama) | Yok/yarım (EKL-04) | |
| 12 | **Advisor** (kurulu; güvenlik/performans önerileri) | Yalnız firewall önerisi | |
| 13 | **Track Email Delivery** (site Mail sekmesi) | Kısmi (teslimat tanılama) | |
| 14 | **Softaculous, Sitejet Builder** (kurulu) | Docker tabanlı uygulama marketi var; PHP uygulama kurucu ve site builder yok | |
| 15 | Event Manager, Mass Email, Custom Buttons, Prohibited Domains, SOGo, Mobile Center | Yok | Düşük öncelik |

**YunPanel'de karşılığı olanlar** (bu bakışta eksik görülmedi, ama gerçek çalışması 1. dalga testlerinde ölçülüyor): Git, PHP Composer, Laravel ve Node.js araçları, Docker ve Docker Proxy Rules, Let's Encrypt/SSL, Firewall, Fail2Ban benzeri koruma (CrowdSec), ModSecurity (yarım), MFA, SSH Terminal, Repair Kit benzeri onarım (Diagnose & Repair), Monitoring (Netdata), Scheduled Tasks, Backup Manager, DNS, Webmail (Roundcube).

## Nginx, domain ve yönlendirme (İNSAN'ın işaret ettiği zayıf alan)
| Plesk özelliği | YunPanel durumu | Kanıt |
|---|---|---|
| **Wildcard domain / subdomain** (`*.st.novasis.ai` alıp altına site açmak, wildcard subdomain hosting) | Yok, açıkça reddediliyor | `packages/shared/src/domain.js:43` → `wildcard_not_supported` "Wildcard domains are not supported in V1". Wildcard SSL ayrı bir konu ve kısmen var |
| **Hosting'siz domain yönlendirme** (forwarding: domaini başka bir URL'ye 301/302 ya da çerçeveli yönlendirme; subdomain veya site oluşturmadan) | Yok | Web yönlendirmesi yalnız iki yerde: HTTP→HTTPS ve ek alan adlarının tercih edilen domaine yönlendirilmesi (`packages/config-templates/src/nginx.js:114` `redirectBody`, `apps/web/src/workspace/DomainHostingPanel.jsx:297-302`). Parity: WEB-04 "İnceleme/kabul açık" |
| **Yönlendirme kuralları** (yol bazlı 301/302, ör. `/eski` → `/yeni`; regex kuralı) | Yok | Nginx şablonunda yalnız `location /` için 301 üretiliyor |
| **Ek nginx yönergeleri** (site başına özel `nginx.conf` parçası) | Yok / doğrulanmadı | Panelde ön-ayarlar (CORS, güvenlik başlıkları, cache) var; serbest yönerge alanı bulunamadı |
| **Nginx önbellekleme** (tek tıkla proxy/fastcgi cache) | Yok | `proxy_cache` / `fastcgi_cache` kodda yok |
| **Hotlink koruması** | Yok | Kodda iz yok |

## Hiç yok (kodda iz yok)
| Plesk özelliği | Not |
|---|---|
| **Ek FTP kullanıcıları** | Site başına SFTP var; klasöre özel ek FTP/SFTP kullanıcısı açma bulunamadı |
| **Şifre korumalı dizinler** | htpasswd / `auth_basic` yok |
| **Site kopyalama** | Bir siteyi başka domaine kopyalama yok. Yalnız WordPress klonu var ve yarım (WP-04) |
| **Yöneticiye e-posta bildirimi** | Bildirim merkezi panelde var; disk/SSL/servis uyarısının e-postayla gönderilmesi yok |
| **Canlı log izleme** | Log sayfası var; anlık akış (tail) yok |
| **PHP eklenti yönetimi** | PHP sürümü seçiliyor; eklenti (PECL/uzantı) açma/kapama yok |
| **Mail içe aktarma** | Başka sunucudan posta kutusu taşıma (IMAP sync) yok |
| **IP adresi yönetimi** | Katalog SYS-01'i "partial" diyor, ama kodda IP havuzu ve dedicated/shared IP karşılığı bulunamadı |

## Yarım (katalog `partial`)
| ID | Özellik |
|---|---|
| EML-03 | Otomatik yanıt / tatil mesajı |
| EML-04 | Spam filtresi, izin/engel listesi |
| DNS-04 | DNSSEC anahtar, DS ve rollover |
| DB-09 | Uzak veritabanı sunucusu kaydı |
| WP-04 | WordPress klonlama, staging, veri senkronizasyonu |
| BAK-07 | Çoklu yedek takvimi ve çoklu hedef |
| SEC-03 | ModSecurity / WAF politikaları |
| SYS-01 | IP havuzu, IPv4/IPv6, shared/dedicated |
| MIG-02 | cPanel / DirectAdmin'den taşıma |
| EKL-04 | Antivirüs ve güvenlik entegrasyonları |
| EKL-02, EKL-06 | Eklenti yönetimi, lisans ve sağlık envanteri |
| DEV-04 | Laravel oluşturma ve tarama |

## Bilerek ertelenmiş (katalog `deferred`, önceki İNSAN kararı)
Mailing list (EML-05), WordPress akıllı güncelleme (WP-07) ve toplu yönetim (WP-03), WHMCS/faturalama (API-05), paket/abonelik senkronizasyonu (API-06), registrar bayiliği (API-07), abonelikler arası DB taşıma (DB-07), harici uptime izleme (MON-06), site builder (EKL-03). Bunlar `agents.md` madde 3 kapsamında sonraki fazdadır; 3. dalgaya ancak İNSAN açıkça isterse alınır.

## 3. dalgada yapılacak
1. İNSAN sık kullanılan Plesk özelliklerini listeler.
2. Senior bu not, `OZET.md` "panelde olmayan" listesi ve parity belgesiyle eşler; her madde için kapsam, risk ve tasarım seçeneği sunar.
3. Onaylananlar `docs/gorevler/G3-*.md` görevlerine çevrilir.
