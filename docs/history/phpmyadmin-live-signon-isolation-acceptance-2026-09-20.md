# phpMyAdmin Live Signon and Database Isolation Acceptance — 2026-09-20

## 1. Context & Objectives

- **Target Server:** Authorized `.28` test server (`157.180.11.28`, Ubuntu 24.04 LTS).
- **Prohibited Server:** `.44` Plesk host was strictly untouched.
- **Goal:** Verify end-to-end phpMyAdmin managed runtime activation, secure signon handoff via capability exchange over private Unix sockets, and cross-site database isolation between Site A (`webrich.news`) and Site B (`mailtest.webrich.news`).

## 2. Changes Made

1. **`packages/host-runtime/src/phpmyadmin-config-activator.js`**:
   - Added bounded polling retry loop (`while (true)` with `sleepFn(100)` up to `socketTimeoutMs = 5000`) for `assertGatewaySocket` to handle Nginx asynchronous socket bind timing upon reload (`SIGHUP`).
2. **`packages/config-templates/src/phpmyadmin-signon.js`**:
   - Explicitly reset `$cfg['Servers'] = []; $i = 1;` in `renderPhpMyAdminSignonConfig()`.
   - Prevented Debian's default `config-db.php` from maintaining a cookie-auth Server 1 that shadowed the signon configuration on Server 2.

## 3. Verification & Live Evidence on `.28`

1. **MariaDB Unix Socket Admin Auth Baseline (`todo.md` line 103):**
   - Verified MariaDB native socket admin connection:
     `effective/login account: root@localhost`, `authPlugin: unix_socket`, `anonymousAccountsAbsent: true`, `remoteRootAccountsAbsent: true`, `testSchemaAbsent: true`.
2. **Database Provisioning for Site A & Site B:**
   - Site A (`webrich.news`): Database `site_a_db`, User `ydb_ddc0bc17b03e95ae9d9fe152`, Credential `637370fc-af3a-41f4-a64c-cf50103e806a`.
   - Site B (`mailtest.webrich.news`): Database `site_b_db`, User `ydb_491ed97edc4f2ce7ad8583a0`, Credential `dc15dfcc-5766-4834-b611-96b516eea05c`.
   - Verified SQL grants: Site A user has grants strictly on `site_a_db`.*; Site B user has grants strictly on `site_b_db`.*.
3. **Protected Signon Handoff & Single-Use Capability:**
   - `POST /api/panel/servers/:id/websites/:id/phpmyadmin-handoffs` issues 43-character base64url capability bound to the site's credential.
   - `POST /tools/phpmyadmin/__yunpanel/signon` consumes capability via private Unix socket `/run/yunpanel-phpmyadmin/handoff.sock`, sets `YunPanelPhpMyAdminSignon` cookie with `path=/tools/phpmyadmin/; secure; HttpOnly; SameSite=Strict`, and redirects with HTTP 303 to `/tools/phpmyadmin/`.
   - Replay of consumed capability returns HTTP 401.
   - Invalid/malformed capability returns HTTP 400.
   - Direct access without YunPanel session cookie returns HTTP 401.
4. **phpMyAdmin UI Session & Database Scope Isolation (`todo.md` lines 60, 105):**
   - **Site A Session:**
     - phpMyAdmin UI loaded successfully (`HTTP 200`).
     - `site_a_db` is present and accessible.
     - `site_b_db` is completely excluded from the schema list.
   - **Site B Session:**
     - phpMyAdmin UI loaded successfully (`HTTP 200`).
     - `site_b_db` is present and accessible.
     - `site_a_db` is completely excluded from the schema list.
5. **Security Boundaries:**
   - No TCP listener open for phpMyAdmin; internal communication strictly via Unix sockets `/run/php/yunpanel-phpmyadmin.sock` and `/run/yunpanel/phpmyadmin-http.sock`.
   - Process runs under dedicated unprivileged user `yunpanel-phpmyadmin`.
