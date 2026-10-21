# Relay

Relay unifies commonly used APIs and MCP servers through one gateway. It supports REST-to-MCP bridging, OpenAPI imports, a configured MCP directory, scoped access, and telemetry for applications and agents. The landing page includes an interactive gateway preview, the supplied Relay branding, a GradientASCII background, and GSAP typography.

The Node.js developer console is available at /dashboard/gateway with Better Auth account login and separate gateway owner authentication. It includes OpenAPI ingestion, an inspector, scoped API keys, telemetry, Dodo billing, and an OAuth-gated MCP directory. Personal account signup does not grant gateway administration.

The design/atelier.html and design/reference-analysis.md files preserve the earlier design study. The live Relay application runs on port 3000. Run node scripts/preview-design.mjs to redirect the earlier port-3100 preview to the actual application.

## Run locally

Requires **Node.js 24+** and npm. SQLite uses Node's built-in `node:sqlite` module.

```sh
npm install
cp .env.example .env
npm run dev
```

PowerShell: use `Copy-Item .env.example .env`. Open http://localhost:3000. The gateway listens on http://127.0.0.1:3001. Create an account at /signup, then use /dashboard to save projects, notes, links, and tasks. Data persists per account in data/relay.db. Development binds to loopback. The separate developer console opens a local gateway owner session automatically; production requires the additional gateway owner password.

For the developer gateway, open /dashboard/gateway, then:

1. Open **Endpoints → Import OpenAPI** and select `examples/openapi.yaml`, or define an endpoint manually.
2. Test arguments in the endpoint manager or **MCP Inspector**. These execute real upstream calls and consume one credit each.
3. Create an API key under **API keys**. The full secret is shown once.
4. Connect an MCP client using the gateway URL and `Authorization: Bearer <key>`.

No fake traffic, provider credentials, or subscription activation is seeded. Generic REST calls report zero model tokens unless the upstream supplies `usage` metadata.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Next.js and gateway with hot reload |
| `npm run typecheck` | Strict frontend and server TypeScript |
| `npm test` | Protocol, billing, OAuth, security and gateway integration tests |
| `npm run build` | Production frontend and compiled gateway |
| `npm start` | Both production processes |
| `npm run mcp:stdio` | Authenticated local MCP subprocess; requires `NEXUS_API_KEY` |

Production stdio can run `node dist/server/stdio.js` with the same data directory and API-key environment.

## Architecture and routes

```text
app/(marketing)/           Relay landing and interactive product preview
app/login/, app/signup/     Better Auth account forms
app/api/auth/               Better Auth handler
app/api/relay/              Session-scoped workspace CRUD
server/relay/               Account runtime, migrations and workspace SQLite store
app/docs/                  Markdown documentation
app/dashboard/             Private projects, library, tasks, settings
app/dashboard/gateway/     Separate developer gateway console
app/auth/connect/          Provider consent entry point
app/api/                   Bounded raw webhook / checkout / OAuth forwarding
config/mcp-registry.ts     Explicit free and gated provider manifest
server/app.ts              Authenticated management API and reverse gateway
server/store.ts            WAL SQLite endpoints, encrypted headers, keys and telemetry
server/bridge/             OpenAPI mapping and official MCP SDK transports
server/mcp/                Guardrails, remote MCP client and OAuth interception
server/oauth/              PKCE state, encrypted Redis token vault and refresh
server/billing/            Dodo SDK, verified fulfillment and durable ledger
server/middleware/         Layered rates, quota admission and notification outbox
server/gateway/            Rolling circuit breaker
server/telemetry/          Structured, redacted logging
tests/                    Behavioral and integration verification
```

| Route | Authentication / purpose |
| --- | --- |
| `/api/auth/*` | Better Auth signup, login, signed sessions and logout |
| `/api/relay/*` | Better Auth session; private workspace CRUD with origin validation |
| `/mcp` | Bearer key/JWT; official SDK Streamable HTTP with negotiated session |
| `/sse`, `/messages?sessionId=…` | Bearer key/JWT; legacy MCP SSE compatibility |
| `/ws` | Optional custom WebSocket transport; Bearer header, JSON text only |
| `/gateway/:endpointId` | Bearer key/JWT; HTTP method must match endpoint; mapped parameters in query and configured JSON body |
| `/api/session` | Owner login/logout/session; HttpOnly signed cookie |
| `/api/endpoints`, `/api/import` | Owner endpoint management |
| `/api/inspector` | Owner JSON-RPC testing against a real SDK server/client pair |
| `/api/keys`, `/api/metrics`, `/api/billing`, `/api/mcps` | Owner workspace management |
| `/api/billing/checkout` | Owner; server catalog and bounded quantity only |
| `/api/webhooks/dodo` | Raw body, Standard Webhooks HMAC, strict timestamp and replay checks |
| `/api/oauth/:provider/start` | Owner; OAuth PKCE and single-use browser-bound state |
| `/api/oauth/:provider/callback` | Authorization code + state cookie; tokens never enter the browser |

