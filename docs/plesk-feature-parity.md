# Plesk → YunPanel Özellik Eşdeğerliği Matrisi ve Uygulama Kapsamı

Tarih: 2026-10-03. Çalışma dalı: `development`.
**Kullanıcı Kararı & Mimari İlke:** Plesk görev düzeni korunur, reseller ilk sürümü sade tutulur. Eski tam reseller/paket/abonelik zorunluluğu bu matris, `plan.md` ve [güncel RS sözleşmesi](ux/plesk-full-scope.md) ile daraltılmıştır.

Önceki 21 gruplu bütün özellik listesi ve S01–S27 resmî kaynak kaydı, hiçbir satırı kaybetmeden [tam envanter kopyasında](history/plesk-feature-parity-before-simple-reseller-20260923.md) muhafaza edilmektedir. Bu belge, söz konusu envanterin **tam eşdeğerlik matrisi ve canlı sistem haritasıdır**. Tüm özellik ID'leri; kaynak kod bileşenleri, API uç noktaları, servis adaptörleri, eksik/kısmi kalan davranışlar, rol ayrımları (Owner, sade Reseller, Customer, Site Manager), hedef işletim sistemi ve sağlayıcı (provider) sınırları ile eşleştirilmiştir.

> **Önemli Kural ve İlkeler:**
> 1. **Yapay Oran Yasağı:** Checkbox sayısından veya özellik listesinden yapay bir tamamlanma yüzdesi üretilmez.
> 2. **Canlı Kabul Ayrımı:** Kaynak testleri, birim testleri veya mock fixture'lar canlı SMTP/IMAP, gerçek TLS bağlantısı, işletim sistemi süreç izolasyonu veya render edilmiş tarayıcı kabulü yerine geçmez. Canlı kabul kapıları ilgili staging/host kanıtı oluşana kadar açık tutulur.
> 3. **EKL-07 Durumu:** Marketplace eklenti araştırması açık tutulur.
> 4. **Ertelenmiş Reseller Kapsamı:** İlk sürüm MVP engeli veya tamamlanmış iş sayılmaz; sonraki faz olarak sınıflandırılır.

---

## 1. Sade Reseller Mimarisi ve Tamamlanan PAR-01 / PAR-02 Geliştirmeleri

**Hiyerarşi:** `Owner → isteğe bağlı tek Reseller → Customer → mevcut Website`.
Paket (Plan) ve Abonelik (Subscription) nesneleri site işlemleri için önkoşul değildir. Mevcut site araçları, yetkilendirme, Files girişleri ve Unix kullanıcı izolasyonu korunmuştur.

### Tamamlanan PAR-01 / RS-01–02: Basit Sahiplik ve Güvenli Entegrasyon
- **Basit Sahiplik Hiyerarşisi:** Owner → isteğe bağlı tek Reseller → Customer → Website ilişkisi uygulandı. Reseller hesaplarının alt-bayi (sub-reseller) zincirleri oluşturması veritabanı kısıtları (`CHECK(kind != 'reseller' OR reseller_id IS NULL)`) ve tetikleyicilerle engellendi.
- **Mevcut Roller ve Unix Kimliklerinin Korunması:** Mevcut `site_manager` üyeliği, kullanıcı rolleri, ID'leri ve her web sitesine özel izole Unix kullanıcı kimlikleri (`system_user`) eksiksiz korundu.
- **Saf Kapsam ve Limit Politikası:** Durum kablolamasından önce saf kapsam kuralları işletildi (`apps/api/src/hosting-account-store.js`, `apps/api/src/hosting-site-allocation-schema.js`). Müşteri erişimi yalnızca atanmış sitelerle sınırlandırıldı; bayi erişimi ise yalnızca doğrudan alt müşterilerinin siteleriyle sınırlandı.
- **Sürümlü Şema, Migrasyon ve Rollback:** Hosting hesapları ve site tahsisleri için sürümlü şema yapısı (`auth_hosting_accounts`, `auth_hosting_site_allocations`, `auth_customer_websites`) uygulandı. Bozuk, eksik veya uyumsuz şemada sistem fail-closed 503 (`hosting_site_state_invalid`, `hosting_accounts_corrupted`) yanıtı verir; boş şemada güvenli rollback (`rollbackEmptyHostingAccountSchema`) sağlanır.
- **Atomik Adet, Kota Doğrulaması ve Drift Koruması:** Müşteri ve bayi kotalarının güncellenmesinde üst bayi kapasitesi atomik SQLite transaction ile kontrol edilerek overselling engellendi. Tahsis kayıtları ile müşteri web sitesi ilişkileri arasında çift yönlü tutarlılık denetimi (`hostingWebsitesForCapacity`) eklenerek tahsis kayması (drift) anında 503 fail-closed ile durduruldu.
- **Anında Oturum ve Yetki İptali:** Kullanıcı rolü, grant veya hesap askıya alma durum değişikliklerinde `revokeSession` ve `revokeLiveUser` hooks işletilerek API uç noktalarında açık oturumların anında sonlandırılması sağlandı; `auth-store.js` içinde `isHostingRole` (`site_manager`, `reseller`, `customer`) için oturum profili ve web sitesi kapsamı canlı olarak yüklendi.
- **Doğrulama Testleri:** `apps/api/test/par-01-reseller-ownership.test.js` (8/8 test), `apps/api/test/hosting-account-store.test.js`, `apps/api/test/staging-e2e-verification.test.js`.

### Tamamlanan PAR-02 / RS-03–05: Basit Customer/Reseller Yönetimi
- **Owner ve Reseller Yönetim Ayrımı:** Owner bayileri ve müşterileri yönetir (`/api/users/hosting/accounts`, limitler, kotalar, listeleme, detay); bayiler (reseller) ise yalnızca kendi doğrudan çocuk müşterilerini ve bunlara bağlı siteleri listeler ve yönetir (`/api/users/hosting/accounts/self/customers`, `POST .../self/customers`, `PATCH .../:id/login`, `PATCH .../:id/status`). Yabancı bayiye, yabancı müşteriye veya Owner'ın doğrudan müşterisine erişim girişimleri 403 `reseller_scope_forbidden` ile metadata sızdırmaksızın fail-closed reddedilir.
- **Müşteri (Customer) Sınırları:** Müşteri oturumunda yalnızca kendilerine tahsis edilen siteler (`/api/websites`, `/api/domains`), self-service site araçları (veritabanı, posta, dosyalar, site terminali) ve kotalar (`maxWebsites`, `maxDiskMb`, `maxTrafficMb`, `maxDatabases`) sunulur; unmanaged ve hosted site oluşturma girişimleri fail-closed 403 ile engellenir.
- **Askı (Suspension) Yaşam Döngüsü:** `setActive: false` ile müşteri veya bayinin oturum ve yetkileri iptal edilerek yeni oturum açması ve mutasyon yapması engellenirken (401/403 fail-closed), mevcut site dosyaları, veritabanları, posta kutuları ve host konfigürasyonları silinmeksizin korunur; bayi askıya alındığında tüm alt müşteri oturumları anında geçersiz kılınır.
- **Güvenli Silme Engeli (Safe Deletion Blocking):** Bağlı aktif kaynaklar (`websites`, `domains`, `databases`, `mailboxes`) veya çocuk müşteriler mevcutken müşteri veya bayi varlıklarının silinmesi fail-closed 409 `hosting_account_in_use` ile engellenir. Kaynaklar temizlendikten sonra güvenli `deleteCustomerLogin` ile kota, profil, kullanıcı ve oturum kayıtlarının atomik temizliği ve `hosting.customer_login_deleted` denetim kaydı sağlanır.
- **Doğrulama Testleri:** `apps/api/test/par-02-reseller-customer-management.test.js` (6/6 test), `apps/api/test/tenant-boundary.test.js`, `apps/api/test/site-resource-boundary.test.js`, `apps/api/test/hosting-site-create-http.test.js`, `apps/api/test/staging-e2e-verification.test.js`.

---

