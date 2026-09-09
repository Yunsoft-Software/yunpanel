# YunPanel

YunPanel is Yunsoft's focused hosting and server control plane for managing Node.js, static, Docker, database, domain, SSL, backup and mail workloads without depending on a full Plesk installation.

The project is intentionally scoped around Yunsoft production needs rather than full Plesk feature parity.

## Target architecture and next work

The 2026-09-09 product direction is a website-centric enterprise interface with explicit domain/subdomain/alias hierarchy, real user authentication, an integrated root/site terminal, and a local privileged panel backend instead of a separate `yun-agent` daemon.

**This is the development target, not the current implementation.** The existing gateway uses an IP allowlist and a shared bootstrap management token; it is not a user login/session system. Do not remove the current access restriction or publish a root backend/terminal before the authentication release gate is satisfied. Hosted applications and build scripts must continue to run as dedicated site users even when the management backend runs as root.

See [plan.md](plan.md) for remaining code/UI work and acceptance criteria, [todo.md](todo.md) for pending real-host/DNS/Plesk/browser validation, and [agents.md](agents.md) for updated development rules. Completed tasks are removed from the two task lists; history remains in Git. A planning change does not mean the target has been implemented or deployed.

## Current implementation

The repository has progressed beyond the initial read-only skeleton. Current implemented foundations include:

- React control-plane frontend using JavaScript/JSX only,
- Node.js control-plane API,
- allowlisted `yun-agent` operation protocol with no arbitrary shell endpoint,
- server enrollment, heartbeat and read-only inventory flows,
- Nginx/domain configuration staging and activation foundations,
- ACME certificate issue/renew control-plane flows,
- static application release/deploy/rollback foundations,
- Node.js/systemd deployment with dedicated application users and hardened generated units,
- health-check-based failed-deploy recovery,
- guarded Node manual rollback and restart,
- bounded Node process-status inspection,
- release/state drift validation between control plane and managed server,
- installable Debian package with systemd-owned API, agent and restricted web services,
- fixed-scope APT inspection and self-upgrade jobs with delayed service restart,
- navigation for implemented server, application, domain, certificate, job and update surfaces,
- inline controls for enrollment tokens, application lifecycle/status, protected Node environment values, domain staging/activation, certificate operations and queued-job cancellation,
- separate AES-256-GCM application environment storage,
- masked secret metadata in normal admin reads,
- authenticated just-in-time secret delivery to the assigned server agent,
- atomic root-protected systemd EnvironmentFile materialization for Node deploy/restart/rollback,
- local tests and repository policy validation,
- no GitHub Actions.

Database, Docker lifecycle, mail, backup and audit screens currently expose unavailable/capability states rather than completed management modules. Safe redacted log transport and its operator UI also remain development work. The detailed next-work source is `plan.md`; external validation and operational recovery work stay in `todo.md`.

## Requirements

- Node.js 24+
- npm 11+

## Development

```bash
npm install
npm run dev
```

Current local services, until the agentless migration is implemented:

- web: `http://127.0.0.1:5173`
- API: `http://127.0.0.1:3001`
- agent: `http://127.0.0.1:4010`

Run the complete local validation set with:

```bash
npm run check
```

## Debian package

On an Ubuntu 24.04 build host with Node.js 24 and `dpkg-deb` available:

```bash
npm install
npm run build
./scripts/build-deb.sh 0.2.0-1
```

The current package keeps runtime state under `/var/lib/yunpanel` and configuration/secrets under `/etc/yunpanel`; package upgrades replace application code and systemd units without overwriting those persistent paths. `scripts/publish-local-apt.sh` can publish a built package into a host-local APT repository for controlled validation.

The agentless package migration, authentication bootstrap and PTY dependencies still need implementation and real-host validation. Preserve configuration/state, drain jobs and prove rollback before retiring the old agent service.

See [docs/development.md](docs/development.md) for the existing development setup. Update runtime/package documentation alongside the corresponding code migration rather than presenting the new target as already operational.
