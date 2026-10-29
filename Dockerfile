# Oracle keeper (cross-cluster, relaunch / fresh-ID wrapper ETDLAdi) on Railway.
# Mirrors the Mac launchd launcher start-keeper-relaunch.sh: same Node (25.6.1),
# same pnpm lockfile, same entry point (src/cross-cluster.ts via tsx), TSX cache off.
FROM node:25.6.1-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g pnpm@10.33.0

COPY package.json pnpm-lock.yaml ./
COPY vendor/ vendor/
RUN pnpm install --frozen-lockfile --prod

COPY tsconfig.json ./
COPY src/ src/
COPY deploy/ deploy/

# Runs as root: Railway volumes (registry lives on /data) mount root-owned.
ENV NODE_ENV=production \
    TSX_DISABLE_CACHE=1 \
    CC_HEALTH_BIND=0.0.0.0

CMD ["bash", "deploy/railway-start.sh"]