## 2. İlk Sürümden Çıkarılan / Ertelenmiş Reseller Maddeleri (Sonraki Faz)

Aşağıdaki maddeler **ilk sürüm MVP engeli değildir** ve **tamamlanmış iş sayılmaz**. Sonraki fazlara ertelenmiştir:

1. **Alt Bayi Zinciri (Sub-Reseller Hierarchy):** Bayinin kendi altında başka bayiler oluşturması engellenmiştir; hiyerarşi kesin olarak tek seviyeli (`resellerId IS NULL` kısıtı) kalır.
2. **Ayrı Reseller Hizmet Paketi Motoru (Dedicated Reseller Package Engine):** Reseller'a özel paket şablonları motoru kurulmaz; Owner tarafından atanan doğrudan adet limitleri (`maxCustomers`, `maxWebsites`) yeterlidir.
3. **Hosting Add-on Paketleri:** Ek kaynak veya özellik eklentileri paket motoru kapsam dışıdır.
4. **Abonelik Senkronizasyonu, Kilitleme ve Özelleştirme (Subscription Sync/Lock/Customization):** Plan değişikliklerinin aboneliklere yayılması, kilit mekanizmaları ve özelleştirilmiş abonelik motoru ertelenmiştir.
5. **Overselling (Aşırı Tahsis):** Bayinin sahip olduğu kaynaklardan fazlasını müşterilerine dağıtması kesin olarak engellenmiştir; atomik kota kontrolleri işletilir.
6. **Otomatik Faturalama ve Süre Sonu (Automatic Billing & Expiration Lifecycle):** Otomatik süre sonu takibi, askıya alma ve faturalama entegrasyonu ilk sürümün şartı değildir.
7. **Bayi Markalama (Reseller Branding / White-Labeling):** Bayiye özel logo, tema veya giriş ekranı özelleştirmeleri ilk sürüme dahil edilmez.
8. **Müşteri ↔ Bayi Dönüşümü (Customer-Reseller Conversion):** Hesap türü veritabanında sabittir; dinamik tür dönüşümü kapalıdır.
9. **Toplu Hesap Transferi (Bulk Account Transfer / Mass Migration):** Müşteri veya sitelerin bayiler arasında toplu taşınması API ve UI düzeyinde kapalıdır.
10. **Login-As (Yetkili Müşteri/Bayi Bağlamına Geçiş / Impersonation):** Yöneticinin başka bir hesabın kimliğine bürünerek oturum açması güvenlik gerekçesiyle ilk sürümde kapalıdır; fail-closed korunur.

---

## 3. EKL-07 Eklenti Kataloğu ve Marketplace Araştırma Durumu

- **Durum:** **AÇIK TUTULDU (Aktif Araştırma)**
- **Kapsam:** Plesk Marketplace üzerindeki tüm üçüncü taraf ürünlerin (güvenlik, SEO, yedekleme, e-posta, geliştirici araçları) vendor, sürüm, hedef işletim sistemi, lisans gereksinimi ve teknik işlev bazında envanterinin çıkarılması süreci devam etmektedir.
- **İlke:** Liste dışındaki eklentiler sessizce kapsam dışı sayılmaz; çekirdek panel işlevleri ile harici ticari eklentiler kesin olarak ayrıştırılır.

---

## 4. 21 Özellik Grubu Tam Eşdeğerlik Matrisi

### Grup 01 — Paneller, Roller ve Erişim [S01, S02]
| ID | Özellik | Durum | Kaynak, API & Servis | Rol Ayrımı | OS & Provider | Doğrulama & Sınırlar |
| --- | --- | --- | --- | --- | --- | --- |
| ROL-01 | Yönetici Service Provider görünümü | Tamamlandı (Sade) | `WorkspaceApp.jsx`, `ux-model.js`; `/api/servers/:id`; `server-registry.js` | Owner tam yetkili; Reseller/Customer 403 | Ubuntu Linux | `navigation.test.js`, `staging-e2e-verification.test.js`; Tekil görev hiyerarşisi |
| ROL-02 | Yönetici Power User görünümü & toggle | Ertelendi | `WorkspaceApp.jsx` | Owner | Linux | Dinamik switcher MVP engeli değildir; tekil yerleşim korunur |
| ROL-03 | Reseller paneli & kullanıcı sınırı | Tamamlandı (PAR-01/02) | `hosting-account-store.js`, `tenant-boundary.js`; `/api/users/hosting/accounts/self/customers` | Reseller yalnız kendi çocuk müşterilerini yönetir | Linux / SQLite | `par-01-reseller-ownership.test.js`, `staging-e2e-verification.test.js` |
| ROL-04 | Müşteri paneli & site seçimi | Tamamlandı (PAR-01/02) | `tenant-boundary.js`, `site-resource-boundary.js`; `/api/websites`, `/api/domains` | Customer yalnız tahsisli sitelere erişir | Linux | `tenant-boundary.test.js`, `staging-e2e-verification.test.js` |
| ROL-05 | Ek kullanıcılar, roller ve izin matrisi | Kısmi | `auth-store.js`, `panel-access.js`; `/api/users` | Sabit roller: owner, reseller, customer, site_manager, read_only | Linux | `auth-store.test.js`; Dinamik rol oluşturma motoru sonraki faz |
| ROL-06 | Ek yönetici hesapları & yönetim yetkisi | Kısmi | `auth-store.js`, `user-admin-http.js`; `/api/users` | Çoklu Owner var; son aktif Owner silinemez | Linux | `auth-store.test.js`; İkincil alt-yönetici yetkileri sonraki faz |
| ROL-07 | Profil, parola, oturum ve MFA | Tamamlandı (YP-11) | `auth-store.js`, `auth-mailer.js`; `/api/auth/reset-password/*`, `.../mfa/*` | Tüm roller; Owner sıfırlama verified recovery mail ile | Linux / SMTP | `auth-password-reset.test.js`, `auth-store.test.js`; FIDO2/SMS sonraki faz |
| ROL-08 | Yetkili müşteri/bayi geçişi (Login-As) | Ertelendi | N/A | Owner | Linux | Güvenlik gerekçesiyle kapalıdır; MVP engeli değildir |

### Grup 02 — Müşteri ve Bayi Yaşam Döngüsü [S02, S03]
| ID | Özellik | Durum | Kaynak, API & Servis | Rol Ayrımı | OS & Provider | Doğrulama & Sınırlar |
| --- | --- | --- | --- | --- | --- | --- |
| HSP-01 | Müşteri CRUD, askı ve silme | Tamamlandı (PAR-02) | `hosting-account-http.js`, `hosting-account-store.js`; `POST/PATCH/DELETE /api/users/hosting/accounts*` | Owner ve yetkili Reseller; Customer yönetemez | Linux / SQLite | `par-02-reseller-customer-management.test.js`, `staging-e2e-verification.test.js`; Bağlı aktif kaynakta 409 |
| HSP-02 | Reseller CRUD, limit ve askı | Tamamlandı (PAR-01/02) | `hosting-account-http.js`, `hosting-account-store.js`; `POST .../accounts`, `PATCH .../limits` | Yalnız Owner (Reseller alt-reseller açamaz) | Linux / SQLite | `par-01-reseller-ownership.test.js`, `par-02-reseller-customer-management.test.js`; Bayi askısında alt oturumlar iptal |
| HSP-03 | İletişim, şirket, hesap bilgisi | Tamamlandı | `auth-store.js`, `hosting-account-store.js`; `/api/users/:id`, `.../profile` | Owner ve ilgili Reseller | Linux | `hosting-account-http.test.js`; Ayrı fatura motoru sonraki faz |
| HSP-04 | Hesap altında domain/müşteri/site listesi | Tamamlandı (PAR-01/02) | `hosting-account-store.js`, `hosting-site-allocation-store.js`; `/api/websites` | Reseller yalnız kendi çocuklarını/sitelerini listeler | Linux | `par-01-reseller-ownership.test.js`, `staging-e2e-verification.test.js` |
| HSP-05 | Müşteriyi başka bayiye taşıma | Ertelendi | N/A | Owner | Linux | Çapraz bayi taşıma sonraki faz; MVP engeli değildir |
| HSP-06 | Müşteri ↔ reseller dönüşümü | Ertelendi | N/A | Owner | Linux | DB tetikleyicisiyle kind sabittir; sonraki faz |
| HSP-07 | Toplu hesap işlemleri & izin iptali | Ertelendi / Kısmi | `live-session-registry.js` | Owner | Linux | `staging-e2e-verification.test.js`; Tekil oturum iptali tam; toplu batch API sonraki faz |
| HSP-08 | Reseller hosting aboneliği | Sadeleştirildi | `hosting-account-store.js`; `/api/websites` | Reseller | Linux | `staging-e2e-verification.test.js`; Reseller kendi sitesini müşteri kimliğiyle yönetir |

