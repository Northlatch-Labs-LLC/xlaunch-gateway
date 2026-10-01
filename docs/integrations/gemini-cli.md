# Gemini CLI

<!-- Endpoint truth: POST /v1beta/models/{model}:generateContent and
     :streamGenerateContent, GET /v1beta/models, :countTokens →
     server/src/routes/gemini.ts:80,95,220,224,228 (mounted at /v1beta,
     server/src/app.ts:312-313). Auth: x-goog-api-key or ?key= — unified key
     ONLY (server/src/routes/gemini.ts:43-56). -->

The gateway exposes the native Gemini wire surface, so Gemini CLI and
Gemini-lineage agents connect by overriding the endpoint.

## Setup

Gemini CLI reads its endpoint from `GOOGLE_GEMINI_BASE_URL`:

```bash
export GOOGLE_GEMINI_BASE_URL="http://localhost:3001/v1beta"
export GEMINI_API_KEY="xlaunch-your-unified-key"
```

(If your Gemini CLI build does not honor the base-url variable, any
OpenAI-compatible client can reach the same models via
`http://localhost:3001/v1` — see [curl.md](curl.md).)

## Verify it works

```bash
curl -s "http://localhost:3001/v1beta/models" \
  -H "x-goog-api-key: xlaunch-your-unified-key" | head -c 400

curl -s "http://localhost:3001/v1beta/models/auto:generateContent" \
  -H "x-goog-api-key: xlaunch-your-unified-key" \
  -H "content-type: application/json" \
  -d '{"contents":[{"parts":[{"text":"Say OK"}]}]}'
```

The model list is served in Gemini shape (`models/auto`,
`models/openai/gpt-4.1`, …) with `supportedGenerationMethods`
(`server/src/routes/gemini.ts:59-79`).

## Gotchas

- **Unified key only:** the Gemini router accepts the unified key —
  client-profile keys (`sk-cp-…`) are NOT valid here
  (`server/src/routes/gemini.ts:53-55`). Use the unified key even when the
  dashboard offers profile keys for other clients.
- **Model naming:** the Gemini path form is `models/<id>` where `<id>` is the
  catalog id or `auto` — i.e. `models/auto:generateContent`. The platform
  prefix stays: `models/google/gemini-2.5-flash:generateContent`.
- **`?key=` works but leaks:** the router accepts `?key=` for compatibility
  and logs a warning — the key lands in shell history and proxy logs
  (`server/src/routes/gemini.ts:44-50`). Prefer the header.
- **Streaming:** `:streamGenerateContent` streams the native Gemini chunk
  shape (`server/src/routes/gemini.ts:224`).
