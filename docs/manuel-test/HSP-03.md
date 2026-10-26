# HSP-03 — İletişim, şirket, açıklama ve hesap erişim bilgileri

- **Grup:** 02 — Müşteri ve bayi yaşam döngüsü
- **Parity kaynağı:** `docs/plesk-feature-parity.md` § `HSP-03` (`Kısmi / kabul açık`)
- **Test tarihi:** 2026-10-27
- **Test eden:** AGENT_5
- **Sonuç:** KISMİ

## Özeti

`HSP-03` kapsamında müşteri ve bayi hesaplarının **hesap erişim bilgileri** (`username` — e-posta biçimli adresler dahil — ve `password`) oluşturma aşamasında (`/resellers`, `/customers`, `/settings/users`), bayinin kendi müşterisi için `Girişi düzenle` modalında (`PATCH /api/panel/users/hosting/accounts/:id/login`) ve tüm rollerin self-servis `Hesabım` (`AccountDialog`) ekranında çalışmaktadır; erişim bilgisi güncellendiğinde hedef hesabın açık oturumları anında düşürülmekte (`401 Unauthorized`) ve `.28` üzerindeki SQLite veritabanına (`users`, `auth_hosting_accounts`, `auth_user_revisions`) yansımaktadır. Buna karşın Plesk `HSP-03` eşdeğerliğinin diğer yarısını oluşturan **iletişim adı (`contactName`), ayrı iletişim e-postası (`email`), şirket (`company`), telefon (`phone`), adres/şehir/ülke ve yönetici açıklaması (`description`/`notes`) alanları** ne veritabanı şemasında ne API doğrulayıcılarında ne de kullanıcı arayüzünde mevcuttur; ayrıca Owner rolü `/customers` ve `/resellers` ekranlarındaki `Hesabı yönet` modalından veya `/settings/users` → `Düzenle` modalından mevcut bir müşteri/bayi hesabının parolasını sıfırlayamamakta ve `Kurtarma E-postası` özelliği yalnız Owner rolüne açık olup Bayi ve Müşteri rollerine `403 forbidden` dönmektedir.

## Ön koşul

- Test ortamı: `.local/test-server.env` ve `.local/yunpanel-owner-password-only.json` ile doğrulanan `.28` (`https://192.168.1.28:8443`) canlı YunPanel sunucusu.
- Sunucu erişim kilidi: `sunucu-28-2` / `sunucu-28-4` (`AGENT_5` tarafından alındı ve test/temizlik sonunda serbest bırakıldı).
- Test önek kuralı: Tüm geçici hesaplar `thsp03-a5-` önekiyle (`thsp03-a5-res@webrich.news`, `thsp03-a5-cust1@webrich.news`, `thsp03-a5-cust2` → `thsp03-a5-cust2.yeni@webrich.news`, `thsp03-a5-direct` → `thsp03-a5-direct@webrich.news`) oluşturuldu; parolalar ve kimlik bilgileri yalnızca gitignore kapsamındaki `.local/manuel-test/HSP-03/accounts.json` dosyasında tutuldu.

## Senaryolar

### Senaryo 1: Hesap oluşturma modallarında iletişim/şirket/açıklama alanlarının kontrolü ve e-posta biçimli erişim bilgileriyle bayi + müşteri açma (Happy path)

- **Adımlar:**
  1. Owner olarak panele giriş yap; `/resellers` (`Bayiler`) ekranında `Bayi ekle`, `/customers` (`Müşteriler`) ekranında `Müşteri ekle` ve `/settings/users` (`Kullanıcılar`) ekranında `Kullanıcı ekle` modallarını sırayla açarak form etiketlerini ve girdi alanlarını incele.
  2. `/resellers` ekranında `Bayi ekle` modalından e-posta biçimli kullanıcı adıyla (`thsp03-a5-res@webrich.news`, müşteri sınırı `5`, site sınırı `10`) yeni bir bayi hesabı oluştur (`POST /api/panel/users/hosting/accounts/create-login`).
  3. `/customers` ekranında `Müşteri ekle` modalından e-posta biçimli kullanıcı adıyla (`thsp03-a5-cust1@webrich.news`, bağlı bayi: `thsp03-a5-res@webrich.news`) bayiye bağlı müşteri ve `thsp03-a5-direct` (doğrudan yönetim) müşteri hesaplarını oluştur.
  4. `.28` üzerinde `/var/lib/yunpanel/control-plane/auth/auth.sqlite` veritabanında `PRAGMA table_info(users)`, `PRAGMA table_info(auth_hosting_accounts)`, `PRAGMA table_info(auth_recovery_emails)` şema sütunlarını ve oluşturulan kayıtları sorgula.
- **Beklenen:**
  - Müşteri ve bayi oluşturma formlarında hesap erişim bilgilerinin (`Kullanıcı adı`, `Parola`) yanı sıra iletişim adı, e-posta, şirket, telefon, adres ve açıklama alanları bulunmalı; e-posta biçimli kullanıcı adları kabul edilerek `users` ve `auth_hosting_accounts` tablolarına kaydedilmelidir.
