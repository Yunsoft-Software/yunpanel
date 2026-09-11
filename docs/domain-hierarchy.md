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

## Guarded site creation

Owner-only site creation uses two authenticated management endpoints:

```text
POST /api/sites/create-preview
POST /api/sites
```

Preview accepts exactly one `input` object. Apply accepts that same input plus the exact current `previewDigest` and typed `confirmation` returned by preview. Both routes require the normal Owner session, Origin, CSRF and MFA management boundary; Read Only is denied before registry access. Both enter the bounded common management audit without persisting request bodies, repository URLs, proxy targets, digests or confirmation text.

The input requires a caller-generated UUID `operationId`, `serverId`, display `name`, canonicalized `primaryDomain`, explicit nullable `parentDomainId`, `wwwMode`, `httpsMode` and one source:

- `existing_application` binds one existing same-server static or Node Application that is not already bound to another Website,
- `new_static` creates a deterministic Application with its canonical managed document root,
- `new_node` creates a deterministic Application and assigns the first collision-free managed port after considering same-server Node Applications and loopback Domain targets; callers cannot supply the port,
- `external_proxy` creates no Application and accepts only a validated DNS/IP host, port and WebSocket flag.

Docker is reported as explicitly unsupported rather than creating a placeholder resource. `wwwMode=alias` keeps `www` as an alias on the primary Domain; `wwwMode=independent` creates a separate child Domain with an explicit parent; `none` creates neither. No parent is inferred from hostname labels.

The operation ID deterministically derives the new Application, Website and Domain IDs. Exact retries are idempotent. If the process stops after an earlier resource is persisted, a new preview reports the completed steps and apply resumes from those resources without duplicating them. Reusing the operation ID for different immutable input, conflicting hostname ownership, changed same-server state or a stale digest fails before further mutation.

Site creation establishes only control-plane Application/Website/hostname desired state. `lifecycle.dnsPublished`, `certificateIssued` and `mailDomainCreated` remain false. `httpsMode=managed` expresses certificate intent on the Domain but does not claim ACME issuance. DNS provider changes, Nginx activation, deploy, certificate issuance and mail provisioning retain their separate guarded job/lifecycle paths.

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

Website/domain identity, DNS hosting/provider state, certificate state and mail-domain/mailbox state remain separate lifecycles. Creating or binding a hostname does not mean DNS propagated, a certificate exists or mail is configured. The site-create result exposes those three external lifecycle outcomes as false rather than fabricating success.

DNS hosting and mail-domain tracking have separate private versioned registries and authenticated inventory APIs:

```text
GET  /api/dns-zones
GET  /api/dns-zones/:dnsZoneId
POST /api/dns-zones
GET  /api/dns-zones/:dnsZoneId/provider-credential
PUT  /api/dns-zones/:dnsZoneId/provider-credential
DELETE /api/dns-zones/:dnsZoneId/provider-credential
POST /api/dns-zones/:dnsZoneId/readiness/refresh
POST /api/dns-zones/:dnsZoneId/records/preview
POST /api/dns-zones/:dnsZoneId/records/apply
GET  /api/mail-domains
GET  /api/mail-domains/:mailDomainId
GET  /api/mail-domains/:mailDomainId/config-preview
POST /api/mail-domains
GET  /api/mailboxes?mailDomainId=<mail-domain-uuid>
GET  /api/mailboxes/:mailboxId
POST /api/mailboxes
POST /api/mailboxes/:mailboxId/password
PATCH /api/mailboxes/:mailboxId
DELETE /api/mailboxes/:mailboxId
```

Owner creation requires exactly `name`, an explicit `webDomainId` or `null`, and `managementMode`. DNS accepts only `external`; mail accepts `external` or `local`. A non-null reference must name the exact canonical web Domain; suffix matching or hostname inference is not used. External resources begin `unverified`; a local mail domain begins `disabled`. Every create response states that DNS was not published and mail/mailboxes were not configured. Read Only may inspect the bounded lifecycle metadata but cannot create or refresh it.

Mail configuration preview is currently a read-only, candidate-domain-only contract. It returns the exact canonical Postfix virtual-domain source map, SHA-256 digest, fixed `postmap`/`postfix check` commands and `sideEffects=false`. An external record returns `readyToApply=false` with `mail_domain_management_mode_external`; a local/disabled record returns `mail_configuration_apply_not_implemented`. No file is staged, compiled or activated. Local apply remains unavailable until the managed-mail lifecycle can aggregate every local domain and provide test plus rollback evidence.

Mailbox create accepts exactly `mailDomainId`, `address` and plaintext `password`; only a `local` mail-domain identity is eligible. Password rotation accepts the exact current `expectedRevision` plus `password`. Enable/disable accepts `expectedRevision + enabled`; delete additionally requires `delete-mailbox:<canonical-address>`. Plaintext passwords, Argon2id hashes and encryption envelopes never appear in responses. Read Only may list and inspect the bounded metadata but cannot mutate it. Every mutation reports that mail configuration and mail data were unchanged; the registry is desired-state metadata, not evidence that a Dovecot account exists. Common management audit retains only bounded action/resource/outcome metadata and never the password or request body.

