# Railway Immich All-in-One image
# Combines the custom Immich server build with PostgreSQL 14 + VectorChord,
# Redis-compatible Valkey and optional Machine Learning in one Railway service.

FROM ghcr.io/immich-app/base-server-dev:202607211135@sha256:83c9ff3f7390111596a2dcd24a746c3f8618d58259dbc7aae36618d153462f18 AS builder
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1 COREPACK_HOME=/tmp PNPM_HOME=/buildcache/pnpm-store PATH="/buildcache/pnpm-store:$PATH"
RUN npm install --global corepack@latest && corepack enable pnpm && pnpm config set store-dir "$PNPM_HOME"

FROM builder AS server-build
WORKDIR /usr/src/app
COPY package.json .pnpmfile.cjs pnpm-lock.yaml pnpm-workspace.yaml ./
COPY ./server ./server/
COPY ./packages/sdk ./packages/sdk/
COPY ./packages/plugin-sdk ./packages/plugin-sdk/
RUN SHARP_IGNORE_GLOBAL_LIBVIPS=true pnpm --filter @immich/sdk --filter @immich/plugin-sdk --filter immich build && \
    SHARP_FORCE_GLOBAL_LIBVIPS=true pnpm --filter immich --prod --no-optional deploy /output/server-pruned

FROM builder AS web-build
WORKDIR /usr/src/app
COPY package.json .pnpmfile.cjs pnpm-lock.yaml pnpm-workspace.yaml ./
COPY ./web ./web/
COPY ./i18n ./i18n/
COPY ./packages ./packages/
RUN SHARP_IGNORE_GLOBAL_LIBVIPS=true pnpm --filter @immich/sdk --filter immich-web install --frozen-lockfile --force && \
    pnpm --filter @immich/sdk --filter immich-web build

FROM builder AS cli-build
WORKDIR /usr/src/app
COPY package.json .pnpmfile.cjs pnpm-lock.yaml pnpm-workspace.yaml ./
COPY ./packages ./packages/
RUN pnpm --filter @immich/sdk --filter @immich/cli install --frozen-lockfile && \
    pnpm --filter @immich/sdk --filter @immich/cli build && \
    pnpm --filter @immich/cli --prod --no-optional deploy /output/cli-pruned

FROM builder AS plugins-build
ARG TARGETPLATFORM
COPY --from=ghcr.io/jdx/mise:2026.7.11@sha256:6599c81b0da6206cbf5151df97a36794d70aaec4574ceb92d13783b42080b055 /usr/local/bin/mise /usr/local/bin/mise
WORKDIR /app
COPY package.json .pnpmfile.cjs pnpm-lock.yaml pnpm-workspace.yaml ./
COPY ./mise.toml ./mise.toml
COPY ./packages/plugin-core/mise.toml ./packages/plugin-core/
ENV MISE_TRUSTED_CONFIG_PATHS=/app/mise.toml MISE_DATA_DIR=/buildcache/mise MISE_DISABLE_TOOLS=flutter
RUN mise install
COPY ./packages/sdk ./packages/sdk/
COPY ./packages/plugin-core ./packages/plugin-core/
COPY ./packages/plugin-sdk ./packages/plugin-sdk/
RUN mise //:plugins

# Keep the exact production runtime used by this fork, then add the local stateful services.
FROM ghcr.io/immich-app/base-server-prod:202607211135@sha256:ced131da7523544fe975cfd25abd67386e712e39496340b437cd95a08d0a18f3 AS runtime
ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive

# PostgreSQL 14 and Redis. VectorChord/pgvecto.rs are installed below to match the
# existing Immich database image (14-vectorchord0.4.3-pgvectors0.2.0).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg postgresql-common redis-server supervisor && \
    mkdir -p /usr/share/postgresql-common/pgdg && \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc && \
    . /etc/os-release && \
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list && \
    apt-get update && apt-get install -y --no-install-recommends postgresql-14 postgresql-client-14 && \
    ARCH="$(dpkg --print-architecture)" && \
    wget -q -O /tmp/vchord.deb "https://github.com/tensorchord/VectorChord/releases/download/0.4.3/postgresql-14-vchord_0.4.3-1_${ARCH}.deb" && \
    wget -q -O /tmp/pgvectors.deb "https://github.com/tensorchord/pgvecto.rs/releases/download/v0.2.0/vectors-pg14_0.2.0_${ARCH}.deb" && \
    apt-get install -y /tmp/vchord.deb /tmp/pgvectors.deb && \
    rm -f /tmp/*.deb && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
COPY --from=server-build /output/server-pruned ./server
COPY --from=web-build /usr/src/app/web/build /build/www
COPY --from=cli-build /output/cli-pruned ./cli
COPY --from=plugins-build /app/packages/plugin-core/dist /build/plugins/immich-plugin-core/dist
COPY --from=plugins-build /app/packages/plugin-core/manifest.json /build/plugins/immich-plugin-core/manifest.json
RUN ln -s ../../cli/bin/immich server/bin/immich
COPY LICENSE /licenses/LICENSE.txt
COPY LICENSE /LICENSE
COPY all-in-one/entrypoint.sh /usr/local/bin/immich-aio-entrypoint
COPY all-in-one/supervisord.conf /etc/supervisor/conf.d/immich-aio.conf
COPY all-in-one/healthcheck.sh /usr/local/bin/immich-aio-healthcheck
RUN chmod +x /usr/local/bin/immich-aio-entrypoint /usr/local/bin/immich-aio-healthcheck

ENV PATH="${PATH}:/usr/src/app/server/bin" \
    NODE_ENV=production \
    IMMICH_MEDIA_LOCATION=/persistent/immich \
    PGDATA=/persistent/postgres/data \
    REDIS_DATA_DIR=/persistent/redis \
    MACHINE_LEARNING_CACHE_FOLDER=/persistent/ml-cache \
    IMMICH_AIO_ENABLE_ML=false \
    DB_HOSTNAME=127.0.0.1 \
    DB_PORT=5432 \
    REDIS_HOSTNAME=127.0.0.1 \
    REDIS_PORT=6379 \
    IMMICH_MACHINE_LEARNING_URL=http://127.0.0.1:3003

EXPOSE 2283
ENTRYPOINT ["tini", "--", "/usr/local/bin/immich-aio-entrypoint"]
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=5 CMD ["/usr/local/bin/immich-aio-healthcheck"]
