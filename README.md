# Xlaunch Gateway

Xlaunch Gateway is a self-hosted LLM gateway: one OpenAI-compatible endpoint
that routes each request across 45 free-tier providers with automatic
failover, per-key quota tracking and cooldowns, so a single unified key keeps
working while individual providers rate-limit, error, or run out of quota.

Alongside `/v1/chat/completions` it speaks the Anthropic Messages API
(`/v1/messages`), the OpenAI Responses API (`/v1/responses`), the Gemini wire
format (`/v1beta`), an Ollama emulation (`/api/chat`, `/api/generate`,
`/api/tags`, `/api/show`, `/api/version`) and MCP at `/mcp`. A React dashboard
manages provider keys, routing chains, client profiles, URL tokens, the
playground, analytics, logs, fusion, prompt compression, the response cache
and backups. The model catalog ships with the bundled database migrations.

Everything runs locally: Node/Express, SQLite, and a static React build served
from the same process. MIT licensed; see `LICENSE`.

## Quick start

Requires Node.js 20.18+ and npm 10+.

```bash
npm install
npm run build
npm start --workspace server      # or: node server/dist/index.js
```

The server listens on port 3001 and serves the dashboard at
http://localhost:3001 and the API at http://localhost:3001/v1.

On first run no dashboard account exists yet. A browser on the same machine
can create it directly; from any other machine the setup form also asks for
the one-time **setup code** printed in the server log at startup. After
signing in, add provider keys on the **Keys** page and copy the unified
`xlaunch-...` key from the **Agents** page.

```bash
curl http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer xlaunch-your-unified-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'
```

`model: "auto"` lets the router pick; any catalog model id pins that model.

For development, `npm run dev` starts the server and the Vite dashboard
(port 5173) together. Docker: `docker compose up -d --build` builds the image
locally as `xlaunch-gateway:latest` (see `docker/README.md`). A menu-bar
desktop app lives in `desktop/`.

## Environment variables

Copy `.env.example` to `.env`; every variable is documented there. The
important ones:

| Variable | Purpose |
| --- | --- |
| `ENCRYPTION_KEY` | 64-char hex key encrypting provider keys at rest. Required in production; auto-generated to `.encryption-key` otherwise. |
| `PORT`, `HOST` | Listen port (default 3001) and interface (default `::`). |
| `PUBLIC_URL` | The address customers reach the gateway at, e.g. `https://gateway.xlaunch.work`. The dashboard prints it as the API base. Unset, the dashboard prints its own origin, which is only right when the browser and the API share a host. Must be an http(s) URL or the server refuses to start. |
| `XLAUNCH_GATEWAY_DB_PATH` | SQLite file location (default `server/data/xlaunch-gateway.db`). |
| `XLAUNCH_GATEWAY_DB_DIR_HARDENING` | Tighten permissions on the data directory. |
| `XLAUNCH_GATEWAY_DB_BACKUP_PATH` / `_URL` / `_TOKEN` / `_KEY` / `_INTERVAL_MS` | Encrypted DB backup target (local file or HTTP), restored on boot when the DB is missing. |
| `XLAUNCH_GATEWAY_CONFIG_PATH` / `XLAUNCH_GATEWAY_CONFIG_JSON` | Declarative config (keys, custom providers, routing) applied on every boot. |
| `XLAUNCH_GATEWAY_ENV_PATH` | Explicit `.env` location for embedders. |
| `XLAUNCH_GATEWAY_COMPRESSION` | `off` disables prompt compression. |
| `XLAUNCH_GATEWAY_CONTEXT_HANDOFF` | `on_model_switch` injects a context-handoff note when a session changes model. |
| `XLAUNCH_GATEWAY_BLOCK_PRIVATE_PROVIDER_URLS` | Reject custom provider URLs on private networks. |
| `XLAUNCH_GATEWAY_PROXY_LOCAL_DESTINATIONS` | Route loopback/LAN provider URLs through the outbound proxy too. |
| `PROXY_URL`, `TRUST_PROXY`, `DASHBOARD_ORIGINS`, `PROXY_RATE_LIMIT_RPM` | Outbound proxy, reverse-proxy trust, extra CORS origins, per-IP rate limit. |

The CLI reads `XLAUNCH_GATEWAY_URL` and `XLAUNCH_GATEWAY_API_KEY` in place of
`--url` / `--api-key`.

## Connecting the Xlaunch harness

The `xlaunch-gateway` CLI (workspace `cli/`) writes agent configs against the
live catalog. To connect the Xlaunch harness:

```bash
npx xlaunch-gateway setup-xlaunch --url https://gateway.xlaunch.work --api-key <unified-key>
```

This merges an `xlaunch` provider route into `~/.xlaunch/settings.yaml`
(honouring `$XLAUNCH_HOME`) under `llm-pi-ai.providers` — `api:
openai-completions`, `baseURL: https://gateway.xlaunch.work/v1`, `apiKeyEnv:
XLAUNCH_API_KEY`, one model entry per catalog model — and stores the key as
`XLAUNCH_API_KEY` in `~/.xlaunch/.credentials.yaml`. Existing keys in both files
are preserved. `--profile NAME` adds a second route instead of replacing the
default; `--dry-run` prints the diff without writing.

The same CLI has `setup-claude`, `setup-codex`, `setup-cline`, `setup-continue`,
`setup-aider`, `setup-opencode`, `setup-goose`, `setup-qwen`, `setup-roo`,
`setup-kilo`, `setup-crush`, `setup-mimo`, `setup-atomcode`, `setup-cursor` and
`setup-generic`, plus `doctor`, `launch` and `launch-codex`. See `cli/README.md`.

## Repository layout

- `server/` — Express API, router, providers, SQLite migrations
- `client/` — React dashboard (64 locales)
- `cli/` — `xlaunch-gateway` agent setup CLI
- `shared/` — types shared by server and client
- `desktop/` — Electron menu-bar app
- `docker/` — Docker guide; `Dockerfile` and `docker-compose.yml` at the root

## Scripts

```bash
npm run dev            # server + dashboard with hot reload
npm run build          # server, cli, client
npm test               # all workspace test suites
npm run lint
npm run db:migration:status
```

Source and issues: https://github.com/xlaunch/xlaunch
