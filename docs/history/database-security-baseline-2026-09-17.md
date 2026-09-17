# Database güvenlik baseline — 2026-09-17

MySQL/MariaDB host işlemlerinin örtülü credential fallback'ı kaldırıldı ve salt-okunur güvenlik kanıtı eklendi.

- Inventory, schema create/drop, credential/grant, dump ve restore istemcileri explicit `--no-defaults --protocol=socket --user=root` kullanır.
- `MYSQL_PWD`, `MARIADB_PWD`, `MYSQL_HOST`, `MYSQL_TCP_PORT` ve `MYSQL_UNIX_PORT` inherited process environment'ından database client'a taşınmaz.
- Security inspector effective/login account, auth plugin, anonymous account sayısı, localhost dışı root hesabı ve `test` schema varlığını bounded metadata'ya dönüştürür.
- Yalnız `root@localhost` + `unix_socket`/`auth_socket` ve temiz hygiene sayımları `ready=true` üretir. Password plugin veya insecure default, parola ya da raw client çıktısı göstermeden ayrı reason code ile hazır değil kalır.
- Host adapter testleri no-defaults/socket/root argümanlarını, environment redaction'ı, sağlıklı native auth'u ve insecure/password-auth sonucunu kapsar.

Gerçek Ubuntu kabulü `todo.md` T-DATABASE altında kalır. Bu host kanıtının authenticated Database API/UI ve service-install completion'a bağlanması planın açık işidir.
