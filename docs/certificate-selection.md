# Certificate import and selection

YunPanel supports two production certificate sources for a local managed Domain:

- `acme`: Certbot-issued HTTP-01 or Cloudflare DNS-01 material with automatic renewal;
- `custom`: Owner-supplied material with manual renewal.

ACME DNS-01 can issue exact-name or wildcard certificates. Custom wildcard material can also cover an ordinary current hostname when X.509 wildcard matching permits it. Website hostname state never becomes wildcard state: `domains` remains the exact current primary hostname and aliases, while ACME's actual SAN request is stored separately as `certificateNames`.

## Managed ACME challenge flow

`POST /api/domains/:domainId/certificates/issue` accepts only `email`, `staging` and optional `challenge`. Omitting the challenge, or sending exactly `{ "type": "http-01" }`, keeps the existing webroot flow and requires the current Domain revision to be active.

DNS issuance sends exactly `{ "type": "dns-01", "dnsZoneId": "<uuid>", "wildcard": true|false }`. It is limited to the local managed Server. The selected persistent DNS zone must contain the Domain's primary hostname and every alias, and that zone must have a configured Cloudflare credential. Exact DNS-01 requests use the current hostname set. A wildcard request asks for the zone apex plus `*.zone`; any deeper hostname not covered by that one-label wildcard remains an explicit SAN. DNS-01 does not claim that Nginx or general DNS records are active.

Provider credentials are Owner-only:

- `GET /api/dns-zones/:dnsZoneId/provider-credential` returns masked configuration metadata;
- `PUT` accepts exactly `provider`, `token` and `confirmation=configure-dns-provider:<zone-uuid>:cloudflare`;
- `DELETE` accepts exactly `confirmation=delete-dns-provider:<zone-uuid>`.

The token is AES-256-GCM encrypted in `YUNPANEL_DNS_CREDENTIAL_STORE` with `YUNPANEL_SECRET_MASTER_KEY`. Public certificate/job/audit data carries only the bounded provider, credential ID, DNS-zone ID and propagation delay. The local root executor decrypts the token only when it claims the exact certificate operation. Certbot receives a mode-`0600` temporary credentials file below `/run/yunpanel/acme-credentials`; the token is never placed in argv and the temporary directory is removed after success or failure.

Production and dry-run renewal reuse the challenge bound to the certificate record. Manual renewal and the automatic renewal sweep both require the same credential ID/provider still to be configured; automatic scheduling skips DNS certificates whose credential is unavailable instead of queuing an operation that cannot materialize its secret. The Ubuntu package installs the Cloudflare Certbot plugin, but actual Cloudflare authorization, TXT propagation/cleanup and Let's Encrypt behavior are external acceptance work in `todo.md`.

## Guarded Owner flow

Custom import is a two-step operation. `POST /api/domains/:domainId/certificates/custom-preview` accepts exactly `certificatePem`, `chainPem` and `privateKeyPem`. The leaf certificate must be current, cover the Domain's exact primary hostname and aliases, begin the supplied full chain, and match the unencrypted private key. The response returns only bounded certificate metadata, an SHA-256 preview digest and typed confirmation; it never echoes PEM, key or material paths.

`POST /api/domains/:domainId/certificates/custom` accepts the same material plus that exact `previewDigest` and `confirmation`. The API repeats every inspection after obtaining a Domain-scoped operation lock. Domain revision, selected certificate, material or active work drift makes the preview stale before installation. Concurrent import/selection requests for one Domain are serialized.

An existing active or superseded production certificate can be reselected with `POST /api/domains/:domainId/certificates/:certificateId/select-preview`, using an empty JSON object, followed by `POST /api/domains/:domainId/certificates/:certificateId/select` with the returned digest and confirmation. Selection is limited to the same local Server and Domain. The API re-opens the exact fixed material paths and verifies certificate/key identity, chain leaf, validity, hostname coverage and persisted fingerprint before changing the Domain reference.

Both successful operations attach the selected certificate to desired Domain state. They do not claim that Nginx has changed: the Owner must run the ordinary Domain stage and activation jobs. Only after attachment succeeds are other production records for that Domain marked `superseded`. Manual custom certificates never enter the automatic renewal sweep or ACME renew route.

## Material boundary and recovery

Custom material is installed by the packaged root API below `/var/lib/yunpanel/control-plane/custom-certificates/<certificate-uuid>` when the standard certificate store path is used. The root directory and certificate directory are `0700`; `cert.pem`, `fullchain.pem` and `privkey.pem` are `0600`. IDs and paths are deterministic registry metadata, symlinked custom files are rejected, and an installation whose registry write fails is cleaned up. If later Domain attachment fails, the registered certificate remains visible and selectable rather than deleting operator-supplied material during an uncertain outcome.

Certbot paths remain fixed below `/etc/letsencrypt/live/<cert-name>`. Certbot symlinks are allowed only at those exact paths. Production issue/renew inspection now reads both `cert.pem` and `privkey.pem` and rejects a mismatch before returning a successful result. Domain staging repeats stored-material inspection for the local Server, including custom material, so post-import file replacement fails before a TLS job is queued.

Public import/selection responses omit PEM, private-key paths and material digests. Common management audit records only the bounded Domain-scoped action and outcome; request bodies are not audit metadata. Certificate registry state upgrades in memory from version 1 ACME records through version 2 source/renewal metadata to version 3 `certificateNames`/challenge metadata and is written only on the next mutation.

Source tests use real short-lived OpenSSL certificates to cover matched and mismatched keys, wildcard hostname coverage, private file modes, concurrent import, selection, store migration, ACME inspection, private DNS credential materialization/cleanup and post-import tamper rejection. The required packaged Ubuntu, Nginx, Cloudflare/Let's Encrypt, HTTPS, permission, restart, upgrade and backup/restore acceptance remains in `todo.md`.