- **Gözlenen:**
  - E-posta biçimli kullanıcı adlarıyla (`thsp03-a5-res@webrich.news` — `id: 16a7d71d-a8d1-46bb-9d4d-976fd6580536`, `thsp03-a5-cust1@webrich.news` — `id: cb0c4ba5-5b7d-4244-a25f-f6b80f70a388`) ve standart kullanıcı adıyla (`thsp03-a5-direct` — `id: ab98b8a4-247b-48fa-a4e7-cbcdd4cbed35`) bayi ve müşteri hesapları başarıyla oluşturuldu; fiziksel SQLite sorgusunda `users.role = 'site_manager'`, `users.active = 1`, `auth_hosting_accounts.revision = 1` ve `auth_user_revisions.revision = 2` olarak doğrulandı.
  - Buna karşın üç oluşturma modalının hiçbirinde iletişim adı, ayrı iletişim e-postası, şirket, telefon, adres veya açıklama alanı **bulunmamaktadır**:
    - `Bayi ekle` etiketleri: `["Kullanıcı adı", "İlk parola", "En fazla müşteri", "En fazla web sitesi"]`
    - `Müşteri ekle` etiketleri: `["Kullanıcı adı", "İlk parola", "Bağlı bayi"]`
    - `Kullanıcı ekle` etiketleri: `["Kullanıcı adı", "İlk parola", "Rol", "Hesap durumu"]`
  - Fiziksel DB şemasında da `users` (`id, username, password_hash, role, active, created_at, password_changed_at`) ve `auth_hosting_accounts` (`user_id, kind, reseller_id, revision, created_at, updated_at`) tablolarında iletişim, şirket veya açıklama sütunu yoktur. Yalnızca `apps/web/src/workspace/ssl-request-draft.js` içinde kullanıcı adı `@` içeriyorsa (`emailLike(user?.username)`) SSL iletişim e-postası taslağı olarak değerlendirilmektedir.
- **Sonuç:** KISMİ
- **Kanıt:** `.local/manuel-test/HSP-03/01a-owner-create-reseller-modal-fields.png`, `.local/manuel-test/HSP-03/01b-owner-create-customer-modal-fields.png`, `.local/manuel-test/HSP-03/01c-settings-users-create-modal-fields.png`, `.local/manuel-test/HSP-03/results.json` (`scenario1`)

### Senaryo 2: Bayinin kendi müşterisinin hesap erişim bilgilerini (`Girişi düzenle`) güncellemesi, e-posta/kullanıcı adı normalizasyonu ve aktif oturum düşürme (Happy path)

- **Adımlar:**
  1. Bayi (`thsp03-a5-res@webrich.news`) olarak panele giriş yap; `/customers` (`Müşterilerim`) ekranında `Müşteri ekle` ile `thsp03-a5-cust2` müşterisini oluştur (`POST /api/panel/users/hosting/self/customers`).
  2. Ayrı bir tarayıcı bağlamında müşteri (`thsp03-a5-cust2`) olarak giriş yap ve `GET /api/auth/session` yanıtının `200 OK` olduğunu doğrula.
  3. Bayi ekranında `thsp03-a5-cust2` satırındaki `Girişi düzenle` butonuna tıkla; hiçbir değişiklik yapılmamışken `Girişi kaydet` butonunun `disabled` olduğunu kontrol et.
  4. Kullanıcı adını `thsp03-a5-cust2@webrich.news` olarak ve yeni parolayı (`>= 12` karakter) girerek `Girişi kaydet` butonuna tıkla (`PATCH /api/panel/users/hosting/accounts/:id/login`).
  5. Açık olan müşteri oturumunda `GET /api/auth/session` çağrısının `401 Unauthorized` döndüğünü ve müşterinin yeni kullanıcı adı + yeni parolayla giriş yapabildiğini doğrula.
  6. Bayi ekranında `Girişi düzenle` modalını tekrar açıp başında/sonunda boşluk ve büyük harf içeren `  THSP03-A5-CUST2.YENI@WEBRICH.NEWS  ` değerini kaydet; küçük harfe normalize edildiğini ve `.28` SQLite veritabanına yazıldığını doğrula.
- **Beklenen:**
  - Bayi kendi müşterisinin kullanıcı adını ve parolasını güncelleyebilmeli, girdi trim + küçük harfe normalize edilmeli, `users.password_changed_at`, `auth_hosting_accounts.revision` ve `auth_user_revisions.revision` artmalı ve müşterinin açık oturumları anında kapatılmalıdır.
- **Gözlenen:**
  - `Girişi düzenle` modalında `"Kullanıcı adı"` ve `"Yeni parola (değişmeyecekse boş bırakın)"` alanları açıldı; değişiklik yokken `Girişi kaydet` butonu `disabled=true` olarak korundu.
  - Güncelleme sonrası `"thsp03-a5-cust2@webrich.news giriş bilgileri güncellendi; mevcut oturumları kapatıldı."` bildirimi gösterildi.
  - Müşterinin açık oturumunda `GET /api/auth/session` anında `401` döndü; yeni kimlik bilgileriyle yapılan giriş `200 OK` döndü (`hosting: { kind: "customer", resellerId: "16a7d71d-a8d1-46bb-9d4d-976fd6580536" }`).
  - İkinci düzenlemede `  THSP03-A5-CUST2.YENI@WEBRICH.NEWS  ` değeri `thsp03-a5-cust2.yeni@webrich.news` olarak normalize edildi; `.28` SQLite sorgusunda `id: "5570b49e-373b-420d-9bb7-260fafbda109"`, `username: "thsp03-a5-cust2.yeni@webrich.news"`, `password_changed_at: 1793055304242`, `auth_hosting_accounts.revision: 3`, `auth_user_revisions.revision: 4` olarak doğrulandı.
