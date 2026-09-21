# xlaunch-gateway

Point your coding agent at a Xlaunch Gateway instance in one command. The
generators read the models your server is actually serving and write the
config file each tool expects.

```bash
npx xlaunch-gateway setup-claude --url https://gateway.xlaunch.work --api-key <your-key>
```

No install step, no account. The unified API key comes from your Xlaunch Gateway
dashboard (or the tray popover in the desktop app).

## Commands

| Command | Tool |
| --- | --- |
| `setup-xlaunch` | Xlaunch harness (`~/.xlaunch/settings.yaml` + `.credentials.yaml`) |
| `setup-claude` | Claude Code |
| `setup-codex` | Codex CLI |
| `setup-cline` | Cline |
| `setup-continue` | Continue |
| `setup-aider` | Aider |
| `setup-opencode` | OpenCode |
| `setup-goose` | Goose |
| `setup-qwen` | Qwen Code |
| `setup-roo` | Roo Code |
| `setup-kilo` | Kilo Code |
| `setup-crush` | Crush |
| `setup-mimo` | MiMo Code (`mimo`) |
| `setup-atomcode` | AtomCode |
| `setup-cursor` | Cursor |
| `setup-generic` | Any OpenAI-compatible client |
| `doctor [tool…]` | Check whether a tool's requests actually reach this gateway |
| `launch` | Run Claude Code with credentials injected into the child process |
| `launch-codex` | Run Codex the same way |
| `list` | Print the supported tools and their base URLs |

`setup-xlaunch` writes an `xlaunch` route under `llm-pi-ai.providers` in
`$XLAUNCH_HOME/settings.yaml` (default `~/.xlaunch`), with one model entry per
catalog model, and stores the key as `XLAUNCH_API_KEY` in
`$XLAUNCH_HOME/.credentials.yaml`. Both files are merged structurally, so other
keys already in them are kept.

## Options

| Flag | Meaning |
| --- | --- |
| `--url URL` | Gateway base URL (default `https://gateway.xlaunch.work`; `XLAUNCH_GATEWAY_URL` overrides) |
| `--api-key KEY` | Unified API key |
| `--profile NAME` | Name the generated profile/provider entry |
| `--model ID` | Pin a specific model instead of the catalog default |
| `--dry-run` | Print the diff and write nothing |

`XLAUNCH_GATEWAY_URL` and `XLAUNCH_GATEWAY_API_KEY` work in place of `--url` /
`--api-key`.

## Safety

Every generator is non-destructive: it merges into your existing configuration
rather than replacing it, and takes a timestamped backup before touching a file
that already exists. `--dry-run` shows the exact diff first.

The two `launch` commands never write credentials to disk at all — they inject
them into the child process environment for that run only.

## Requirements

Node.js >= 20.18 and a running Xlaunch Gateway (see the repository README at
https://github.com/xlaunch/xlaunch).

MIT
