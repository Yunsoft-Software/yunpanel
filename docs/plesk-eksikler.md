# Plesk'te olup YunPanel'de olmayan özellikler (3. dalga adayları)

> 2026-10-26 · senior (Claude) kod incelemesi. **Not, onaylı görev değil.** 3. dalgada İNSAN'ın vereceği "Plesk'te sık kullandıklarımız" listesiyle birleştirilip göreve çevrilir (`docs/orkestra/DECISIONS.md` 2026-10-26 iş sırası).
>
> Yöntem: Plesk'in sık kullanılan özellikleri YunPanel'in `apps/api/src`, `apps/web/src`, `packages/*/src` kodunda anahtar kelimeyle arandı. Ayrıca kendi yetenek kataloğu `apps/api/src/non-reseller-capabilities.js` (95 özellik: 70 completed, 13 partial, 9 deferred) okundu. Sınırlar: Plesk tarafı resmî belgeyle tek tek doğrulanmadı; farklı isimle yazılmış bir özellik kaçmış olabilir. Katalogdaki "completed" işareti çalıştığı anlamına gelmez; gerçek durum 1. dalga manuel test raporlarında (`docs/manuel-test/`).

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
