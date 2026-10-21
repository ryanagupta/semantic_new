import type { Metadata } from 'next';
import { isValidElement } from 'react';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import { ArrowLeft, ArrowUpRight, Info } from 'lucide-react';
import { MarketingNav } from '@/components/marketing/nav';
import { MarketingFooter } from '@/components/marketing/footer';
import { CopyButton } from '@/components/marketing/copy-button';

export const metadata: Metadata = { title: 'Documentation', description: 'Install Relay, import your first OpenAPI specification, and connect an MCP client over HTTP, SSE, or stdio.' };

const sections = [ ['workspace', 'Your workspace'], ['accounts', 'Accounts'], ['gateway', 'Developer gateway'], ['quickstart', 'Quickstart'], ['authentication', 'Authentication'], ['custom-tools', 'Custom tools'], ['scraper-builder', 'Scraper builder'], ['openapi', 'OpenAPI import'], ['graphql', 'GraphQL endpoints'], ['transports', 'MCP transports'], ['provider-connections', 'Provider connections'], ['resources-and-prompts', 'Resources & prompts'], ['gateway-and-observability', 'Gateway & observability'], ['billing-and-quotas', 'Billing & quotas'], ['security', 'Security'], ['deployment', 'Deployment'], ['limitations', 'Current limitations'] ];

