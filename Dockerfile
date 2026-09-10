FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsup.config.ts vitest.config.ts ./
COPY src ./src
COPY scripts/central-copy-migrations.mjs ./scripts/central-copy-migrations.mjs
COPY scripts/central-safety-check.mjs ./scripts/central-safety-check.mjs
RUN npm run build

FROM build AS checks
RUN node scripts/central-safety-check.mjs && npm run typecheck && npm run test:central

FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS runtime
ARG SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/YIXIKEJI6/teamai-cli" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
# Keep the same Debian release; install the specific PCRE2 security fix.
# Package managers and the Corepack bootstrap are not needed by the service.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libpcre2-8-0=10.42-1+deb12u1 \
    && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v${YARN_VERSION} \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg \
        /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx
# The application bundle is self-contained; no application node_modules are copied.
COPY --from=checks /app/dist/central.js ./dist/central.js
COPY --from=checks /app/dist/migrations ./dist/migrations
COPY LICENSE ./LICENSE
RUN printf '{"type":"module","private":true}\n' > package.json
RUN mkdir -p /data && chown node:node /data
USER 1000:1000
ENV NODE_ENV=production TEAMAI_CENTRAL_HOST=0.0.0.0 TEAMAI_CENTRAL_PORT=3722 TEAMAI_CENTRAL_DB=/data/usage.sqlite
EXPOSE 3722
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3722/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/central.js"]
CMD ["serve"]
