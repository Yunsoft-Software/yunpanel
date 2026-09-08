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
- local tests and repository policy validation,
- no GitHub Actions.

Active Node Milestone 4 work is focused on protected user environment/secrets, safe redacted log transport and the environment/log UI. Real Ubuntu/systemd validation is tracked continuously in `todo.md` rather than being treated as completed by code-only tests.

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

See [docs/development.md](docs/development.md) for development details, [plan.md](plan.md) for the living roadmap, [todo.md](todo.md) for real-server/Plesk validation work and [agents.md](agents.md) for binding project rules.
