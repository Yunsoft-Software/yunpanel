# Website workspace — implemented UI and remaining work

## What changed

The management entry point `apps/web/src/App.jsx` now renders `workspace/WorkspaceApp.jsx` instead of the previous single `activeView` component. This is mounted code, not an unused design proposal. The existing `main.jsx` still wraps App in **AuthGate**. Login, Owner MFA enrollment, cookies, API authorization and the host/agent architecture were not changed by this UI increment.

The new shell uses a compact light workspace, a 232px dark sidebar, shared buttons/badges/tables/forms and native dialogs. It includes a mobile navigation state with focus handling, a skip link, site search with a keyboard shortcut, page headings and route-based site tabs. These interactions are implemented but still require the browser acceptance below; source styles are not proof of visual/accessibility quality.

React Router is pinned to **8.3.0**, preserving the existing React/Vite versions. Its Data Router is created outside React state and has **no loaders or actions containing protected data**. Workspace API effects run only while the authenticated management UI is mounted. Direct URLs, browser history, query-string filters and unsaved-change navigation blocking replace the old view-name state. References: the official React Router Data Mode installation and navigation-blocking documentation.

## Routes and working API connections

| Route | Implemented surface |
|---|---|
| `/dashboard` | Real inventory counts, server CPU/memory/disk data, certificate warnings and recent jobs. Missing metrics display a dash rather than invented zero values. |
| `/websites` | Explicit domain/subdomain tree; alias search; target/status filters; ascending/descending root-group ordering; pagination that keeps children with their parent; clickable site records. Filter state is in the URL. |
| `/websites/new` | Guided hostname/parent, server, Node/static/proxy target and HTTPS selection. Existing Node targets derive the port from the selected application. The result is a draft domain, not automatic DNS/SSL provisioning. |
| `/websites/:websiteId/:tab?` | Persistent site heading and parent breadcrumb, open-site link, runtime/SSL state and site operation tabs. |
| `/applications`, `/applications/new` | Existing Node/static application lifecycle and creation, deliberate server selection when several servers exist, environment editing and confirmations. |
| `/jobs` | Search/status filters, pagination, job inspection and confirmed cancellation of queued jobs. |
| `/servers`, `/settings`, `/domains` | New summaries and access to existing advanced enrollment, update, domain and certificate tools. Package updates remain hidden in development mode. |

Within a site, the Node/application and Git tabs call the existing deploy, restart, process-status and rollback endpoints. Environment values use the existing masked GET/PUT/DELETE API; removal is confirmed and a successful save is explicitly distinguished from applying a change to the running process. The domain tab calls Nginx stage/activate. SSL calls existing ACME validation/issue and renewal/dry-run endpoints with prerequisites and confirmation for production actions. The logs tab currently shows resource-scoped **job history**, not live Nginx/Node output.

Long operations return tracked queued/running jobs, not an immediate success claim. Closing the operation dialog does not cancel a server-side job. Late collection responses cannot regress a tracked completed job back to queued/running. Terminal history in client memory is bounded while active jobs are retained. Access denial clears observed job state; polling stops on unauthorized/forbidden/not-found responses.

The new collection layer uses the shared session-aware API client, aborts superseded reads, separates resource failures and stops treating 404 as authentication. Network failures can retain clearly marked stale data; access denial does not retain it. One in-flight poll per collection avoids overlapping refreshes. The initial workspace still reads five collections globally; route-specific loading/lazy splitting is remaining optimization work.

## Important boundaries

**This is not the completed Plesk replacement.** The new site URL currently uses the existing **domain ID** as a compatibility view. It does not create the planned independent, persistent Website entity or migrate state.

Node application candidates are identified by the same server and exact proxy/runtime port. A single candidate is displayed; ambiguous matches require a deliberate selection. This is visibly identified as compatibility matching, not a permanent relationship. Static targets are not silently assigned to an application. Persisted website/application/Unix-user links, migration, reparenting and dependency-aware deletion remain in `plan.md`.

Mail, files, databases, Docker lifecycle, cron, backups, audit and terminal backends are not implemented by these screens. Their menu/section states explicitly say so. Runtime version changes, start/stop endpoints, automatic port/document-root allocation, private-repository credential management and live logs also remain open. Existing advanced tools are retained so this UI refactor does not remove working operations before their replacement exists.

Some shared forms now block navigation with unsaved edits, but this has not yet been extended to every legacy advanced form or validated across logout, multiple tabs and all route transitions. There is no claim of a fully validated enterprise design solely from the new stylesheet.

## Blocked user-administration work

Before the UI work, a local user-administration draft was prepared for user creation/update/deactivation/deletion, last-active-Owner protection, optimistic edit revisions and session invalidation. The GitHub connector blocked creation of its `user-admin-store.js` blob because it could not determine the request's safety. That write was **not retried through a different action, encoding or destination**. The backend draft, its password-helper extraction and tests were **not committed**. No user-administration HTTP route or management screen is part of the delivered repository changes. The existing auth implementation on main remains unchanged.

Sixteen local draft tests passed with Node 24.11.1 native Argon2/SQLite and a controlled session lookup. Those are **not** delivered-feature tests or end-to-end authentication tests. Keep the user-management task open; `todo.md` T-USER describes the handoff and required integration checks. Do not mark last-Owner administration controls complete merely because the local draft was tested.

## Validation performed in this UI increment — 2026-09-09

The available native Node runtime was **v24.11.1**. The final focused command passed **22 tests, 0 failed, 0 skipped**:

```bash
node --test \
  apps/web/test/workspace-model.test.js \
  apps/web/test/site-list-model.test.js \
  apps/web/test/application-form.test.js \
  apps/web/test/job-tracking.test.js
```

Counts: twelve collection/site/SSL/job/link model tests, four hierarchy-group pagination tests, three application form mapping tests and three monotonic job-tracking tests. These test pure JavaScript models against fixtures, not rendered React controls or actual hosting operations. JavaScript syntax checks and JSX transpilation/CSS parsing also passed for the new source; these are not a dependency-resolving Vite build.

The container had only a reconstructed source subset. Repository clone/dependency installation was unavailable because of network/DNS restrictions, so **full `npm run check`, Vite production build and complete dependency resolution were not performed**. The project runtime requirement was not lowered and no crypto compatibility bridge was introduced. A local browser preview attempt returned `ERR_BLOCKED_BY_ADMINISTRATOR` before rendering; no alternate route was used to bypass that restriction. Consequently, **no actual React screenshot, responsive layout, keyboard/focus or browser-history acceptance passed in this environment**.

Before publishing a candidate, install the full workspace with the required Node/npm versions, including the new router dependency, run the complete checks and build, and execute `todo.md` T-UI on the built application. Deploy matching API/assets and verify HTTPS deep links without weakening AuthGate, MFA, CSRF or existing network restrictions. Do not install this source increment on a live host merely because the model tests pass.

No new branch, force push, GitHub Actions/workflow, live deployment, root-service change or production data migration was performed. Development stays directly on main.
