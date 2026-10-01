# Market gaps — public surface audit (G1)

Audited at `main@21f5fd3`. Route inventory (operator host): `/portal/*` → customer
portal (client/src/App.tsx:429); `/v1/openapi.json` + `/v1/docs` → static API
reference (server/src/routes/docs.ts:16); every other path — `/` included — falls
through to the auth-gated operator dashboard (client/src/App.tsx:430), and after
login `/` redirects to `/models/chat` (client/src/App.tsx:454). On a customer host
(`portal.*`) all paths render the portal sign-in (client/src/App.tsx:425-426).

| # | Severity | Gap | Evidence | Fix |
|---|----------|-----|----------|-----|
| 1 | HIGH | No public landing page: a first-time visitor at `/` meets the operator login, not the product | client/src/App.tsx:430, client/src/components/auth-gate.tsx:111 | Ship a public landing at `/`; move the dashboard entry to `/admin` |
| 2 | HIGH | The root URL sells nothing — it is a `Navigate` to the dashboard table | client/src/App.tsx:454 | Let `/` render marketing content instead of redirecting away |
| 3 | HIGH | SEO surface is a title and a favicon: no meta description, OG/Twitter tags, canonical, robots.txt or sitemap | client/index.html:30-31, client/public/ (only favicon.svg, icons.svg) | Add description/OG meta to index.html and a robots.txt to client/public |
| 4 | HIGH | Signup is undiscoverable: the portal opens in login mode and hides sign-up behind a text-only toggle | client/src/pages/PortalPage.tsx:87,137-143 | Show a visible Create-account action from the first paint |
| 5 | HIGH | No email verification: customer signup mints a session immediately; the welcome mail is fire-and-forget and never gates the account | server/src/routes/customer.ts:106-117 | Gate signup (or first wallet/key) behind an emailed verification once mail is reliable |
| 6 | MED | The signup form ignores the server's password rule (min 10) until the server rejects the submit; the operator gate validates inline, the customer one does not | client/src/pages/PortalPage.tsx:114,133 vs auth-gate.tsx:71-73 | Validate min-length client-side with FieldError |
| 7 | MED | Error handling is one silent text line: no field errors, no `role="alert"`, raw server message | client/src/pages/PortalPage.tsx:132 | Use FieldError and announce failures to screen readers |
| 8 | MED | Password reset exists server-side but the portal UI never reaches it — a customer who forgets a password is stuck | server/src/routes/customer.ts:158,173; PortalPage.tsx:85-147 has no reset link | Add a forgot-password flow to the portal's signed-out view |
| 9 | MED | No user-facing product docs in-repo beyond README.md and DEPLOY.md; the only public reference is the API spec viewer | server/src/routes/docs.ts:8-24 | Grow docs/ into real user documentation (quickstart, concepts) |
| 10 | LOW | Wallet chain labels are hardcoded English inside an otherwise fully translated page | client/src/pages/PortalPage.tsx:25-29 | Move the three labels into the i18n dictionaries |
| 11 | LOW | The customer hostname serves a bare sign-in at `/` with zero product context — the same blindness as the operator host | client/src/App.tsx:425-426 | Reuse the landing (or a portal-flavored variant) on the customer host |
| 12 | LOW | Document title is static: every route shows "Unified LLM Router" in tabs and history | client/index.html:30 | Set a per-route `document.title` |

Counts: 5 HIGH, 4 MED, 3 LOW. Gaps 1-3 (and 12 for the landing) are addressed by
this mission; 4-8, 10-11 are follow-up work scoped here, not fixed by it.