### Grup 03 — Hizmet Paketleri ve Abonelikler [S03, S04]
| ID | Özellik | Durum | Kaynak, API & Servis | Rol Ayrımı | OS & Provider | Doğrulama & Sınırlar |
| --- | --- | --- | --- | --- | --- | --- |
| PLN-01 | Hosting paket CRUD | Ertelendi | N/A | Owner | Linux | Paket motoru ilk sürüm şartı değil; sonraki faz |
| PLN-02 | Add-on paketleri | Ertelendi | N/A | Owner | Linux | Sonraki faz |
| PLN-03 | Reseller paketleri | Ertelendi | N/A | Owner | Linux | Doğrudan atanan maxCustomers/maxWebsites limitleri kullanılır |
| PLN-04 | Müşteriye paketli/özel kota | Sadeleştirildi | `customer-quotas.js`, `hosting-account-store.js`; `PATCH .../quotas` | Owner ve yetkili Reseller | Linux / SQLite | `customer-quotas.test.js`, `staging-e2e-verification.test.js`; Doğrudan müşteri kaynak kotası |
| PLN-05 | Abonelik askı/etkinleştirme | Sadeleştirildi | `website-suspension-runtime.js`, `hosting-account-store.js`; `POST .../suspension` | Owner ve yetkili Reseller | Linux | `website-suspension-runtime.test.js`; Hesap ve site askı yaşam döngüsü |
| PLN-06 | Paket senkronizasyon & kilit | Ertelendi | N/A | Owner | Linux | Sonraki faz |
| PLN-07 | Aboneliği başka müşteriye taşıma | Ertelendi | N/A | Owner | Linux | Sonraki faz |
| PLN-08 | Disk, trafik, DB, site adet limitleri | Tamamlandı (PAR-01 & PROD-15) | `customer-quotas.js`, `mailbox-quota-http.js`; `PATCH .../quotas` | Owner ve yetkili Reseller | Linux | `customer-quotas.test.js`, `staging-e2e-verification.test.js`; Aşımda 409 quota exceeded |
| PLN-09 | Kaynak aşımı & overselling | Sınırlandırıldı | `customer-quotas.js`, `operational-notification-service.js` | Owner ve Reseller | Linux | `customer-quotas.test.js`; Overselling kesin yasak; %85 uyarı bildirimi |
| PLN-10 | Paket bazlı izin tahsisi | Sadeleştirildi | `panel-access.js`, `site-resource-boundary.js` | Sabit RBAC ve site sahiplik yetkisi | Linux | `tenant-boundary.test.js`; Dinamik bayrak yerine rol yetkilendirmesi |

### Grup 04 — Siteler ve Domainler [S05, S06]
| ID | Özellik | Durum | Kaynak, API & Servis | Rol Ayrımı | OS & Provider | Doğrulama & Sınırlar |
| --- | --- | --- | --- | --- | --- | --- |
| WEB-01 | Domain ekleme & site sihirbazı | Tamamlandı | `site-create.js`, `website-provisioning-runtime.js`; `POST /api/sites/hosted` | Owner ve Reseller; Customer unmanaged açamaz | Ubuntu Linux / Nginx / PHP-FPM | `hosting-site-create-http.test.js`; Canlı host kabulü staging'de yürütülür |
| WEB-02 | Subdomain & ayrı docroot | Tamamlandı | `domain-http.js`, `domain-registry.js`; `POST /api/domains` | Site kapsamlı roller | Nginx vhost | `domain-http.test.js`; Wildcard için DNS-01 gerekir |
| WEB-03 | Domain alias & yönlendirme | Tamamlandı | `domain-http.js`, `mail-alias-http.js`; `POST /api/domains/alias` | Site kapsamlı roller | Nginx / Postfix | `domain-http.test.js`, `mail-alias-http.test.js`; Web ve mail alias entegrasyonu |
| WEB-04 | Hosting/forwarding/DNS-only mod | Tamamlandı | `domain-http.js`, `website-http.js`; `/api/domains` | Site kapsamlı roller | Nginx 301/302 | `domain-http.test.js`; Barındırmasız DNS-only ve yönlendirme alan adları |
| WEB-05 | Tercih edilen domain & HTTPS | Tamamlandı | `domain-http.js`, `certificate-http.js`; `PATCH .../routing` | Site kapsamlı roller | Nginx | `domain-http.test.js`, `ssl-renewal.test.js`; HSTS başlığı ve kanonik yönlendirme |
| WEB-06 | Domain/site askı ve güvenli silme | Tamamlandı (BUG-02 / WR-01–04) | `website-removal-runtime.js`, `website-suspension-runtime.js`; `POST .../removal/*` | Owner ve yetkili Reseller; Customer silemez | Nginx / Systemd / FS | `website-removal-http.test.js`, `website-suspension-runtime.test.js`; Typed-domain onayı, retention |
| WEB-07 | Domain liste, arama, filtre | Tamamlandı | `WebsitesPage.jsx`, `website-registry.js`; `GET /api/websites` | Tüm yetkili roller (kendi kapsamında) | Web UI | `navigation.test.js`; Plesk görev aileleri: Genel Bakış, Dosyalar, DB vb. |
| WEB-08 | Önizleme & site sağlık kontrolü | Tamamlandı | `site-health-http.js`, `website-http-health-inspector`; `GET .../health` | Tüm yetkili roller | Loopback HTTP | `site-health-http.test.js`; Loopback adres kontrolü ve canlı önizleme |
| WEB-09 | Siteyi müşteriye bağlama & taşıma | Sadeleştirildi (PAR-01) | `hosting-site-allocation-store.js` | Owner ve yetkili Reseller | SQLite | `par-01-reseller-ownership.test.js`, `staging-e2e-verification.test.js`; Müşteri taşıma sonraki faz |

