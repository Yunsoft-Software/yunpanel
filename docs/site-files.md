# Site file-manager boundary

YunPanel's file API is limited to the active release of one local static or Node Website. It does not expose a caller-selected host root. The backend derives the deterministic Application path and `yunapp-*` identity from persisted Website state, resolves `current`, and accepts only an exact UUID release below that same managed Application root.

Every filesystem operation runs in a short-lived worker through fixed `/usr/sbin/runuser -u <site-user> -- <packaged-node> <fixed-worker>` arguments. Request data cannot choose the executable, Unix user or release root. The worker receives a fixed, secret-free environment. The API must run as root so it can enter the site account; the worker itself has only that account's filesystem permissions. Static release ownership remains with the same dedicated site user after artifact verification, while the existing public read modes continue to support Nginx.

Owner-only routes are:

- `GET /api/websites/:websiteId/files?path=` for a bounded directory listing and type/size/mode/uid/gid/mtime metadata;
- `GET /api/websites/:websiteId/files/download?path=...` for a binary download up to 16 MiB;
- `PUT /api/websites/:websiteId/files/upload?path=...` with `application/octet-stream` for a binary create or atomic replacement up to 16 MiB;
- `GET /api/websites/:websiteId/files/text?path=...` for valid UTF-8 text up to 512 KiB plus its SHA-256 revision;
- `PUT /api/websites/:websiteId/files/text` with exactly `path`, `content` and `expectedSha256` for an atomic optimistic-lock edit;
- `POST /api/websites/:websiteId/files/mkdir` and `/rename` for single explicit operations;
- `DELETE /api/websites/:websiteId/files` with exactly `path` and `confirmation: delete:<websiteId>:<path>`.

Paths are release-relative UTF-8 strings. Absolute paths, empty interior components, `.`/`..`, backslashes, control characters, oversized paths and components are rejected. Each existing component is inspected without following symbolic links. Listings may identify a symlink, and confirmed deletion may unlink that symlink itself, but read, write, traversal and rename never follow it. The release root itself must be a real directory whose canonical path is unchanged.

Writes use an exclusive temporary file in the validated destination directory, flush it, apply a bounded mode and atomically rename it. New static files/directories use Nginx-readable `0644`/`0755`; new Node entries use private `0640`/`0750`, while replacements retain the existing regular-file mode without special bits. Text edits require the SHA-256 returned by the read call so a stale browser cannot silently overwrite a newer file. Operations for the same Application are serialized, directory listings are capped at 1,000 entries, and request, worker and response buffers are capped independently.

The common management audit records only the Website-scoped action and outcome for upload, edit, mkdir, rename and delete. Paths and file content are not copied into audit metadata. Read Only accounts cannot use these routes. Owner host-file browsing is intentionally not part of this API; it remains a separate future Server context.

Real Ubuntu package, ownership, Nginx continuity and adversarial symlink acceptance remains in `todo.md`; source tests are not host evidence.
