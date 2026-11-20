FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM build AS test
COPY test ./test
CMD ["npm", "test"]

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/bucketeer.sqlite
WORKDIR /app
COPY --from=build /app/dist ./dist
# Without the image's own UTC zone files, a host /etc/localtime mounted by compose sets the zone (ADR-0007).
RUN ln -s /app/dist/cli.js /usr/local/bin/bucketeer \
    && mkdir /data && chown node:node /data \
    && rm -f /etc/localtime /etc/timezone
USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=10s --timeout=6s --start-period=5s --retries=3 CMD bucketeer status --url "http://127.0.0.1:${PORT}" --json
CMD ["node", "dist/server.js"]