### Grup 05 — Dosyalar ve Erişim [S07, S08]
| ID | Özellik | Durum | Kaynak, API & Servis | Rol Ayrımı | OS & Provider | Doğrulama & Sınırlar |
| --- | --- | --- | --- | --- | --- | --- |
| DOS-01 | Global Files & domain File Manager | Tamamlandı | `FilesPage.jsx`, `site-file-manager.js`, `elfinder-handoff-service.js` | Owner tüm siteler; Reseller/Customer kendi siteleri | Linux / Dedicated Unix User | `site-file-http.test.js`, `elfinder-handoff-http.test.js`; Her iki giriş korunur |
| DOS-02 | Klasör ağacı, yol, liste, sıralama | Tamamlandı | `site-file-manager.js`, `FilesPanel.jsx`; `GET .../files/list` | Site kapsamlı roller | Linux ext4/xfs | `site-file-http.test.js`; elFinder ve dahili dosya gezgini |
| DOS-03 | Dosya/klasör CRUD | Tamamlandı | `site-file-worker.js`; `POST .../files/*` | Site kapsamlı roller | Linux permissions | `site-file-http.test.js`; Path traversal fail-closed docroot hapsi |
| DOS-04 | Dosya yükleme & drag/drop | Tamamlandı | `site-file-http.js`, `FilesPanel.jsx`; `POST .../upload` | Site kapsamlı roller | Multipart stream | `site-file-http.test.js`; Kota ve dosya boyutu kontrolleri |
| DOS-05 | Dosya indirme & URL import | Tamamlandı | `site-file-http.js`; `POST .../import-url` | Site kapsamlı roller | HTTP client / SSRF block | `site-file-http.test.js`; Özel IP bloklarına indirmede SSRF koruması |
| DOS-06 | Kopyalama & taşıma | Tamamlandı | `site-file-manager.js`, `site-file-worker.js` | Site kapsamlı roller | Linux FS | `site-file-http.test.js`; Hedef varlığında güvenli üzerine yazma onayı |
| DOS-07 | Arşivleme (zip, tar.gz) | Tamamlandı | `site-file-worker.js`; `POST .../archive` | Site kapsamlı roller | zip / tar CLI | `site-file-http.test.js`; Zip-slip saldırılarına karşı mutlak yol kontrolü |
| DOS-08 | Kod/metin düzenleme & kaydetme | Tamamlandı | `FileEditorModal.jsx`, `site-file-manager.js`; `PUT .../content` | Site kapsamlı roller | UTF-8 | `site-file-http.test.js`; Eşzamanlı değişiklik uyarısı |
| DOS-09 | Gizli dosyalar, arama ve chmod | Tamamlandı | `site-file-manager.js`, `site-file-worker.js`; `PATCH .../permissions` | Site kapsamlı roller | Linux chmod/chown | `site-file-http.test.js`; .env ve gizli dosyalarda secret masking |
| DOS-10 | FTP/FTPS hesapları & kota | Kısmi / SFTP | `website-sftp-key-http.js`, `website-sftp-key-service.js` | Site kapsamlı roller | OpenSSH / SFTP | `website-sftp-key-http.test.js`; Düz metin FTP yerine güvenli SFTP anahtarları |
| DOS-11 | SSH/SFTP/shell erişimi & Unix izolasyonu | Tamamlandı | `terminal-capability-http.js`, `ttyd-session-manager.js` | Site: Customer/Reseller; Root: Yalnız Owner | Linux PAM / ttyd / OpenSSH | `terminal-capability-http.test.js`, `staging-e2e-verification.test.js`; Site kullanıcısı root olamaz |

### Grup 06 — Hosting ve Çalışma Ortamları [S05, S09, S10]
| ID | Özellik | Durum | Kaynak, API & Servis | Rol Ayrımı | OS & Provider | Doğrulama & Sınırlar |
| --- | --- | --- | --- | --- | --- | --- |
| RUN-01 | Docroot, sistem kullanıcısı ve hosting | Tamamlandı | `site-create.js`, `website-provisioning-runtime.js` | Owner ve yetkili Reseller | Ubuntu Linux / Useradd / Nginx | `hosting-site-create-http.test.js`; Her siteye benzersiz izole sistem kullanıcısı |
| RUN-02 | PHP sürümü, php.ini, PHP-FPM | Tamamlandı | `website-php-tools-http.js`, `website-php-tools-service.js` | Site kapsamlı roller | PHP-FPM (7.4, 8.1, 8.2, 8.3) | `website-php-tools-http.test.js`; FPM pool izolasyonu ve direktif doğrulaması |
| RUN-03 | Apache/Nginx ek direktifler | Tamamlandı | `domain-http.js`, `nginx -t` | Yalnız Owner ek direktif girebilir | Nginx reverse proxy | `domain-http.test.js`; Hatalı sözdiziminde otomatik rollback |
| RUN-04 | MIME, index, hata sayfaları, basic auth | Tamamlandı | `domain-http.js`; `/api/websites/:id/http-auth` | Site kapsamlı roller | Nginx | `domain-http.test.js`; Özel hata sayfaları ve Basic Auth |
| RUN-05 | Node.js sürümü, app root, environment | Tamamlandı (PROD-14) | `node-runtime-http.js`, `application-configuration-http.js` | Site kapsamlı roller | Node.js / Systemd / Passenger | `application-operations.test.js`; Secret değişkenler maskelenir |
| RUN-06 | Node script, restart ve canlı loglar | Tamamlandı (PROD-14) | `application-process-http.js`, `application-deploy-queue.js` | Site kapsamlı roller | npm / yarn / pnpm / systemd | `application-operations.test.js`; Onay jetonuyla süreç kontrolü |
| RUN-07 | Composer bağımlılık yönetimi | Tamamlandı (PHP-ACTION-01/02) | `website-php-tool-action.js`, `website-php-tool-action-service.js` | Site kapsamlı roller | Composer / PHP CLI | `website-php-tool-action.test.js`; Sabit eylem kataloğu; 0600 receipt |
| RUN-08 | Dil/runtime eklentileri (Python, Docker) | Tamamlandı (PROD-14) | `application-operations-http.js`, `docker-workload-http.js` | Owner tam yetkili; Customer site-isolated | Python / Docker (Ürün Uzantısı) | `application-operations.test.js`, `staging-e2e-verification.test.js`; Açık ürün uzantısıdır |

### Grup 07 — Git ve Framework Araçları [S10, S11]
| ID | Özellik | Durum | Kaynak, API & Servis | Rol Ayrımı | OS & Provider | Doğrulama & Sınırlar |
| --- | --- | --- | --- | --- | --- | --- |
| DEV-01 | Uzak/yerel Git repository | Tamamlandı | `application-operations-http.js`; `POST .../git` | Site kapsamlı roller | Git CLI / SSH | `application-operations.test.js`; GitHub, GitLab ve özel SSH depoları |
| DEV-02 | Branch, deploy path, manuel/otomatik deploy | Tamamlandı | `application-deploy-queue.js`; `POST .../deploy` | Site kapsamlı roller | Git / Bash | `application-operations.test.js`; Dayanıklı kuyrukla arka plan deploy |
| DEV-03 | Deploy key, webhook ve sonuç takibi | Tamamlandı | `application-operations-http.js`; `/api/.../webhook` | Site kapsamlı roller | Webhook HMAC | `application-operations.test.js`; Push tetiklemeli otomatik deploy ve rollback |
| DEV-04 | Laravel oluşturma & tarama | Kısmi | `website-php-tools-service.js` | Site kapsamlı roller | Composer / Laravel | `website-php-tools-service.test.js`; Proje yapısı tespiti var; özel sihirbaz kısmi |
| DEV-05 | Laravel environment, Artisan, Composer | Tamamlandı | `website-php-tool-action.js`, `application-configuration-http.js` | Site kapsamlı roller | Artisan / Composer | `website-php-tool-action.test.js`; Güvenli kataloglanmış Artisan eylemleri |
| DEV-06 | Laravel scheduled task & logs | Tamamlandı | `website-cron-http.js`, `application-operations-http.js` | Site kapsamlı roller | Linux Crontab | `website-cron-http.test.js`; `php artisan schedule:run` crontab entegrasyonu |

### Grup 08 — Docker [S12]
| ID | Özellik | Durum | Kaynak, API & Servis | Rol Ayrımı | OS & Provider | Doğrulama & Sınırlar |
| --- | --- | --- | --- | --- | --- | --- |
| DKR-01 | Registry/image arama ve yönetim | Tamamlandı | `docker-workload-http.js`, `docker-workload-registry.js` | Owner tam yetkili; Customer sınırlandırılmış | Docker Engine / Linux | `docker-workload-http.test.js`; Açık ürün uzantısı (Plesk dışı modern yetenek) |
| DKR-02 | Container CRUD ve süreç kontrolü | Tamamlandı | `docker-workload-http.js`; `POST .../process` | Owner tam yetki | Docker daemon | `docker-workload-http.test.js`; Container yaşam döngüsü kontrolleri |
| DKR-03 | Port, environment, volume politikası | Tamamlandı | `docker-workload-http.js`; `.../config` | Owner | Docker / Bridge | `docker-workload-http.test.js`; Host port çakışma kontrolleri |
| DKR-04 | Reverse proxy bağlantısı ve loglar | Tamamlandı | `docker-workload-http.js`, `domain-http.js` | Owner ve ilgili site yöneticisi | Nginx upstream | `docker-workload-http.test.js`; Container HTTP portunu Nginx üzerinden bağlama |
| DKR-05 | Compose stack oluşturma (up/down) | Tamamlandı | `docker-workload-http.js`; `/api/docker/compose` | Owner | Linux / docker-compose | `docker-workload-http.test.js`; YAML şema doğrulama ve stack izolasyonu |
| DKR-06 | Yapılandırma yedeği ile volume ayrımı | Tamamlandı | `backup-resource-provider.js`; `/api/backups` | Owner | Restic / Docker | `website-backup-acceptance.test.js`; Statik config ile kalıcı volume verisi ayrılır |

