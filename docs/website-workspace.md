# Website workspace — current compatibility boundary

This document describes the current management workspace boundary that matters to backend development. Visual redesign, layout/styling and component polish are deliberately deferred by the 2026-09-10 execution decision; see `agents.md` and `plan.md`.

## Current routing and authentication boundary

`apps/web/src/App.jsx` mounts the routed workspace behind `AuthGate`. Protected management data is loaded only after the authenticated session boundary. Owner/Read Only authorization, Owner MFA, CSRF/Origin checks and backend route guards remain authoritative; hiding a button in React is never treated as authorization.

Current routes include dashboard, websites/site detail, applications, domains, servers, databases, jobs and settings/users. Direct URL/deep-link/browser-history behavior exists in the routed workspace but current browser acceptance remains in `todo.md`.

The server setup UI no longer provisions enrollment tokens. New server ownership is agentless and operator-driven through the packaged migration CLIs documented in `docs/local-runtime-migration.md`. The removed `/api/servers/enroll` and `/api/dev/agent/inspect` compatibility paths must not be reintroduced by workspace work.

## Current Website compatibility limitation

**There is still no independent persistent `Website` resource.** `/websites/:websiteId/...` remains a compatibility view over the existing domain/application records. The planned permanent model in `plan.md` must separate:

- Website identity,
- domain/subdomain/alias identity and explicit parent relationships,
- application/runtime binding,
- document root,
- deterministic site Unix user,
- DNS-hosting and mail-domain lifecycles.

Existing compatibility matching must not be mistaken for a durable foreign-key relationship. A domain ID is not the future Website ID.

## Existing backend connections

The current workspace can call implemented backend foundations including:

- authenticated server inventory and persisted local snapshots,
- static application deploy/rollback,
- Node deploy/restart/status/rollback,
- encrypted/masked application environment management,
- Nginx domain stage/activate,
- managed ACME certificate issue/renew foundations,
- managed-service inspection/install/start/stop/restart,
- MySQL/MariaDB inventory and database create/delete,
- durable jobs and job cancellation where allowed,
- Owner-protected user administration.

Long host operations are durable jobs. A `202` response means accepted/queued, not completed. Running/uncertain work must follow the durable recovery rules rather than a blind retry.

## Missing backend functionality

The workspace must not present the following as implemented merely because a route/tab/menu entry exists:

- persistent Website resource and migration,
- complete Node runtime/version/start-stop configuration management,
- private Git credentials and explicit commit/tag deployment selection,
- live Node/Nginx/deploy log backend,
- real PTY terminal and site file manager,
- full Docker/Compose lifecycle,
- site cron,
- general application/DB/volume/mail backup product,
- DNS provider/resolver management and DNS-01/wildcard certificates,
- complete mail/Roundcube lifecycle,
- common durable audit backend,
- Plesk importer/migration.

See `plan.md` for the remaining implementation list. Do not add fake data or inert controls to make these modules appear complete.

## Access and data-loading constraints

Read Only sessions may access only backend-declared read-only inventory surfaces. Jobs/users/env/nested host management and mutations remain Owner-only unless the backend access policy explicitly changes. Browser request selection is an optimization and must never become an authorization mechanism.

Resource transitions must remain scoped: a stale response from a previous route/resource must not overwrite the current view. Access denial must clear privileged cached data. Job detail must be tied to the exact server-verified job identity rather than stale client state.

## User administration

Owner-protected user administration is now implemented in the backend and workspace; the older statement that it was only an uncommitted draft is obsolete. Real browser/process/concurrency acceptance is still open in `todo.md` T-USER and T-AUTH. Last-Owner protection, session revocation effects and MFA-related races must not be considered production-ready until those acceptance items pass.

## Design status

The existing workspace is functional scaffolding, not the final visual target. Do not spend the current backend development phase on layout, styling, typography, visual table polish or responsive redesign. A separate model will handle the enterprise UI/UX pass after functionality is complete.

Security/browser behavior that materially protects authentication, authorization, destructive forms, WebSocket/terminal access or stale privileged data is **not** considered optional design polish and remains part of the relevant backend/security acceptance.

## Validation status

Historical UI/model test runs are preserved in Git history and dated historical documents such as `docs/ui-runtime.md`; they do not prove the current tree. The current full Node 24, Vite build, real browser and package-host acceptance requirements live in `todo.md`.

Do not claim current visual quality, full browser acceptance or production readiness unless those current acceptance steps were actually run. GitHub Actions are not used for this project.
