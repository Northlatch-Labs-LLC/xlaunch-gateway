# Cline / Roo Code

<!-- Endpoint truth: POST /v1/chat/completions → server/src/routes/proxy.ts:1157
     (mounted at /v1, server/src/app.ts:307). GET /v1/models → proxy.ts:334.
     Auth: Authorization: Bearer (server/src/routes/proxy.ts:112-123). -->

Cline and Roo Code are VS Code extensions with an "OpenAI Compatible"
provider that takes a base URL and key directly in their settings UI.

## Setup (Cline)

Open the Cline sidebar → settings (gear) → **API Provider: OpenAI Compatible**
→ Base URL: `http://localhost:3001/v1` → API Key:
`xlaunch-your-unified-key` → Model ID: `auto` (or a catalog id like
`openai/gpt-4.1`) → Save/Done.

## Setup (Roo Code)

Roo Code sidebar → settings → **API Provider: OpenAI Compatible** →
Base URL: `http://localhost:3001/v1` → API key → Model: `auto` → Save.

Both extensions read tool-calling support from the models they list; after
switching provider, use the model id exactly as the gateway advertises it
(fetch the list below).

## Verify it works

```bash
curl -s http://localhost:3001/v1/models \
  -H "Authorization: Bearer xlaunch-your-unified-key" | head -c 400
```

In the extension, start a task that needs a tool (e.g. "list the files in
this folder"). The gateway routes tool-bearing requests only to models that
emit real `tool_calls` (`server/src/routes/proxy.ts:1367-1371` region) — a
reply with an actual file list means the whole loop works.

## Gotchas

- **Base URL shape:** enter the base through `/v1`; the extension appends
  `/chat/completions`.
- **Model naming:** the extension may prefill a model id that does not exist
  here — replace it with a `platform/model` catalog id or `auto`, or every
  request returns 404 `model_not_found`.
- **Tool-heavy sessions:** Cline/Roo replay long histories; the gateway
  tolerates echo-tolerant tool-call shapes (missing ids, object-typed
  `arguments`) rather than 400-ing mid-session
  (`server/src/routes/proxy.ts:494-509`).
- **VS Code proxy:** if the extension can't reach `localhost:3001` while curl
  can, check VS Code's `http.proxy` and `NO_PROXY` settings.