Readiness refresh accepts exactly the current positive `expectedRevision`. It resolves the linked Domain's canonical hostname and aliases as bounded A, AAAA and CNAME evidence, canonicalizes IPv6, and compares resolved addresses with the explicitly linked managed Server inventory. Missing records, target mismatch, missing expected Server addresses and resolver failures remain distinct authored states; resolver exceptions are never serialized. HTTP-01 additionally requires the current Domain revision to be active. DNS-01 independently reports whether a supported provider credential is configured and distinguishes an unavailable credential store from an absent credential. A successful revision check records only evidence-derived `ready` or `degraded` lifecycle status. It does not publish DNS, contact the provider mutation API or claim certificate issuance.

Cloudflare record mutation is a separate Owner-only two-step path for A, AAAA and CNAME. Preview validates an explicit local web Domain relationship, canonical zone boundary, current zone revision, encrypted credential metadata and the live provider snapshot; it returns the normalized desired record, create/update/delete/no-change effect, a deterministic digest and typed confirmation. Apply recomputes the live preview, rejects provider/credential/zone drift, and queues one resource-locked `dns.record.apply` job. TTL is either provider automatic (`1`) or 60–86400 seconds; proxied records require automatic TTL. The provider token is materialized only inside the local root adapter and is absent from the API result, public/private job payload, recovery result, audit and URL.

The adapter checks the provider post-condition after mutation and returns only bounded record state. An interrupted running job can be resolved, with both command consumers stopped, through `job-recovery.mjs recover-dns-record <server-id> <job-id> --confirm`. Recovery uses the exact private intent and the adapter's idempotent post-condition: an already-applied create/update/delete completes without repeating the write, an unchanged preview snapshot may safely finish the original intent, and drift or provider uncertainty leaves the job unresolved. DNS mutation never marks propagation or certificate readiness; the readiness endpoint must observe public DNS separately.

Nginx stage/activate and managed certificate issue/renew continue through durable jobs and operation-specific recovery. Do not replace them with generic retry/force-success behavior.

Reverse-proxy targets may use canonical DNS, IPv4 or IPv6 hosts. They never accept a URL scheme, path, credentials or control characters; IPv6 is rendered with URL-safe brackets. Node application targets remain backend-assigned loopback ports, while an explicitly selected external-proxy Website may point to a remote origin.

## Reparent and guarded move/delete impact

`POST /api/domains/:domainId/reparent-preview` accepts one explicit `parentDomainId` (or `null` for a root). It validates the exact selected parent, same-server ownership, dot-boundary ancestry and cycles against the current hierarchy; it never derives a parent by trimming hostname labels. The SHA-256 preview digest covers the complete canonical hierarchy snapshot and reports descendants plus Website/certificate references without changing state.

`POST /api/domains/:domainId/reparent` requires that digest and the exact typed confirmation returned by preview. Any hierarchy, Website binding, certificate or desired-revision drift invalidates it before mutation. Reparent is hierarchy-only: it preserves hostname/aliases, Website binding, target, certificate, Nginx stage/apply state and traffic revisions. Read Only cannot call either POST route, and both actions enter common management audit without request bodies or digests.

The broader Owner-only previews are:

```text
POST /api/websites/:websiteId/impact-preview
POST /api/domains/:domainId/impact-preview
```

Delete accepts exactly `{ "operation": "delete" }`. Move accepts exactly `{ "operation": "move", "targetServerId": "<server-uuid>" }`; the target must exist and differ from the current server. The preview digest covers the selected resource plus relevant child/linked Domains, Website/Application binding, explicitly linked DNS zones and mail domains, bounded certificate identity and queued/running jobs. It returns a typed confirmation for future guarded apply, but never mutates state.

Mailbox, backup, cron and Docker providers have explicit bounded adapter slots. Until a real association registry exists, each category is returned with `status=unavailable` and a blocker rather than a fabricated empty list. Provider failure or unsafe/duplicate reference metadata fails the whole preview closed. Certificate email/path/private-key metadata, repository URLs, proxy targets, job payloads/results and external provider data are not copied into the preview.

Every current preview returns `applySupported=false`, `safeToApply=false`, `autoApply=false` and an `impact_apply_not_implemented` blocker. There is deliberately no move/delete apply endpoint yet and no hidden cascade. A future apply path must recompute the digest and resolve every dependency or require an explicit resource-scoped choice; the preview API alone is not evidence that deletion or migration occurred.

## Design status and validation

Visual hierarchy/site-detail redesign is deferred until backend functionality is complete. Do not spend this phase on layout/styling polish.

Authenticated package persistence, Website migration policy, IDN and real DNS/Nginx/ACME acceptance requirements are in `todo.md`. Source implementation and a local Node24 full-workspace check are not production acceptance. GitHub Actions are not used.