- **Sonuç:** GEÇTİ
- **Kanıt:** `.local/manuel-test/HSP-03/02a-reseller-create-customer-modal.png`, `.local/manuel-test/HSP-03/02b-reseller-edit-customer-login-modal.png`, `.local/manuel-test/HSP-03/02c-reseller-customer-login-updated.png`, `.local/manuel-test/HSP-03/02d-reseller-customer-username-normalized.png`, `.local/manuel-test/HSP-03/results.json` (`scenario2`)

### Senaryo 3: Owner'ın `/customers`, `/resellers` ve `/settings/users` ekranlarından hesap erişim ve profil bilgilerini düzenleme sınırı (Eksik / kısmi akış)

- **Adımlar:**
  1. Owner oturumunda `/customers` sayfasına git, `thsp03-a5-cust1@webrich.news` satırındaki `Hesabı yönet` butonuna tıkla ve modal içeriğini incele.
  2. Owner oturumunda `/resellers` sayfasına git, `thsp03-a5-res@webrich.news` satırındaki `Hesabı yönet` butonuna tıkla ve modal içeriğini incele.
  3. Owner oturumunda `/settings/users` sayfasına git, `thsp03-a5-direct` satırındaki `Düzenle` butonuna tıkla; parola sıfırlama ve iletişim/şirket/açıklama alanlarının varlığını kontrol et, ardından kullanıcı adını `thsp03-a5-direct@webrich.news` olarak güncelle.
  4. Owner oturumundan bayi hesabı için `PATCH /api/panel/users/hosting/accounts/:resellerId/login` uç noktasını çağır.
- **Beklenen:**
  - Owner hem `/customers` ve `/resellers` ekranlarından hem de `/settings/users` ekranından müşteri ve bayi hesaplarının erişim bilgilerini (kullanıcı adı ve parola) ve iletişim/şirket/açıklama bilgilerini düzenleyebilmeli; bağlı bayi bilgisi UUID yerine bayi kullanıcı adıyla gösterilmelidir.
- **Gözlenen:**
  - Owner'ın `/customers` sayfasındaki `Hesabı yönet` modalında (`HostingProfileDialog`) **hiçbir girdi alanı (`ownerCustomerModalInputs: 0`) yoktur**; ne kullanıcı adı/parola düzenleme (`Girişi düzenle`) ne de iletişim/şirket/açıklama alanı bulunur. Ayrıca bağlı bayi bilgisi kullanıcı adı yerine ham UUID (`Bağlı bayi: 16a7d71d-a8d1-46bb-9d4d-976fd6580536`) olarak gösterilmektedir.
  - Owner'ın `/resellers` sayfasındaki `Hesabı yönet` modalında yalnızca `Toplam müşteri` ve `Toplam site` adet sınırları vardır; bayi erişim bilgisi veya iletişim/şirket/açıklama alanı yoktur. Ayrıca `PATCH /api/panel/users/hosting/accounts/:resellerId/login` çağrısı Owner için bile `403 reseller_scope_forbidden` (`hosting-account-store.js:405` `row.kind !== 'customer'`) döndürmektedir.
  - `/settings/users` → `Düzenle` modalında (`UserDialog`, `UsersPage.jsx:144`) `{!user && (<label>İlk parola...</label>)}` koşulu nedeniyle **düzenleme modunda parola alanı gizlenmiştir** (`hasPasswordInputOnEdit: false`). Arka uç `PATCH /api/panel/users/:id` `password` ve `email` alanlarını desteklediği halde Owner arayüzden hiçbir kullanıcının (ne bayi ne müşteri ne de standart kullanıcı) parolasını değiştirememektedir. Yalnızca `Kullanıcı adı` alanı `thsp03-a5-direct@webrich.news` olarak güncellenebildi (`user-admin-store.js:230-232`).
- **Sonuç:** KISMİ
- **Kanıt:** `.local/manuel-test/HSP-03/03a-owner-customer-profile-modal-no-login-or-contact-fields.png`, `.local/manuel-test/HSP-03/03b-owner-reseller-profile-modal-only-limits.png`, `.local/manuel-test/HSP-03/03c-settings-users-edit-modal-no-password-or-contact.png`, `.local/manuel-test/HSP-03/03d-settings-users-username-updated.png`, `.local/manuel-test/HSP-03/results.json` (`scenario3`)

### Senaryo 4: Self-servis `Hesabım` (`AccountDialog`) üzerinden parola değiştirme, aktif oturum yönetimi ve kurtarma e-postası rol sınırı (Happy path + Rol sınırı)