const documentation = `
## Workspace

Relay brings projects, notes, saved links, and tasks into your own private workspace. [Create an account](/signup), then open [your dashboard](/dashboard). Use **New** to create a project, capture a note, save an HTTP(S) link, or add a task. Pin important ideas, associate them with projects, and search across your workspace from the top bar.

Your overview reflects saved records and workspace activity. Project pages collect their own notes and tasks. Edit or delete records from their action menus; deleting a project keeps its notes and tasks in your library.

## Accounts

Email and password authentication uses Better Auth. Passwords require at least 12 characters and are hashed before storage. Account sessions use signed, HttpOnly cookies, server-side validation, and a seven-day lifetime. Every workspace query and mutation is scoped to the signed-in user. Signing out revokes that session.

Update your display name in [Settings](/dashboard/settings). Email verification and password-reset delivery require separately configured delivery services.

The sign-in page offers Google, X, Apple, GitHub, and email. Social provider buttons stay disabled until their credentials are configured. Set the provider's CLIENT_ID and CLIENT_SECRET variables from .env.example, register the callback URL at your public origin followed by /api/auth/callback/provider-id, and restart Relay. Never place these secrets in NEXT_PUBLIC variables.

Amazon Cognito additionally requires COGNITO_DOMAIN, COGNITO_REGION, and COGNITO_USER_POOL_ID. TikTok uses TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET. Apple requires a public HTTPS callback and a valid, unexpired signed client-secret JWT. Configure the provider app's email permissions where required. These account sign-in providers are separate from MCP provider connections.

For production, set a random 32-character-or-longer BETTER_AUTH_SECRET and your public HTTPS BETTER_AUTH_URL. Account and workspace data persist in RELAY_DATABASE_PATH (default: data/relay.db). Development creates a persistent local secret automatically; keep it private and back it up with the database.

## Gateway

The [developer console](/dashboard/gateway) manages the REST-to-MCP gateway. It requires a Relay account plus a separate gateway owner session. Creating a personal account does not grant gateway administrator privileges. The gateway owner model and billing ledger are independent of personal workspace accounts.

## Quickstart

Relay runs a Next.js dashboard and a separate Node.js gateway. You need **Node.js 24 or newer** and npm. The gateway uses built-in SQLite, so a local setup needs no external database service.

### 1. Install and configure

Run these commands from the project directory:

\`\`\`bash
npm install
\`\`\`

Copy \`.env.example\` to \`.env\` and review the settings. In PowerShell, run \`Copy-Item .env.example .env\`; on macOS or Linux, run \`cp .env.example .env\`. Keep \`.env\` out of source control.

\`\`\`bash
npm run dev
\`\`\`

Open [the developer console](/dashboard/gateway) at \`http://localhost:3000/dashboard\`. The gateway listens on \`http://127.0.0.1:3001\`. The SQLite database is created at \`data/nexus.db\` by default.

### 2. Add an endpoint

Open **Endpoints → Add endpoint**. Give your tool a unique name, choose the HTTP method, and supply an upstream URL. A public test endpoint such as \`https://jsonplaceholder.typicode.com/todos/1\` works with \`GET\` and an empty object input schema.

### 3. Create an API key

Open **API keys**, create a key, and grant \`tools:read\` and \`tools:call\`. Copy the complete key immediately; it is only displayed once. Use the MCP Inspector to discover your tools and execute a request.

### 4. Connect a client

Point a compatible MCP client at \`http://127.0.0.1:3001/mcp\` and send your API key as an \`Authorization: Bearer\` header. The transport examples below include a complete TypeScript client.

## Authentication

### Dashboard sessions

During local development, the developer console establishes a gateway owner session automatically after Relay account login. This mode is intended for a gateway bound to the loopback interface. A dashboard session authorizes management operations, such as creating endpoints, issuing keys, and using the inspector.

In production, set \`DASHBOARD_PASSWORD\` to a strong value of at least 24 characters, \`SESSION_SECRET\` to at least 32 characters, and \`ENCRYPTION_KEY\` to exactly 64 hexadecimal characters. Set \`APP_ORIGIN\` to the dashboard's public HTTPS origin. Production configuration is validated at startup.

### Client API keys

MCP and gateway clients authenticate with an active, unrevoked API key:

\`\`\`http
Authorization: Bearer nx_live_your_generated_key
\`\`\`

API keys are stored as hashes. Each key has a name, a request limit per 60 seconds, and explicit permissions. Revoke a key from the dashboard to stop further authenticated requests.

- \`tools:read\` allows tool discovery.
- \`tools:call\` allows tool discovery and invocation.
- \`tool:get_customer\` grants access to a single named tool.
- \`resources:read\` allows discovery and reads of available zero-argument GET resources. \`prompts:read\` grants prompt discovery and retrieval. Neither scope grants tool-call access.
- \`tools:*\` and \`*\` are broad grants; use narrower scopes for agent clients where possible.

External JWT verification is optional. Configure \`JWT_ISSUER\`, \`JWT_AUDIENCE\`, and \`JWT_JWKS_URL\` together to verify tokens against a trusted identity provider. This is token verification, not a complete OAuth authorization server or a hosted identity service.

## Custom tools

An endpoint definition connects an MCP tool name to an HTTP request. Input is validated against its JSON Schema before an upstream request is made. Names use 1–64 letters, numbers, underscores, or hyphens.

The following endpoint accepts a customer ID, safely inserts it into a path segment, and appends an optional query parameter:

\`\`\`json
{
  "name": "get_customer",
  "description": "Retrieve a customer by ID",
  "method": "GET",
  "url": "https://api.example.com/customers/{id}",
  "enabled": true,
  "kind": "rest",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "string", "minLength": 1 },
      "expand": { "type": "string" }
    },
    "required": ["id"],
    "additionalProperties": false
  },
  "parameters": [
    { "name": "id", "in": "path", "required": true },
    { "name": "expand", "in": "query" }
  ],
  "headers": {}
}
\`\`\`

For JSON request bodies, define a \`body\` property in the input schema and set \`bodyProperty\` to \`"body"\`. Static upstream credentials belong in the endpoint's configured headers. They are encrypted at rest and are never part of a tool's public input schema.

A client invokes the example with this JSON-RPC message after initialization:

\`\`\`json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "get_customer",
    "arguments": { "id": "cus_001", "expand": "orders" }
  }
}
\`\`\`

The MCP bridge returns text content for JSON and text responses, image content for supported images, and embedded resource content for binary responses. An upstream HTTP failure becomes a tool result with \`isError: true\`. Malformed protocol requests and invalid tool arguments are returned as JSON-RPC errors.

## Scraper builder

The [Scraper builder](/dashboard/scrapers) turns an authorized public website into a Relay API and MCP tool. Enter the exact source URL, describe the fields you need, and choose a cache lifetime from zero to 24 hours. A zero-second cache always fetches fresh results.

The agent fetches rendered HTML through Browserless Chromium, asks an OpenRouter model to write an extraction function, and verifies its JSON against the requested fields. A failed extraction gets at most three repairs. Live logs use an authenticated event stream; queued builds and progress persist across gateway restarts. Generation can incur OpenRouter model charges.

Publishing creates a fixed-source GET endpoint at /api/v1/custom/endpoint-id and a zero-argument MCP tool named scrape_ followed by its unique identifier. Use the existing MCP Inspector to discover it, or open the endpoint's interactive API docs from the builder. The docs contain its verified sample, inferred OpenAPI 3.0 schema, cURL command, and Swagger explorer.

Every generated key is a normal Relay key scoped to that tool. Reveal and copy it once within one hour of completion; full keys are never stored in browser storage. Revoke it in [API keys](/dashboard/keys). A replacement key can be issued through the authenticated key API using the exact tool:name scope. Send either X-API-Key or Authorization: Bearer to the generated REST endpoint. Deleting a scraper revokes its generated key; pausing it blocks execution through both REST and MCP.

Management and docs require your Relay account and the gateway owner session. Builds, artifacts, and one-time key reveals are scoped to the account that created them. The gateway and usage ledger remain operator-owned; generated tools with an authorized key use the same rate limits, quotas, circuit protection, and request telemetry as other tools. One credit is consumed for a build admission and one per invocation, including cached responses. Generation repair calls do not consume extra Relay usage credits.

### Runtime setup

The builder stays disabled until SCRAPER_ENABLED=true, SCRAPER_BROWSERLESS_URL, SCRAPER_BROWSERLESS_TOKEN, SCRAPER_EGRESS_PROXY_URL, OPENROUTER_API_KEY, and REDIS_URL are configured. OPENROUTER_MODEL defaults to openai/gpt-4o; choose an available model/provider supporting structured JSON outputs. SCRAPER_WORKER_CONCURRENCY defaults to two. No OpenRouter or browser token belongs in a NEXT_PUBLIC variable.

Use the supplied Docker Compose stack and deployment guide in docs/scraper-deployment.md for Oracle Ampere or another Linux host. It runs the Relay application, private Browserless Chromium, Redis, and a public-only egress proxy. Keep Browserless, Redis, and the egress listener off the public network. SQLite persists encrypted inputs, artifacts, jobs, samples, and key hashes; Redis caches recent JSON and holds request limits/refresh locks. Back up the databases and ENCRYPTION_KEY together.

### Execution limits

Scrapers have a 15-second wall-clock deadline, a 64 MB V8 isolate, 256 browser operations, a 200-row ceiling, and a 1 MB JSON output limit. The read-only Playwright interface supports CSS/XPath locators, chaining, count, all, nth, first, textContent, innerText, allTextContents, and getAttribute. It grants no navigation, clicks, arbitrary browser evaluation, imports, filesystem, process, or direct network access. Multi-field scrapers generally extract fewer than 200 rows within the operation budget.

Every browser request passes through the guarded egress proxy, which blocks local/private/metadata networks and connects to a validated DNS address. Sites requiring login, CAPTCHA solving, multi-page crawling, downloads, or stateful interaction need a separate integration. A schema mismatch after a source changes fails closed; rebuild that scraper to establish a new verified schema.

## OpenAPI

Open **Endpoints → Import OpenAPI** and paste a JSON or YAML OpenAPI 3.x document. Review the generated operations before saving them. Each operation becomes a tool; \`operationId\` is used as its name when present.

\`\`\`yaml
openapi: 3.0.3
info:
  title: Customer API
  version: 1.0.0
servers:
  - url: https://api.example.com
paths:
  /customers/{id}:
    get:
      operationId: get_customer
      summary: Retrieve a customer by ID
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: Customer record
          content:
            application/json:
              schema:
                type: object
                properties:
                  id:
                    type: string
                  email:
                    type: string
\`\`\`

The importer maps operation parameters and JSON request bodies into tool input schemas. Local schema references are resolved within the document. Imported URLs must meet the same network policy as manually configured endpoints. Add upstream authentication headers after import; an OpenAPI security scheme does not automatically provision credentials.

> The public playground is a local schema preview for cURL and endpoint JSON. Use the dashboard importer to persist a complete OpenAPI specification.

## GraphQL

GraphQL endpoints work through HTTP POST. Define the GraphQL request envelope as the JSON body and select \`graphql\` as the endpoint kind. Use a descriptive tool name and a schema appropriate to the specific operation you want to expose.

\`\`\`json
{
  "name": "graphql_query",
  "description": "Execute a GraphQL query on the configured service",
  "method": "POST",
  "url": "https://api.example.com/graphql",
  "kind": "graphql",
  "enabled": true,
  "parameters": [],
  "headers": {},
  "bodyProperty": "body",
  "inputSchema": {
    "type": "object",
    "properties": {
      "body": {
        "type": "object",
        "properties": {
          "query": { "type": "string" },
          "variables": { "type": "object" }
        },
        "required": ["query"],
        "additionalProperties": false
      }
    },
    "required": ["body"],
    "additionalProperties": false
  }
}
\`\`\`

Automatic GraphQL introspection and per-field tool generation are not included. For narrowly scoped agent access, expose predefined operations with constrained arguments rather than allowing unrestricted query text.

## Transports

The official MCP TypeScript SDK handles protocol negotiation, JSON-RPC validation, request framing, and transport behavior. Clients must initialize a session before using \`tools/list\`, \`tools/call\`, resources, or prompts.

### Streamable HTTP

Use \`/mcp\` for modern MCP clients. The transport can return server-sent events and maintains a session identifier. An SDK client handles initialization, accepted content types, session headers, and cleanup for you.

Install \`@modelcontextprotocol/sdk\` in your client application, set \`NEXUS_API_KEY\` to a generated key, and run:

\`\`\`typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const apiKey = process.env.NEXUS_API_KEY;
if (!apiKey) throw new Error('Set NEXUS_API_KEY to an active API key.');

const transport = new StreamableHTTPClientTransport(
  new URL('http://127.0.0.1:3001/mcp'),
  { requestInit: { headers: { Authorization: 'Bearer ' + apiKey } } }
);
const client = new Client({ name: 'my-agent', version: '1.0.0' });
await client.connect(transport);

try {
  const { tools } = await client.listTools();
  console.log(tools);
  const result = await client.callTool({
    name: 'get_customer',
    arguments: { id: 'cus_001' }
  });
  console.log(result);
} finally {
  await client.close();
}
\`\`\`

### Legacy HTTP + SSE

Older clients can connect to \`GET /sse\`. The initial SSE endpoint event advertises the message URL under \`POST /messages?sessionId=...\`. Authenticate both the event stream and message requests. Use an MCP SSE client implementation that supports authorization headers; the browser's native EventSource API does not accept arbitrary request headers.

An SSE connection is bound to the principal that created it. Reuse the same active API key for all requests in that session.

### Stdio

The stdio server reads MCP messages from stdin and writes protocol output to stdout. It loads the same configuration and SQLite database as the HTTP gateway. Use an existing API key from that database; no dashboard session substitutes for the key.

In PowerShell:

\`\`\`powershell
$env:NEXUS_API_KEY = "nx_live_your_generated_key"
npm run --silent mcp:stdio
\`\`\`

In a compatible desktop MCP client, configure an absolute working directory and environment:

\`\`\`json
{
  "mcpServers": {
    "nexusmcp": {
      "command": "npm",
      "args": ["run", "--silent", "mcp:stdio"],
      "cwd": "/absolute/path/to/nexusmcp",
      "env": {
        "NEXUS_API_KEY": "nx_live_your_generated_key"
      }
    }
  }
}
\`\`\`

Client configuration formats differ. On Windows, some clients require \`npm.cmd\` as the command. Keep your client configuration and API key private.

### WebSocket extension

The optional WebSocket endpoint at \`ws://127.0.0.1:3001/ws\` accepts JSON-RPC text messages after an authenticated upgrade. Supply an \`Authorization: Bearer\` header when opening the connection. Use \`wss://\` behind your production HTTPS ingress. Binary messages are rejected, and connections expire after 30 minutes.

WebSocket is a custom transport extension. Standard MCP clients should use Streamable HTTP or stdio unless they implement this message transport explicitly. Browsers cannot set arbitrary headers in the native WebSocket constructor; use a compatible server-side client instead of placing API keys in URLs.

## Provider connections

The [MCP registry](/dashboard/mcps) can aggregate separately configured remote MCP servers. Its built-in descriptors cover ReactBits, Sequential Thinking, Mobbin, and Higgsfield. A descriptor is a configuration slot, not a claim that a vendor offers a public MCP endpoint or OAuth integration. Obtain the service's authorized endpoints and application credentials before enabling it.

Set a provider's HTTPS MCP URL using its environment prefix: \`REACTBITS_MCP_URL\`, \`SEQUENTIAL_THINKING_MCP_URL\`, \`MOBBIN_MCP_URL\`, or \`HIGGSFIELD_MCP_URL\`. The optional \`*_MCP_TRANSPORT\` value selects \`streamable-http\` (default) or \`sse\`.

Mobbin and Higgsfield connections require user authorization. Configure the corresponding \`*_OAUTH_AUTHORIZATION_URL\`, \`*_OAUTH_TOKEN_URL\`, \`*_OAUTH_CLIENT_ID\`, optional \`*_OAUTH_CLIENT_SECRET\`, and \`*_OAUTH_SCOPE\`. Match \`*_OAUTH_CLIENT_AUTH_METHOD\` to the registered client: \`client_secret_basic\`, \`client_secret_post\`, or \`none\`. Register the exact callback URL \`{APP_ORIGIN}/api/oauth/{provider-id}/callback\` with the provider.

Provider authorization requires Redis. Connections use OAuth authorization code flow with S256 PKCE and single-use state. Access and refresh tokens are encrypted before storage and stay on the server. The registry provides connect and disconnect actions. Expired tokens are refreshed when possible; missing or rejected authorization produces JSON-RPC error \`-32001\` with an \`auth_url\` for reconnection.

Remote tools are namespaced as \`provider-id__tool-name\`. The bridge resolves provider authorization before making an upstream tool call or charging its quota. Each connection stays bound to the configured public HTTPS origin, and redirects are refused. This deployment has a single workspace owner: dashboard sessions and workspace API keys use that owner's connections. External JWT identities are isolated from the owner's tokens; the interactive dashboard consent flow currently links the workspace owner.

## Resources and prompts

Relay advertises tools, resources, and prompts through standard MCP discovery methods.

- **Tools** expose enabled endpoints visible to the authenticated key. Tool annotations identify read-only and potentially destructive operations.
- **Resources** expose GET endpoints that require no path parameters or mandatory arguments. Resource URIs use \`nexus://endpoints/{endpointId}\`. Reading a resource executes the upstream request and requires the resource scope or call access to its tool.
- **Prompts** include \`invoke_tool\`, which takes \`tool\` and \`goal\` arguments and helps a client plan a validated call. A prompt supplies instructions to the client; it does not independently invoke an LLM.

The MCP Inspector in the dashboard supports discovery, JSON-RPC inspection, and tool calls. Requests execute against the same configured upstreams and are captured in telemetry.

## Gateway and observability

The gateway authenticates clients, validates input, checks the key's sliding-window rate limit, and forwards the request to the configured upstream. The default limiter uses memory. Set \`REDIS_URL\` for a shared limiter when several processes need to coordinate request quotas.

The dashboard updates from recorded request data. It shows request counts, average and percentile latency, error rates, active keys, and recent invocations. Token counts are collected only when an upstream response provides recognizable usage data. A generic REST response does not reveal LLM token consumption.

Requests are bounded by \`UPSTREAM_TIMEOUT_MS\` (5 seconds by default) and \`MAX_RESPONSE_BYTES\` (5 MiB by default). Avoid configuring unnecessarily large limits. Inspect failures from the dashboard before retrying a mutating tool, since the upstream may already have processed the original request.

## Billing and quotas

The Billing dashboard shows the workspace's plan, monthly allowance, consumed calls, and purchased add-on credits. The Developer plan includes 10,000 tool calls per month, up to 60 requests and 10 tool calls per minute. Pro includes 1,000,000 tool calls per month, up to 1,000 requests and 200 tool calls per minute. Each upstream execution consumes an allowance credit; this is separate from any LLM token usage returned by an upstream provider.

API keys retain their individual limits. Effective access is constrained by both the key's configured rate and the workspace limits. When the monthly allowance and remaining add-on credits are exhausted, calls are rejected with an HTTP 402 response and an upgrade message.

### Configure Dodo Payments

Set \`DODO_PAYMENTS_API_KEY\`, \`DODO_PAYMENTS_WEBHOOK_KEY\`, \`DODO_PRO_PRODUCT_ID\`, and \`DODO_CREDITS_PRODUCT_ID\` in the server environment. Choose \`DODO_PAYMENTS_ENVIRONMENT=test_mode\` while testing, or \`live_mode\` for real payments. Configure the products and their prices in Dodo Payments; Relay does not hard-code purchase amounts.

\`REDIS_URL\` is required for paid checkout and fulfillment so distributed quota checks coordinate correctly. Without a complete payment configuration, the dashboard reports payments as unavailable and does not simulate a successful purchase.

Create a recurring Pro subscription product and a one-time add-on credit product. Each credit bundle supplies 10,000 calls. A checkout can include 1–100 bundles. Billing starts a server-created checkout session and redirects to Dodo's checkout page. Subscription activation and credits are applied only after a verified payment webhook, never from the browser's return URL. Duplicate webhook deliveries are recorded without applying the same purchase twice.

Enterprise plans are provisioned by the deployment operator with custom quota settings; there is no public Enterprise checkout. A plan upgrade changes workspace limits and does not provision hosting infrastructure.

## Security

Only connect upstream services you intend agents to access. A tool schema describes an action; it does not make the action safe to execute without appropriate client-side approval.

- The gateway rejects private, loopback, link-local, and otherwise non-public upstream destinations to reduce server-side request forgery risk. DNS is checked before a connection is made.
- \`UPSTREAM_ALLOWLIST\` optionally limits upstreams to a comma-separated set of exact public hostnames. It does not permit private IP destinations.
- Credentials in endpoint headers are encrypted with \`ENCRYPTION_KEY\`. Back up that key alongside the database; replacing it prevents existing encrypted credentials from being decrypted.
- Use HTTPS at the public ingress, a precise \`APP_ORIGIN\`, private storage for secrets, and API keys scoped to the tools each client needs.
- Tool results are untrusted upstream data. Agents should never treat response content as higher-priority system instructions.

Tool argument guards also reject command delimiters, SQL injection patterns, and directory traversal patterns in string inputs. This strict policy can reject legitimate code, HTML, SQL, or GraphQL variable syntax. Review the guard policy against the APIs you intend to expose; input filtering does not replace upstream authorization or client confirmation for sensitive actions.

Local development authentication is intended for a loopback-only setup. Configure production credentials before exposing the dashboard or gateway to a network.

## Deployment

### Build and run

\`\`\`bash
npm run typecheck
npm test
npm run build
npm start
\`\`\`

Run both the web process and gateway under a process supervisor or the supplied container setup. Forward dashboard traffic to port 3000 and MCP traffic to gateway port 3001. Set \`HOST\` appropriately for the deployment; use \`0.0.0.0\` when a container ingress needs to reach the gateway.

Provide \`NODE_ENV=production\`, a public HTTPS \`APP_ORIGIN\`, and the required production secrets. Generate a 32-byte encryption key with:

\`\`\`bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
\`\`\`

Give \`DASHBOARD_PASSWORD\` and \`SESSION_SECRET\` their own unique values. Do not reuse the encryption key as a password.

### Reverse proxy settings

Disable response buffering and compression for event streams, allow long-lived HTTP connections, and forward authorization and MCP session headers. The gateway checks browser origins against \`APP_ORIGIN\`. Non-browser clients can omit the Origin header.

Mount \`DATABASE_PATH\` on durable storage and back up the SQLite database using a consistent SQLite backup procedure. Preserve the encryption key securely. Use a **single gateway instance** with this database design. Redis provides shared rate-limit state; it does not replace the SQLite database or make MCP sessions distributed.

## Limitations

This repository supplies a self-hosted platform with optional Dodo Payments checkout and webhook integration. It does not provision managed hosting, organization tenancy, SSO administration, or an OAuth authorization server. Payments require your own configured catalog, credentials, webhook endpoint, and Redis service.

OpenAPI ingestion covers HTTP operations, parameters, JSON bodies, and local references. Check generated schemas and request serialization against your API, especially for advanced document constructs. External reference fetching and automatic upstream authentication provisioning are not included. GraphQL support forwards configured JSON requests without automatic introspection.

The HTTP gateway supports Streamable HTTP and legacy HTTP + SSE; local clients can use stdio. WebSocket support is a custom extension rather than a universally supported MCP transport. MCP sessions live in process memory and must be reinitialized after a restart. SQLite persistence is designed for a single instance.

Use the included checks and your own upstream integration tests before a production rollout. Infrastructure availability and LLM token accounting depend on the services you connect.
`;

