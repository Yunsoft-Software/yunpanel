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
- `websiteId` is optional only for legacy/migration compatibility,
- an explicit Website binding requires an existing Website on the same server,
- a legacy unbound domain can migrate one-way from `websiteId=null` to one exact Website; changing an existing binding requires a future impact-preview path.

## Hostname normalization

Shared hostname validation canonicalizes internationalized domain names through Node's UTS-46/ASCII conversion. Unicode and equivalent punycode forms persist and compare in one ASCII representation. Unicode dot variants are normalized before conversion.

Duplicate domain/alias and parent-boundary checks operate on that canonical ASCII form. Wildcards remain outside the ordinary hostname validator and are a separate DNS/certificate feature.

## Migration boundary

Existing domain files with no `websiteId` still open as `websiteId=null`; startup does not invent bindings from hostname, server or port.

A read-only migration planner is now available at:

```text
GET /api/websites/migration/preview
```

It is Owner-only and never mutates state. For each legacy domain it may report:

- `already_bound` when an explicit Website relationship already exists,
- `ready / bind_existing_website` when exactly one matching application already has a Website,
- `ready / create_website_then_bind` when exactly one matching application exists but has no Website yet,
- `ambiguous` when multiple applications match the old traffic target,
- `unresolved` when no safe mapping exists.

Static candidate discovery requires exact current managed document-root equality. Node candidate discovery requires the same server, loopback proxy host and exact current port. These matches are migration **candidates**, not permanent foreign keys. The preview returns `destructive=false` and `autoApply=false`; target paths and ports are not copied into its safe result.

A guarded one-way existing-Website bind is available at:

```text
POST /api/websites/migration/bind
```

The request accepts only canonical `domainId`, `websiteId` and typed confirmation. The server recomputes the migration preview immediately before mutation and permits the bind only when the current preview still says that exact existing Website is ready. Ambiguous, unresolved, `create_website_then_bind`, stale or different-Website states do not mutate the domain. Repeating the exact successful bind is idempotent.

The endpoint deliberately does **not** create a Website and bind a Domain in one call because the two registries are separate durable files and there is no cross-registry transaction yet. Create the Website explicitly, re-run preview, then bind it.

Remaining migration work is versioned plan/digest + rollback orchestration and eventual policy transition that makes Website binding mandatory for new managed domains without breaking legacy rollback. Domain/application IDs, traffic targets, certificate links, encrypted secrets and release history must remain stable.

## Website/domain relationship reads

`GET /api/websites/:websiteId/domains` returns only domains whose persisted `websiteId` equals that Website ID. It does not infer a relationship from proxy ports, static roots or hostname suffixes. Read Only accounts may use this safe relationship read; unrelated nested Website management and migration remain Owner-only.

## DNS, SSL and mail separation

Website/domain identity, DNS hosting/provider state, certificate state and mail-domain/mailbox state remain separate lifecycles. Creating or binding a hostname does not mean DNS propagated, a certificate exists or mail is configured.

Nginx stage/activate and managed certificate issue/renew continue through durable jobs and operation-specific recovery. Do not replace them with generic retry/force-success behavior.

## Delete/move/reparent rule

Future reparent/move/delete operations require a backend impact preview covering at least child domains, Website/application bindings, certificates, mail resources, backups and later cron/Docker dependencies. Default behavior must fail closed when dependent resources would be orphaned; hidden cascade deletion is not acceptable.

## Design status and validation

Visual hierarchy/site-detail redesign is deferred until backend functionality is complete. Do not spend this phase on layout/styling polish.

Current Node24/full-workspace, authenticated API, package persistence, IDN, Website/domain migration and real DNS/Nginx/ACME acceptance requirements are in `todo.md`. Source implementation is not production acceptance. GitHub Actions are not used.
