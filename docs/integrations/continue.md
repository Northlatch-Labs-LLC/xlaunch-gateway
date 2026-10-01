# Continue

<!-- Endpoint truth: POST /v1/chat/completions → server/src/routes/proxy.ts:1157;
     POST /v1/completions (autocomplete) → proxy.ts:750; GET /v1/models →
     proxy.ts:334 (all mounted at /v1, server/src/app.ts:307). Auth: Bearer
     (server/src/routes/proxy.ts:112-123). -->

Continue configures arbitrary OpenAI-compatible providers in its config file
(`~/.continue/config.yaml`, or `.continue/config.yaml` in the repo — JSON was
the classic shape, YAML is the current one):

```yaml
name: xlaunch-gateway
version: 1.0.0
models:
  - name: Xlaunch Auto
    provider: openai
    model: auto
    apiKey: xlaunch-your-unified-key
    apiBase: http://localhost:3001/v1
    roles:
      - chat
      - edit
      - apply
  - name: Xlaunch Autocomplete
    provider: openai
    model: auto
    apiKey: xlaunch-your-unified-key
    apiBase: http://localhost:3001/v1
    roles:
      - autocomplete
```

`provider: openai` + `apiBase` is the generic OpenAI-compatible mechanism —
any provider entry with an `apiBase` field plays this role if your config
layout differs.

## Verify it works

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

- **Autocomplete hits /v1/completions, not chat:** the gateway keeps the
  legacy text-completion endpoint alive specifically for editor ghost-text
  clients like Continue (`server/src/routes/proxy.ts:747-750`) — prompts are
  routed through chat models and answered in `text_completion` shape.
- **Model naming:** `model:` takes catalog ids — `auto`,
  `openai/gpt-4.1`, or an `auto:<name>` fallback chain. Check ids with
  `curl -s http://localhost:3001/v1/models -H "Authorization: Bearer
  xlaunch-your-unified-key"`.
- **Config precedence:** Continue merged config from user and workspace files;
  if an old `config.json` sits next to `config.yaml`, stale entries can win.
  The assistant dropdown shows which config entry is live.
- **Context truncation:** the gateway advertises `context_length` so Continue
  truncates honestly; if you pinned a wrong model id, Continue falls back to
  its own conservative default and truncates early.
