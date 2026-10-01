# Client integration guides

Point any AI coding client at Xlaunch Gateway and it keeps its native wire
format — the gateway speaks OpenAI, Anthropic, OpenAI Responses, Google Gemini,
Ollama, and MCP natively. One unified API key (`xlaunch-…`, from the dashboard
**Keys** page) authenticates every surface.

> Endpoint truth: every path in these guides is mounted in
> `server/src/app.ts:285-321` and defined in `server/src/routes/`. Each guide
> cites the exact route file:line at the top. Default local base:
> `http://localhost:3001` (`server/src/lib/config.ts:81`, override with `PORT`).
> Verified by `scripts/check-integrations-docs.mjs`.

| Client | Wire format | Base URL | Auth header | Guide |
| --- | --- | --- | --- | --- |
| Claude Code | Anthropic Messages | `http://localhost:3001` | `x-api-key` (or Bearer) | [claude-code.md](claude-code.md) |
| Cursor | OpenAI chat completions | `http://localhost:3001/v1` | `Authorization: Bearer` | [cursor.md](cursor.md) |
| opencode | OpenAI chat completions | `http://localhost:3001/v1` | `Authorization: Bearer` | [opencode.md](opencode.md) |
| Aider | OpenAI chat completions | `http://localhost:3001/v1` | `Authorization: Bearer` | [aider.md](aider.md) |
| Continue | OpenAI chat + completions | `http://localhost:3001/v1` | `Authorization: Bearer` | [continue.md](continue.md) |
| Cline / Roo Code | OpenAI chat completions | `http://localhost:3001/v1` | `Authorization: Bearer` | [cline-roo.md](cline-roo.md) |
| Zed | OpenAI chat completions | `http://localhost:3001/v1` | `Authorization: Bearer` | [zed.md](zed.md) |
| curl (generic) | any | `http://localhost:3001/v1` | `Authorization: Bearer` | [curl.md](curl.md) |
| Codex CLI | OpenAI Responses | `http://localhost:3001/v1` | `Authorization: Bearer` | [codex.md](codex.md) |
| Gemini CLI | Gemini generateContent | `http://localhost:3001/v1beta` | `x-goog-api-key` (or `?key=`) | [gemini-cli.md](gemini-cli.md) |

Running into errors? See [troubleshooting.md](troubleshooting.md).

## Wire surfaces at a glance

| Surface | Endpoints | Route definitions |
| --- | --- | --- |
| OpenAI | `GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/completions` | `server/src/routes/proxy.ts:334,750,1157` |
| Anthropic | `POST /v1/messages`, `POST /v1/messages/count_tokens`, `GET /v1/models`* | `server/src/routes/anthropic.ts:439,1044,1083` |
| OpenAI Responses | `POST /v1/responses` | `server/src/routes/responses.ts:514` |
| Gemini | `GET /v1beta/models`, `GET /v1beta/models/{model}`, `POST /v1beta/models/{model}:generateContent`, `:streamGenerateContent`, `:countTokens` | `server/src/routes/gemini.ts:80,95,220,224,228` |
| Ollama | `GET /api/tags`, `GET /api/version`, `POST /api/show`, `POST /api/chat`, `POST /api/generate` | `server/src/routes/ollama.ts:94,117,125,378,493` |
| MCP | `POST /mcp`, `GET /mcp`, `DELETE /mcp` | `server/src/routes/mcp.ts:347,371,374` |
| Reference | `GET /v1/docs`, `GET /v1/openapi.json`, `GET /v1/providers` | `server/src/routes/docs.ts:14,20`, `server/src/routes/status.ts:115` |

\* `GET /v1/models` answers in the Anthropic shape only when the caller sends
an `anthropic-version` header; otherwise it falls through to the OpenAI
listing (`server/src/routes/anthropic.ts:1084`).

Auth details: the gateway accepts `Authorization: Bearer <key>`,
`x-api-key: <key>`, or `x-goog-api-key: <key>` on every /v1 surface
(`server/src/routes/proxy.ts:112-123` — `extractApiToken`). Client-profile
keys (`sk-cp-…`) also work on /v1 surfaces, except the Gemini router, which
accepts the unified key only (`server/src/routes/gemini.ts:43-56`). Clients
that cannot set headers at all can use a revocable URL token:
`/v1/t/<token>/chat/completions` (`server/src/app.ts:294-295`).
