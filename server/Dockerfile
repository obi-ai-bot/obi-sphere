# The Sphere as one Node process (node/main.ts): SQLite in /data, no Cloudflare. Run it behind a
# proxy with TLS: deploy/docker/compose.yaml has Caddy, and docs/self-host-docker.md walks through it.
#
#   docker build -t obi-sphere server

FROM node:26-slim AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install --global pnpm@11.23.0 && pnpm install --prod --frozen-lockfile

FROM node:26-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY node ./node
COPY migrations ./migrations
RUN mkdir /data && chown node:node /data
ENV NODE_ENV=production PORT=8787 SPHERE_DATA=/data
VOLUME /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/v0.1/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "node/main.ts"]
