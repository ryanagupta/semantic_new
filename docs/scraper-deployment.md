# Deploy Relay with website-to-API generation

Website-to-API generation is a Relay feature. The existing Next application, Better Auth accounts, gateway, billing, MCP integrations, and SQLite data stay in the same deployment. One Relay container runs Next on port 3000 and the gateway on port 3001. Browserless renders pages and an isolated egress proxy validates outbound destinations. SQLite persists the job queue, events, endpoint records, hashed API keys, and encrypted inputs/generated artifacts. Redis holds scraped-response caches, short refresh locks, and atomic rate/quota admission state.

## Oracle host

Use an Ubuntu Server Ampere A1 instance with 4 OCPUs, 24 GB RAM, and sufficient persistent boot storage (50 GB or more for images, SQLite, logs, and backups). Check availability and Always Free eligibility in your tenancy before creation; regional capacity and your account's quotas determine availability. Attach a public IP and point a domain's DNS A record at it. Configure an AAAA record only if IPv6 is correctly routed.

In the OCI network security group or subnet security list, allow inbound TCP 80 and 443 from the internet and TCP 22 only from your administrator IP/CIDR. Keep ports 3000, 3001, 6379, and 8080 closed. Retain the instance's necessary outbound connectivity for DNS, package/image downloads, TLS, OpenRouter, and public scrape targets. No OCI credentials are required inside Relay.

Copy the repository to the host, for example `/opt/relay`, and run the supplied bootstrap script from that checkout:

```bash
sudo bash deploy/provision-oracle.sh relay.example.com admin@example.com
```

The script installs Docker Engine and Compose from Docker's Ubuntu repository, Nginx, Certbot, and SQLite tools. It preserves existing firewall rules and inserts inbound HTTP/HTTPS rules before Oracle Ubuntu's reject rule. It creates the Nginx site and obtains a Let's Encrypt certificate using HTTP validation; DNS and OCI ingress must already work. It does not start application containers or generate credentials. Review the script before running it on an existing shared server. Docker administrators have root-equivalent host access; use `sudo docker` rather than granting unrelated users Docker group membership.

## Configure credentials on the server

Create `.env` from `.env.example` **on the deployment host**, and restrict it to its owner. Do not replace an existing environment file containing live credentials.

```bash
cp -n .env.example .env
chmod 600 .env
openssl rand -hex 32
```

Run the random-generation command separately for each secret. Set these values in the private `.env` file:

| Variable | Value |
| --- | --- |
| `APP_ORIGIN`, `BETTER_AUTH_URL` | Same public HTTPS origin, without a path |
| `BETTER_AUTH_SECRET` | Independent random secret, at least 32 characters |
| `DASHBOARD_PASSWORD` | Independent owner-console password, at least 24 characters |
| `SESSION_SECRET` | Independent random secret, at least 32 characters |
| `ENCRYPTION_KEY` | 64 hexadecimal characters; retain for encrypted stored credentials |
| `REDIS_PASSWORD` | Independent 64-character hexadecimal password; hex avoids URL escaping ambiguity |
| `SCRAPER_BROWSERLESS_TOKEN` | Independent random internal token, at least 32 characters |
| `OPENROUTER_API_KEY` | Server-side key from your OpenRouter account |
| `OPENROUTER_MODEL` | An available model supporting structured output, default `openai/gpt-4o` |
| `SCRAPER_WORKER_CONCURRENCY` | Concurrent generation jobs, from 1 to 4; default 2 |

Configure billing and authorized OAuth providers using the existing Relay environment variables if used. Compose supplies the internal Browserless/Redis/proxy addresses and enables the feature. OpenRouter calls incur model-provider costs. The browser worker never receives the OpenRouter key or database/encryption credentials. Do not add credentials to `NEXT_PUBLIC_*` variables, Docker build arguments, a URL shared with a user, or a committed file.

