# CozyClay demo API

Cloudflare Worker for the hosted asynchronous ARDY demo. The Worker is deployed at
`api.cozyclay.org`; D1 is the source of queue and account state and the R2 bucket is
private. Result bytes are exposed only through `GET /r/:token.npz`, which checks
D1 on every request and sends `Cache-Control: private, no-store`.

## Local setup

```sh
cd workers/api
cp .dev.vars.example .dev.vars
npm ci
npm run migrate:local
wrangler dev --config wrangler.toml --env development
```

The development environment uses Cloudflare Turnstile's official always-pass pair
(`1x00000000000000000000AA` /
`1x0000000000000000000000000000000AA`). There is no local token bypass. Use the
always-block pair to exercise the failure path.

Create a signed development session without OAuth:

```sh
DEV_SESSION=$(node scripts/dev-session.mjs --account dev-account-1)
# The command prints seed SQL on stderr; apply it to local D1:
node scripts/dev-session.mjs --account dev-account-1 --sql \
  | tail -n 1 \
  | npx wrangler d1 execute cozyclay-demo --local --command
```

A simpler explicit seed is:

```sh
npx wrangler d1 execute cozyclay-demo --local \
  --command "INSERT OR IGNORE INTO accounts(id,created_at) VALUES ('dev-account-1', strftime('%s','now')*1000);"
```

## Configuration and secrets

Only non-secret identifiers and origins belong in `wrangler.toml`. Set these with
`wrangler secret put` (never commit values):

- `GOOGLE_CLIENT_SECRET` — Google OAuth client secret.
- `CC_WORKER_SECRET` — current box HMAC key.
- `SESSION_SIGNING_KEY` — HMAC key for `__Host-cc_sess` session tokens.
- `TURNSTILE_SECRET_KEY` — Turnstile verification secret.

Public variables are `SITE_ORIGIN`, `API_ORIGIN`, `ENVIRONMENT`, `GOOGLE_CLIENT_ID`,
and `TURNSTILE_SITE_KEY`. The redirect URI is fixed by environment and is not
assembled from the request host:

- production: `https://api.cozyclay.org/auth/google/callback`
- development: `http://127.0.0.1:8787/auth/google/callback`

## D1 migrations and deployment

```sh
npx wrangler d1 create cozyclay-demo
# Put the returned database id in wrangler.toml, then:
npm run migrate:local
npm run migrate:remote
npm run deploy
```

Nothing has been deployed yet, so edit `migrations/0001_init.sql` directly before
applying it. To pause new submissions without an HTTP control route, update D1
with Wrangler, for example:

```sh
npx wrangler d1 execute cozyclay-demo --remote \
  --command "UPDATE operational_state SET submissions_enabled=0,updated_at=CAST(strftime('%s','now') AS INTEGER)*1000,updated_by='operator' WHERE id=1;"
```

Set `submissions_enabled=1` in the same way to resume admissions. The scheduled
handler (every five minutes) reclaims expired leases, applies the 20-minute hard
timeout, removes result objects after the 30-day retention window, sweeps old
unreferenced `results/` objects, and cleans consumed HMAC nonces and expired OAuth
state.

`POST /jobs/:token/revoke` is available only to the owning session. Revocation
immediately releases the active-job slot and refunds the admission reservation
against the job's original `usage_day`; a revoked ticket and its
`/r/:token.npz` URL return 410.

## Development curl runbook

```sh
API=http://127.0.0.1:8787
ORIGIN=http://127.0.0.1:5180
curl -si -X POST "$API/jobs" \
  -H "Origin: $ORIGIN" -H 'content-type: application/json' \
  -b "__Host-cc_sess=$DEV_SESSION" \
  -d '{"prompt":"A person walks forward.","turnstileToken":"<turnstile-token>"}'

curl -si "$API/me" -b "__Host-cc_sess=$DEV_SESSION"
# Sign /worker requests with the box HMAC canonical v1 protocol. The request
# must include X-CC-Worker-Id, X-CC-Ts, X-CC-Nonce, X-CC-Kid: current, X-CC-Sig.
curl -si "$API/worker/next" -H 'X-CC-Worker-Id: dev-box' ...
```

All mutation requests require an exact `Origin` match. Every response carries
exact ACAO, `Vary: Origin`, and credential CORS headers (the result proxy omits
credentials because the token itself is the capability).

A ticket page always displays: “Bookmark this page — it is the only way back to
your result.”
