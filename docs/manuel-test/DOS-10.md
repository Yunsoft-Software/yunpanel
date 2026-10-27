# DOS-10 — FTP/FTPS hesapları, dizin kapsamı ve kota
Sonuç: ÇALIŞMIYOR
Ajan: AGENT_4 · Tarih: 2026-10-27 14:20 · Senaryo: `e2e/ozellik/dos-10.spec.js` · Koşu: 4/4, test.fail 3

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol 1: Panel arayüzünde mevcut erişim protokolü (SFTP/SSH) ve Unix kullanıcı parametreleri | geçti | UI'da SFTP/SSH protokol, 22 port, docroot ve dedicated `yunapp-*` kullanıcısı doğrulandı |
| mutlu yol 2 (Plesk eşdeğerliği): Panelde FTP/FTPS hesabı oluşturma, dizin kapsamı ve kota formu | bilinen hata (test.fail) | UI'da FTP hesap ekleme butonu, dizin kapsamı (chroot) ve disk kota alanı bulunmuyor |
| fiziksel kontrol: Sunucuda FTP/FTPS servisi (port 21) ve FTP daemon varlığı | bilinen hata (test.fail) | Host'ta port 21 kapalı; vsftpd/proftpd/pure-ftpd kurulu değil (yalnızca SSH/SFTP 22 aktif) |
| hatalı girdi ve güvenlik: FTP hesap API'sinde path traversal ve geçersiz kota engeli | bilinen hata (test.fail) | Arka uçta `/api/websites/:id/ftp/accounts` rotası mevcut değil (HTTP 404) |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Panelde FTP/FTPS hesabı, dizin kapsamı ve kota yönetim arayüzü/API'si yok | — (test.fail ile işaretli) |
| NORMAL | Canlı sunucuda vsftpd/proftpd servisi kurulu değil ve port 21 kapalı | — (test.fail ile işaretli) |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/website-sftp-key-http.test.js` | GEÇERLİ | Alternatif erişim olan SFTP key HTTP rotaları ve guard kontrolleri |
| `packages/host-runtime/test/sftp-site-manager.test.js` | GEÇERLİ | OpenSSH internal-sftp chroot ve mount yaşam döngüsü testleri |

## Panelde olmayan
Plesk eşdeğeri ek FTP/FTPS hesabı oluşturma, kullanıcı bazlı dizin kapsamı (chroot docroot) ve FTP hard quota tanımlama özellikleri panel arayüzünde ve API'de yer almıyor; sunucuda da FTP daemon kurulu değil (yalnızca port 22 internal-sftp mevcut).

## Temizlenemeyen kaynaklar
—