- **Adımlar:**
  1. Müşteri (`thsp03-a5-cust1@webrich.news`) olarak giriş yap, üst bardaki `Hesabım` butonuna tıkla; modal başlıklarını (`Parolayı değiştir`, `İki adımlı doğrulama`, `Aktif oturumlar`) ve `Kurtarma E-postası` bölümünün varlığını kontrol et.
  2. Müşteri `Hesabım` modalında önce birbiriyle eşleşmeyen yeni parolalar, ardından yanlış mevcut parola girerek doğrulama hatalarını gözlemle; sonrasında geçerli mevcut parola ve yeni parolayla `Parolayı değiştir` butonuna tıkla (`POST /api/auth/password`).
  3. Müşteri oturumunun otomatik kapatılıp giriş ekranına (`"Parolanız değiştirildi. Yeni parolanızla giriş yapın."`) yönlendirildiğini ve yeni parolayla tekrar giriş yapılabildiğini doğrula.
  4. Müşteri ve Bayi oturumlarından `GET /api/auth/recovery-email` ve `POST /api/auth/recovery-email` uç noktalarını çağır.
  5. Owner oturumunda `Hesabım` modalını aç, `Kurtarma E-postası` alanına `thsp03-a5-owner@webrich.news` yazıp `Kurtarma E-postasını Kaydet` butonuna tıkla; `.28` SQLite `auth_recovery_emails` tablosundan kaydı doğrula ve ardından Owner'ın önceki kurtarma e-postasını geri yükle.
- **Beklenen:**
  - Tüm roller kendi parolasını değiştirebilmeli ve aktif oturumlarını yönetebilmeli; ayrıca müşteri ve bayi hesapları da kendi iletişim/kurtarma e-postasını görüntüleyip güncelleyebilmelidir.
- **Gözlenen:**
  - Müşteri `Hesabım` modalında eşleşmeyen yeni parola `"Yeni parolalar eşleşmiyor."`, yanlış mevcut parola `"Kullanıcı adı, parola veya kurulum anahtarı geçersiz."` hatasıyla reddedildi; doğru mevcut parolayla yapılan güncelleme sonrası oturum kapatıldı ve yeni parolayla giriş başarılı oldu.
  - Owner `Hesabım` modalında `Kurtarma E-postası` bölümü görüntülendi; `thsp03-a5-owner@webrich.news` kaydedildiğinde `"Kurtarma e-postası başarıyla güncellendi."` mesajı alındı ve `.28` SQLite `auth_recovery_emails` tablosunda `user_id: "d36910d7-58c1-495a-be83-c673f9d829c4"`, `email: "thsp03-a5-owner@webrich.news"`, `verified: 1` olarak doğrulandı (test sonunda orijinal değere geri alındı).
  - Ancak Müşteri ve Bayi `Hesabım` modallarında `Kurtarma E-postası` bölümü **gösterilmemektedir** (`AccountDialog.jsx:170` `{isOwner && ...}` kısıtı) ve `/api/auth/recovery-email` uç noktası Müşteri ve Bayi için `GET` ve `POST` çağrılarında `403 forbidden` (`ownerPolicy.requireManagement(session)`) döndürmektedir.
- **Sonuç:** KISMİ
- **Kanıt:** `.local/manuel-test/HSP-03/04a-customer-account-dialog-no-recovery-email.png`, `.local/manuel-test/HSP-03/04b-customer-account-dialog-password-mismatch.png`, `.local/manuel-test/HSP-03/04c-customer-self-password-changed-signed-out.png`, `.local/manuel-test/HSP-03/04d-reseller-account-dialog-no-recovery-email.png`, `.local/manuel-test/HSP-03/04e-owner-account-dialog-recovery-email-saved.png`, `.local/manuel-test/HSP-03/results.json` (`scenario4`)

### Senaryo 5: Hatalı girdi, sınır değerler ve iletişim/şirket/açıklama alanlarının API tarafından reddedilmesi (Hatalı girdi + Sınır değer)

- **Adımlar:**
  1. Bayi ekranında (`/customers` → `Girişi düzenle`) `thsp03-a5-cust2.yeni@webrich.news` müşterisinin kullanıcı adını mevcut başka bir müşterinin kullanıcı adıyla (`thsp03-a5-cust1@webrich.news`) değiştirmeyi dene (`409 username_taken`).
  2. Aynı modalda boşluk içeren geçersiz kullanıcı adı (`a b`) girerek doğrulama hatasını (`invalid_username`) gözlemle.
  3. API üzerinden 12 karakterden kısa parola (`Short123!`), değişiklik içermeyen boş güncelleme (`{ revision }`) ve Owner için geçersiz kurtarma e-postası (`not-an-email`) gönder.
  4. `/api/panel/users/hosting/self/customers`, `/api/panel/users/hosting/accounts/:id/login` ve `/api/panel/users/:id` uç noktalarına `contactName`, `company`, `phone`, `description`, `address` alanlarını içeren JSON gövdeleri gönder.
- **Beklenen:**
  - Mükerrer kullanıcı adı `409 username_taken`, geçersiz kullanıcı adı `400 invalid_username`, kısa parola `400 invalid_password`, boş güncelleme `400 empty_hosting_customer_update` ve geçersiz e-posta `400 invalid_email` ile reddedilmeli; iletişim/şirket/açıklama alanlarının API davranışı kanıtlanmalıdır.
