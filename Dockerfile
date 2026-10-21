# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Build-time values only. Runtime secrets are injected by Compose and never copied
# into the image; no build-time database is copied into the runtime stage.
RUN APP_ORIGIN=https://build.relay.invalid \
    BETTER_AUTH_URL=https://build.relay.invalid \
    BETTER_AUTH_SECRET=build-only-not-a-runtime-authentication-secret \
    DASHBOARD_PASSWORD=build-only-not-a-runtime-owner-password \
    SESSION_SECRET=build-only-not-a-runtime-session-secret \
    ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
    SCRAPER_ENABLED=false \
    npm run build \
    && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 \
    NEXT_TELEMETRY_DISABLED=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/data /app/.next/cache \
    && chown -R node:node /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/next.config.ts /app/tsconfig.json ./
COPY --from=build --chown=node:node /app/deploy ./deploy
USER node
EXPOSE 3000 3001
HEALTHCHECK --interval=30s --timeout=8s --start-period=45s --retries=3 CMD ["node", "deploy/healthcheck.mjs"]
CMD ["node", "deploy/start.mjs"]
