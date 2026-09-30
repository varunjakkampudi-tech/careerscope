ARG NODE_IMAGE=node:26.8.1-bookworm-slim@sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e
ARG GO_IMAGE=golang:1.26-alpine
ARG ALPINE_IMAGE=alpine:3.23

# Upstream caddy:2-alpine ships a binary built with a vulnerable Go toolchain and
# dependencies, so the proxy binary is rebuilt here instead of being consumed as-is.
FROM ${GO_IMAGE} AS caddy-build
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
WORKDIR /build
RUN printf '%s\n' \
    'package main' \
    'import (' \
    '  caddycmd "github.com/caddyserver/caddy/cmd"' \
    '  _ "github.com/caddyserver/caddy/caddyconfig/caddyfile"' \
    '  _ "github.com/caddyserver/caddy/modules/caddyhttp"' \
    '  _ "github.com/caddyserver/caddy/modules/caddyhttp/fileserver"' \
    '  _ "github.com/caddyserver/caddy/modules/caddyhttp/headers"' \
    '  _ "github.com/caddyserver/caddy/modules/caddyhttp/requestbody"' \
    '  _ "github.com/caddyserver/caddy/modules/caddyhttp/reverseproxy"' \
    '  _ "github.com/caddyserver/caddy/modules/caddyhttp/rewrite"' \
    ')' \
    'func main() { caddycmd.Main() }' > main.go \
    && go mod init careerscope/proxy \
    && go get github.com/caddyserver/caddy/v2@latest \
    && go get golang.org/x/net@latest golang.org/x/crypto@latest \
    && go get google.golang.org/grpc@v1.83.2 \
    && go mod tidy \
    && go build -trimpath -ldflags '-s -w' -o /out/caddy .

FROM ${ALPINE_IMAGE} AS proxy
ARG CAREERSCOPE_REVISION=unknown
LABEL org.opencontainers.image.revision="${CAREERSCOPE_REVISION}"
LABEL org.opencontainers.image.source="https://github.com/varunjakkampudi-tech/careerscope"
RUN apk upgrade --no-cache \
    && apk add --no-cache ca-certificates mailcap \
    && mkdir -p /config/caddy /data/caddy \
    && chown -R 1000:1000 /config /data
COPY --from=caddy-build /out/caddy /usr/bin/caddy
USER 1000:1000
ENV XDG_CONFIG_HOME=/config XDG_DATA_HOME=/data
ENTRYPOINT ["/usr/bin/caddy"]
CMD ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake python3 \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY migrations ./migrations
COPY scripts ./scripts
COPY drizzle.config.ts ./drizzle.config.ts
RUN npm ci
RUN npm run build --workspace @careerscope/shared \
    && npm run build --workspace @careerscope/resume \
    && npm run build --workspace @careerscope/matching \
    && npm run build --workspace @careerscope/providers
RUN npm run build
RUN npm prune --omit=dev --omit=optional

FROM ${NODE_IMAGE} AS runtime
ARG CAREERSCOPE_REVISION=unknown
LABEL org.opencontainers.image.revision="${CAREERSCOPE_REVISION}"
LABEL org.opencontainers.image.source="https://github.com/varunjakkampudi-tech/careerscope"
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 CAREERSCOPE_REVISION=${CAREERSCOPE_REVISION}
# The base image is digest-pinned for reproducibility, so it never picks up
# Debian security updates on its own; apply them explicitly.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/workers/search/package.json ./apps/workers/search/package.json
COPY --from=build /app/apps/workers/search/dist ./apps/workers/search/dist
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/apps/web/next.config.ts ./apps/web/next.config.ts
COPY --from=build /app/apps/web/.next ./apps/web/.next
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/scripts/migrate.ts ./scripts/migrate.ts
COPY --from=build /app/scripts/setup-owner.ts ./scripts/setup-owner.ts
# backfill-job-sightings.ts (CS-28) was documented as a one-time production
# step but never actually reached the runtime image until now - the fix
# landed here, alongside the same gap for CS-26's script, rather than in two
# separate changes.
COPY --from=build /app/scripts/backfill-job-sightings.ts ./scripts/backfill-job-sightings.ts
COPY --from=build /app/scripts/run-scheduled-discovery.ts ./scripts/run-scheduled-discovery.ts
COPY --from=build /app/scripts/check-lead-liveness.ts ./scripts/check-lead-liveness.ts
COPY --from=build /app/scripts/enforce-search-retention.ts ./scripts/enforce-search-retention.ts
RUN mkdir -p /private/objects /app/apps/web/.next/cache \
    && chown -R node:node /private /app/apps/web/.next/cache \
    && chmod 700 /private /private/objects
WORKDIR /app
USER node
CMD ["node", "apps/api/dist/main.js"]
