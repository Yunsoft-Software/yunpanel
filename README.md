# YunPanel

YunPanel is Yunsoft's focused hosting and server control plane for managing Node.js, static, Docker, database, domain, SSL, backup and mail workloads without depending on a full Plesk installation.

The project is intentionally scoped around Yunsoft production needs rather than full Plesk feature parity.

## Current status

Milestone 0 establishes the repository foundation:

- React control-plane frontend using JavaScript/JSX only,
- Node.js control-plane API,
- development-mode `yun-agent`,
- allowlisted API-to-agent operation protocol,
- local tests and repository policy validation,
- no GitHub Actions.

The current agent is read-only and is not ready to mutate production servers.

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

See [docs/development.md](docs/development.md) for development details, [plan.md](plan.md) for the roadmap and [agents.md](agents.md) for binding project rules.
