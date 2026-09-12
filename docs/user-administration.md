# User administration — implementation and acceptance

## Implemented scope

The existing authenticated API now exposes account listing, creation, username/role/activity edits and deletion. The React workspace provides **Settings → Users** at `/settings/users`. This is repository implementation, not a live deployment or production acceptance claim. Existing local Owner setup, password recovery, account self-service, MFA and agent transport are retained.

Owner accounts can manage accounts only through the existing live Owner/MFA policy. HTTPS requires MFA enrollment; the existing explicit loopback HTTP development exception is unchanged. `read_only` accounts still have self-service account access only: this increment does not grant resource viewing, user-list or mutation access. The UI explains that restriction rather than implying an implemented read-only server workspace.

## API contract

Browser requests use `/api/panel/users`; the web gateway forwards them to `/api/users`. Both prefixes on the API use the same session/Origin/CSRF/Owner-MFA boundary. The web gateway does not expose raw `/api/users` as another browser entry point. User administration is deliberately **outside** the `/api/auth/*` self-service exception.

| Method | API path | Input | Successful data |
| --- | --- | --- | --- |
| GET | `/api/users` | Optional numeric `offset` and `limit` query | `{ users, total, offset, limit }` |
| POST | `/api/users` | `{ username, password, role?, active? }` | `{ user, sessionRevoked: false }` with HTTP 201 |
| PATCH | `/api/users/:id` | `{ revision, username?, role?, active? }` | `{ user, sessionRevoked }` |
| DELETE | `/api/users/:id` | JSON `{ revision }` | `{ deleted: true, sessionRevoked }` |

Responses are wrapped in the existing `{ data: ... }` envelope. A public user contains only `id`, `username`, `role`, `active`, `createdAt`, `updatedAt`, `revision` and `mfaEnabled`. Timestamps are integer epoch milliseconds. No password, hash, session token, MFA secret or recovery value is returned by these endpoints.

The API defaults to offset 0 and limit 50; limit is restricted to 1–100 and the UI requests 25. Unknown, duplicate or nonnumeric pagination parameters are rejected. Username normalization and password hashing use the existing auth-store helpers. Roles are `owner` and `read_only`; creation defaults to Owner and active. Updates do not accept password/hash or arbitrary account fields. Password changes remain in account self-service; recovery remains in the existing local CLI.

Mutation requests require JSON, the exact public Origin and the current CSRF header. The shared reader limits the body to 16 KiB. Stale account revision returns `409 user_revision_conflict`; duplicate username returns `409 username_taken`; removing the final active Owner returns `409 last_owner`. Unsupported methods return 405 and malformed account paths return 404. These routes cannot reach the legacy handler as a fallback.

## Transactions, revocation and migration

`user-admin-store.js` shares the auth database and synchronous `BEGIN IMMEDIATE` transaction helper; it does not open a second identity store. Authorization is checked again inside mutations, including after asynchronous password hashing during creation. A concurrent logout, account deactivation/demotion or MFA removal must win before creation commits. Username uniqueness is also checked again after hashing.

Edits/deletion require the listed revision. Role/activity/username changes increment it and revoke all target sessions, pending MFA enrollments and login challenges. Existing enrolled MFA and recovery codes are retained on edits; deletion removes them. No-op updates do not change revision or revoke sessions. User deletion does not delete hosted websites, applications or their data.

The final active Owner cannot be disabled, demoted or removed. The count and mutation occur under the same write transaction; inactive Owners do not satisfy the invariant. A login now snapshots the account row and administration revision in one query, and rechecks the revision after the password KDF. This prevents an in-flight login from surviving a lifecycle change, including changes later reversed back to the original role/activity.

Migration is additive and separately versioned:

- `auth_user_admin_schema`: administration schema version 1; unknown versions fail closed.
- `auth_user_revisions`: per-user revision/update time, removed through the user foreign key. Existing accounts implicitly start at revision 1.
- `auth_user_admin_events`: actor ID, target ID, action and time. It deliberately has no user FK so safe lifecycle records survive account deletion. Records older than 90 days are pruned on administration mutations.

The base authentication schema remains version 2. Existing users, hashes and session IDs are not rewritten at migration. Lifecycle audit and ordinary auth events commit atomically with the account change; audit failure rolls back changes and revocation. The common Owner-only audit screen now exposes bounded lifecycle and management events, including terminal job outcomes, without exposing request bodies or credentials.

Preserve private auth directory/database permissions, the existing service identity and master key. Back up SQLite consistently, not just the main file while WAL writers are active. Exercise startup, repeat migration, backup/restore and older-package behavior on a test copy before release. An old code version does not enforce the new administration-revision login rule; do not assume rollback has identical security behavior or manually drop sidecars on a running service.

## Browser behavior

The page uses existing workspace components, modal and dirty-form routing protection. It includes paginated accounts, role/activity/MFA state, creation/editing, typed username confirmation for deletion and explicit session-impact warnings. There is no persistent account or password cache and no credentials in URLs or localStorage.

`user-admin-client.js` validates response shapes and keeps only public fields. Request sequence, abort signals and session generations reject old responses. Reads are cleared on refresh/error rather than retaining privileged stale account data. Mutations are single-flight; they are never automatically retried. A revision conflict requires reopening the current account; an ambiguous transport/malformed success response requires checking the list before attempting another mutation. An aborted browser request is not proof the server cancelled its transaction.

For a self-edit/delete, the API returns `sessionRevoked` rather than emitting a cookie-deletion header. The session-aware client clears only its current in-memory session and closes the workspace. A delayed response cannot remove a newer login cookie. HTTP permission loss also clears the page/form and returns control to authentication. The existing AuthGate remains the management render boundary.

## Validation performed in this increment (2026-09-09)

The following command passed **37 focused tests** on Node **22.16.0** in a reconstructed source subset:

```bash
node --test \
  apps/api/test/user-admin-store.test.js \
  apps/api/test/user-admin-http.test.js \
  apps/web/test/user-admin-client.test.js
```

The 16 store tests use real native SQLite, foreign keys and transactions, but controlled password/session adapters. The nine HTTP tests use the actual authentication HTTP listener and real SQLite account store with controlled sessions/passwords/MFA state. They cover both API prefixes, anonymous/Read Only/unenrolled Owner denial, Origin/CSRF, last Owner protection, revision conflicts, JSON/path validation and reauthorization after asynchronous work. The 12 browser-client/model tests cover public-field validation, old responses, access loss, generation changes, mutation serialization, self-revocation and ambiguous outcomes. They do not mount React or run in a browser.

Changed backend/client JavaScript passed syntax checks. `UsersPage.jsx`, `WorkspaceApp.jsx` and `OperationsPages.jsx` passed JSX syntax transpilation using the environment's parser; that is not a Vite build, dependency-resolution check or visual/accessibility test. No TypeScript source or runtime dependency was added to the project.

Three additional tests in `apps/api/test/user-admin-native.test.js` exercise real auth-store/native password login, revocation and an in-flight login/rename race. **They were added but could not be executed successfully here.** The source subset lacked the full dependencies and the available Node 22 runtime has no native Argon2. The supported application runtime is still **Node 24.11.1+ / npm 11+**; it was not lowered, and controlled adapters were not substituted into production code.

Before release, run the native tests and unfiltered workspace checks/build, real HTTPS/MFA/gateway/index integration, separate-process concurrent updates, migration/rollback and rendered browser acceptance. Exact handoff is `todo.md` T-USER and T-UI. No live panel, SSH, Debian/APT deployment, root/agentless migration or terminal acceptance was performed. Existing network restrictions remain in force; no GitHub Actions were added or used.
