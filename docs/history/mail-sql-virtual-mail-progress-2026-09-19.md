# Mail SQL virtual-mail cutover progress — 2026-09-19

Bu kayıt P0.4 mail core parity içindeki hash/passwd-file tabanlı virtual-mail lookup modelinden SQLite-backed Postfix/Dovecot modeline kaynak geçişini özetler.

## Control-plane ve host modeli

Control-plane source-of-truth değişmedi:

- Mail Domain registry
- Mailbox registry
- Alias registry
- Mailbox quota registry
- Forwarding registry
- DKIM/TLS/SRS state

host apply sırasında deterministic bir SQLite read-model'e materialize edilir.

Yeni host sınırı:

- Maildir root: `/var/lib/yunpanel/mail`
  - owner/group: `vmail:vmail`
  - Website Unix UID/GID ile paylaşılmaz.
- Virtual-mail SQL DB: `/var/lib/yunpanel/mail-auth/virtual-mail.sqlite3`
  - Maildir root'tan ayrı tutulur.
  - owner/group: `root:yunpanel-mailauth`
  - mode: `0640`
- `yunpanel-mailauth` supplementary group yalnız Postfix ve Dovecot reader identity'leri içindir.
- Postfix/Dovecot hiçbir şekilde `vmail` storage grubuna eklenmez.

Debian package postinst fresh install/upgrade sırasında `vmail`, `yunpanel-mailauth`, Maildir root ve mail-auth state root'unu oluşturur. Yeni mail-auth group membership oluşursa Postfix/Dovecot process credential'larının yenilenmesi için servisler restart edilir.

## SQLite desired state

Private seed:

- `/etc/yunpanel/mail/sql/virtual-mail.sql`

Database tabloları:

- `yunpanel_meta`
- `virtual_domains`
- `virtual_mailboxes`
- `virtual_aliases`

Seed:

- foreign key enforcement açar,
- transaction içinde canonical state'i yazar,
- enabled domain/mailbox/alias state'ini rebuild eder,
- Argon2id password hash ve quota value'larını yalnız private seed/DB içinde tutar,
- public preview'a password hash veya rendered seed içeriği taşımaz,
- canonical state digest'ini `yunpanel_meta.state_sha256` içine pinler.

## Postfix/Dovecot lookup

Postfix artık yeni apply preview'larında SQLite lookup kullanır:

- `virtual_mailbox_domains = proxy:sqlite:/etc/postfix/yunpanel-sql/virtual-domains.cf`
- `virtual_mailbox_maps = proxy:sqlite:/etc/postfix/yunpanel-sql/virtual-mailboxes.cf`
- `virtual_alias_maps = proxy:sqlite:/etc/postfix/yunpanel-sql/virtual-aliases.cf`
- submission sender-login: `proxy:sqlite:/etc/postfix/yunpanel-sql/sender-login.cf`

Dovecot:

- `passdb sql`
- SQLite config: `/etc/dovecot/yunpanel-sql.conf.ext`
- password + quota read-model DB'den gelir.
- `userdb static` dedicated `vmail` identity ve `/var/lib/yunpanel/mail/%d/%n` kullanır.
- PAM veya Website user fallback'i yoktur.

Managed service catalog Postfix için `postfix-sqlite + sqlite3`, Dovecot için `dovecot-sqlite + sqlite3` package dependency'lerini taşır. API managed-service state policy aynı exact package setine güncellendi.

## Durable apply / rollback

SQLite bundle mevcut mail apply journal'ına entegre edildi:

1. private SQL seed + public lookup configs stage edilir;
2. pre-apply backup alınır;
3. SQLite seed fixed allowlisted `sqlite3 <db> ".read <seed>"` command'ıyla uygulanır;
4. DB root:mailauth 0640'a çekilir;
5. `PRAGMA quick_check` ve exact `state_sha256` doğrulanır;
6. Postfix/Dovecot config validate/reload/health çalışır;
7. submission auth socket exact postfix UID/GID 0660 olarak doğrulanır;
8. yalnız başarılı cutover sonrasında eski hash/passwd lookup dosyaları fixed allowlist üzerinden retire edilir.

Legacy live lookup retirement seti:

- eski virtual domain/mailbox/alias source hash map'leri ve `.db` çıktıları,
- sender-login hash map + `.db`,
- eski Dovecot passwd-file credential kaydı.

Failure olursa pre-apply backup bu state'i geri yükleyebilir.

Backup manifest v6:

- legacy paths,
- SQL seed/config files,
- SQL database,
- managed SQL directories

snapshot'ını alır.

V5 manifest okuyucu compatibility korunur; upgrade öncesinde başlamış recovery journal'ları source seviyesinde okunabilir kalır.

## Recovery compatibility

Yeni preview/apply işlemleri SQLite desired state üretir.

Fakat `MailConfigurationService` aynı registry state'inden ayrıca legacy preview identity'sini de hesaplar. Persisted eski apply/rollback job'ındaki preview/config digest legacy identity ile eşleşiyorsa protected materialization legacy bundle'ı döndürebilir.

Bu compatibility yalnız persisted old digest match'i için vardır; yeni preview'lar hash/passwd modeline dönmez.

## Live evidence

SQL apply success/recovery evidence aşağıdakileri birlikte doğrular:

- SQL lookup artifact bytes/digest/mode/owner,
- SQL directory owner/group/mode,
- `yunpanel-mailauth` group membership,
- DB root:mailauth 0640,
- SQLite quick_check,
- exact state digest,
- Postfix parameters,
- submission master service/sender-login map,
- Dovecot submission socket,
- Sieve ownership,
- service validators/health,
- legacy lookup dosyalarının artık live path'te bulunmaması.

Bu kanıtlardan biri eksik veya drifted ise successful apply/recovery sayılmaz.

## Kaynak commit dilimleri

Başlıca commitler:

- `0b052fb5`, `bfe34ca5` — dedicated vmail package identity.
- `52876d9f`, `294f0a26`, `5f72775b` — SQLite template + tests/export.
- `7940d193`, `31757633` — legacy preview -> SQL lookup transformer.
- `b14f4ff8`, `dc55aa3b`, `47f9a701` — state digest + seed compile.
- `99954b36`, `24a34831`, `2940da83` — durable plan/staging/backup v6 + v5 compatibility.
- `6c61ce07`, `90174172`, `92cf68ae` — activation/evidence/domain-scope binding.
- `6360fbb7`, `78928324`, `d06f60c5`, `5e2e4848` — isolated reader group/readiness.
- `9f9183a8` — new production previews/apply path SQL cutover + legacy digest recovery fallback.
- `469fc976`, `12c3cebc`, `124c5b75` — legacy lookup retirement + evidence.
- `2a0dd2a5`, `3743d557`, `81c00607`, `3c7652d6`, `c99650a2` — isolated DB root and directory ownership.
- `3c9c3a4e`, `83e1f669`, `c59e1bdd`, `63cbf3d8` — package/service dependency + group lifecycle.
- SQL-oriented source test updates are in the adjacent small test commits.

## Doğrulama durumu

Bu sohbet ortamında repository checkout/Node 24 runner ve gerçek Ubuntu mail hostu yoktur. Kaynak testleri yazıldı/güncellendi ancak burada çalıştırılmış gibi gösterilmez.

Targeted Node tests, full `npm run check`, Ubuntu 24.04 package/apply/rollback/restart failure-injection ve gerçek SMTP/IMAP authentication kabulü `todo.md` T-CODEX-SOURCE ve T-MAIL altında açık tutulur.

Bu acceptance geçmeden P0.4 maddesi ürün anlamında DONE sayılmaz.
