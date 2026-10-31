ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ARG GO_IMAGE=golang:1.26-alpine@sha256:a2012b4a1d1f9f7e9f44e0d39b805a901e856b1dd80b4e6ee4338db547050308
ARG ALPINE_IMAGE=alpine:3.23@sha256:ff7f0c727dd796aa36787bfcd9a64bf35a6ce72a73451b3359fde849b6703d63

# Upstream caddy:2-alpine ships a binary built with a vulnerable Go toolchain and
# dependencies, so the proxy binary is rebuilt here instead of being consumed as-is.
# Every module is pinned to an exact released version (no @latest) so a rebuild of the
# same revision resolves the same dependency graph; bump the pins deliberately.
FROM ${GO_IMAGE} AS caddy-build
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
WORKDIR /build
RUN printf '%s\n' \
    'package main' \
    'import (' \
    '  caddycmd "github.com/caddyserver/caddy/v2/cmd"' \
    '  _ "github.com/caddyserver/caddy/v2/caddyconfig/caddyfile"' \
    '  _ "github.com/caddyserver/caddy/v2/modules/caddyhttp"' \
    '  _ "github.com/caddyserver/caddy/v2/modules/caddyhttp/caddyauth"' \
    '  _ "github.com/caddyserver/caddy/v2/modules/caddyhttp/fileserver"' \
    '  _ "github.com/caddyserver/caddy/v2/modules/caddyhttp/headers"' \
    '  _ "github.com/caddyserver/caddy/v2/modules/caddyhttp/requestbody"' \
    '  _ "github.com/caddyserver/caddy/v2/modules/caddyhttp/reverseproxy"' \
    '  _ "github.com/caddyserver/caddy/v2/modules/caddyhttp/rewrite"' \
    ')' \
    'func main() { caddycmd.Main() }' > main.go \
    && go mod init careerscope/proxy \
    && go get github.com/caddyserver/caddy/v2@v2.11.7 \
    && go get golang.org/x/net@v0.62.0 golang.org/x/crypto@v0.58.0 \
    && go get google.golang.org/grpc@v1.83.2 \
    && go mod tidy \
    && go build -trimpath -ldflags '-s -w' -o /out/caddy .

FROM ${ALPINE_IMAGE} AS proxy
ARG CAREERSCOPE_REVISION=unknown
LABEL org.opencontainers.image.revision="${CAREERSCOPE_REVISION}"
LABEL org.opencontainers.image.source="https://github.com/varunjakkampudi-tech/careerscope"
# Exact package versions from the pinned alpine:3.23 repository. If a pinned version leaves the
# repository the build fails loudly; bump the pins together with ALPINE_IMAGE. No apk upgrade runs.
RUN apk add --no-cache ca-certificates=20261020-r0 mailcap=2.1.54-r0 \
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
# No OS packages are installed in the build stage: every native dependency ships a prebuilt binary
# for linux-x64 (argon2, next/swc), so no compiler toolchain is needed and there is nothing to pin.
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
# Argon2 and Next.js ship platform-specific runtime binaries as optional
# dependencies. Removing them breaks authentication and the production server.
RUN npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
ARG CAREERSCOPE_REVISION=unknown
LABEL org.opencontainers.image.revision="${CAREERSCOPE_REVISION}"
LABEL org.opencontainers.image.source="https://github.com/varunjakkampudi-tech/careerscope"
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 CAREERSCOPE_REVISION=${CAREERSCOPE_REVISION}
# The base image is digest-pinned and no unpinned package upgrade runs here, so a
# rebuild is reproducible. Debian security updates arrive by bumping NODE_IMAGE to
# a newer digest, not by an apt-get upgrade at build time.
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
COPY --from=build /app/scripts/jobs/migrate.ts ./scripts/jobs/migrate.ts
COPY --from=build /app/scripts/jobs/setup-owner.ts ./scripts/jobs/setup-owner.ts
# backfill-job-sightings.ts (CS-28) was documented as a one-time production
# step but never actually reached the runtime image until now - the fix
# landed here, alongside the same gap for CS-26's script, rather than in two
# separate changes.
COPY --from=build /app/scripts/jobs/backfill-job-sightings.ts ./scripts/jobs/backfill-job-sightings.ts
COPY --from=build /app/scripts/jobs/run-scheduled-discovery.ts ./scripts/jobs/run-scheduled-discovery.ts
COPY --from=build /app/scripts/jobs/check-lead-liveness.ts ./scripts/jobs/check-lead-liveness.ts
COPY --from=build /app/scripts/jobs/enforce-search-retention.ts ./scripts/jobs/enforce-search-retention.ts
RUN mkdir -p /private/objects /app/apps/web/.next/cache \
    && chown -R node:node /private /app/apps/web/.next/cache \
    && chmod 700 /private /private/objects
WORKDIR /app
USER node
CMD ["node", "apps/api/dist/main.js"]
