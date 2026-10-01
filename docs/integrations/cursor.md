# Cursor

<!-- Endpoint truth: POST /v1/chat/completions → server/src/routes/proxy.ts:1157
     (mounted at /v1 in server/src/app.ts:307). GET /v1/models → proxy.ts:334.
     Auth: Authorization: Bearer (server/src/routes/proxy.ts:112-123). -->

Cursor supports OpenAI-compatible endpoints by overriding its OpenAI base URL.

## Setup

In Cursor: **Settings → Cursor Settings → Models** — enable the OpenAI API key
override, enter your unified key, and set the **Override Base URL** to
`http://localhost:3001/v1`. Save, then click **Verify**. Disable Cursor's own
built-in models you do not want it to call directly, and add the gateway's
model ids to the custom model list (`auto`, or catalog ids from
`GET /v1/models`) so they can be selected per-chat.

Cursor stores provider settings in its local config; the UI path above is the
supported way to change them — there is no documented hand-editable config
file. If your Cursor build has no Override Base URL field visible, any
"OpenAI-compatible base URL" field in the Models settings plays the same role.

## Verify it works

```bash
curl -s http://localhost:3001/v1/models \
  -H "Authorization: Bearer xlaunch-your-unified-key" | head -c 400
```

```bash
curl -s http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer xlaunch-your-unified-key" \
  -H "content-type: application/json" \
  -d '{
    "model": "auto",
    "max_tokens": 64,
    "messages": [{ "role": "user", "content": "Say OK" }]
  }'
```

## Gotchas

- **Base URL shape:** Cursor appends `/chat/completions` itself, so the
  override must end at `/v1` — do not include `/chat/completions`.
- **Model naming:** add model ids exactly as the gateway lists them:
  `platform/model` form (e.g. `openai/gpt-4.1`), plus the virtual `auto`.
  A name Cursor guesses on its own (`gpt-4.1` without the prefix) returns
  `model_not_found` — see [troubleshooting.md](troubleshooting.md).
- **Tab autocomplete:** Cursor's Tab feature calls Cursor's own models, not
  the override — it is not routed through the gateway.
- **Proxy settings:** if a corporate proxy is set system-wide, ensure
  `localhost` is in the no-proxy list or the Verify step fails while curl
  succeeds.
