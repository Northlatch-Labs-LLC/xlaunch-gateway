# opencode

<!-- Endpoint truth: POST /v1/chat/completions → server/src/routes/proxy.ts:1157
     (mounted at /v1 in server/src/app.ts:307). GET /v1/models → proxy.ts:334.
     Auth: Authorization: Bearer (server/src/routes/proxy.ts:112-123). -->

opencode is an OpenAI-compatible client via the `@ai-sdk/openai-compatible`
provider. This repository dogfoods that exact setup — the root `opencode.json`
is a working example:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "xlaunch-gateway/auto",
  "provider": {
    "xlaunch-gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Xlaunch Gateway (local)",
      "options": {
        "baseURL": "http://127.0.0.1:3001/v1",
        "apiKey": "xlaunch-your-unified-key"
      },
      "models": {
        "auto": {
          "name": "Xlaunch Gateway Auto Router",
          "limit": { "context": 1048576, "output": 65536 }
        }
      }
    }
  }
}
```

## Setup

Place that JSON in `opencode.json` at the project root (or `~/.config/opencode/opencode.json`
globally), replacing the key. `apiKey` can also come from an environment
variable the config references, but the gateway itself never reads your
provider keys — only the unified key it issued.

## Verify it works

```bash
curl -s http://localhost:3001/v1/models \
  -H "Authorization: Bearer xlaunch-your-unified-key" | head -c 400
```

Then in opencode, run a session against `xlaunch-gateway/auto`; the gateway's
server log prints `[Proxy] start … openai - <model>` trace lines per attempt.

## Gotchas

- **Model naming:** `model` must be `<provider-id>/<model-id>`, e.g.
  `xlaunch-gateway/auto` or `xlaunch-gateway/openai/gpt-4.1`. The provider id
  is the key you chose in the config's `provider` block.
- **Context limits:** opencode reads `context_length` from
  `GET /v1/models` (the gateway emits both `context_window` and
  `context_length`, `server/src/routes/proxy.ts:434-439`); the `limit` block in
  the config overrides what it advertises, so keep it at or below the real
  window.
- **Thinking models:** the gateway replays `reasoning_content` on follow-up
  turns for thinking models (`server/src/routes/proxy.ts:194-249`), which fixes
  the "reasoning_content in thinking mode must be passed back" failure without
  any opencode config.
