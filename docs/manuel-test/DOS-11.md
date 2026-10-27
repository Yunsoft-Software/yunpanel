# DOS-11 — SSH/SFTP/shell erişimi ve anahtarlar; kullanıcı izolasyonu
Sonuç: KISMİ
Ajan: AGENT_3 · Tarih: 2026-10-27 11:33 · Senaryo: `e2e/ozellik/dos-11.spec.js` · Koşu: 3/4, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol 1: UI üzerinde SSH/SFTP erişim bilgileri ve Unix izolasyon parametrelerinin görüntülenmesi | geçti | UI'da SFTP/SSH protokol, 22 port, docroot ve `yunapp-016be7e1a7d2` kullanıcısı doğrulandı |
| mutlu yol 2: SFTP/SSH anahtarı ekleme, listeleme ve fiziksel sunucuda authorized_keys / chroot doğrulaması | geçti | Host `/etc/ssh/yunpanel-authorized-keys/<user>` dosyasında public key doğrulandı; non-root UID ve OpenSSH chroot/no-pty konfigürasyonu teyit edildi |
| hatalı girdi: Geçersiz anahtar formatı ve eksik/fazla alanlar reddedilir | geçti | HTTP 400 Bad Request (`sftp_authorized_key_invalid` ve `sftp_key_add_input_invalid`) |
| Plesk eşdeğerliği: Panel arayüzünde SSH/SFTP anahtar yönetim ve kullanıcı parolası formu | bilinen hata (test.fail) | UI'da SSH Keys / parola formu yok; yetenek yalnızca API (/api/websites/:id/sftp/keys) seviyesinde |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Panel UI'da SSH anahtarı ekleme/yönetme ve parola değiştirme formu bulunmuyor | — (test.fail ile işaretli) |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/website-sftp-key-http.test.js` | GEÇERLİ | SFTP key list/add/revoke/rotate/reconcile HTTP rotaları ve guard kontrolleri |
| `packages/host-runtime/test/sftp-authorized-key-manager.test.js` | GEÇERLİ | Host authorized_keys yazımı, fingerprint ve atomik dosya yönetimi |
| `packages/config-templates/test/sftp.test.js` | GEÇERLİ | OpenSSH chroot, internal-sftp, force-command ve izolasyon template testleri |

## Panelde olmayan
Plesk'teki gibi web arayüzünden doğrudan SSH anahtarı ekleme/yükleme (SSH Keys UI) ve SSH/SFTP kullanıcı parolası belirleme formları panelde bulunmuyor (yalnızca arka uç API seviyesinde mevcut).

## Temizlenemeyen kaynaklar
—
