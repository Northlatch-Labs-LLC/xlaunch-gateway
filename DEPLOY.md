# Deploying Xlaunch Gateway

Handover document for whoever installs this on a server. Written for Ubuntu
x86_64 on a cloud VM with Docker, which is the target it was built against.

The gateway is a single Node process plus a SQLite file. It serves three
surfaces from one port:

| Path | Who | Auth |
|---|---|---|
| `/` | The operator | Dashboard session (email + password) |
| `/portal` | Customers | Their own account, separate session |
| `/v1`, `/v1beta`, `/api/chat`, `/mcp` | Applications | A gateway API key |

---

## 1. Before you start

You need:

- A server with Docker and Docker Compose.
- A domain pointing at it, and a TLS terminator in front. **The gateway speaks
  plain HTTP and has no TLS of its own.** Put Caddy, nginx or a load balancer
  ahead of it. Do not expose port 3001 directly.
- A 64-character hex encryption key: `openssl rand -hex 32`.

---

## 2. Configure

Copy `.env.example` to `.env` and set at minimum:

```
ENCRYPTION_KEY=<64 hex characters>
PORT=3001
PUBLIC_URL=https://api.weir.social
HOST_BIND=127.0.0.1
TRUST_PROXY=1
DASHBOARD_ORIGINS=https://gateway.yourdomain.com
```

`ENCRYPTION_KEY` encrypts provider keys at rest. **If it is lost, every stored
provider key becomes unreadable.** Back it up separately from the database.

`HOST_BIND` in `docker-compose.yml` decides what the published port binds to.
It defaults to `127.0.0.1`, which is correct when a reverse proxy on the same
host reaches it. Only set `0.0.0.0` if something off-box must reach the
container directly, and firewall it if you do.

Note the server process itself defaults to binding all interfaces
(`HOST` unset means `::`). Inside a container that is fine because Docker
controls what is published; running it bare on a host without a firewall is
not.

---

## 3. Run

```bash
docker compose up -d --build
docker compose logs -f
```

First boot prints a one-time setup code. You need it to create the first
operator account from anywhere other than the server itself:

```bash
docker compose logs | grep "setup code"
```

Then open `https://gateway.yourdomain.com`, enter the code, and create the
operator login.

The database lives in the `xlaunch-gateway-data` volume, mounted at
`/app/server/data`. Back that volume up. It holds provider keys, customer
accounts, balances and the payment ledger.

---

## 4. First-run checklist in the dashboard

1. **Keys → Providers.** Add at least one LLM provider key.
2. **Keys → Unified API key.** Copy it if any of your own tools will call the
   gateway directly.
3. **Keys → Customers.** Everything billing lives here:
   - *Pricing* — switch billing on and set USD per million tokens. Leave it off
     and the gateway serves without charging anyone.
   - *Payments* — set your treasury addresses and switch the watcher on.
   - *Customers* — the roster, balances, manual credit adjustments.
   - *Payments received* — transfers seen on chain, including ones from
     unregistered senders.

---

## 5. Crypto payments

Receiving only. **The gateway holds no private key and cannot move funds.** It
polls both chains read-only every sixty seconds and credits accounts.

| Asset | Chain | Interface |
|---|---|---|
| SUI | Sui mainnet | GraphQL — `https://graphql.mainnet.sui.io/graphql` |
| USDC | Base or Ethereum | JSON-RPC `eth_getLogs` against your own RPC URL |

Sui's JSON-RPC was disabled on Foundation mainnet nodes in July 2026, so the
GraphQL interface is the only supported one. The public endpoint is rate
limited; point `Sui GraphQL endpoint` at a dedicated one for production.

For USDC you must supply an EVM RPC URL — there is no usable default. Any
provider works. The USDC contract defaults to the canonical one for the chain.

**Matching is by sender.** A customer registers the wallet they will pay from,
in their portal. A transfer from an unregistered wallet is recorded with status
`unmatched` and credits nobody, so watch that list.

USDC credits one-to-one with dollars. SUI needs a rate you set by hand in
*Pricing*; a rate of zero records SUI payments without crediting them, which is
deliberate — the alternative is guessing a price for real money.

Crediting is idempotent on `(chain, tx_hash)`. A re-scan, an overlapping poll
or a restart cannot double-credit.

---

## 6. What limits a customer

Two independent controls, both enforced before any provider is called:

- **Balance.** Zero or below gives `402` with code `account_balance_exhausted`.
- **Token cap.** Per key, refilling daily, monthly, or never. Reaching it gives
  `429` with code `client_profile_cap_reached`.

Usage is charged on successes, on errors that produced tokens, and on streams
the client abandoned mid-answer. Anything the provider generated is billed,
because it was spent.

---

## 7. Upgrading

```bash
git pull
docker compose up -d --build
```

Database migrations run automatically at boot and are additive. Take a copy of
the data volume first anyway.

---

## 8. Operational notes

- **Health:** `GET /livez` and `GET /readyz`. The container has a healthcheck on
  `/api/ping`.
- **Logs:** `docker compose logs -f`, and the dashboard has a log viewer.
- **Backups:** the data volume is the whole state. The dashboard also has an
  encrypted backup feature under Keys.
- **Rate limits:** per-IP limiters guard both `/api` and `/v1`. Tune with
  `PROXY_RATE_LIMIT_RPM` and `ADMIN_RATE_LIMIT_RPM`.
- **Node:** the image pins Node 20, which satisfies the workspace's
  `>=20.18.0 <25.0.0`.

---

## 9. Known gaps

Be explicit with whoever operates this:

- No TLS in the process. A reverse proxy is mandatory.
- No invoicing or receipts. The ledger is the record; nothing generates a PDF
  or emails anyone.
- No email delivery at all: no verification, no password reset for customers.
  A customer who forgets their password needs operator help.
- The SUI/USD rate is manual. There is no price feed.
- Payment settlement is as fast as the poll, so up to sixty seconds.
