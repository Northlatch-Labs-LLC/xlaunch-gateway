# Aider

<!-- Endpoint truth: POST /v1/chat/completions → server/src/routes/proxy.ts:1157
     (mounted at /v1 in server/src/app.ts:307). GET /v1/models → proxy.ts:334.
     Auth: Authorization: Bearer (server/src/routes/proxy.ts:112-123). -->

Aider's `--openai-api-base` switch points it at any OpenAI-compatible server.

## Setup

```bash
export OPENAI_API_BASE="http://localhost:3001/v1"
export OPENAI_API_KEY="xlaunch-your-unified-key"

aider --model openai/auto
```

Or inline, which keeps it out of your shell profile:

```bash
aider \
  --openai-api-base http://localhost:3001/v1 \
  --openai-api-key xlaunch-your-unified-key \
  --model openai/auto
```

The `/v1` suffix matters: Aider appends `/chat/completions` to the base.

## Verify it works

```bash
curl -s http://localhost:3001/v1/models \
  -H "Authorization: Bearer xlaunch-your-unified-key" | head -c 400
```

Inside Aider, run `/models` — it lists what the gateway advertises. Then ask
for a small edit; `/tokens` shows the model actually serving (the gateway may
route `auto` to a different model than requested).

## Gotchas

- **Model naming:** with the `--model openai/<id>` form, `<id>` must be the
  gateway's catalog id — `openai/auto` (router decides) or
  `openai/openai/gpt-4.1` (yes, doubled: Aider's prefix + the platform-prefixed
  catalog id). An id Aider invents itself returns `model_not_found`.
- **Env var precedence:** Aider checks `--openai-api-base` before
  `OPENAI_API_BASE`; a stale `OPENAI_API_BASE` pointing at api.openai.com in
  your profile silently bypasses the gateway. `aider --models` shows what it
  can see.
- **Weak-model role:** Aider's summary/model hints (`--weak-model`) go through
  the same base URL — `openai/auto` works there too and lets the router pick a
  cheap model.
- **Streaming:** Aider streams by default; the gateway streams SSE per the
  OpenAI shape (`server/src/routes/proxy.ts:1733` retry loop handles upstream
  rate limits transparently).
