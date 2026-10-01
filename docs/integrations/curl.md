# curl (generic OpenAI-compatible client)

<!-- Endpoint truth: POST /v1/chat/completions → server/src/routes/proxy.ts:1157;
     POST /v1/completions → proxy.ts:750; GET /v1/models → proxy.ts:334
     (mounted at /v1, server/src/app.ts:307). Auth: Bearer/x-api-key/x-goog-api-key
     all accepted (server/src/routes/proxy.ts:112-123). -->

Any library or script that speaks the OpenAI HTTP shape works unchanged:
set its base URL to `http://localhost:3001/v1` and its API key to the unified
key. The same address serves the Anthropic, Responses, and Gemini shapes —
only the path differs.

## Minimal chat call

```bash
curl -s http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer xlaunch-your-unified-key" \
  -H "content-type: application/json" \
  -d '{
    "model": "auto",
    "max_tokens": 64,
    "messages": [
      { "role": "system", "content": "You are terse." },
      { "role": "user", "content": "Say OK" }
    ]
  }'
```

Streaming: add `"stream": true` — the response is standard SSE
(`data: {…}` frames, terminated by `data: [DONE]`).

## Verify it works

```bash
curl -s http://localhost:3001/v1/models \
  -H "Authorization: Bearer xlaunch-your-unified-key" | head -c 400
```

The first entries are the virtual routers: `auto` (router decides),
`fusion` (panel + judge), and `auto:<name>` (named fallback chains), followed
by the catalog.

## Other shapes on the same server

```bash
# Anthropic Messages (server/src/routes/anthropic.ts:439)
curl -s http://localhost:3001/v1/messages \
  -H "x-api-key: xlaunch-your-unified-key" \
  -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"auto","max_tokens":64,"messages":[{"role":"user","content":"Say OK"}]}'

# OpenAI Responses (server/src/routes/responses.ts:514)
curl -s http://localhost:3001/v1/responses \
  -H "Authorization: Bearer xlaunch-your-unified-key" \
  -H "content-type: application/json" \
  -d '{"model":"auto","input":"Say OK"}'

# Gemini (server/src/routes/gemini.ts:220)
curl -s "http://localhost:3001/v1beta/models/auto:generateContent" \
  -H "x-goog-api-key: xlaunch-your-unified-key" -H "content-type: application/json" \
  -d '{"contents":[{"parts":[{"text":"Say OK"}]}]}'
```

## Gotchas

- **No header support in the tool?** Use a URL token:
  `/v1/t/<token>/chat/completions` (`server/src/app.ts:294-295`).
- **Model naming:** ids are `platform/model` (`openai/gpt-4.1`), or the
  virtual `auto`/`fusion`/`auto:<chain>`. Unknown ids → 404 `model_not_found`.
- **max_tokens ≤ 0** means "no limit" and is treated as unset
  (`server/src/routes/proxy.ts:1198-1200`).
- **Idempotency & caching:** send `Idempotency-Key` to dedupe retries; the
  response's `X-Routed-Via` header names the platform+model that served you.
