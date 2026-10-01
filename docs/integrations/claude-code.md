# Claude Code

<!-- Endpoint truth: POST /v1/messages → server/src/routes/anthropic.ts:439
     (mounted at /v1 in server/src/app.ts:306). Auth: extractApiToken accepts
     x-api-key or Bearer (server/src/routes/proxy.ts:112-123). -->

Claude Code speaks the Anthropic Messages wire format natively, so it needs no
plugin — just point its base URL at the gateway.

## Setup

Claude Code reads its Anthropic endpoint from environment variables
(the official mechanism; `ANTHROPIC_API_KEY` is the documented one, and the
gateway accepts it in the same `x-api-key` header):

```bash
export ANTHROPIC_BASE_URL="http://localhost:3001"
export ANTHROPIC_AUTH_TOKEN="xlaunch-your-unified-key"
```

To persist them per-project, put the same variables in the `env` block of
`.claude/settings.json` or `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:3001",
    "ANTHROPIC_AUTH_TOKEN": "xlaunch-your-unified-key"
  }
}
```

Restart Claude Code after changing either file.

## What the gateway serves

`ANTHROPIC_BASE_URL` + `/v1/messages` is the endpoint Claude Code will call
(`server/src/routes/anthropic.ts:439`). `GET /v1/models`
(`server/src/routes/anthropic.ts:1083`) answers in Anthropic shape because
Claude Code sends `anthropic-version`.

## Verify it works

```bash
curl -s http://localhost:3001/v1/messages \
  -H "x-api-key: xlaunch-your-unified-key" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "auto",
    "max_tokens": 64,
    "messages": [{ "role": "user", "content": "Say OK" }]
  }'
```

A JSON reply with a `content` array means the path and key are good. The
model list check: `curl -s http://localhost:3001/v1/models -H "x-api-key:
xlaunch-your-unified-key" -H "anthropic-version: 2023-06-01"`.

## Gotchas

- **Env var precedence:** a real Anthropic key in the environment does not
  break routing (the gateway only looks at the key it receives), but Claude
  Code may pick the wrong endpoint if `ANTHROPIC_BASE_URL` is shadowed in
  `.claude/settings.local.json` or your shell profile — check
  `claude /status` for the endpoint actually in use.
- **Model naming:** use `auto` to let the gateway route, a catalog id like
  `anthropic/claude-sonnet-4` (exact ids in `GET /v1/models`), or `auto:<name>`
  for a named fallback chain. A bare `claude-sonnet-4` is *not* a catalog id —
  the platform prefix is required.
- **Proxy settings:** Claude Code honors `HTTP_PROXY`/`HTTPS_PROXY`; make sure
  they do not intercept `localhost`.
- Client-profile keys (`sk-cp-…`) also authenticate here, and carry their
  server-enforced system prompt (`server/src/lib/system-prompt.ts:57`).