### Grup 09 — DNS [S13]
| ID | Özellik | Durum | Kaynak, API & Servis | Rol Ayrımı | OS & Provider | Doğrulama & Sınırlar |
| --- | --- | --- | --- | --- | --- | --- |
| DNS-01 | Domain zone ve RR CRUD (A, AAAA, CNAME vb.) | Tamamlandı | `powerdns-http.js`; `GET/POST .../records` | Site kapsamlı roller | PowerDNS / BIND | `powerdns-http.test.js`, `dns-requirements-service.test.js`; Tüm RR türleri doğrulanır |
| DNS-02 | TTL, SOA ve zone şablonları | Tamamlandı | `powerdns-http.js`; `PATCH .../soa` | Owner ve Reseller | PowerDNS | `powerdns-http.test.js`; Otomatik serial artırımı ve varsayılan şablonlar |
| DNS-03 | Master/secondary, DNS aç/kapat | Tamamlandı | `dns-hosting-registry.js`; `PATCH .../status` | Site kapsamlı roller | PowerDNS / Harici sağlayıcı | `dns-requirements-service.test.js`; Harici DNS kullanımında yerel zone kapatılabilir |
| DNS-04 | DNSSEC anahtar/DS/rollover | Kısmi | `powerdns-http.js`; `GET .../dnssec` | Owner | PowerDNS | `powerdns-http.test.js`; DS kaydı ve anahtar sunumu var; otomatik rollover sonraki faz |
| DNS-05 | Zone transfer yetkileri (AXFR) | Tamamlandı | `powerdns-http.js`; `/api/.../axfr-acl` | Owner | PowerDNS | `powerdns-http.test.js`; İkincil DNS sunucularına IP bazlı AXFR kısıtlaması |
| DNS-06 | Cloudflare entegrasyonu & yayılım | Tamamlandı | `cloudflare-dns-manager`, `dns-requirements-service.js` | Owner ve Reseller | Cloudflare / Harici DNS | `dns-requirements-service.test.js`, `staging-e2e-verification.test.js`; Canlı yayılım tespiti |

### Grup 10 — Sertifikalar ve TLS [S14]
| ID | Özellik | Durum | Kaynak, API & Servis | Rol Ayrımı | OS & Provider | Doğrulama & Sınırlar |
| --- | --- | --- | --- | --- | --- | --- |
| TLS-01 | Ücretsiz ACME issue, renew & oto-yenileme | Tamamlandı | `certificate-http.js`, `certificate-renewal-scheduler.js` | Site kapsamlı roller | Let's Encrypt / HTTP-01 | `ssl-renewal.test.js`, `certificate-http.test.js`; Arka plan zamanlayıcı, yenileme audit |
| TLS-02 | Wildcard/DNS-01, SAN ve www kapsamı | Tamamlandı | `certificate-http.js`; `POST .../wildcard` | Site kapsamlı roller | Let's Encrypt | `certificate-http.test.js`; Wildcard için DNS API bilgisi zorunludur |
| TLS-03 | Sertifika/anahtar/chain yükleme & CSR | Tamamlandı | `certificate-material-manager.js`; `POST .../custom` | Site kapsamlı roller | X.509 / OpenSSL | `certificate-http.test.js`; Özel CRT/KEY yükleme ve CSR üretimi |
| TLS-04 | Panel, site ve mail servisine sertifika atama | Tamamlandı | `certificate-http.js`, `mail-service-identity-http.js` | Owner (panel/mail), Site yöneticisi (site) | Nginx / Postfix / Dovecot | `certificate-http.test.js`, `ssl-renewal.test.js`; Servis reload ve hata uzlaştırması |
| TLS-05 | HTTPS yönlendirme & HSTS | Tamamlandı | `domain-http.js`; `PATCH .../ssl-settings` | Site kapsamlı roller | TLS 1.2 / TLS 1.3 | `domain-http.test.js`; Güvenli şifre paketleri ve HSTS preload |
| TLS-06 | Gerçek sunulan TLS sertifikası kontrolü | Tamamlandı (SR-05 / BUG-06) | `certificate-http.js`; `POST .../verify-tls` | Site kapsamlı roller | Canlı Port 443 / TLS | `ssl-renewal.test.js`, `certificate-http.test.js`; Sunulan sertifika ile kayıt karşılaştırılır |
| TLS-07 | Ticari sertifika satın alma API'si | Kısmi / Manuel | `certificate-http.js`; `POST .../custom` | Owner | Harici CA | `certificate-http.test.js`; Özel CRT yükleme var; doğrudan satın alma sonraki faz |

### Grup 11 — E-posta [S15]
| ID | Özellik | Durum | Kaynak, API & Servis | Rol Ayrımı | OS & Provider | Doğrulama & Sınırlar |
| --- | --- | --- | --- | --- | --- | --- |
| EML-01 | Mailbox CRUD, parola ve kota | Tamamlandı | `mailbox-http.js`, `mailbox-quota-http.js` | Site kapsamlı roller | Postfix / Dovecot | `mailbox-http.test.js`, `mailbox-quota-http.test.js`; Dovecot kota ve şifreli parola |
| EML-02 | Alias, forwarding ve yerel kopya | Tamamlandı | `mail-alias-http.js`, `mailbox-forwarding-http.js` | Site kapsamlı roller | Postfix | `mail-alias-http.test.js`; Yerel ve harici e-posta yönlendirme kuralları |
| EML-03 | Otomatik yanıt / tatil mesajları | Kısmi | `mail-configuration.js`; `/api/.../autoresponder` | Site kapsamlı roller | Dovecot Sieve | `mail-configuration.test.js`; Sieve altyapısı var; doğrudan UI sonraki faz |
| EML-04 | Spam filtre, allow/deny list | Kısmi | `mail-configuration.js`; `/api/mail/spam-filter` | Owner ve Site yöneticisi | Rspamd | `mail-configuration.test.js`; Postscreen/Rspamd puanlama; detaylı UI sonraki faz |
| EML-05 | Mailing list (Mailman) | Ertelendi | N/A | Owner | Linux | Mailman ilk sürüm şartı değildir; sonraki fazdır |
| EML-06 | Domain mail aç/kapat, catch-all | Tamamlandı | `mail-configuration-http.js`; `PATCH .../status` | Site kapsamlı roller | Postfix | `mail-configuration-http.test.js`; Catch-all yönlendirme veya bounce |
| EML-07 | Webmail (Roundcube) & istemci ayarları | Tamamlandı (PROD-12) | `roundcube-configuration-http.js`, `mail-client.js` | Tüm kullanıcılar | Roundcube / Nginx | `roundcube-configuration-http.test.js`, `mail-client.test.js`; Tek tıkla kurulum; port bilgisi |
| EML-08 | SMTP/IMAP/POP3 port politikası | Tamamlandı (PROD-12) | `mail-delivery-diagnostics-service.js` | Owner ve Site yöneticisi | Postfix / Dovecot | `mail-delivery-diagnostics.test.js`; 25, 587, 465, 143, 993 dinleyicileri denetlenir |
| EML-09 | SPF/DKIM/DMARC ve relay güvenliği | Tamamlandı (PROD-12) | `mail-dkim-http.js`, `dns-requirements-service.js` | Site kapsamlı roller | BIND / PowerDNS / Cloudflare | `mail-delivery-diagnostics.test.js`, `mail-dkim-http.test.js`; 2048-bit DKIM anahtarları |
| EML-10 | Posta kuyruğu & teslimat tanılama | Tamamlandı (PROD-12) | `mail-diagnostics-http.js`; `POST .../test-delivery` | Owner (sunucu), Site yöneticisi (kutusu) | Postfix | `mail-delivery-diagnostics.test.js`, `mail-diagnostics-http.test.js`; Test teslimatı, secret masking |
| EML-11 | Mail servisi sertifikası & SNI | Tamamlandı | `mail-service-identity-http.js` | Owner | Dovecot / Postfix | `mail-service-identity-http.test.js`; Çoklu alan adı için Dovecot SNI TLS sertifikası |

