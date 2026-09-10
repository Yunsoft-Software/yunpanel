# Website workspace — current backend boundary

Visual redesign/layout/styling/component polish remains deferred. This document only describes the backend contracts the later UI must consume.

## Persistent Website resource

YunPanel has a real persistent Website resource separate from hostname/domain records.

Implemented backend contracts:

- `GET /api/websites`
- `GET /api/websites/:websiteId`
- `GET /api/websites/:websiteId/domains`
- `POST /api/websites`
- `GET /api/websites/migration/preview`
- `POST /api/websites/migration/bind`

Website state is stored separately through `YUNPANEL_WEBSITE_STORE`. Production startup validates persisted Website server/application foreign keys before accepting the store.

An application-backed Website owns stable Website UUID, server/application IDs, runtime type, canonical managed document root and deterministic `yunapp-*` Unix user. A proxy Website is a real resource without an invented application/document root/Unix user.

The Website ID is not a domain ID. Backend relationships use explicit foreign keys rather than permanent server/port/root heuristics.

## Domain relationship and IDN

Domain records may persist `websiteId`. `GET /api/websites/:websiteId/domains` reads only that explicit field; it does not infer membership from hostname, parent suffix, proxy port or application root.

Legacy domain state without the field opens as `websiteId=null`. A one-way registry primitive can bind an unbound legacy domain to one same-server Website without changing its current Nginx desired/applied revision. Rebinding an already-bound domain is blocked until impact-preview/move semantics exist.

Shared hostname validation canonicalizes IDN input to ASCII punycode. Unicode/punycode equivalents therefore collide as the same hostname/alias and hierarchy comparisons use one canonical form.

## Migration preview and guarded bind

`GET /api/websites/migration/preview` is Owner-only and read-only. It examines current persisted Domain/Website/Application state and reports safe migration decisions without mutating state. Static legacy targets match applications only by exact managed web root; Node targets match only same-server loopback proxy + exact current port. Multiple matches are `ambiguous`; no safe match is `unresolved`.

A single exact application candidate produces either `bind_existing_website` or `create_website_then_bind`. These are migration suggestions only: preview explicitly returns `destructive=false` and `autoApply=false`.

`POST /api/websites/migration/bind` only performs the existing-Website case. It accepts canonical Domain/Website UUIDs plus typed confirmation, recomputes the current preview immediately before mutation and permits only the exact currently-authorized existing Website relationship. Retry of the same completed binding is idempotent.

The backend intentionally does not combine Website creation and Domain binding into one call because those registries are independent durable files and no cross-registry transaction exists. The operator/API must create the Website explicitly, re-run preview and then bind.

Both migration endpoints remain Owner-only. Migration bind is covered by common management audit; request bodies/confirmation are not copied into audit metadata.

## Authentication/access boundary

All Website management enters through the authenticated API listener. Owner management requires normal session/MFA/Origin/CSRF policy. Read Only accounts may read Website collection/detail and explicit Website→domains relation; Website creation and migration remain Owner-only.

Caller input cannot set `documentRoot` or `unixUser`; those values are derived from managed application identity.

## Existing hosting functionality available to the future UI

The later Website UI can build on server inventory/snapshots, static and Node deployment lifecycle, masked/encrypted application env, Nginx stage/activate, managed ACME, managed services, DB inventory/create/delete, durable jobs/recovery, common audit and Owner user administration.

A `202` response is queued/accepted work, not completion.

## Remaining backend work

See `plan.md` C/E/F/G/H/I. Persistent Website foundation and guarded legacy existing-Website bind do **not** complete migration. Remaining Website/domain work includes:

- versioned migration plan/digest and rollback orchestration,
- explicit create-Website step for safe migration candidates that have no Website,
- mandatory Website binding for new managed domains only after rollback-safe transition,
- Website update/rebind lifecycle,
- reparent/move/delete impact preview,
- site-create orchestration,
- DNS/mail lifecycle separation,
- Docker/static/Node/site-resource relationships beyond current application/domain links.

## Design status

Do not spend the current development phase on visual Website workspace polish. The existing React workspace may retain compatibility routing/data shapes until a later integration pass. Final enterprise UI/UX is intentionally assigned to a separate model after functionality is complete.

Security behavior, authenticated routing, stale privileged-data handling and destructive confirmation are not optional visual polish and remain subject to `todo.md` acceptance.

## Validation

Current full Node24/workspace, browser, package persistence, Website foreign-key, IDN and migration acceptance are tracked in `todo.md`. Historical UI/model tests are not evidence that the current tree passed. GitHub Actions are not used.
