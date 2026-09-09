# YunPanel

YunPanel is Yunsoft's focused hosting and server control plane for managing Node.js, static, Docker, database, domain, SSL, backup and mail workloads without depending on a full Plesk installation.

The project is intentionally scoped around Yunsoft production needs rather than full Plesk feature parity.

## Current status

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
- guarded Node manual rollback,
- guarded Node manual restart,
- bounded Node process-status inspection,
- release/state drift validation between control plane and managed server,
- installable Debian package with systemd-owned API, agent and restricted web services,
- fixed-scope APT inspection and self-upgrade jobs with delayed service restart,
- working navigation for implemented server, application, domain, certificate, job and update surfaces,
- inline controls for enrollment tokens, application lifecycle/status, protected Node environment values, domain staging/activation, certificate operations and queued-job cancellation,
- separate AES-256-GCM application environment storage,
- masked secret metadata in normal admin reads,
- authenticated just-in-time secret delivery to the assigned server agent,
- atomic root-protected systemd EnvironmentFile materialization for Node deploy/restart/rollback,
- local tests and repository policy validation,
- no GitHub Actions.

Active Node Milestone 4 work is now focused on safe redacted log transport and its operator UI. Real Ubuntu/systemd validation, secret master-key operations and filesystem permission verification are tracked continuously in `todo.md` rather than being treated as completed by code-only tests.

## Requirements

- Node.js 24+
- npm 11+

## Development

```bash
npm install
npm run dev
```

Local services:

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

The package keeps runtime state under `/var/lib/yunpanel` and configuration/secrets under `/etc/yunpanel`; package upgrades replace application code and systemd units without overwriting those persistent paths. `scripts/publish-local-apt.sh` can publish a built package into a host-local APT repository for controlled validation.

See [docs/development.md](docs/development.md) for development details, [plan.md](plan.md) for the living roadmap, [todo.md](todo.md) for real-server/Plesk validation work and [agents.md](agents.md) for binding project rules.
