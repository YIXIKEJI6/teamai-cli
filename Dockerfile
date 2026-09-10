FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS build
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

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS runtime
ARG SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/YIXIKEJI6/teamai-cli" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
# The central bundle is self-contained. No CLI dependencies, tooling, credentials or HOME in this image.
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
