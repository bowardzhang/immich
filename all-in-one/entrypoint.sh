#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[immich-aio] %s\n' "$*"; }

PERSISTENT_ROOT="${IMMICH_AIO_ROOT:-/persistent}"
PGDATA="${PGDATA:-$PERSISTENT_ROOT/postgres/data}"
REDIS_DATA_DIR="${REDIS_DATA_DIR:-$PERSISTENT_ROOT/redis}"
IMMICH_MEDIA_LOCATION="${IMMICH_MEDIA_LOCATION:-$PERSISTENT_ROOT/immich}"
ML_CACHE="${MACHINE_LEARNING_CACHE_FOLDER:-$PERSISTENT_ROOT/ml-cache}"

export PGDATA REDIS_DATA_DIR IMMICH_MEDIA_LOCATION MACHINE_LEARNING_CACHE_FOLDER="$ML_CACHE"
export DB_HOSTNAME=127.0.0.1 DB_PORT="${DB_PORT:-5432}"
export REDIS_HOSTNAME=127.0.0.1 REDIS_PORT="${REDIS_PORT:-6379}"

: "${DB_USERNAME:=${POSTGRES_USER:-postgres}}"
: "${DB_PASSWORD:=${POSTGRES_PASSWORD:-postgres}}"
: "${DB_DATABASE_NAME:=${POSTGRES_DB:-immich}}"
export DB_USERNAME DB_PASSWORD DB_DATABASE_NAME
export POSTGRES_USER="$DB_USERNAME" POSTGRES_PASSWORD="$DB_PASSWORD" POSTGRES_DB="$DB_DATABASE_NAME"

log "preparing shared persistent tree at $PERSISTENT_ROOT"
mkdir -p "$PGDATA" "$REDIS_DATA_DIR" "$IMMICH_MEDIA_LOCATION" "$ML_CACHE"
chown -R postgres:postgres "$(dirname "$PGDATA")"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  log "initializing PostgreSQL 14 cluster"
  install -d -o postgres -g postgres -m 700 "$PGDATA"
  runuser -u postgres -- /usr/lib/postgresql/14/bin/initdb \
    --pgdata="$PGDATA" \
    --username="$DB_USERNAME" \
    --pwfile=<(printf '%s' "$DB_PASSWORD") \
    --data-checksums \
    --auth-host=scram-sha-256 \
    --auth-local=trust

  cat >> "$PGDATA/postgresql.conf" <<'PGCONF'
listen_addresses = '127.0.0.1'
port = 5432
shared_preload_libraries = 'vchord.so, vectors.so'
max_connections = 100
shared_buffers = 128MB
fsync = on
synchronous_commit = on
full_page_writes = on
PGCONF

  # Start only long enough to create the Immich database if it differs from the bootstrap user.
  runuser -u postgres -- /usr/lib/postgresql/14/bin/pg_ctl -D "$PGDATA" -w start
  if ! runuser -u postgres -- /usr/lib/postgresql/14/bin/psql -v ON_ERROR_STOP=1 --username "$DB_USERNAME" --dbname postgres \
      -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_DATABASE_NAME//\'/\'\'}'" | grep -q 1; then
    log "creating database $DB_DATABASE_NAME"
    runuser -u postgres -- /usr/lib/postgresql/14/bin/createdb --username "$DB_USERNAME" "$DB_DATABASE_NAME"
  fi
  runuser -u postgres -- /usr/lib/postgresql/14/bin/pg_ctl -D "$PGDATA" -m fast -w stop
fi

# Redis/Valkey is deliberately lightweight. Persistence is kept in the same Railway volume.
cat > /tmp/redis-aio.conf <<EOF
bind 127.0.0.1
port ${REDIS_PORT}
dir ${REDIS_DATA_DIR}
dbfilename dump.rdb
appendonly no
save 900 1
save 300 10
save 60 10000
protected-mode yes
EOF

log "starting PostgreSQL, Redis and Immich under supervisord"
exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf
