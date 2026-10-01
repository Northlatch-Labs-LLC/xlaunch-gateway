# Codex CLI

<!-- Endpoint truth: POST /v1/responses → server/src/routes/responses.ts:514
     (mounted at /v1, server/src/app.ts:309 — "Codex CLI requires
     wire_api=\"responses\""). Auth: Bearer (server/src/routes/proxy.ts:112-123). -->

Codex CLI speaks the OpenAI **Responses** API rather than chat completions;
the gateway ships a Responses shim precisely for it
(`server/src/app.ts:308-309`).

## Setup

In `~/.codex/config.toml`:

```toml
model = "auto"
model_provider = "xlaunch-gateway"

[model_providers.xlaunch-gateway]
name = "Xlaunch Gateway (local)"
base_url = "http://localhost:3001/v1"
wire_api = "responses"
env_key = "XLAUNCH_GATEWAY_API_KEY"
```

Then export the key the profile points at:

```bash
export XLAUNCH_GATEWAY_API_KEY="xlaunch-your-unified-key"
```

`env_key` names the environment variable Codex reads the key from — pick any
name you like; the gateway itself only cares about the Bearer header it
receives.

## Verify it works

```bash
curl -s http://localhost:3001/v1/responses \
  -H "Authorization: Bearer xlaunch-your-unified-key" \
  -H "content-type: application/json" \
  -d '{"model": "auto", "input": "Say OK"}'
```

## Gotchas

- **`wire_api = "responses"` is required:** with the default `"chat"`, Codex
  posts `/chat/completions` instead — which also works, but the guide above
  exercises the Responses surface Codex expects.
- **Base URL ends at `/v1`:** Codex appends `/responses`.
- **Model naming:** `auto` or `platform/model` catalog ids; `auto:<name>`
  picks a named fallback chain.
- Codex's `--profile` flag selects between `[model_providers.*]` blocks —
  keep one block per gateway you run.