export default function DocumentationPage() {
  return <><a className="skip-link" href="#main">Skip to content</a><MarketingNav /><main id="main" className="site-container docs-layout"><aside className="docs-sidebar"><span>DOCUMENTATION</span><nav aria-label="Documentation sections">{sections.map(([id, label]) => <a key={id} href={'#' + id}>{label}</a>)}</nav><Link className="docs-back" href="/"><ArrowLeft size={12} /> Back to Relay</Link></aside><article className="docs-content"><span className="docs-page-eyebrow">THE DEVELOPER GUIDE</span><h1>A little guidance. More possibility.</h1><p className="docs-lead">Find your way around your workspace, manage your account, and connect the developer gateway.</p><div className="docs-notice"><Info size={16} /><span>Start locally with Node.js 24+. Your dashboard runs on port 3000, and the MCP gateway runs on port 3001.</span></div><div className="docs-markdown"><ReactMarkdown components={{ h2({ children }) { const id = String(children).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); return <h2 id={id}>{children}</h2>; }, pre({ children }) { const child = isValidElement<{ children?: React.ReactNode; className?: string }>(children) ? children : null; const value = child ? String(child.props.children ?? '').replace(/\n$/, '') : ''; const language = child?.props.className?.replace('language-', '') ?? 'code'; return <div className="docs-code-block"><div className="docs-code-label"><span>{language}</span><CopyButton value={value} /></div><pre>{children}</pre></div>; } }}>{documentation}</ReactMarkdown></div><div className="docs-end"><div><strong>Make your first connection.</strong><p>Your tools are one endpoint away.</p></div><Link href="/dashboard/endpoints" className="button button-primary">Open endpoint manager <ArrowUpRight size={14} /></Link></div></article></main><MarketingFooter /></>;
}
