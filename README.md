# YunPanel

YunPanel is Yunsoft's focused hosting and server control plane for managing Node.js, static, Docker, database, domain, SSL, backup and mail workloads without depending on a full Plesk installation.

The project is intentionally scoped around Yunsoft production needs rather than full Plesk feature parity.

## Current UI and target architecture

The management entry point now mounts a **routed website workspace** instead of the old `activeView` panel: compact sidebar, dashboard, searchable domain tree, site detail tabs, guided hostname/application forms and tracked job dialogs. Existing Node deploy/restart/status/rollback, environment, Nginx and ACME operations are available from the relevant site context. See [docs/website-workspace.md](docs/website-workspace.md) for the implemented routes and exact limitations.

**The complete hosting target is not implemented yet.** Site routes currently use existing domain IDs, and Node application candidates are identified by matching server/port; this is not the planned persistent Website/application/Unix-user model. Mail, files, database/Docker lifecycle, cron, backups, audit and terminal modules remain unavailable where their backends are missing. The separate agent is still present. Owner-protected user administration is implemented in the API and Settings workspace, while its complete authenticated-browser acceptance remains open.

The product target remains a website-centric enterprise panel, explicit domain/subdomain/alias ownership, an integrated root/site terminal and a privileged local backend replacing `yun-agent`. Full Node 24 dependency/test/build acceptance and the initial live HTTPS setup/deep-link render now pass; authenticated Owner/MFA, Read Only, responsive/keyboard and complete operation acceptance remain open.

## Authentication boundary

Local Owner setup, login/logout, persistent sessions, password changes/recovery, TOTP enrollment and MFA login/recovery are wired to the API and React entry points. The new UI remains **inside the existing AuthGate**; it does not replace authentication. The web gateway retains its IP allowlist and no longer injects a shared administrator token.

**HTTPS management requires Owner MFA enrollment.** Password-only sessions can complete their own setup/recovery but cannot read or mutate management resources. A dedicated setup workspace precedes entry to the panel, including acknowledgement of recovery codes. Only explicit loopback HTTP development is exempt. See [docs/owner-mfa-policy.md](docs/owner-mfa-policy.md) for prerequisites and validation limits.

Future user-administration, root and socket routes must inherit the same management policy. Do not remove the network restriction or publish root/terminal access before the remaining security release gate is satisfied.

See [plan.md](plan.md) for remaining development work, [todo.md](todo.md) for blocked and real-environment acceptance, and [agents.md](agents.md) for rules. Completed tasks leave the task lists; history stays in Git. Unless explicitly requested otherwise, work directly on **main** in small commits. No GitHub Actions. Repository changes are not a live deployment.

## Implemented foundations

- React/JavaScript/JSX management UI with real routes, site breadcrumbs, URL-backed filters, parent-group pagination, shared controls and unsaved-change handling for new forms.
- Dashboard based on actual inventory/certificate/job data; unavailable metrics remain unknown, and 404 is not mislabeled as authorization.
- Site-scoped existing Node lifecycle, masked environment editing, Nginx stage/activate, ACME issue/test and renewal/dry-run controls, with confirmation for impactful operations.
- Separate queued/running/completed job observation; delayed refreshes cannot regress tracked job state. The site log tab is explicitly job history, not live process logs.
- Initial Owner setup, account/password/session interface, native Argon2id hashing and private SQLite user/session persistence.
- Cookie authentication, Origin/CSRF checks, persistent login throttling, idle/absolute expiry and revocation.
- Encrypted TOTP, second-factor login, one-use recovery codes, factor removal and mandatory Owner enrollment for HTTPS management.
- Session-generation safeguards, expiry warnings, explicit idle extension and local setup/password/MFA-recovery CLI.
- Session-authenticated Node API entry point and retained authenticated `yun-agent` enrollment/heartbeat/command transport pending migration.
- Explicit domain/subdomain parent references, aliases and independent target/certificate lifecycle.
- Nginx configuration staging/activation and ACME issue/renew scheduling foundations.
- Static release/deploy/rollback and Node/systemd deployment with dedicated application users, health-check recovery, guarded rollback/restart and bounded process status.
- Separate AES-256-GCM environment storage, masked metadata, authenticated agent materialization and atomic root-protected systemd EnvironmentFile generation.
- Debian packaging with API/agent/restricted web services and local auth CLI; fixed-scope APT inspection/self-update jobs with delayed restart.
- Existing advanced domain, certificate, enrollment and update tools remain accessible while the underlying legacy architecture is retained.

The new screens do not add missing server operations by themselves. Live redacted logs, persistent Website migration, automatic runtime/port provisioning, private Git credential management, user administration and agentless root/terminal management remain development work. MFA uses manual authenticator-key entry, not QR rendering.

## Requirements and development

- Node.js **24.11.1+**, including native Argon2 and SQLite.
- npm **11+**.
- Install the full workspace dependencies before building. The new UI adds pinned `react-router` **8.3.0** while preserving the existing React/Vite versions; copying only source files is insufficient.

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. In another terminal at the repository root:

```bash
npm run auth -- setup-token
```

Complete Owner setup and sign in. No default credentials are created. The CLI runs in the API workspace so relative state paths match; any explicit API store/database overrides must also reach the CLI. Follow [docs/mfa.md](docs/mfa.md) for MFA keys rather than replacing a working master key. HTTPS management requires enrollment, including after local factor reset.

Current development services are web on port 5173, API on 3001 and the retained agent on 4010. Run the complete checks on the installed workspace:

```bash
npm run check
```

The current combined tree passes **473 tests**, repository policy validation and the Vite production build on supported Node 24 runtimes both locally and on the Ubuntu package build host. The packaged `0.3.0-2` candidate also passed the live initial-setup render, auth boundary, SPA deep-link and hosted-traffic checks recorded in `todo.md`. These results do not replace the remaining authenticated Owner/MFA, Read Only, responsive/keyboard, rollback and full operation acceptance.

## Existing-host upgrade and Debian package

Before upgrading, back up state/configuration and keep independent SSH/provider-console access. Preserve the IP restriction and configure the same exact HTTPS `YUNPANEL_PUBLIC_ORIGIN` in API and web environments. Use a private auth database path inside the service's writable directory. Follow [docs/authentication.md](docs/authentication.md) for ownership/recovery and [docs/mfa.md](docs/mfa.md) for consistent SQLite schema-2 backup/rollback.

Preserve and configure the **existing** `YUNPANEL_SECRET_MASTER_KEY`. Unenrolled Owners cannot complete required MFA without it, and replacing a working key can make existing ciphertext inaccessible. Do not weaken auth or switch production to development to bypass a deployment prerequisite.

On an Ubuntu 24.04 build host with the required runtime and `dpkg-deb`:

```bash
npm install
npm run check
./scripts/build-deb.sh 0.3.0-4
```

The package version above is the existing example, not a new release. Use a new version for a candidate rather than overwriting an APT release. Deploy matching API and built web assets only after T-UI/T1 acceptance. Verify HTTPS deep links, browser back/forward, expired sessions, MFA setup and the preserved advanced operations against the real package. Model tests alone are not rollout approval.

Runtime state stays under `/var/lib/yunpanel`, configuration/secrets under `/etc/yunpanel`. `scripts/publish-local-apt.sh` supports controlled local-APT testing. Agentless package migration and PTY dependencies remain unimplemented; drain jobs and prove rollback before retiring the old service. No package publication, migration or live deployment is performed merely by updating this repository.

[docs/development.md](docs/development.md) describes the existing core/agent setup. The authentication and workspace runbooks define the current entry points and supersede older bootstrap-token or single-view UI examples.
