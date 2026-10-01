# Troubleshooting

Every failure below is mapped to what the gateway code actually does —
cite lines are live behavior, not guesses.

## 401 — `Invalid API key`

`POST /v1/*` returns
`{"error":{"message":"Invalid API key","type":"authentication_error"}}`
when the presented token is neither the unified key nor an enabled
client-profile key (`server/src/routes/proxy.ts:61-69`,
`server/src/lib/system-prompt.ts:57-73`).

- Key copied with whitespace or a missing character — copy again from the
  dashboard **Keys** page.
- Profile key was disabled or deleted — a disabled profile is rejected
  exactly like an unknown key, on purpose.
- Gemini surface only: the key must be the unified key; profile keys are
  rejected there (`server/src/routes/gemini.ts:53-55`).
- URL-token path: the token was revoked or transcribed wrong
  (`server/src/routes/url-tokens.ts`).

## 403 — not an inference error

A 403 from `/v1/*` is not the gateway's inference path. The statuses you may
hit:

- **Hosted portal, unverified email:** an unverified portal account gets 403
  `Verify your email before creating an API key` (and before wallet
  registration) — `server/src/routes/customer.ts:411-413,321-324`. This gates
  *key creation on the hosted service*, not local inference. Fix: open the
  verification link that was emailed, or request a new one from the portal.
- **Dashboard setup:** a 403 `setup_code_required` protects first-run account
  creation from remote devices (`server/src/routes/auth.ts:111`).
- Local `/v1` inference never returns 403 for email state — a wrong key there
  is always 401.

## 404 — `model_not_found`

`{"error":{"message":"Model 'X' is not in the catalog…"}}`
(`server/src/routes/proxy.ts:842-850`). Causes:

- **Missing platform prefix:** ids are `platform/model` — `gpt-4.1` fails,
  `openai/gpt-4.1` works. `GET /v1/models` is the source of truth.
- Model disabled in the dashboard → same 404 with "is disabled".
- Typo'd `auto:` chain name (`auto:<name>` must match a fallback-chain
  profile exactly, case-insensitively).

## 429 — rate limits and caps

- **Per-IP proxy rate limit:** `{"type":"rate_limit_error"}` with a
  `Retry-After` header (`server/src/middleware/rateLimit.ts:67-70`). Tuned by
  `PROXY_RATE_LIMIT_RPM` (0 disables). You hit this only with bursty scripts.
- **Client-profile token cap:** 429 `client_profile_cap_reached` with
  `Retry-After: 3600` (daily) or `86400` (total)
  (`server/src/routes/proxy.ts:95-106`).
- **Key cooldown is mostly invisible:** when an *upstream provider* 429s a
  key, the gateway benches that key and fails over to the next model in the
  chain (`server/src/routes/proxy.ts:1733`); you see a slower answer, not an
  error. A 429 reaches you only when the rate limiter above or a profile cap
  trips — upstream exhaustion surfaces as 503 instead.

## 503 — everything is cooling down

`no_providers_configured` or an exhaustion payload means every candidate was
skipped: keys on cooldown, disabled, or out of their rate/token windows
(`server/src/lib/fallback-loop.ts:742`). Wait (cooldowns are short) or enable
another provider in the dashboard's Fallback Chain.

## 502 — provider error

`Provider error (<name>): …` — the last upstream attempt failed after the
retry ladder (`server/src/routes/proxy.ts:1125-1133`). The message is
redacted (no key material, `server/src/lib/error-redaction.ts`). Check the
dashboard **Logs** page for the per-attempt trail.

## 422 — `no_vision_model`

The request contained an image but no vision-capable model is enabled
(`server/src/routes/proxy.ts:1346-1356`). Enable a vision model in the
Fallback Chain (e.g. a Gemini or Llama 4 variant).

## 402 — `account_balance_exhausted`

A client-profile key on an unpaid hosted account is refused before its token
cap is consulted (`server/src/routes/proxy.ts:84-93`). Add credit to the
account the profile belongs to.

## Streaming quirks per format

- **OpenAI (`/v1/chat/completions`):** SSE `data:` frames; the gateway holds
  headers until the first real token so a stream that dies early fails over
  invisibly; `data: [DONE]` terminates. `stream_options.include_usage`
  produces a final usage frame (`server/src/routes/proxy.ts:1733` region).
- **Anthropic (`/v1/messages`):** the `anthropic-version` header is required
  for the Anthropic-shaped `GET /v1/models` (`server/src/routes/anthropic.ts:1084`)
  — without it you get the OpenAI listing instead.
- **Gemini (`:streamGenerateContent`):** native Gemini chunk shape; the
  `?key=` query form is accepted but logged and leaks into shell history —
  use `x-goog-api-key` (`server/src/routes/gemini.ts:44-50`).
- **A thinking-model hiccup:** if a follow-up turn on a thinking model 400s
  with "reasoning_content in thinking mode must be passed back", that is a
  client stripping `reasoning_content` — the gateway itself replays the
  remembered trace (`server/src/routes/proxy.ts:194-249`); upgrade the client
  or report the tool.
