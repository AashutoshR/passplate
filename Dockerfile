# One image for the server processes: the API (default), the realtime
# gateway and the outbox relay. Stateless: run as many API copies as the
# load needs behind a load balancer (NFR-1).
#
#   docker build -t passplate .
#   docker run passplate                                   # API on :4000
#   docker run passplate bun apps/gateway/src/index.ts     # gateway on :4100
#   docker run passplate bun apps/worker/src/index.ts      # outbox relay

FROM oven/bun:1.4.4-alpine
WORKDIR /app
ENV NODE_ENV=production

# Dependencies first, so source changes do not reinstall them.
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/gateway/package.json apps/gateway/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/gateway ./apps/gateway
COPY apps/worker ./apps/worker

USER bun
EXPOSE 4000
CMD ["bun", "apps/api/src/index.ts"]