- **Gözlenen:**
  - Mükerrer kullanıcı adı UI'da `"Bu kullanıcı adı zaten kullanımda. Başka bir kullanıcı adı seçin."` (`409 username_taken`) uyarısıyla engellendi.
  - Geçersiz kullanıcı adı (`a b`) UI'da `"Kullanıcı adı 3–128 karakter olmalı; harf, rakam ve . _ @ + - kullanılabilir."` uyarısıyla engellendi.
  - Kısa parola `400 invalid_password` (`"Use at least 12 characters and no more than 1024 bytes."`), boş güncelleme `400 empty_hosting_customer_update` (`"Choose a customer login field to change."`) ve geçersiz kurtarma e-postası `400 invalid_email` (`"Geçerli bir e-posta adresi girin."`) döndürdü.
  - İletişim, şirket, telefon ve açıklama (`contactName`, `company`, `phone`, `description`) alanları hem `/api/panel/users/hosting/self/customers` hem `/api/panel/users/hosting/accounts/:id/login` uç noktalarında `400 invalid_hosting_account_input` (`"Send only the documented hosting account fields."`), `/api/panel/users/:id` uç noktasında ise `400 invalid_user_input` (`"Send only the documented account fields."`) ile kesin olarak reddedildi (`allowedKeys` whitelist doğrulaması).
- **Sonuç:** GEÇTİ
- **Kanıt:** `.local/manuel-test/HSP-03/05a-reseller-edit-login-duplicate-username-409.png`, `.local/manuel-test/HSP-03/05b-reseller-edit-login-invalid-username.png`, `.local/manuel-test/HSP-03/results.json` (`scenario5`)

### Senaryo 6: Rol / yetki sınırları (RBAC), yabancı müşteri erişim engeli ve sıra/revizyon sızıntısı (Rol / yetki sınırı)

- **Adımlar:**
  1. Müşteri (`thsp03-a5-cust1@webrich.news`) oturumundan kendi hesabına ve aynı bayideki kardeş müşteriye (`thsp03-a5-cust2.yeni@webrich.news`) `PATCH /api/panel/users/hosting/accounts/:id/login` ve `GET /api/panel/users` çağrıları yap.
  2. Bayi (`thsp03-a5-res@webrich.news`) oturumundan kendisine bağlı olmayan doğrudan müşteriye (`thsp03-a5-direct@webrich.news`, `reseller_id: null`) `GET /api/panel/users/hosting/accounts/:id` çağrısı yap.
  3. Bayi oturumundan aynı yabancı müşteriye önce doğru `revision` (`1`) ile, ardından yanlış `revision` (`999`) ile `PATCH /api/panel/users/hosting/accounts/:id/login` çağrısı yap.
  4. Tüm `thsp03-a5-*` test hesaplarını temizle ve `.28` SQLite veritabanında `0` kayıt kaldığını doğrula.
- **Beklenen:**
  - Müşteri `/api/panel/users` ve `/api/panel/users/hosting/*` yönetim uç noktalarına erişememeli (`403`); bayi ise kendisine ait olmayan bir müşteri için `revision` değerinden bağımsız olarak her zaman `403 reseller_scope_forbidden` almalıdır.
- **Gözlenen:**
  - Müşteri oturumundan yapılan `PATCH .../login` çağrıları (hem kendi ID'si hem kardeş müşteri ID'si için) `403 reseller_scope_forbidden`, `GET /api/panel/users` çağrısı `403 forbidden` ile reddedildi.
  - Bayi oturumundan yabancı müşteriye yapılan `GET /api/panel/users/hosting/accounts/:id` ve doğru `revision: 1` ile yapılan `PATCH .../login` çağrısı `403 reseller_scope_forbidden` ile reddedildi.
  - Ancak bayi yabancı müşteriye **yanlış `revision: 999`** ile `PATCH /api/panel/users/hosting/accounts/:id/login` gönderdiğinde, `hosting-account-store.js:404` içinde `existing(id, expectedRevision)` kontrolü `customerScope(actor, row)` kontrolünden **önce** çalıştığı için `403 reseller_scope_forbidden` yerine `409 hosting_account_revision_conflict` döndü.
- **Sonuç:** KISMİ
- **Kanıt:** `.local/manuel-test/HSP-03/06a-cleanup-verified-settings-users.png`, `.local/manuel-test/HSP-03/results.json` (`scenario6`)

## Mevcut testler