### Grup 12 — Veritabanları [S16]
| ID | Özellik | Durum | Kaynak, API & Servis | Rol Ayrımı | OS & Provider | Doğrulama & Sınırlar |
| --- | --- | --- | --- | --- | --- | --- |
| DB-01 | MySQL/MariaDB CRUD, site bağı, boyut | Tamamlandı | `database-http.js`, `website-database-delete-http.js` | Site kapsamlı roller | MariaDB 10.x / MySQL 8.0 | `database-http.test.js`, `website-database-delete-http.test.js`; Boyut ölçümü ve site ilişkisi |
| DB-02 | DB kullanıcıları, roller ve grant | Tamamlandı | `database-credential-http.js`, `database-binding-http.js` | Site kapsamlı roller | MariaDB / MySQL | `database-credential-http.test.js`; Kullanıcı izinleri ve güvenli parola saklama |
| DB-03 | Uzak erişim & bağlantı bilgisi | Tamamlandı | `database-credential-http.js`; `PATCH .../access` | Site kapsamlı roller | MariaDB | `database-credential-http.test.js`; Localhost veya belirli harici IP izinleri |
| DB-04 | phpMyAdmin geçişi & yetki izolasyonu | Tamamlandı (YP-04 / RS-02e.8) | `phpmyadmin-handoff-http.js`; `POST .../handoff` | Site kapsamlı roller | phpMyAdmin / Nginx | `phpmyadmin-handoff-http.test.js`, `staging-e2e-verification.test.js`; Panel-bound token; cookie korunur |
| DB-05 | Dump import/export, kopyalama | Tamamlandı | `website-database-data-http.js`; `POST .../export` | Site kapsamlı roller | MariaDB / gzip | `website-database-data-http.test.js`; Sıkıştırılmış SQL dump dışa/içe aktarma |
| DB-06 | Veritabanı denetimi ve onarımı | Tamamlandı | `database-http.js`; `POST .../repair` | Site kapsamlı roller | InnoDB / MyISAM | `database-http.test.js`; Tablo optimizasyonu ve bütünlük kontrolü |
| DB-07 | Abonelikler arası DB taşıma | Ertelendi | N/A | Owner | Linux | Sonraki faz |
| DB-08 | PostgreSQL desteği | Kısmi / Ayrı Hat | N/A | Owner | PostgreSQL | MariaDB birincil hedeftir; PostgreSQL ayrı adaptör gerektirir |
| DB-09 | Uzak DB sunucusu kaydı | Kısmi | `server-registry.js`; `/api/servers/:id/databases` | Owner | Harici MySQL | `server-registry.test.js`; Yerel MariaDB tamdır; harici cluster sonraki faz |

### Grup 13 — Yedek ve Kurtarma [S17]
| ID | Özellik | Durum | Kaynak, API & Servis | Rol Ayrımı | OS & Provider | Doğrulama & Sınırlar |
| --- | --- | --- | --- | --- | --- | --- |
| BAK-01 | Sunucu ve site düzeyinde yedekleme | Tamamlandı (PROD-13) | `backup-http.js`, `website-backup-http.js` | Owner (tüm sunucu); Reseller/Customer (kendi siteleri) | Linux / Restic | `website-backup-http.test.js`, `website-backup-acceptance.test.js`; Paket seviyesi kendi fazında |
| BAK-02 | Kapsam seçimi (6 temel kurtarma alanı) | Tamamlandı (PROD-08 & PROD-13) | `backup-manifest.js`, `backup-resource-provider.js` | Site kapsamlı roller | Restic | `website-backup-acceptance.test.js`; 6 alan: site_files, database, mail, config, relationships, keys |
| BAK-03 | Tam ve artımlı yedekleme (Deduplication) | Tamamlandı | `@yunpanel/host-runtime/restic-manager` | Site kapsamlı roller | Restic | `website-backup-acceptance.test.js`; Blok seviyesinde tekilleştirme ve şifreleme |
| BAK-04 | Zamanlama, rotasyon ve saklama bütçesi | Tamamlandı (PROD-13) | `website-backup-operation-service.js`; `POST .../plan` | Site kapsamlı roller | Linux | `website-backup-http.test.js`; Günlük/haftalık rotasyon ve retention politikası |
| BAK-05 | Uzak depolar (S3, SFTP, Object Storage) | Tamamlandı (PROD-13) | `rclone-remote-registry.js`, `restic-repository-registry.js` | Owner tam yetkili; siteye secret sızdırılmaz | AWS S3 / Wasabi / B2 / SFTP | `website-backup-http.test.js`; Depo şifreleri ve anahtarlar recursive maskelenir |
| BAK-06 | Seçici geri yükleme & parola koruması | Tamamlandı (PROD-13) | `website-restore-http.js`; `POST .../restore/preview` | Site kapsamlı roller | Restic restore | `website-backup-acceptance.test.js`; Yalnız dosya veya DB seçici restore; pre-snapshot |
| BAK-07 | Çoklu takvim ve çoklu hedef | Kısmi | `website-backup-operation-service.js` | Owner | Restic | `website-backup-http.test.js`; Tek depoya çoklu plan tam; multi-cloud fan-out sonraki faz |
| BAK-08 | Gerçek kurtarma, RPO/RTO ölçümü | Tamamlandı (PROD-08) | `backup-plan.js`, `database-restore-job-result.js` | Owner | Linux / HTTP 200 health check | `website-backup-acceptance.test.js`; Boş hedefe restore, HTTP 200 doğrulaması, RPO/RTO |

### Grup 14 — Güvenlik ve Sunucu [S18, S19]
| ID | Özellik | Durum | Kaynak, API & Servis | Rol Ayrımı | OS & Provider | Doğrulama & Sınırlar |
| --- | --- | --- | --- | --- | --- | --- |
| SEC-01 | Firewall, portlar, güvenli geri dönüş | Tamamlandı (PROD-04) | `firewall-service.js`; `POST /api/firewall/preview` | Yalnız Owner; diğer roller 403 fail-closed | Linux nftables / systemd | `firewall.test.js`; SSH lockout koruması, 60s onay penceresi, otomatik rollback |
| SEC-02 | IP erişim kısıtları, brute-force & ban | Tamamlandı | `firewall-service.js`; `/api/firewall/bans` | Yalnız Owner | Linux | `firewall.test.js`; Başarısız login denemelerinde IP engelleme ve bouncer |
| SEC-03 | ModSecurity / WAF politikaları | Kısmi | `domain-http.js`; `/api/websites/:id/waf` | Owner | Nginx / ModSecurity | `domain-http.test.js`; Temel Nginx koruma kuralları; tam OWASP CRSv3 sonraki faz |
| SEC-04 | Oturum/MFA/parola politikası & API sınırı | Tamamlandı | `auth-store.js`; `/api/auth/*` | Tüm roller | Linux / SQLite | `auth-store.test.js`, `auth-password-reset.test.js`; Anti-enumeration, rate-limiting |
| SYS-01 | IP havuzu, IPv4/IPv6, shared/dedicated | Kısmi | `server-registry.js`; `/api/servers/:id/network` | Owner | Linux | `server-registry.test.js`; Sunucu IP'leri kullanılır; dinamik havuz tahsisi sonraki faz |
| SYS-02 | Sistem servisleri yönetimi (systemd) | Tamamlandı | `managed-service-http.js`; `POST .../services/:name/:action` | Yalnız Owner | systemd (Ubuntu Linux) | `managed-service-http.test.js`, `staging-e2e-verification.test.js`; Nginx/MariaDB/PHP/Postfix |
| SYS-03 | Hostname, saat dilimi ve ayarlar | Tamamlandı | `panel-settings-http.js`, `server-registry.js` | Yalnız Owner | Linux | `panel-settings-http.test.js`; Panel genel yapılandırması ve sunucu kimliği |
| SYS-04 | Sistem/PHP/panel güncellemeleri | Tamamlandı | `managed-service-http.js`; `/api/system/packages` | Yalnız Owner | Ubuntu apt | `managed-service-http.test.js`; Paket güncelleme denetimi |
| SYS-05 | Yönetici terminali, watchdog & onarım | Tamamlandı | `system-watchdog-service.js`, `ttyd-session-http.js` | Yalnız Owner; Reseller/Customer erişemez | Linux PAM / systemd | `staging-e2e-verification.test.js`, `system-watchdog-service.test.js`; Root terminali, flap koruması |
| SYS-06 | Cron/scheduled tasks; zamanlama | Tamamlandı | `website-cron-http.js`, `website-cron-apply-service.js` | Site kapsamlı roller | Linux cron | `website-cron-http.test.js`, `local-website-cron-operation.test.js`; Site crontab'ı, durable queue |

