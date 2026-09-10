# syntax=docker/dockerfile:1.7
#
# Job Radar — API image (also serves the SPA).
#
# ## Why node:24
#
# The database layer uses `node:sqlite`, which is a *built-in* module rather
# than a native dependency. That is what keeps this image small — no
# build-essential, no node-gyp, no prebuild download — but it also pins the
# floor: `node:sqlite` needed `--experimental-sqlite` until 23.3, became
# unflagged in 23.4, and only stabilised in 24.0. Anything older than 24 will
# either refuse the import or print an experimental warning on every boot.
#
# ## Two targets
#
# `api` is the default: no browser, no display. The three browser-backed
# sources report themselves unavailable, with a reason, and every other source
# works normally.
#
# `api-scrape` is that same image plus Chromium, its shared libraries and an X
# server — several times the size, for one opt-in tier. Build it only if you
# intend to set ENABLE_SCRAPERS=true; the code path is otherwise identical, and
# a source that is switched off does not get cheaper for being installed.
#
# Build from the repository root:
#   docker build -f infra/Dockerfile --target api        -t job-radar:latest .
#   docker build -f infra/Dockerfile --target api-scrape -t job-radar:scrape .

ARG NODE_IMAGE=node:24-slim


# --------------------------------------------------------------------------
# manifests — the package.json files and nothing else
#
# Every install stage starts here, so editing a source file does not invalidate
# any of them. The workspace manifests must be listed one by one: a COPY
# wildcard flattens directories, which would break the layout npm needs.
# --------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS manifests
WORKDIR /app

# Playwright's postinstall downloads ~150 MB of browsers. Two of the three
# install stages below have no use for them, and the third wants them somewhere
# it controls, so the download is switched off here and done explicitly in
# `api-scrape`.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/resume/package.json packages/resume/
COPY packages/matching/package.json packages/matching/
COPY packages/providers/package.json packages/providers/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/


# --------------------------------------------------------------------------
# deps — full install, including dev
# --------------------------------------------------------------------------
FROM manifests AS deps

RUN --mount=type=cache,target=/root/.npm npm ci


# --------------------------------------------------------------------------
# build — compile every workspace, then bundle the SPA
# --------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps apps
COPY mobile-site/jobs.json mobile-site/jobs.json

# Empty API base URL means "same origin as this page", which is exactly right
# for this image: the API serves the bundle itself. The Pages build overrides
# both of these — see .github/workflows/deploy-pages.yml.
ARG VITE_API_BASE_URL=""
ARG VITE_BASE_PATH="/"
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL} \
    VITE_BASE_PATH=${VITE_BASE_PATH}

RUN npm run build


# --------------------------------------------------------------------------
# prod-deps — the same lockfile, without anything only the build needed
#
# A separate stage rather than `npm prune` in place, so the runtime image
# never contains a layer that once held TypeScript, Vite and Vitest.
#
# `--omit=optional` is what leaves Playwright out. It is an optional dependency
# of @job-radar/providers precisely so this line can be a flag rather than a
# second manifest: the code has a real path for its absence, and greying the
# browser sources out with a reason is a supported state, not a failure.
# --------------------------------------------------------------------------
FROM manifests AS prod-deps

RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --omit=optional


# --------------------------------------------------------------------------
# scrape-deps — production dependencies plus Playwright
#
# Identical to prod-deps but for the omitted flag, and from the same lockfile,
# so the two images cannot drift in anything except the browser.
# --------------------------------------------------------------------------
FROM manifests AS scrape-deps

RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev


# --------------------------------------------------------------------------
# api — the runtime image
# --------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS api
WORKDIR /app

# WEB_DIST is absolute because it resolves against the working directory, and
# the default `../web/dist` assumes a cwd of apps/api. Here the cwd is /app.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/app/data \
    SERVE_WEB=true \
    WEB_DIST=/app/apps/web/dist

# node_modules first: it contains symlinks into packages/*, so those
# directories have to exist by the time anything resolves an import.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./package.json

COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/resume/package.json ./packages/resume/
COPY --from=build /app/packages/resume/dist ./packages/resume/dist
COPY --from=build /app/packages/matching/package.json ./packages/matching/
COPY --from=build /app/packages/matching/dist ./packages/matching/dist
COPY --from=build /app/packages/providers/package.json ./packages/providers/
COPY --from=build /app/packages/providers/dist ./packages/providers/dist

COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist

# Seed data lives at /app/seed, NOT /app/data. The data directory is a mounted
# volume, and a volume mounted over a directory hides whatever the image put
# there — so seed files kept in `data/` would be invisible on the one boot
# that actually needs them. WORKDIR is /app, so this is also exactly where
# `seedFileArg()` looks by default.
COPY seed ./seed

COPY infra/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# The `node` user ships with the base image (uid 1000). Creating the data
# directory here and handing it over means a *named* volume inherits this
# ownership when Docker first populates it. A bind mount does not — the host
# directory has to be chown'd to 1000 by hand (see docs/RUNBOOK.md).
RUN mkdir -p /app/data && chown -R node:node /app/data /app/seed
USER node

EXPOSE 8080

# `fetch` is global in Node 24, so this needs no curl in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "/app/apps/api/dist/index.js"]


# --------------------------------------------------------------------------
# api-scrape — the same server, with a browser and somewhere to draw it
#
# Derived from `api` rather than assembled alongside it, so the two images can
# only differ in what is added below. Everything above — env, layout, seed,
# entrypoint, healthcheck, ownership — is inherited and cannot drift.
#
# This target is only worth building with ENABLE_SCRAPERS=true. Without it the
# browser sources stay off and this is `api` carrying a browser it never opens.
# --------------------------------------------------------------------------
FROM api AS api-scrape

# `api` ended on USER node; apt and the browser install need root back.
USER root

# Playwright resolves browsers relative to this, at install time *and* at
# launch. Left at its default they would land in root's home directory and be
# unreadable by the user that actually runs them.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Merges over the pruned tree from prod-deps: same lockfile, same resolution,
# so the only new directory is playwright itself.
COPY --from=scrape-deps /app/node_modules ./node_modules

# xvfb is not among Playwright's dependencies — those are the libraries
# Chromium links against, not an X server — so it is asked for by name.
#
# `--with-deps` shells out to apt with a distro-specific package list. If a
# future base image is newer than the Playwright in the lockfile knows about,
# it says so and stops; the fix is to build both stages on a release it does
# know, e.g. --build-arg NODE_IMAGE=node:24-bookworm-slim.
RUN apt-get update \
 && apt-get install -y --no-install-recommends xvfb \
 && ./node_modules/.bin/playwright install --with-deps chromium \
 && chmod -R a+rX /ms-playwright \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

COPY infra/xvfb-exec.sh /usr/local/bin/xvfb-exec.sh
RUN chmod +x /usr/local/bin/xvfb-exec.sh

USER node

# The entrypoint still runs first and still `exec`s this, so the X server comes
# up between the migration and the server, and node still ends up as PID 1.
CMD ["/usr/local/bin/xvfb-exec.sh", "node", "/app/apps/api/dist/index.js"]

FROM api-scrape AS api-apply

USER root
ARG COPILOT_VERSION=1.0.83
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git x11vnc novnc websockify \
 && npm install --global @github/copilot@${COPILOT_VERSION} \
 && copilot --version \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

ENV APPLICATION_COPILOT_PATH=/usr/local/bin/copilot
COPY infra/application-exec.sh /usr/local/bin/application-exec.sh
RUN chmod +x /usr/local/bin/application-exec.sh \
 && mkdir -p /home/node/.copilot /home/node/.vnc \
 && chown -R node:node /home/node

USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "Promise.all(['http://127.0.0.1:8080/api/health/ready','http://127.0.0.1:6080/vnc.html'].map(url=>fetch(url).then(r=>{if(!r.ok)throw Error('not ready')}))).then(()=>process.exit(0),()=>process.exit(1))"
CMD ["/usr/local/bin/xvfb-exec.sh", "/usr/local/bin/application-exec.sh", "node", "/app/apps/api/dist/index.js"]