| Test dosyası | Koşturma sonucu | Değerlendirme | Not |
|---|---|---|---|
| `apps/api/test/hosting-account-store.test.js` | `68/68` geçti (`node --test`) | GEÇERLİ | Gerçek SQLite üzerinde `createOwnerLogin`, `createCustomerLogin`, `updateCustomerLogin` (`username`/`email`/`password`, oturum düşürme ve revizyon) doğrulamalarını yapıyor. |
| `apps/api/test/hosting-account-http-boundary.test.js` | `35/35` geçti (`node --test`) | GEÇERLİ | Gerçek HTTP sunucusu + SQLite ile Owner/Reseller/Customer giriş oluşturma ve düzenleme sınırlarını test ediyor. |
| `apps/api/test/hosting-account-integration.test.js` | `7/7` geçti (`node --test`) | GEÇERLİ | `user-admin-store` ve `hosting-account-store` entegrasyonunu; `/api/panel/users/:id` üzerinden yalnız `username` güncellemesine izin verilip `role`/`active`/`websiteIds` değişiminin `409 hosting_account_managed` ile engellendiğini doğruluyor. |
| `apps/api/test/hosting-account-native-auth.test.js` | `1/1` geçti (`node --test`) | GEÇERLİ | Gerçek Argon2 + SQLite ile hosting hesap güncellemelerinde aktif oturum iptalini doğruluyor. |
| `apps/api/test/par-02-reseller-customer-management.test.js` | `6/6` geçti (`node --test`) | GEÇERLİ | Bayi müşteri oluşturma ve giriş bilgisi güncelleme akışını gerçek SQLite üzerinde test ediyor. |
| `apps/api/test/user-admin-native.test.js` | `3/3` geçti (`node --test`) | GEÇERLİ | Gerçek Argon2 + SQLite ile kullanıcı oluşturma, yeniden adlandırma ve uçuş sırasındaki giriş iptalini test ediyor. |
| `apps/api/test/site-admin-provisioning.test.js` | `34/34` geçti (`node --test`) | GEÇERLİ | E-posta biçimli `siteAdmin` kullanıcı adı normalizasyonunu, girişini ve kiracı izolasyonunu gerçek SQLite ve Argon2 ile test ediyor. |
| `apps/web/test/user-admin-patch.test.js` | `15/15` geçti (`node --test`) | GEÇERLİ | `userAdminInput` saf fonksiyonunun kullanıcı düzenleme diff davranışını doğruluyor. |
| `apps/web/test/ssl-request-draft.test.js` | `23/23` geçti (`node --test`) | GEÇERLİ | `sslContactEmail` saf fonksiyonunun `email`, `contactEmail`, `recoveryEmail`, `hosting.contactEmail` ve e-posta biçimli `username` çözümlemesini test ediyor. |
| `apps/api/test/user-admin-store.test.js` | `17/17` geçti (`node --test`) | MOCK | `:memory:` SQLite kullanmasına rağmen `helpers/user-admin-fixture.js` içinde `hashPassword = async () => 'test-only-encoded-password'` sahte parola özetleyici ve sahte `getSession` kullanıyor. |
| `apps/api/test/user-admin-http.test.js` | `9/9` geçti (`node --test`) | MOCK | `helpers/user-admin-fixture.js` üzerinden sahte `hashPassword` ve sahte `getSession` kullanıyor. |
| `apps/api/test/auth-password-reset.test.js` | `13/13` geçti (`node --test`) | MOCK | Gerçek SQLite ve Argon2 kullanmakla birlikte `createMockMailer()` sahte e-posta göndericisi kullanıyor. |
| `apps/api/test/hosting-account-http.test.js` | `60/60` geçti (`node --test`) | MOCK | Rota ve gövde ayrıştırma testlerinde gerçek store yerine `calls.push` kaydeden sahte `accounts` nesnesi kullanıyor. |
| `apps/web/test/hosting-account-client.test.js` | `57/57` geçti (`node --test`) | MOCK | İstemci çağrılarında gerçek HTTP yerine sahte `request` callback fonksiyonu kullanıyor. |
| `apps/web/test/user-admin-client.test.js` | `12/12` geçti (`node --test`) | MOCK | İstemci çağrılarında sahte `request` callback fonksiyonu kullanıyor. |
| `apps/web/test/auth-protocol.test.js` | `14/14` geçti (`node --test`) | MOCK | `t.mock.method(globalThis, 'fetch', ...)` ile sahte HTTP yanıtları kullanıyor. |
| `apps/web/test/hosting-accounts-wiring.test.js` | `7/7` geçti (`node --test`) | YÜZEYSEL | `UsersPage.jsx` ve `HostingAccountsPanel.jsx` dosyalarını `readFile` ile okuyup metin/regex araması yapıyor. |
| `apps/web/test/reseller-customers-wiring.test.js` | `4/4` geçti (`node --test`) | YÜZEYSEL | `ResellerCustomersPage.jsx` kaynak kodunda `readFile` + metin kontrolü yapıyor. |
| `apps/web/test/reseller-customer-panel.test.js` | `18/18` geçti (`node --test`) | YÜZEYSEL | Kaynak dosyaları `readFile` ile okuyup metin eşleşmesi arıyor. |
| `apps/web/test/ssl-renewal-wiring.test.js` | `6/6` geçti (`node --test`) | YÜZEYSEL | `SiteOperations.jsx` üzerinde `readFile` ile metin araması yapıyor. |
| `e2e/01-auth-users.spec.js` | `4/5` geçti, `1/5` KIRMIZI (`npx playwright test`) | KIRMIZI | Test `1.2` (`Owner login displays session bar, owner role, and valid lifetime`) sol menüde kaldırılmış olan `aside a[href="/settings"]` bağlantısını aradığı için (`e2e/01-auth-users.spec.js:32`) zaman aşımıyla düşüyor; ayrıca `HSP-03` bayi/müşteri erişim ve iletişim bilgisi akışlarını kapsamıyor. |

## Bulunan sorunlar

