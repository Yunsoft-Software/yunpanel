# Workspace data loading and view preferences — 2026-09-09

This records the follow-up to the routed workspace. It supersedes the initial global-polling description in `website-workspace.md`; the hosting/backend limitations in that runbook still apply.

## Delivered on main

| Commit | Change |
|---|---|
| `5806e5d` | Fence collection state to its current resource and refresh generation. |
| `9b01a72` | Enable only the collections required by the current page, plus active/observed job monitoring. |
| `105c7e4` | Revalidate job details on every dialog opening; reject wrong IDs and clear inaccessible details. |
| `8e825a4` | Add persisted comfortable/compact density and 10/25/50 parent-group page sizes. |

No new branch, dependency, GitHub Actions workflow, backend privilege change or live deployment is part of this increment.

### Resource lifetime

`useCollection` now associates each response with a scope identity and run number. Switching the path or disabling the resource masks its old data in the first render, before effects run. Older runs cannot populate the new scope. Refreshing the same resource can retain its existing data; transport errors use the existing stale state, while access-denied responses clear data. Disabled resources expose an empty, disabled state rather than a misleading known zero count.

The workspace reads resources according to an explicit route-demand map. Dashboard needs all five collections. Servers and Settings need only servers. The website list needs domains/applications/certificates/servers but not the job inventory. Unimplemented global modules do not poll unrelated inventories. A running tracked job or open job dialog keeps job monitoring enabled across navigation. These are code-level request selections, not measured browser performance benchmarks.

This is not backend resource-scoped pagination or lazy module splitting. Those remain in plan D. The demand map is not an authorization rule: AuthGate, session-aware requests and backend Owner/MFA/Origin/CSRF checks remain unchanged.

### Job details

A job dialog now mounts a fresh observer each time it opens or selects another ID. Until the server verifies that exact job, cached details are not rendered. A wrong ID or malformed result stops observation. A 401, 403 or 404 removes displayed details and does not keep retrying. A transient network error retains only the observer's previously verified data with an explicit warning. Closing the dialog aborts its observer and prevents late responses from updating it; it does not cancel the server job.

Job queue and lifecycle implementations are unchanged. This increment does not claim complete revocation of every cache in every legacy view, nor does it add live process logs, a terminal or audit lifecycle.

### Table preferences

The Web Sites list offers comfortable/compact row spacing and 10/25/50 parent groups per page. Group pagination continues keeping children with their parent. Page-size changes return to page 1 without dropping the URL search/filter values. The preferences have a versioned browser-wide storage entry containing only `version`, `density` and `perPage`. Domain/account/application IDs, searches, credentials and resource payloads are not stored. Invalid data falls back to defaults; blocked storage leaves the control usable in memory and displays a persistence warning. Cross-tab storage-event handling is implemented but requires browser acceptance.

Persistent collapsed branches, column selection and application-list pagination are still remaining tasks. The new CSS source is not a claim of completed visual/accessibility acceptance.

## Validation actually run

**40 tests passed, 0 failed, 0 skipped**, using the available **Node 22.16.0** and a local source subset:

```bash
node --test \
  apps/web/test/collection-scope.test.js \
  apps/web/test/workspace-resources.test.js \
  apps/web/test/job-observation.test.js \
  apps/web/test/website-preferences.test.js \
  apps/web/test/workspace-model.test.js
```

The count comprises 28 new checks (7 scope/generation, 6 route demand, 9 job observation and 6 preferences) and the 12 unchanged workspace model tests. Observer tests use controlled request/timer callbacks; preference tests use storage doubles. They do not mount React or make real HTTP/hosting changes. The unchanged test, site-model and resource-model source copies were verified against their repository Git blob hashes before the run.

The three modified JSX files passed syntax transpilation, the JavaScript passed `node --check`, and the preference stylesheet passed CSS parsing. No TypeScript source or dependency was added; a preinstalled transpiler was used only for the local syntax checks.

Repository cloning failed because the container could not resolve GitHub. Downloading the required Node 24 runtime also failed. Full dependency installation, `npm run check`, Vite production build, native authentication/SQLite/Argon2 tests, real browser/network/storage-event/layout checks, Ubuntu package acceptance and live HTTPS deployment were **not** performed in this increment. The required Node 24.11.1+/npm 11+ runtime was not lowered. The prior increment's native-Node24 or blocked-browser results are historical records, not results from this run.

## User-administration limitation

A fresh `user-admin-store.js` blob write was attempted once and rejected by the connector's safety gate. That rejected write was not retried through another action, encoding or destination. No user-administration source, route, password-helper refactor, tests or UI was committed by this increment. The new local draft was not tested; the older 16-test draft report in `website-workspace.md` must not be attributed to this run. Existing authentication, users, MFA storage and host/agent permissions were not changed.

Keep user administration open under `plan.md` A / `todo.md` T-USER. Native/full-workspace and real-browser acceptance for these UI changes is under `todo.md` T-UI-RUNTIME, in addition to the existing release gates. Do not deploy a privileged/root release or label the whole panel production-ready on the basis of these model tests.
