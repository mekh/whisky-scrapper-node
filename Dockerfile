FROM node:24 AS base
RUN rm -rf /app
WORKDIR /app
RUN corepack enable

# Dependency stages are keyed on the manifests alone, so a source-only change
# never re-resolves or re-downloads a single package. `--ignore-scripts` keeps
# playwright's postinstall from pulling browsers here; the runtime stage owns
# that (and caches it separately).
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm i --frozen-lockfile --ignore-scripts

FROM base AS prod_deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm i --frozen-lockfile --ignore-scripts --prod

FROM base AS service_build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm run build:prod

FROM base AS service_run

# Browsers live outside any home directory so the unprivileged user can read
# them (same layout the legacy scraper image uses).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Must match the exact `playwright` version pinned in package.json. It is
# duplicated here on purpose: this ARG is the entire cache key of the Chromium
# layer below, so the ~500 MB download happens only when the browser version
# actually changes, not on every code deploy. The assertion further down fails
# the build if the two ever drift apart.
ARG PLAYWRIGHT_VERSION=1.62.0

# Everything from here to the app COPYs is deploy-invariant and stays cached.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        mc nano iputils-ping net-tools telnet \
    && rm -rf /var/lib/apt/lists/*

# The browser tier (`rozetka`) needs a real Chromium plus its shared libraries
# (--with-deps installs libatk and friends). Installed via `npx playwright@<v>`
# rather than the project's own binary so the layer does not depend on
# node_modules — that dependency is what used to re-download Chromium on every
# deploy.
#
# PARTIALLY VERIFIED (2026-08-08): the stage builds on the dev machine
# (podman/arm64 — the old "cannot pull node:24" failure was stale docker.io
# credentials forwarded by compose; `podman pull` the base image first), the
# app boots and serves from the resulting image, and Chromium launches inside
# the container as appuser with the engine's own launch arguments. It mirrors
# ../scrapper/Dockerfile, which runs the same browser in production. Still
# unproven: the same on the amd64 production host, and one real `rozetka`
# sync in the container (including whether the default /dev/shm holds up
# under a full walk). Do both before flipping that store to `ts`. See
# FOLLOWUPS.md, item 2.
RUN npx --yes playwright@"${PLAYWRIGHT_VERSION}" install --with-deps chromium \
    && rm -rf /root/.npm

# Chromium's sandbox refuses to run as root; the user owns the code and the
# browsers. The recursive chown sits in this cached block because it doubles
# the size of the Chromium layer every time it runs.
RUN useradd --create-home --uid 10001 appuser \
    && chown -R appuser:appuser /ms-playwright /app

# Only the layers below change on a code deploy; they are ordered
# least-to-most volatile. `--chown` avoids a second full copy of node_modules.
COPY --from=prod_deps --chown=appuser:appuser /app/package.json /app/pnpm-lock.yaml ./
COPY --from=prod_deps --chown=appuser:appuser /app/node_modules ./node_modules
COPY --from=service_build --chown=appuser:appuser /app/dist ./dist

# Guard against PLAYWRIGHT_VERSION drifting away from package.json: a mismatch
# would otherwise surface only as a "browser not found" error during the first
# rozetka sync.
RUN installed="$(node -p "require('./node_modules/playwright/package.json').version")" \
    && [ "${installed}" = "${PLAYWRIGHT_VERSION}" ] \
    || { \
        echo "playwright ${installed} in package.json != PLAYWRIGHT_VERSION=${PLAYWRIGHT_VERSION} in Dockerfile" >&2; \
        exit 1; \
    }

USER appuser

CMD ["node", "dist/src/main.js"]
