# Security Policy — Xlaunch Gateway

**Northlatch Labs LLC** treats the security of this product as a commercial obligation, not a best-effort courtesy.

## Supported versions

| Version | Supported |
|---|---|
| 0.3.0-beta.4 and later `next`/`latest` releases | ✅ |
| ≤ 0.3.0-beta.3 (legacy, pre-commercial) | ⚠️ best-effort only |

## Reporting a vulnerability

Email **security@northlatchlabs.com** (or open a private GitHub security advisory on this repository). Please include: affected version/commit, a reproduction or PoC, and your assessment of impact. We aim to acknowledge within **2 business days** and to publish a fix or mitigation for high/critical findings within **30 days**. Please do not open public issues for exploitable findings.

## Security-relevant configuration

| Setting | Default | Notes |
|---|---|---|
| `HOST` | `::` (all interfaces) | On a non-loopback bind, custom-provider URLs are **blocked from private ranges by default** (`XLAUNCH_GATEWAY_BLOCK_PRIVATE_PROVIDER_URLS=0` opts out). |
| `ENCRYPTION_KEY` | required in production | 64 hex chars; provider keys are AES-256-GCM encrypted at rest. A local dev key file is auto-generated (0600) outside the database. |
| `TRUST_PROXY` | unset (do not trust) | `true` trusts every hop and warns at boot; prefer a hop count or the proxy's address. |
| Relay URLs | https enforced | A plaintext remote fetch-relay is refused (dashboard) or degraded to a forward proxy (boot). |

Key disclosure surfaces (key reveal, export, unified-key read/regenerate, URL-token minting) all require password re-verification through a shared per-account lockout.

## Assurance

- Dependency gate: `npm audit --omit=dev --audit-level=high` runs on every PR and weekly (`.github/workflows/security-gate.yml`); production findings must stay at zero.
- CodeQL (javascript-typescript) runs weekly.
- Last full security audit: **2026-10-21** (`AUDIT-0.3.0-beta.4.md`, four specialist lanes; all HIGH/MEDIUM findings remediated — see the repository history from commit `7eabe05`).
