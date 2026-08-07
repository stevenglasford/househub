# Multi-stage: build the front-end, then ship only what runs.
#
# The web build lands in server/public and is served by Express, so there is one
# container and one origin -- which also means the strict CSP does not need a
# cross-origin exception for the API.

FROM node:20-alpine AS web
WORKDIR /build/web
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
# vite.config.js writes to ../server/public
RUN mkdir -p /build/server && npm run build


FROM node:20-alpine AS deps
WORKDIR /build/server
COPY server/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund


FROM node:20-alpine
# tini reaps zombies: the upgrade pipeline spawns git and npm as children.
RUN apk add --no-cache tini git ca-certificates && \
    addgroup -g 10001 -S househub && \
    adduser -u 10001 -S -G househub househub

WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps  --chown=househub:househub /build/server/node_modules ./node_modules
COPY --chown=househub:househub server/package.json ./package.json
COPY --chown=househub:househub server/src ./src
# Operator tooling -- promoting a super-admin, and anything else that has to be
# run against a live database. Omitting these made the documented
# create-super-admin command fail with MODULE_NOT_FOUND inside the container.
COPY --chown=househub:househub server/scripts ./scripts
COPY --from=web   --chown=househub:househub /build/server/public ./public

# Writable state lives here and nowhere else in the image.
RUN mkdir -p /var/lib/househub/upgrades && chown -R househub:househub /var/lib/househub

USER househub
EXPOSE 4000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
