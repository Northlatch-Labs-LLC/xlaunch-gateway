# Zed

<!-- Endpoint truth: POST /v1/chat/completions → server/src/routes/proxy.ts:1157
     (mounted at /v1, server/src/app.ts:307). GET /v1/models → proxy.ts:334.
     Auth: Authorization: Bearer (server/src/routes/proxy.ts:112-123). -->

Zed's assistant supports OpenAI-compatible endpoints through the `openai`
provider block with a custom `api_url` in `~/.config/zed/settings.json`
(macOS: `~/.zed/settings.json`):

```json
{
  "language_models": {
    "openai": {
      "api_url": "http://localhost:3001/v1",
      "available_models": [
        {
          "name": "auto",
          "display_name": "Xlaunch Gateway Auto",
          "max_tokens": 8192,
          "max_output_tokens": 8192,
          "capabilities": { "type": "chat", "tool_call": true, "streaming": true }
        }
      ]
    }
  }
}
```

Zed prompts for the API key in-app when you first enable the provider; paste
the unified key (`xlaunch-…`). Zed stores it in its own credential storage.

## Verify it works

```bash
curl -s http://localhost:3001/v1/models \
  -H "Authorization: Bearer xlaunch-your-unified-key" | head -c 400
```

Then open Zed's assistant panel, pick the model you declared, and send a
message.

## Gotchas

- **`api_url` ends at `/v1`:** Zed appends `/chat/completions` itself.
- **Model naming:** every entry in `available_models` must use the gateway's
  catalog ids (`auto`, `openai/gpt-4.1`, `anthropic/claude-sonnet-4`, …).
  Zed does not fetch the list for you — mirror the ids from
  `GET /v1/models`.
- **`max_tokens` is your setting, not the gateway's:** it bounds what Zed
  requests; the model's real context window is what the gateway advertises
  as `context_length`.
- **Streaming:** leave `streaming` on — the gateway serves standard SSE.