| # | Önem | Başlık | Kanıt | Dosya / satır |
|---|---|---|---|---|
| 1 | NORMAL | Müşteri ve bayi hesaplarında iletişim adı, ayrı iletişim e-postası, şirket, telefon, adres ve yönetici açıklaması (`description`) alanları DB şemasında, API'de ve UI'da yok | `PRAGMA table_info(users)` ve `PRAGMA table_info(auth_hosting_accounts)` çıktılarında ilgili sütunlar yok; `contactName`, `company`, `phone`, `description` gönderildiğinde API `400 invalid_hosting_account_input` / `400 invalid_user_input` döndürüyor (`.local/manuel-test/HSP-03/01a-owner-create-reseller-modal-fields.png`, `01b-owner-create-customer-modal-fields.png`, `results.json` `scenario1` & `scenario5`). | `apps/api/src/hosting-account-schema.js:10-18`, `apps/api/src/hosting-account-http.js:87-105`, `apps/web/src/workspace/HostingAccountsPanel.jsx:64-156`, `apps/web/src/workspace/ResellerCustomersPage.jsx:40-159` |
| 2 | NORMAL | Owner rolü `/customers` ve `/resellers` (`Hesabı yönet`) veya `/settings/users` (`Düzenle`) ekranlarından müşteri ya da bayi parolasını sıfırlayamıyor; bayi giriş düzenleme API'si Owner'a bile `403` dönüyor | Owner `/customers` `Hesabı yönet` modalında `0` input var (`03a`); `/settings/users` `Düzenle` modalında `{!user && <label>İlk parola...}` nedeniyle parola alanı gizli (`03c`); Owner'ın bayi için `PATCH /api/panel/users/hosting/accounts/:resellerId/login` çağrısı `403 reseller_scope_forbidden` döndürüyor (`results.json` `scenario3`). | `apps/web/src/workspace/HostingAccountsPanel.jsx:186-267`, `apps/web/src/workspace/UsersPage.jsx:144`, `apps/api/src/hosting-account-store.js:402-406` |
| 3 | NORMAL | `Hesabım` (`AccountDialog`) içindeki `Kurtarma E-postası` özelliği yalnız Owner'a açık; Müşteri ve Bayi kendi iletişim/kurtarma e-postasını kaydedemiyor (`403 forbidden`) | Müşteri (`04a`) ve Bayi (`04d`) `Hesabım` modallarında `Kurtarma E-postası` bölümü gizli; `/api/auth/recovery-email` `GET` ve `POST` çağrıları Müşteri ve Bayi için `403 forbidden` döndürüyor (`results.json` `scenario4`). | `apps/web/src/AccountDialog.jsx:88`, `apps/web/src/AccountDialog.jsx:170`, `apps/api/src/auth-http.js:343-387` |
| 4 | NORMAL | `updateCustomerLogin` içinde `existing(id, expectedRevision)` kontrolü `customerScope(actor, row)` yetki kontrolünden önce çalışarak yabancı müşteri için `403` yerine `409 hosting_account_revision_conflict` sızdırıyor | Bayi kendisine ait olmayan `thsp03-a5-direct@webrich.news` müşterisine `revision: 999` ile `PATCH .../login` gönderdiğinde `403 reseller_scope_forbidden` yerine `409 hosting_account_revision_conflict` aldı (`results.json` `scenario6.resellerRbacChecks`). | `apps/api/src/hosting-account-store.js:402-406` |
| 5 | NORMAL | Owner `/customers` `Hesabı yönet` modalında bağlı bayi kullanıcı adı yerine ham UUID gösteriliyor ve müşteri/bayi modallarında geliştiriciye yönelik iç mimari notları ("AI slop") yer alıyor | Modalda `"Bağlı bayi: 16a7d71d-a8d1-46bb-9d4d-976fd6580536"` ham UUID'si ve `"Bu ekran Owner için profil ve limit yönetimidir. Yeni giriş hesabı, site yetkisi, paket veya abonelik oluşturmaz."` / `"Müşteri erişim hesapları da iç olarak site_manager rolünü kullanır..."` metinleri görünüyor (`03a`, `03b`, `02a`, `02b`). | `apps/web/src/workspace/HostingAccountsPanel.jsx:202`, `apps/web/src/workspace/HostingAccountsPanel.jsx:208`, `apps/web/src/workspace/ResellerCustomersPage.jsx:78`, `apps/web/src/workspace/ResellerCustomersPage.jsx:127` |
| 6 | NORMAL | `AccountDialog` açıkken `TotpSetupPanel` yüklendikten sonra modal içinde iki adet `"Mevcut parola"` etiketli parola alanı oluşuyor | Parola değiştirme formu (`AccountDialog.jsx:144`) ve 2FA bölümü (`TotpSetupPanel.jsx`) aynı `"Mevcut parola"` etiketini kullandığı için seçiciler tekilleştirilmezse çakışıyor. | `apps/web/src/AccountDialog.jsx:144`, `apps/web/src/TotpSetupPanel.jsx` |

## Eksik / yanlış / yüzeysel testler

