# Docker Guide

Docker Compose is the recommended way to run Xlaunch Gateway for personal use.
The container serves the Express API and the built React dashboard from one
process on port 3001, with SQLite persisted in a named volume. The image is
built locally from this checkout as `xlaunch-gateway:latest`; nothing is pulled
from a registry.

## Prerequisites

- Docker
- Docker Compose
- OpenSSL for generating `ENCRYPTION_KEY`

## Quick Start

Create a `.env` file with a 32-byte encryption key:

```bash
ENCRYPTION_KEY="$(openssl rand -hex 32)"
printf "ENCRYPTION_KEY=%s\nPORT=3001\n" "$ENCRYPTION_KEY" > .env
```

Build and start the app:

```bash
docker compose up -d --build
```

Open http://localhost:3001, add provider keys on the **Keys** page, then use the
generated `xlaunch-...` key with any OpenAI-compatible client.

## Example API Call

```bash
curl http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer xlaunch-your-unified-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Say hello from Xlaunch Gateway."}]
  }'
```

## Operations

Check status:

```bash
docker compose ps
```

Tail logs:

```bash
docker compose logs -f xlaunch-gateway
```

Stop the app:

```bash
docker compose down
```

Rebuild after pulling new source:

```bash
docker compose up -d --build
```

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ENCRYPTION_KEY` | Yes | None | 64-character hex key used to encrypt provider API keys at rest. Generate it once and keep it stable. |
| `PORT` | No | `3001` | Host port exposed by Docker Compose. The container listens on port 3001. |
| `XLAUNCH_GATEWAY_DB_PATH` | No | `/app/server/data/xlaunch-gateway.db` | SQLite file path. Set this when your host only persists one mounted directory. |
| `XLAUNCH_GATEWAY_DB_BACKUP_PATH` | No | None | Local encrypted backup file. Restored on startup if the DB file is missing, then refreshed while the app runs. |
| `XLAUNCH_GATEWAY_DB_BACKUP_URL` | No | None | HTTP(S) encrypted backup target. Startup uses `GET`; periodic backups use `PUT`. |
| `XLAUNCH_GATEWAY_DB_BACKUP_TOKEN` | No | None | Optional bearer token for `XLAUNCH_GATEWAY_DB_BACKUP_URL`. |
| `XLAUNCH_GATEWAY_DB_BACKUP_KEY` | No | `ENCRYPTION_KEY` | 64-character hex key for backup encryption. Use a separate stable key if possible. |
| `XLAUNCH_GATEWAY_CONFIG_PATH` | No | None | JSON config file applied idempotently after migrations on every boot. |
| `XLAUNCH_GATEWAY_CONFIG_JSON` | No | None | Inline JSON config. Takes precedence over `XLAUNCH_GATEWAY_CONFIG_PATH`. |

The `xlaunch-gateway-data` volume stores SQLite data at `/app/server/data`. Keep
the same volume and `ENCRYPTION_KEY` when upgrading, otherwise existing
encrypted provider keys cannot be decrypted.

Example `xlaunch-gateway.config.json`:

```json
{
  "keys": [
    { "platform": "groq", "key": "gsk_...", "label": "main" }
  ],
  "customProviders": [
    {
      "baseUrl": "http://host.docker.internal:11434/v1",
      "label": "Ollama",
      "models": [
        { "model": "llama3.1:8b", "displayName": "Local Llama", "supportsTools": true }
      ]
    }
  ],
  "routing": { "strategy": "balanced" }
}
```
