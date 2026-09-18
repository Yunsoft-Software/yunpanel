# Website Files / elFinder boundary

> Current source status — 2026-09-18: elFinder is the primary Website Files path. The old custom `site-file-manager` API remains only as a migration fallback until the real Ubuntu/browser/filesystem acceptance gates in `todo.md` T-TOOLS pass. Do not add new features to the legacy API.

## Canonical Files path

Managed `static`, `node` and `php` Websites use the persistent Website/Application identity and canonical dedicated `yunapp-*` Unix account.

The filesystem authority is the Website HOME/SFTP root:

`/var/lib/yunpanel/data/<applicationId>`

The browser cannot choose a host root, Unix user, Website identity, Application identity, PHP-FPM socket or connector path.

The primary browser flow is:

1. Owner opens the Website Files tab and chooses **elFinder ile aç**.
2. YunPanel API issues a short-lived, single-use `audience=elfinder` capability only after the Website's elFinder runtime is healthy.
3. Browser navigates to `/tools/elfinder/#handoff=<capability>`.
4. The minimal bootstrap removes the fragment with `history.replaceState` before loading vendor assets.
5. Capability is sent in an exact same-origin JSON POST to `/tools/elfinder/__yunpanel/handoff`.
6. Public web gateway consumes it through private `/run/yunpanel-elfinder/handoff.sock`.
7. The raw capability is discarded. A random HttpOnly tool-session cookie scoped to `/tools/elfinder/` is created and bound to the current panel session cookie digest.
8. Only after the tool session exists are local jQuery/jQuery-UI/elFinder browser assets loaded.
9. Connector requests pass through the authenticated same-origin web gateway and private Nginx Unix socket.

The capability is never placed in query parameters or browser storage. The tool session does not replace panel authentication: every tool request must still pass the live Owner management-session gate.

## Shared application packaging

elFinder upstream is pinned to version `2.1.70`, exact commit:

`e7ea668fd569fc9903fb1c431d47d58f2daad2f2`

The Debian build requires a clean tag/commit-verified vendor tree before packaging and does not fetch a floating "latest" release.

Packaged paths include:

- `/usr/share/yunpanel/elfinder/vendor/elfinder`
- `/usr/share/yunpanel/elfinder/connector.php`
- `/usr/share/yunpanel/elfinder/index.html`
- `/usr/share/yunpanel/elfinder/yunpanel-client.js`
- `/usr/share/yunpanel/elfinder/VERSION`

Browser dependencies use distro `libjs-jquery` and `libjs-jquery-ui`; the YunPanel client does not depend on public CDNs.

The internal Nginx gateway only exposes the required vendor browser asset roots:

- `vendor/js/`
- `vendor/css/`
- `vendor/img/`
- `vendor/sounds/`

Vendor PHP, examples, package metadata and arbitrary vendor-root files are not public routes.

## Per-Website PHP-FPM isolation

Every managed Website receives a deterministic elFinder PHP-FPM pool whose process runs as that Website's canonical `yunapp-*` UID/GID.

The pool:

- uses canonical Website HOME as `HOME` and `chdir`;
- uses `HOME/tmp` for upload/session/temp state;
- exposes a dedicated socket `/run/php/yunpanel-elfinder-<yunapp-user>.sock`;
- limits `open_basedir` to the Website HOME and packaged shared elFinder code;
- disables shell/process execution functions;
- is config-tested before activation;
- is verified after PHP-FPM reload;
- keeps durable operation receipt state so operation-owned pool creation can be compensated safely;
- refuses to overwrite a foreign or drifted pool.

Website provisioning has a required `elfinder` step after `unix_identity`. Shared package health, the per-Website pool, PHP service UMask `0027`, private Nginx gateway and final pool inspection must succeed before that step is healthy.

## Hardened connector

The packaged connector derives root and identity only from server-controlled FPM environment:

- `YUNPANEL_ELFINDER_ROOT`
- `YUNPANEL_ELFINDER_WEBSITE_ID`
- `YUNPANEL_ELFINDER_APPLICATION_ID`
- `YUNPANEL_ELFINDER_UNIX_USER`

It verifies:

- root is the exact canonical Website HOME;
- root is not a symlink and `realpath(root) === root`;
- effective PHP user is the expected Website user;
- vendor classes/autoload are present.

elFinder uses only `LocalFileSystem`. Network drivers are disabled, symlink following is disabled, `netmount` and `chmod` are disabled, and upload/archive size bounds are configured.

## Private gateway boundary

The internal Nginx tool gateway listens only on:

`/run/yunpanel/elfinder-http.sock`

It has no dedicated TCP listener.

The public YunPanel web gateway strips any browser-supplied:

- `x-yunpanel-elfinder-unix-user`
- `x-yunpanel-elfinder-website-id`
- `x-yunpanel-elfinder-application-id`

For connector requests it injects only identity values obtained from the consumed handoff session. Panel cookies, tool cookies and the internal proxy credential are not forwarded into PHP.

The Nginx gateway derives the FastCGI socket only from the validated canonical `yunapp-*` value and derives the Website root only from the validated Application UUID.

Generated gateway configuration is applied atomically. The previous exact config (or previous absence) is kept in a root-private digest-scoped snapshot. `nginx -t`, reload/start, Unix-socket ownership/mode and socket health must pass. Failed activation restores the previous state and does not count as ready.

## Legacy migration fallback

The old custom routes under `/api/websites/:websiteId/files...` still exist temporarily. They remain bounded to the managed Website identity/release boundary and are not a future product surface.

The fallback currently provides bounded list/download/upload/text edit/mkdir/rename/delete behavior through a packaged worker running as the site user. Its existing traversal, symlink, size, optimistic-lock, mode and audit guards remain in place only for migration safety.

It must not be expanded with archive, bulk copy/move, richer editor, permissions or other general file-manager features.

## Removal gate

After T-TOOLS proves on a real Ubuntu host that elFinder has correct:

- site UID/GID isolation;
- upload/download/edit/rename/move/copy/delete/mkdir/archive behavior;
- traversal/symlink/special-file/archive escape protection;
- direct vendor/connector bypass rejection;
- logout/revoke/session separation;
- Nginx/FPM restart and package-upgrade recovery;

the custom `site-file-manager` HTTP, worker, backend and legacy UI paths are removed.

Source tests are not a substitute for that real-host acceptance.