### Grup 15 — İzleme, Log ve İstatistik [S20]
| ID | Özellik | Durum | Kaynak, API & Servis | Rol Ayrımı | OS & Provider | Doğrulama & Sınırlar |
| --- | --- | --- | --- | --- | --- | --- |
| MON-01 | CPU/RAM/disk/ağ ölçümleri | Tamamlandı (YP-16) | `DashboardPage.jsx`, `console-model.js` | Owner ve yetkili kullanıcılar | Linux procfs / sysfs | `overview-real-metrics.test.js`; Gerçek envanter ölçümleri, %85-%91 kademeli uyarı |
| MON-02 | Eşik/bildirim tercihleri & teslimat | Tamamlandı | `operational-notification-service.js` | Owner | Linux / SMTP | `operational-notification-http.test.js`; Disk doluluğu ve kritik servis çökme uyarıları |
| MON-03 | Web istatistikleri (GoAccess) | Tamamlandı (AN-01–03) | `website-analytics-http.js`, `SiteAnalyticsPage.jsx` | Site kapsamlı roller | GoAccess CLI | `website-analytics-acceptance.test.js`; Statik HTML raporu; Owner realtime websocket |
| MON-04 | Web/mail/sistem log görüntüleme | Tamamlandı (YP-15) | `log-http.js`, `LogsPanel.jsx` | Owner (sistem), Site yöneticisi (site) | systemd journald | `menu-redundancy-log-placement.test.js`; Canlı log akışı ve anahtar kelime filtreleme |
| MON-05 | Servis watchdog/otomatik kurtarma | Tamamlandı | `system-watchdog-service.js`, `local-api-health.js` | Yalnız Owner | systemd / Linux | `staging-e2e-verification.test.js`; Otomatik servis arıza tespiti, otomatik ayağa kaldırma |
| MON-06 | Harici uptime izleme servisi | Ertelendi | N/A | Owner | Harici SaaS | Harici SaaS izleme sonraki fazdır; MVP engeli değildir |

### Grup 16 — WordPress Araçları [S21]
| ID | Özellik | Durum | Kaynak, API & Servis | Rol Ayrımı | OS & Provider | Doğrulama & Sınırlar |
| --- | --- | --- | --- | --- | --- | --- |
| WP-01 | WordPress kurma, tarama, admin girişi | Tamamlandı | `website-php-tools-service.js`; `/api/.../wordpress` | Site kapsamlı roller | WP-CLI / PHP | `website-php-tools-service.test.js`; WordPress çekirdek kurulum tespiti ve sürüm takibi |
| WP-02 | Core/plugin/theme güncelleme | Tamamlandı (PHP-ACTION-01/02) | `website-php-tool-action.js`; `POST .../execute` | Site kapsamlı roller | WP-CLI / PHP | `website-php-tool-action.test.js`; Sabit eylem kataloğu; 0600 receipt ve crash recovery |
| WP-03 | Toplu yönetim ve setler | Kısmi / Ertelendi | N/A | Owner | Linux | Tekil site araçları tam; birden fazla sitenin toplu güncellemesi sonraki faz |
| WP-04 | Klonlama, staging ve veri senkronizasyonu | Kısmi | `website-restore-service.js` | Site kapsamlı roller | Linux | `website-backup-acceptance.test.js`; Yedekten geri yükleme ile yapılabilir; tek tık sonraki faz |
| WP-05 | Yedek/restore, bakım modu | Tamamlandı | `website-backup-operation-service.js` | Site kapsamlı roller | Linux | `website-backup-acceptance.test.js`; Restic site snapshot'ı ve WP maintenance mode |
| WP-06 | Güvenlik denetimi ve sıkılaştırma | Tamamlandı | `website-php-tools-service.js` | Site kapsamlı roller | Linux | `website-php-tools-service.test.js`; Dosya izinleri ve wp-config.php koruması doğrulaması |
| WP-07 | Otomatik/smart update ve test | Ertelendi | N/A | Owner | Harici AI/SaaS | Plesk Smart Updates tescilli SaaS'tır; açık alternatif sonraki faz |

### Grup 17 — Uygulama ve Eklenti Ekosistemi [S05, S22]
| ID | Özellik | Durum | Kaynak, API & Servis | Rol Ayrımı | OS & Provider | Doğrulama & Sınırlar |
| --- | --- | --- | --- | --- | --- | --- |
| EKL-01 | Uygulama kataloğu (Node, PHP, Static, Python, Docker) | Tamamlandı | `application-registry.js`, `application-operations-http.js` | Site kapsamlı roller | Linux / Systemd / Passenger | `application-operations.test.js`; Hazır çalışma ortamları ve kurulum şablonları |
| EKL-02 | Eklenti yönetimi ve bağımlılıklar | Kısmi | `managed-service-http.js`; `/api/system/packages` | Yalnız Owner | Linux | `managed-service-http.test.js`; Sistem paketleri seviyesinde yönetim |
| EKL-03 | Sitejet/site-builder eşdeğeri | Ertelendi | N/A | Owner | Harici Vendor | Ticari vendor anlaşması gerektirir; sonraki faz |
| EKL-04 | Güvenlik/antivirüs premium entegrasyonlar | Kısmi | `firewall-service.js`; `/api/firewall/*` | Owner | Linux | `firewall.test.js`; CrowdSec ve nftables tamdır; ClamAV/Imunify sonraki faz |
| EKL-05 | Cloud backup, DNS/CDN connector'ları | Tamamlandı | `rclone-manager`, `cloudflare-dns-manager` | Owner | Multi-cloud (S3/Wasabi/B2/Drive) | `website-backup-http.test.js`, `dns-requirements-service.test.js`; Bulut ve CDN connector'ları |
| EKL-06 | Eklenti lisans/sağlık envanteri | Kısmi | `ai-tool-catalog.js`, `server-registry.js` | Owner | Linux | `staging-e2e-verification.test.js`; AI araç kataloğu ve servis envanteri |
| EKL-07 | Marketplace tüm ürünleri araştırması | **AÇIK TUTULDU** | `docs/plesk-feature-parity.md` | Tüm | Tümü | Dokümantasyon; Marketplace ekosistem araştırması açık tutulur; liste dışı ürün kapsam dışı sayılmaz |

