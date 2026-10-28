# BAK-05 — Yerel ve uzak FTP/cloud/object storage hedefleri
Sonuç: KISMİ
Ajan: AGENT_1 · Tarih: 2026-10-28 12:20 · Senaryo: `e2e/ozellik/bak-05.spec.js` · Koşu: 3/3, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: sistem yedekleme motoru doğrulama, yerel ve uzak depolama hedefleri oluşturma, site arayüzünde repo/uzak depo tespiti ve fiziksel disk/ayar kanıtı | geçti | Sunucu rclone/restic sistem ayarları, rclone-remotes.json AES-256 şifreli kayıt, restic-repositories.json ve fiziksel repo config dosyası |
| hatalı girdi: geçersiz remote türü (FTP reddi), geçersiz karakterli isim, eksik hedef ve yetkisiz erişim kontrolleri | geçti | 400 rclone_remote_type_unsupported, 400 rclone_remote_name_invalid, 400 restic_target_invalid, 400 restic_password_invalid, 401/403 yetkisiz erişim engeli |
| Plesk eşdeğerliği: UI üzerinde uzak depolama yapılandırma sihirbazı (Remote Storage Settings / FTP / S3 form) | bilinen hata (`test.fail`) | Plesk Backup Manager'daki Remote Storage Settings (FTP Storage / Amazon S3 / Google Drive) form arayüzü YunPanel UI üzerinde bulunmuyor |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Plesk Backup Manager Remote Storage Settings arayüz sihirbazı panelde yok; uzak hedefler yalnız API üzerinden yönetiliyor | — |
| NORMAL | Eski FTP/FTPS protokolü desteklenmiyor; rclone remote motoru yalnız S3, B2, SFTP ve WebDAV kabul ediyor | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/rclone-remote-registry.test.js` | GEÇERLİ | Rclone remote CRUD, AES-256 şifreleme ve bağlantı testi |
| `apps/api/test/restic-repository-registry.test.js` | GEÇERLİ | Restic local ve rclone repo yönetimi ve saklama politikası |
| `apps/api/test/backup-repository-http.test.js` | GEÇERLİ | Repository ve remote REST HTTP uç noktaları yetki doğrulaması |

## Panelde olmayan
Plesk'te yer alan kullanıcı dostu uzak depolama yapılandırma sihirbazı (Remote Storage Settings / FTP / S3 form arayüzü) ve geleneksel FTP depolama seçeneği; YunPanel'de uzak hedefler API üzerinden rclone (S3, B2, SFTP, WebDAV) olarak tanımlanır.

## Temizlenemeyen kaynaklar
—