The SDK negotiates its supported MCP protocol versions. WebSocket is an explicit custom extension. Tool responses are untrusted upstream content. The gateway does not execute returned text or shell commands.

## Production setup

Set `NODE_ENV=production`, a public HTTPS `APP_ORIGIN` and `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET` (32+ random characters), `DASHBOARD_PASSWORD` (24+ characters), `SESSION_SECRET` (32+ characters), and `ENCRYPTION_KEY` (64 hex characters). Generate each secret independently with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

Run `npm ci`, `npm run build`, then `npm start`; or use `docker compose up --build`. Terminate HTTPS at a trusted proxy, route the website to port 3000, and route external MCP/SSE/WebSocket traffic to port 3001. Keep Redis and the gateway management listener inaccessible to untrusted networks. The supplied Compose ports are loopback-only and intentionally need a reverse proxy. Set `TRUST_PROXY_HOPS` only when that proxy overwrites forwarded headers and direct gateway access is blocked. Configure edge connection/body/rate limits for volumetric traffic; application throttles cannot absorb a network flood.

Persist `/app/data` and Redis AOF storage. Back up SQLite using a consistent SQLite backup or a stopped writer; keep its WAL together with the database. Preserve the encryption key with backups. Losing or rotating that key without migrating stored secrets invalidates upstream headers and OAuth tokens.

Relay accounts have isolated personal workspace data in `RELAY_DATABASE_PATH`. The developer gateway is a **separate single-owner service with one writer per gateway SQLite database**. Redis provides atomic admission and token/state storage. Quota mutations reconcile against durable SQLite inside a shared serial boundary; replicas must not share this database. Horizontal multi-tenant service deployment requires a transactional shared database, explicit user/workspace membership, and a shared quota ledger. Gateway browser sessions are owner sessions; generated keys inherit that owner's provider connections while external JWT subjects remain isolated. External identities connect using their bearer credential at the connection page; the server derives their identity from the verified token, never URL state.

## Billing and quotas

Configure Redis and the Dodo environment/key/webhook/catalog fields in `.env.example`. Create a fixed-price monthly Pro subscription product and a fixed-price one-time product granting **10,000 credits per quantity**. Product prices live in Dodo's server-controlled catalog. The API rejects client prices, arbitrary product IDs, workspace IDs and redirect URLs. Checkout uses the official SDK's `product_cart`, `confirm: true`, validated customer/address fields and fixed return/cancel routes.

Register `/api/webhooks/dodo` as the webhook URL. Subscribe to `payment.succeeded`, `subscription.active`, `subscription.renewed`, `subscription.cancelled`, and `subscription.expired`. Configure `DODO_BUSINESS_ID` to bind events to your merchant account. Test the complete flow in Dodo test mode before switching to live mode.

Fulfillment verifies the **exact raw bytes**, the three Standard Webhooks headers, HMAC-SHA256 using constant-time comparison, and an absolute timestamp delta of at most 300 seconds. Redis `SET NX` prevents simultaneous processing; completed markers live for 72 hours. A durable event/payment/period ledger provides idempotency after cache loss. Processing claims have a short lease so a crashed worker does not suppress retries for three days. Non-2xx responses retain provider retry behavior. Browser returns only display a pending state.

| Plan | Requests / minute | Tool calls / minute | Monthly credits |
| --- | ---: | ---: | ---: |
| Free | 60 | 10 | 10,000 |
| Pro | 1,000 | 200 | 1,000,000 |
| Enterprise | Operator-configured | Operator-configured | Operator-configured |

Each executed API/tool/resource call costs one credit; transport negotiation and schema discovery consume request budgets but no credits. Cancellation/expiry downgrades immediately and revokes above-Free-rate keys. Request and invocation limits share budgets across local/remote tools. Quota exhaustion rejects execution with 402. At 80% usage, HTTP replies include `X-Nexus-Quota-Warning: 80%` and a durable notification outbox can POST to your configured notification/email webhook. Configure `QUOTA_NOTIFICATION_WEBHOOK_URL` and optional bearer token to deliver it; the system does not claim to send email without that service.

Enterprise is operator-provisioned with `npm run enterprise:provision -- 1` using the server environment's custom policy. While an Enterprise term is active, an owner can allocate a temporary shared Redis burst via `PUT /api/enterprise/burst` with `{ "requests": 1000, "tools": 100, "durationSeconds": 60 }`. Allocations expire automatically (maximum five minutes) and do not grant monthly credits or upgrade a Free workspace.

## Registry and OAuth