- `[MOCK] apps/api/test/user-admin-store.test.js` — `helpers/user-admin-fixture.js` içinde gerçek Argon2 yerine sahte `hashPassword` (`'test-only-encoded-password'`) ve sahte `getSession` kullanıyor.
- `[MOCK] apps/api/test/user-admin-http.test.js` — `helpers/user-admin-fixture.js` üzerinden sahte `hashPassword` ve sahte `getSession` kullanıyor.
- `[MOCK] apps/api/test/auth-password-reset.test.js` — Parola sıfırlama testlerinde `createMockMailer()` sahte e-posta nesnesi kullanıyor.
- `[MOCK] apps/api/test/hosting-account-http.test.js` — Gerçek SQLite store yerine çağrıları diziye kaydeden sahte `accounts` nesnesi kullanıyor.
- `[MOCK] apps/web/test/hosting-account-client.test.js` — İstemci fonksiyonlarını sahte `request` callback ile test ediyor.
- `[MOCK] apps/web/test/user-admin-client.test.js` — İstemci fonksiyonlarını sahte `request` callback ile test ediyor.
- `[MOCK] apps/web/test/auth-protocol.test.js` — `globalThis.fetch` metodunu `t.mock.method` ile sahteleyerek test ediyor.
- `[YÜZEYSEL] apps/web/test/hosting-accounts-wiring.test.js` — `UsersPage.jsx` ve `HostingAccountsPanel.jsx` dosyalarını `fs.readFile` ile okuyup metin eşleşmesi arıyor.
- `[YÜZEYSEL] apps/web/test/reseller-customers-wiring.test.js` — `ResellerCustomersPage.jsx` üzerinde yalnızca `fs.readFile` + metin kontrolü yapıyor.
- `[YÜZEYSEL] apps/web/test/reseller-customer-panel.test.js` — Kaynak kod dosyalarında `fs.readFile` ile metin araması yapıyor.
- `[YÜZEYSEL] apps/web/test/ssl-renewal-wiring.test.js` — `SiteOperations.jsx` üzerinde `fs.readFile` ile metin kontrolü yapıyor.
- `[KIRMIZI] e2e/01-auth-users.spec.js` — Test `1.2` (`e2e/01-auth-users.spec.js:32`) sol menüde artık doğrudan bulunmayan `aside a[href="/settings"]` seçicisini beklediği için başarısız oluyor.
- `[EKSİK]` Müşteri ve bayi hesaplarında iletişim adı, e-posta, şirket, telefon, adres ve açıklama alanlarının oluşturulması, düzenlenmesi ve kalıcılığını doğrulayan gerçek API/DB ve Playwright E2E testleri yok.
- `[EKSİK]` Bayinin `/customers` → `Girişi düzenle` modalından müşteri kullanıcı adı/parolasını değiştirmesi, açık müşteri oturumunun düşmesi ve yeni bilgilerle giriş yapılmasını tarayıcıda uçtan uca doğrulayan Playwright E2E testi yok.
- `[EKSİK]` Owner'ın müşteri ve bayi erişim bilgilerini (kullanıcı adı ve parola) `/customers`, `/resellers` ve `/settings/users` ekranlarından güncelleyebilmesini doğrulayan Playwright E2E testi yok.

## Panelde olmayan / bulunamayan

- Müşteri ve bayi hesapları için **İletişim adı (`Contact name`)**, **Ayrı iletişim e-postası (`Email address`)**, **Şirket (`Company`)**, **Telefon (`Phone`)**, **Adres / Şehir / Ülke (`Address / City / Country`)** ve **Yönetici açıklaması (`Description / Notes`)** alanları (hem oluşturma hem düzenleme modallarında ve veritabanı şemasında yok).
- Owner için `/customers` ve `/resellers` ekranlarındaki `Hesabı yönet` modalında **hesap erişim bilgilerini (`Kullanıcı adı` / `Parola`) düzenleme** formu.
- Owner için `/settings/users` → `Düzenle` modalında mevcut kullanıcının **parolasını sıfırlama / değiştirme** alanı.
- Müşteri ve Bayi rolleri için `Hesabım` (`AccountDialog`) ekranında **Kurtarma / İletişim E-postası** tanımlama ve güncelleme alanı.

## Temizlik

- Canlı test sırasında `.28` üzerinde oluşturulan tüm `thsp03-a5-*` hesapları ve profilleri (`thsp03-a5-res@webrich.news`, `thsp03-a5-cust1@webrich.news`, `thsp03-a5-cust2.yeni@webrich.news`, `thsp03-a5-direct@webrich.news`) silindi ve Owner'ın kurtarma e-postası orijinal değerine geri yüklendi.
- `.28` üzerinde `/var/lib/yunpanel/control-plane/auth/auth.sqlite` veritabanında `SELECT id, username, role FROM users WHERE username LIKE 'thsp03-a5-%'` ve `SELECT h.user_id, u.username FROM auth_hosting_accounts h JOIN users u ON u.id = h.user_id WHERE u.username LIKE 'thsp03-a5-%'` sorgularının ikisinin de `[]` (`0` kayıt) döndürdüğü doğrulandı (`.local/manuel-test/HSP-03/results.json` → `scenario6.remainingInDb: []`, `scenario6.remainingProfilesInDb: []`).
- `sunucu-28-2` ve `sunucu-28-4` kilitleri serbest bırakıldı.