### Grup 18 — API, Otomasyon ve Ticari Entegrasyon [S23, S24]
| ID | Özellik | Durum | Kaynak, API & Servis | Rol Ayrımı | OS & Provider | Doğrulama & Sınırlar |
| --- | --- | --- | --- | --- | --- | --- |
| API-01 | REST API ve yetkili API anahtarı | Tamamlandı | `app.js`, `panel-access.js`; `/api/*` | Tüm roller (RBAC korumalı) | REST / JSON | `auth-http.test.js`, `staging-e2e-verification.test.js`; Bearer/Cookie kimlik doğrulama |
| API-02 | XML API uyumluluğu | Kapsam Dışı | N/A | N/A | JSON REST | Eski XML-RPC protokolü yerine standart JSON REST API |
| API-03 | CLI ve otomatik provisioning | Tamamlandı | `website-provisioning-orchestrator.js`, CLI | Yalnız Owner | Linux Shell | `staging-e2e-verification.test.js`; agy CLI ve dayanıklı arka plan iş yürütücüsü |
| API-04 | Tek kullanımlık oturum/SSO & audit | Tamamlandı | `phpmyadmin-handoff-service.js`, `audit-store.js` | Tüm yetkili roller | Kriptografik token | `phpmyadmin-handoff-http.test.js`, `staging-e2e-verification.test.js`; phpMyAdmin SSO; audit zorunlu |
| API-05 | WHMCS/ödeme/faturalama bağlantısı | Ertelendi | N/A | Owner | Harici Ticari | Harici fatura/ödeme otomasyonu panelden ayrıdır; MVP engeli değil |
| API-06 | Paket/abonelik ticari senkronizasyonu | Ertelendi | N/A | Owner | Harici Ticari | Sonraki faz |
| API-07 | Domain/sertifika registrar bayiliği | Ertelendi | N/A | Owner | Harici Registrar | Ticari registrar bayilik API'leri sonraki fazdır; MVP engeli değil |

### Grup 19 — Taşıma ve Yaşam Döngüsü [S25]
| ID | Özellik | Durum | Kaynak, API & Servis | Rol Ayrımı | OS & Provider | Doğrulama & Sınırlar |
| --- | --- | --- | --- | --- | --- | --- |
| MIG-01 | Plesk'ten kaynakları içe aktarma | Tamamlandı | `plesk-importer.js`; `POST .../plesk/import` | Yalnız Owner | Plesk XML/ZIP | `plesk-importer-http.test.js`; Plesk yedeğinden site, DB, mail içe aktarma |
| MIG-02 | cPanel/DirectAdmin taşıma | Kısmi | `plesk-importer.js` | Owner | cPanel / DirectAdmin | `plesk-importer-http.test.js`; Plesk formatı önceliklidir; cPanel sonraki faz |
| MIG-03 | Site/mail/DB/DNS/SSL veri eşleme | Tamamlandı | `website-migration-create.js`, `website-migration-bind.js` | Owner | Linux | `website-migration-http.test.js`; Veri doğrulama ve kullanıcı-site bağlama |
| MIG-04 | Ön kontrol, senkronizasyon & rollback | Tamamlandı | `website-migration-preview.js`, `website-migration-ledger.js` | Owner | SQLite / Ledger | `website-migration-http.test.js`; Güvenli rollback ve atomik işlem günlüğü |
| MIG-05 | Import kısıtları ve veri kaybı uyarısı | Tamamlandı | `website-migration-preview.js` | Owner | JSON etki raporu | `website-migration-http.test.js`; Eksik bileşenlerde açık kullanıcı uyarısı |
| MIG-06 | Panel güncellemesi, OS migration, rollback | Tamamlandı | `hosting-account-schema.js`, `production-exit-gate.js` | Owner | Ubuntu Linux | `staging-e2e-verification.test.js`; Sürümlü şema ve deterministik geri alma |

### Grup 20 — Arayüz, Marka ve Hesap Deneyimi [S01, S26]
| ID | Özellik | Durum | Kaynak, API & Servis | Rol Ayrımı | OS & Provider | Doğrulama & Sınırlar |
| --- | --- | --- | --- | --- | --- | --- |
| UX-01 | Plesk görev yerleşimi ve rollerin menüsü | Tamamlandı (YP-15) | `WorkspaceApp.jsx`, `ux-model.js` | Owner, Reseller, Customer, Site Manager | Web Tarayıcı | `menu-redundancy-log-placement.test.js`, `navigation.test.js`; Menü mükerrerlikleri giderildi |
| UX-02 | Global Files + domain File Manager | Tamamlandı | `FilesPage.jsx`, `SiteDetailPage.jsx` | Tüm yetkili roller | Web Tarayıcı | `menu-redundancy-log-placement.test.js`; Hem global hem site içi giriş korunur |
| UX-03 | Abonelik / All Subscriptions seçimi | Sadeleştirildi | `WebsitesPage.jsx` | Reseller ve Customer | Web Tarayıcı | `navigation.test.js`; Karmaşık seçici yerine sade 'Sitelerim' listesi |
| UX-04 | Dil, tema, marka (Ember dili) | Tamamlandı (YP-16) | `ember-theme.css`, `console-theme.css` | Tüm kullanıcılar | Modern Tarayıcılar | `overview-real-metrics.test.js`; Grafit/mandalina/kırık beyaz, koyu tema, yüksek kontrast |
| UX-05 | Arama, filtre, sıralama, sayfalama | Tamamlandı | `WebsitesPage.jsx`, `OperationsPages.jsx` | Tüm yetkili roller | Web Tarayıcı | `menu-redundancy-log-placement.test.js`; URL parametreleriyle filtrelenebilir listeler |
| UX-06 | İş ilerlemesi, yeniden deneme & durum | Tamamlandı | `JobDrawer.jsx`, `OperationsPages.jsx` | Tüm yetkili roller | Web Tarayıcı | `menu-redundancy-log-placement.test.js`; İdempotent uzlaştırma; 0 deneme korunur |

### Grup 21 — Windows'a Özgü Eşdeğerlik Hattı [S16, S27]
| ID | Özellik | Durum | Kaynak, API & Servis | Rol Ayrımı | OS & Provider | Doğrulama & Sınırlar |
| --- | --- | --- | --- | --- | --- | --- |
| WIN-01 | Windows Server kurulumu & servisler | Ayrı Hat | Windows Service Controller | Owner | Windows Server 2022/2025 | Ubuntu koduyla tamamlandı denilemez; ayrı Windows backend/test hattıdır |
| WIN-02 | IIS site, app pool, virtual directory | Ayrı Hat | Microsoft.Web.Administration (IIS) | Owner ve Site Yöneticisi | Windows Server / IIS 10 | Linux Nginx kodu Windows IIS eşdeğeri sayılmaz |
| WIN-03 | ASP.NET / .NET Toolkit | Ayrı Hat | .NET CLR / Kestrel | Site kapsamlı roller | Windows / .NET | Ayrı Windows çalışma ortamı gerektirir |
| WIN-04 | Microsoft SQL Server & ODBC | Ayrı Hat | MSSQL Server / sqlcmd | Site kapsamlı roller | Windows / MSSQL | MariaDB/MySQL eşdeğeri değildir; ayrı MSSQL adaptörü gerekir |
| WIN-05 | Windows kullanıcı ve NTFS izinleri | Ayrı Hat | Windows ACLs / icacls | Tüm roller | Windows NTFS | Linux Unix UID/GID izolasyonu Windows ACL'lerini karşılamaz |
| WIN-06 | Microsoft DNS ve Windows mail | Ayrı Hat | MS DNS / MailEnable / SmarterMail | Tüm roller | Windows Server | PowerDNS/Postfix/Dovecot Windows bileşenlerini tamamlamaz |

---

## 5. Doğrulama ve Kanıt Kaydı

- **Staging Uçtan Uca Doğrulama:** `apps/api/test/staging-e2e-verification.test.js` testi; hiyerarşik tenant izolasyonunu (`Owner → Reseller → Customer → Website`), kota ve kapasite sınırlarını, fail-closed güvenlik bariyerlerini, veri göçü/rollback mekanizmalarını ve sistem watchdog arıza kurtarmalarını eksiksiz olarak doğrular.
- **Monorepo Test Profili:** `npm test` ve `npm run build` profilleri tüm backend ve frontend paketlerinde deterministik olarak çalıştırılır.
- **Canlı Ortam Ayrımı:** Test ve kaynak başarıları canlı host kabulü sayılmaz; staging sunucu kanıtları bağımsız olarak doğrulanır.