The directory includes Design (ReactBits, Mobbin), Thinking (Sequential Thinking) and Media Gen (Higgsfield). These are configurable integration entries. **No undocumented vendor MCP endpoints or OAuth support are assumed.** The official Sequential Thinking server uses stdio; supply a deployment with an authorized HTTPS MCP adapter to use the remote directory entry.

Set `<PREFIX>_MCP_URL` and `_MCP_TRANSPORT` (`sse` or `streamable-http`). For gated integrations also set `_OAUTH_AUTHORIZATION_URL`, `_OAUTH_TOKEN_URL`, `_OAUTH_CLIENT_ID`, `_OAUTH_CLIENT_SECRET` if required, `_OAUTH_CLIENT_AUTH_METHOD`, and `_OAUTH_SCOPE`. Register `${APP_ORIGIN}/api/oauth/<provider>/callback` at a provider that supports OAuth authorization code + PKCE S256. Redis is required. Confirm provider compatibility and your right to expose its service before configuring it.

Remote tools are namespaced as `provider__tool`. Missing or expired authorization raises JSON-RPC `-32001` with `data.auth_url` pointing to the session-bound connection page. HTTP challenges use 401. The OAuth flow uses 256-bit random state, PKCE, HttpOnly SameSite=Lax callback cookies, ten-minute single-use Redis state, encrypted access/refresh token envelopes, refresh serialization, and strict target-origin pinning. Tokens are injected only into the configured provider origin. A NexusMCP subscription does not grant a third-party subscription; that provider decides entitlement.

## Security boundaries and supported ingestion

API keys contain 256 random bits and are stored as SHA-256 hashes. Upstream credentials and OAuth tokens use AES-256-GCM. Authentication, quota, and provider secrets stay on the server. Production JWT verification can use an explicit issuer/audience/JWKS with RS256/ES256. Key scopes include `tools:read`, `tools:call`, `resources:read`, `prompts:read` and `tool:<exact-name>`.

Outbound calls validate public DNS at setup and request time, pin the selected address, preserve TLS hostname verification, reject private/reserved IPv4/IPv6, prevent argument origin changes, refuse redirects, strip dangerous forwarded/hop headers and bound time/body sizes. JSON requests are limited to 1 MiB; upstream responses default to 5 MiB. A 30-second failure window with at least five samples trips the circuit above 50% failures; recovery starts after 15 seconds and requires five successful probes. Open circuits reject before credit deduction.

OpenAPI 3.0/3.1 JSON/YAML, local acyclic references, JSON/vendor JSON bodies, simple path/header and form/deepObject/space/pipe query parameters are supported. Unsupported cookie/multipart, matrix/label serialization, external/circular references and non-mappable operations are rejected explicitly. GraphQL can use a manually configured JSON POST operation. Strict requested injection guards reject shell delimiters, SQL patterns and traversal even in otherwise legitimate text; adapt that policy deliberately for APIs accepting code, HTML or GraphQL variable syntax. This is input hardening, not a proof that arbitrary upstream APIs are safe.

Structured logs mask sensitive keys, card/SSN/JWT/API-key formats and secret query parameters. Full request/response payloads are not persisted. Tool telemetry retains counts, latency, status and redacted errors for 30 days.

References: [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/server), [Dodo webhooks](https://docs.dodopayments.com/developer-resources/webhooks), [Sequential Thinking server](https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking).

## Website-to-API builder

Relay's **Scraper builder** at `/dashboard/scrapers` turns a prompt and public URL into a verified, cached REST endpoint and MCP tool. It uses OpenRouter, private Browserless Chromium, a restricted isolated-vm/Playwright bridge, and DNS-pinned egress. Jobs, logs, encrypted artifacts, and key hashes persist in SQLite; Redis backs cached output and rate limits. The existing Relay key, quota, circuit, and telemetry pipeline protects execution.

The feature defaults to disabled until its server credentials and runtime are configured. See [the Oracle/Docker deployment guide](docs/scraper-deployment.md) and `/docs#scraper-builder` for setup, limits, scoped keys, and interactive OpenAPI docs. The supplied containers are ARM64-compatible; no Oracle resources are provisioned by the application itself.

## Account deployment notes

Better Auth and workspace tables are created automatically on startup. Preserve data/relay.db and BETTER_AUTH_SECRET; use independent secrets for gateway sessions and upstream encryption. Production requires HTTPS and secure cookies. Auth endpoints enforce database-backed request limits. Personal workspace mutations require a signed-in session, same-origin request, validated inputs, a bounded 64 KiB body, and ownership of associated records.

Email verification, password-reset delivery, social login, and organization collaboration are not configured. The Studio contact form saves an inquiry against the signed-in account; it does not send email or activate billing. Existing Dodo checkout belongs to the separately authenticated gateway owner.
