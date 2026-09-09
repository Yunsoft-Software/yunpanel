# YunPanel

YunPanel is Yunsoft's focused hosting and server control plane for managing Node.js, static, Docker, database, domain, SSL, backup and mail workloads without depending on a full Plesk installation.

The project is intentionally scoped around Yunsoft production needs rather than full Plesk feature parity.

## Target architecture and next work

The product direction is a website-centric enterprise interface with explicit domain/subdomain/alias hierarchy, an integrated root/site terminal, and a local privileged panel backend instead of a separate `yun-agent` daemon.

**The complete target is not implemented yet.** Local Owner setup, user login/logout, persistent sessions, password changes and recovery are now implemented and wired to the API and React entry points. The gateway retains its IP allowlist as an additional restriction but no longer injects a shared administrator token. TOTP, user administration, the agentless/root backend, terminal and website hierarchy remain planned work. Do not remove the current access restriction or publish a root backend/terminal before the remaining security release gate is satisfied.

See [plan.md](plan.md) for remaining code/UI work and acceptance criteria, [todo.md](todo.md) for pending real-host/DNS/Plesk/browser validation, and [agents.md](agents.md) for development rules. Completed tasks leave the task lists; history remains in Git. Repository changes are not a live deployment.

## Current implementation

Implemented foundations include:

- React control-plane frontend using JavaScript/JSX only,
- initial Owner setup, login and account/password/session-management interface,
- Argon2id password hashing and private SQLite user/session persistence,
- cookie-based HTTP authentication, Origin/CSRF protection, persistent login throttling and session expiry/revocation,
- local one-time setup-token and password-recovery CLI,
- Node.js control-plane API with a session-authenticated network entry point,
- allowlisted `yun-agent` operation protocol, still retained until the agentless migration,
- server enrollment, heartbeat and read-only inventory flows,
- Nginx/domain configuration staging and activation foundations,
- ACME certificate issue/renew control-plane flows,
- static application release/deploy/rollback foundations,
- Node.js/systemd deployment with dedicated application users and hardened generated units,
- health-check-based failed-deploy recovery,
- guarded Node manual rollback and restart,
- bounded Node process-status inspection and release/state drift validation,
- Debian packaging with API, agent and restricted web services, plus packaged local authentication CLI,
- fixed-scope APT inspection and self-upgrade jobs with delayed service restart,
- navigation for implemented server, application, domain, certificate, job and update surfaces,
- inline controls for enrollment tokens, application lifecycle/status, protected Node environment values, domain staging/activation, certificate operations and queued-job cancellation,
- separate AES-256-GCM environment storage, masked admin metadata and authenticated just-in-time delivery to the assigned server agent,
- atomic root-protected systemd EnvironmentFile materialization for Node deploy/restart/rollback,
- local tests and repository policy validation,
- no GitHub Actions.

Database, Docker lifecycle, mail, backup and audit screens currently expose unavailable/capability states rather than completed management modules. Safe redacted log transport, the enterprise website workspace and agentless operations remain development work.

## Requirements

- Node.js **24.11.1+**, including native Argon2 and SQLite
- npm 11+

## Development and first login

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. In another terminal at the repository root, generate the one-time setup token:

```bash
npm run auth -- setup-token
```

Complete the Owner form and then sign in. No default credentials are created. The CLI runs in the API workspace to match its default state directory; explicit API store/database overrides must also be provided to the CLI.

Current local services, until the agentless migration:

- web: `http://127.0.0.1:5173`
- API: `http://127.0.0.1:3001`
- agent: `http://127.0.0.1:4010`

Run the complete repository validation on a fully installed workspace:

```bash
npm run check
```

The auth increment's focused tests and environment limitations are recorded in [docs/authentication.md](docs/authentication.md). A focused test run is not a complete build or live-server validation.

## Existing-host upgrade and Debian package

**Before upgrading:** configure the same exact HTTPS `YUNPANEL_PUBLIC_ORIGIN` in both API and web environments. The new API fails closed if this is absent. Set a private auth database path inside the API service's writable state directory; preserve the IP restriction and independent SSH access. Follow [docs/authentication.md](docs/authentication.md) for setup, recovery, database permissions and consistent SQLite backup.

On an Ubuntu 24.04 build host with the required Node runtime and `dpkg-deb`:

```bash
npm install
npm run build
./scripts/build-deb.sh 0.2.0-1
```

Use a new package version when publishing a new candidate rather than overwriting an existing APT release. No release or live deployment is performed merely by updating these sources.

The package keeps runtime state under `/var/lib/yunpanel` and configuration/secrets under `/etc/yunpanel`. `scripts/publish-local-apt.sh` supports a host-local APT repository for controlled validation. The authentication package changes still require a real install/upgrade test. The agentless package migration and PTY dependencies remain to be implemented; preserve state, drain jobs and prove rollback before retiring the old agent service.

See [docs/development.md](docs/development.md) for the existing core/agent development setup; [docs/authentication.md](docs/authentication.md) defines the current network authentication boundary and supersedes old bootstrap-token management examples.
