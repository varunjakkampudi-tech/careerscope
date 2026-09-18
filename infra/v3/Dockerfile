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
    '  caddycmd "github.com/caddyserver/caddy/v2/cmd"' \
    '  _ "github.com/caddyserver/caddy/v2/caddyconfig/caddyfile"' \
    '  _ "github.com/caddyserver/caddy/v2/modules/caddyhttp"' \
    '  _ "github.com/caddyserver/caddy/v2/modules/caddyhttp/headers"' \
    '  _ "github.com/caddyserver/caddy/v2/modules/caddyhttp/requestbody"' \
    '  _ "github.com/caddyserver/caddy/v2/modules/caddyhttp/reverseproxy"' \
    ')' \
    'func main() { caddycmd.Main() }' > main.go \
    && go mod init careerscope/proxy \
    && go get github.com/caddyserver/caddy/v2@latest \
    && go get golang.org/x/net@latest golang.org/x/crypto@latest \
    && go get google.golang.org/grpc@v1.83.2 \
    && go mod tidy \
    && go build -trimpath -ldflags '-s -w' -o /out/caddy .

FROM ${ALPINE_IMAGE} AS proxy
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
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci
RUN npm run build --workspace @job-radar/shared \
    && npm run build --workspace @job-radar/resume \
    && npm run build --workspace @job-radar/matching \
    && npm run build --workspace @job-radar/providers
COPY v2 ./v2
RUN npm ci --prefix v2 && npm --prefix v2 run build
RUN npm prune --omit=dev --omit=optional && npm prune --prefix v2 --omit=dev

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
COPY --from=build /app/v2/package.json ./v2/package.json
COPY --from=build /app/v2/node_modules ./v2/node_modules
COPY --from=build /app/v2/packages ./v2/packages
COPY --from=build /app/v2/apps/api/package.json ./v2/apps/api/package.json
COPY --from=build /app/v2/apps/api/dist ./v2/apps/api/dist
COPY --from=build /app/v2/apps/workers/search/package.json ./v2/apps/workers/search/package.json
COPY --from=build /app/v2/apps/workers/search/dist ./v2/apps/workers/search/dist
COPY --from=build /app/v2/apps/web/package.json ./v2/apps/web/package.json
COPY --from=build /app/v2/apps/web/next.config.ts ./v2/apps/web/next.config.ts
COPY --from=build /app/v2/apps/web/.next ./v2/apps/web/.next
COPY --from=build /app/v2/migrations ./v2/migrations
COPY --from=build /app/v2/scripts/migrate.ts ./v2/scripts/migrate.ts
COPY --from=build /app/v2/scripts/setup-owner.ts ./v2/scripts/setup-owner.ts
RUN mkdir -p /private/objects /app/v2/apps/web/.next/cache \
    && chown -R node:node /private /app/v2/apps/web/.next/cache \
    && chmod 700 /private /private/objects
WORKDIR /app/v2
USER node
CMD ["node", "apps/api/dist/main.js"]