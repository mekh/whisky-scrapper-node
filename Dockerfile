FROM node:24 AS base
RUN rm -rf /app
WORKDIR /app

FROM base AS service_build
COPY . .

RUN corepack enable
RUN pnpm i --force --frozen-lockfile --ignore-scripts
RUN pnpm run build:prod

RUN rm -rf ./node_modules
RUN pnpm i --frozen-lockfile --ignore-scripts --prod

RUN pnpm store prune

FROM base AS service_run

# Browsers live outside any home directory so the unprivileged user can read
# them (same layout the legacy scraper image uses).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY --from=service_build /app/package.json /app/pnpm-lock.yaml ./
COPY --from=service_build /app/dist ./dist
COPY --from=service_build /app/node_modules ./node_modules

RUN apt update
RUN apt install -y mc nano iputils-ping net-tools telnet

# The browser tier (`rozetka`) needs a real Chromium plus its shared libraries
# (--with-deps installs libatk and friends). `playwright` is pinned to an exact
# version in package.json, so the browser build installed here always matches
# the client that drives it.
#
# PARTIALLY VERIFIED (2026-08-08): the stage builds on the dev machine
# (podman/arm64 — the old "cannot pull node:24" failure was stale docker.io
# credentials forwarded by compose; `podman pull` the base image first) and
# the app boots and serves from the resulting image. It mirrors
# ../scrapper/Dockerfile, which runs the same browser in production. Still
# unproven: Chromium actually running as appuser and one real `rozetka` sync
# inside the container (including whether the default /dev/shm is large
# enough). Do both before flipping that store to `ts`. See FOLLOWUPS.md,
# item 2.
RUN ./node_modules/.bin/playwright install --with-deps chromium

# Chromium's sandbox refuses to run as root; the user owns the code and the
# browsers.
RUN useradd --create-home --uid 10001 appuser \
    && chown -R appuser:appuser /app /ms-playwright
USER appuser

CMD ["node", "dist/src/main.js"]
