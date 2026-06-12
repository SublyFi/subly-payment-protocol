# Runs both Subly processes from one image:
#   facilitator (default):  node dist/index.js
#   hosted seller:          npx tsx demo/seller.ts   (compose overrides command)
# The sponsor keypair is NOT baked in; mount it and point
# SUBLY_SPONSOR_KEYPAIR_PATH at the mount (see deploy/docker-compose.yml).
# node:24 keeps the container's npm in line with the npm 11 that generated
# package-lock.json (npm 10 in node:22 rejects the lock as out of sync).
FROM node:24-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY demo ./demo
COPY scripts ./scripts
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/index.js"]
