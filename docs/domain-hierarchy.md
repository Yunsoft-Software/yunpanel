# Domain hierarchy — current backend boundary

## Current model

Domains and Websites are separate persistent backend resources.

A `Website` has its own stable UUID and owns the server/application/runtime/document-root/Unix-user binding. A domain record owns hostname-oriented state and may carry an explicit `websiteId` foreign key plus an explicit `parentDomainId`.

Current Website rules:

- Website identity is independent from hostname/domain IDs,
- application-backed static/Node Websites derive canonical document root and deterministic `yunapp-*` user from the application ID,
- one application cannot be silently bound to multiple Websites,
- persisted Website records revalidate server/application references at startup,
- missing/cross-server/runtime/root drift fails closed,
- proxy Websites remain valid without inventing an application or Unix user,
- `/api/websites`, `/api/websites/:id` and `/api/websites/:id/domains` read real Website state rather than same-server/port inference.

Current domain hierarchy rules:

- `parentDomainId` is explicit; ancestry is never guessed from the final two labels,
- parent/child must share a server,
- the normalized child hostname must be below the parent's primary hostname at a dot boundary,
- duplicate IDs, missing parents and cycles fail closed,
- aliases remain attached names and are not silently promoted into independent parent resources,
- Owner reparent preview/apply keeps the hostname, Nginx target, certificate and desired/applied traffic revisions unchanged,
- an explicit Website binding requires an existing Website on the same server,
- a legacy unbound domain can migrate one-way from `websiteId=null` to one exact Website; general rebind remains blocked until impact-preview/move semantics exist.

## Hostname normalization

Shared hostname validation canonicalizes internationalized domain names through Node's UTS-46/ASCII conversion. Unicode and equivalent punycode forms persist and compare in one ASCII representation. Unicode dot variants are normalized before conversion.

Duplicate domain/alias and parent-boundary checks operate on that canonical ASCII form. Wildcards remain outside the ordinary hostname validator and are a separate DNS/certificate feature.

## Migration boundary

Existing domain files with no `websiteId` still open as `websiteId=null`; startup does not invent bindings from hostname, server or port.

Owner-only migration management endpoints are:

```text
GET  /api/websites/migration/preview
GET  /api/websites/migration/status
POST /api/websites/migration/bind
POST /api/websites/migration/create-website
POST /api/websites/migration/finalize
POST /api/websites/migration/rollback
POST /api/websites/migration/rollback-binding
```

The read-only preview examines current persisted Domain/Website/Application state. For each legacy domain it may report `already_bound`, `ready / bind_existing_website`, `ready / create_website_then_bind`, `ambiguous` or `unresolved`.

Static candidate discovery requires exact current managed document-root equality. Node candidate discovery requires the same server, loopback proxy host and exact current port. These matches are migration **candidates**, not permanent foreign keys. The preview returns `destructive=false`, `autoApply=false` and a deterministic SHA-256 `digest`; target paths and ports are not copied into its safe result.

`POST /api/websites/migration/bind` only handles the existing-Website case. It requires canonical Domain/Website IDs, the exact current preview digest and typed confirmation. The server recomputes the preview before mutation. Stale, ambiguous, unresolved, create-Website or different-Website plans fail closed. Repeating the exact successful bind is idempotent.

Website creation and Domain binding are deliberately not combined into a fake cross-registry transaction. The durable migration ledger makes `create_website_then_bind` repeatable as explicit Website creation, a refreshed preview and guarded binding.

## Binding enforcement policy

Website-binding enforcement has its own versioned durable policy state. The policy starts in `compatibility` mode. It can be finalized to `enforced` only when a freshly recomputed preview with the exact supplied digest shows every managed Domain as `already_bound` and no ready/ambiguous/unresolved items remain.

In `enforced` mode, creating a new managed Domain without an explicit same-server `websiteId` fails closed. Existing legacy state remains readable and the migration bind primitive remains available so rollback/recovery is not stranded.

Policy rollback requires the exact enforced digest and returns only the policy to `compatibility`; it does not rewrite Nginx traffic targets, certificates, application releases or other resource state. Policy transitions and migration binds are covered by common management audit without copying request bodies/digests into audit metadata.

Migration Website create/bind and binding rollback use a durable ledger so interrupted calls can be reconciled without guessing. General Website rebind/unbind is not part of the migration escape hatch.

## Website/domain relationship reads

`GET /api/websites/:websiteId/domains` returns only domains whose persisted `websiteId` equals that Website ID. It does not infer a relationship from proxy ports, static roots or hostname suffixes. Read Only accounts may use this safe relationship read; unrelated nested Website management and migration remain Owner-only.

## DNS, SSL and mail separation

Website/domain identity, DNS hosting/provider state, certificate state and mail-domain/mailbox state remain separate lifecycles. Creating or binding a hostname does not mean DNS propagated, a certificate exists or mail is configured.

Nginx stage/activate and managed certificate issue/renew continue through durable jobs and operation-specific recovery. Do not replace them with generic retry/force-success behavior.

Reverse-proxy targets may use canonical DNS, IPv4 or IPv6 hosts. They never accept a URL scheme, path, credentials or control characters; IPv6 is rendered with URL-safe brackets. Node application targets remain backend-assigned loopback ports, while an explicitly selected external-proxy Website may point to a remote origin.

## Reparent and remaining move/delete rule

`POST /api/domains/:domainId/reparent-preview` accepts one explicit `parentDomainId` (or `null` for a root). It validates the exact selected parent, same-server ownership, dot-boundary ancestry and cycles against the current hierarchy; it never derives a parent by trimming hostname labels. The SHA-256 preview digest covers the complete canonical hierarchy snapshot and reports descendants plus Website/certificate references without changing state.

`POST /api/domains/:domainId/reparent` requires that digest and the exact typed confirmation returned by preview. Any hierarchy, Website binding, certificate or desired-revision drift invalidates it before mutation. Reparent is hierarchy-only: it preserves hostname/aliases, Website binding, target, certificate, Nginx stage/apply state and traffic revisions. Read Only cannot call either POST route, and both actions enter common management audit without request bodies or digests.

Future move/delete operations require a broader backend impact preview covering at least child domains, Website/application bindings, certificates, mail resources, backups and later cron/Docker dependencies. Default behavior must fail closed when dependent resources would be orphaned; hidden cascade deletion is not acceptable.

## Design status and validation

Visual hierarchy/site-detail redesign is deferred until backend functionality is complete. Do not spend this phase on layout/styling polish.

Current Node24/full-workspace, authenticated API, package persistence, Website migration policy, IDN and real DNS/Nginx/ACME acceptance requirements are in `todo.md`. Source implementation is not production acceptance. GitHub Actions are not used.
