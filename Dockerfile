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
RUN pwd

COPY --from=service_build /app/package.json /app/pnpm-lock.yaml ./
COPY --from=service_build /app/dist ./dist
COPY --from=service_build /app/node_modules ./node_modules

RUN apt update
RUN apt install -y mc nano iputils-ping net-tools telnet
# CMD ["ping", "-i", "600", "google.com"]

CMD ["pnpm", "run", "start:prod"]