The official [Browserless open-source deployment guide](https://docs.browserless.io/enterprise/open-source) lists Chromium's ARM64 support and its token/concurrency/timeout configuration. `BROWSERLESS_IMAGE` defaults to the requested `ghcr.io/browserless/chromium:latest`; for a controlled deployment, set it to a tested version or digest before rollout. The browser needs no locally installed Playwright browser binary in the Relay image.

## Build and start

Run from the repository root with Docker Compose 2.20.3 or later. `compose.yaml` includes the canonical `docker-compose.yml` so the default command uses this same topology. Use the same Compose project name/directory during upgrades to retain the existing `nexus-data` and `redis-data` volumes.

```bash
sudo docker compose -f docker-compose.yml config --quiet
sudo docker compose -f docker-compose.yml build
sudo docker compose -f docker-compose.yml up -d --wait --remove-orphans
sudo docker compose -f docker-compose.yml ps
curl --fail --silent http://127.0.0.1:3001/health
curl --fail --head https://relay.example.com/login
```

`config --quiet` validates without printing interpolated credentials. Native `isolated-vm` is compiled on the target architecture using Node 24, Python, make, and g++; the runtime image runs as a non-root user and omits build tools. Runtime secrets are supplied when starting containers. The Docker build uses disposable build-only auth values and never copies its temporary databases into the runtime image.

When upgrading from the original Compose file's `nexus` service, first back up the data, then stop that old container or use `--remove-orphans` as above to release its loopback ports. Keep the same Compose project name and named volumes; the service rename does not move or delete the stored databases.

The sample limits allocate 4 CPUs across services and about 19.5 GB of container memory, leaving capacity for Ubuntu/Nginx. Browserless allows 10 concurrent sessions, a queue of 10, 2 GB shared memory, and a 15-second session limit. `SCRAPER_WORKER_CONCURRENCY` controls generation workers (default 2); serving generated endpoints has a separate limit of two active uncached extractions per gateway. Browser CPU saturation is expected on a four-core instance at the Browserless ceiling; tune admission after measuring your targets. Application scrape deadlines are independently enforced. A generation has a five-minute deadline with one initial synthesis and at most three repairs.

Jobs are durable SQLite records with a renewable 30-second worker lease. An interrupted build can be reclaimed on restart, with at most three worker claims; a successful build atomically publishes its Relay tool, artifact, key, and completion record. API-key hashes persist, while the encrypted one-time reveal is available to its owner for one hour and is erased when read or expired. Completed/failed job history is pruned after seven days without deleting the live endpoint. Closing a browser tab does not discard a running build. Retain both the database volume and `ENCRYPTION_KEY` across restarts.

The app and egress proxy use read-only root filesystems, dropped Linux capabilities, no-new-privileges, process limits, bounded log rotation, and temporary filesystems. Persistent data lives only in the named database and Redis volumes. Next's cache has a separate writable tmpfs. Do not mount the Docker socket into any service.

## Network and identity boundaries

- Only the Relay web and gateway ports are bound to host loopback for Nginx. Browserless, Redis, and the proxy have no published host ports.
- Browserless joins only an `internal: true` Docker network. It cannot open a direct internet route. Relay supplies the validated egress proxy for browser sessions; that proxy rejects local, metadata, private, and other non-public destinations after DNS resolution.
- The egress proxy can reach the internet and the browser network, but cannot join the Redis backend network. Redis joins only its internal backend network and requires a password. Relay joins both private networks and an outbound network for OpenRouter and existing upstream integrations.
- All `/api/scrapers` and `/api/scrapers/**` traffic goes through the Next account BFF. Nginx strips any client-supplied internal identity header. Next verifies the Better Auth session and signs a short-lived user association; the gateway additionally requires its owner-console session. Do not route these paths directly to port 3001.
- Generated `/api/v1/custom/:endpointId` requests go to the gateway and require the endpoint's API key. Never put an API key in a shared documentation URL. Scraper code/data is associated with the requesting Relay account.
- Job events and MCP responses are unbuffered end to end. `deploy/relay.nginx.conf` keeps the SSE connection open and disables gzip/buffering for streaming routes. `/api/auth` continues to use Next, and existing MCP `/mcp`, `/sse`, `/messages`, `/ws`, and `/gateway` routes reach the gateway.

Keep this network split when moving to another orchestrator. Connecting Browserless to the normal outbound network removes a required SSRF boundary. This is a single-host deployment with one writer per SQLite database; do not scale the Relay container horizontally against these volumes.

## Health, recovery, and upgrades

The Relay container health check requests both the web login page and gateway health endpoint. Browserless checks `/active` with its internal token; Redis uses an authenticated PING; the proxy is checked for a listening socket. Health does not prove a remote website is available or that an OpenRouter key has credits. Create a scraper against a public target you control and exercise its docs/API after initial startup. Check normal, cache-hit, rejected-private-target, expired-key, and timeout behavior before opening access.

```bash
sudo docker compose -f docker-compose.yml logs --tail 100 relay egress
sudo docker compose -f docker-compose.yml stats --no-stream
sudo certbot renew --dry-run
```

Avoid enabling verbose Browserless logging with live URLs or tokens. Treat application logs, prompts, HTML, cached results, and backups as potentially sensitive. Protect the OpenRouter account with a spend cap and rotate provider credentials through the private environment file. Restart the relevant services after rotation; changing `ENCRYPTION_KEY` requires re-encrypting stored secrets rather than discarding the old key.

Back up both SQLite databases and Redis persistence before upgrades. For a consistent simple snapshot on this single-instance installation, stop writers, archive both named volumes, then restart. This temporarily interrupts requests:

```bash
umask 077
mkdir -p deploy/backups
sudo docker compose -f docker-compose.yml stop relay redis
sudo docker compose -f docker-compose.yml run --rm --no-deps -T --entrypoint tar relay -C /app/data -czf - . > "deploy/backups/relay-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
sudo docker compose -f docker-compose.yml run --rm --no-deps -T --entrypoint tar redis -C /data -czf - . > "deploy/backups/redis-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
sudo docker compose -f docker-compose.yml up -d --wait
```

Encrypt backups off-host, retain the environment secrets separately, and test restoration into a separate Compose project. Keep `deploy/backups/` out of source control; the Docker build already excludes it. Restoring an old database can restore revoked API keys, old worker jobs, or expired one-time reveals; review restored records before reconnecting infrastructure to the internet. Redis caches can be discarded when deliberately restoring a database snapshot, so stale scraped responses do not survive that rollback. Do not use `docker compose down -v` for upgrades, since it deletes persistent data.

To upgrade, preserve an immutable tag/digest of the current app and Browserless images, take a backup, build the new application, pull only the chosen Browserless/Redis versions, and run `up -d --wait`. If startup fails, inspect logs and roll back to the previous image with the compatible database backup. Certbot's system timer renews TLS independently of application releases.

Provisioning and TLS steps follow [Docker's Ubuntu installation guide](https://docs.docker.com/engine/install/ubuntu/) and [Certbot's Nginx guidance](https://certbot.eff.org/instructions?ws=nginx&os=ubuntunoble). They must be run on your host; source code and a valid Compose model do not constitute a deployed Oracle instance.
