#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[immich-aio] %s\n' "$*"; }

PERSISTENT_ROOT="${IMMICH_AIO_ROOT:-/persistent}"
PGDATA="${PGDATA:-$PERSISTENT_ROOT/postgres/data}"
REDIS_DATA_DIR="${REDIS_DATA_DIR:-$PERSISTENT_ROOT/redis}"
IMMICH_MEDIA_LOCATION="${IMMICH_MEDIA_LOCATION:-$PERSISTENT_ROOT/immich}"
ML_CACHE="${MACHINE_LEARNING_CACHE_FOLDER:-$PERSISTENT_ROOT/ml-cache}"
MIGRATION_MARKER="$PERSISTENT_ROOT/.aio-db-migrated"

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

new_cluster=false
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  new_cluster=true
  log "initializing PostgreSQL 14 cluster"
  install -d -o postgres -g postgres -m 700 "$PGDATA"
  pwfile="$(mktemp)"
  trap 'rm -f "$pwfile"' EXIT
  printf '%s' "$DB_PASSWORD" > "$pwfile"
  chown postgres:postgres "$pwfile"
  chmod 600 "$pwfile"
  runuser -u postgres -- /usr/lib/postgresql/14/bin/initdb \
    --pgdata="$PGDATA" \
    --username="$DB_USERNAME" \
    --pwfile="$pwfile" \
    --data-checksums \
    --auth-host=scram-sha-256 \
    --auth-local=trust
  rm -f "$pwfile"
  trap - EXIT

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
fi

# A newly initialized cluster must be started once before optional migration/database creation.
if [ "$new_cluster" = true ]; then
  runuser -u postgres -- /usr/lib/postgresql/14/bin/pg_ctl -D "$PGDATA" -w start

  if ! runuser -u postgres -- /usr/lib/postgresql/14/bin/psql -v ON_ERROR_STOP=1 --username "$DB_USERNAME" --dbname postgres \
      -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_DATABASE_NAME//\'/\'\'}'" | grep -q 1; then
    log "creating database $DB_DATABASE_NAME"
    runuser -u postgres -- /usr/lib/postgresql/14/bin/createdb --username "$DB_USERNAME" "$DB_DATABASE_NAME"
  fi

  if [ -n "${IMMICH_AIO_SOURCE_DB_HOST:-}" ] && [ ! -f "$MIGRATION_MARKER" ]; then
    src_port="${IMMICH_AIO_SOURCE_DB_PORT:-5432}"
    src_user="${IMMICH_AIO_SOURCE_DB_USER:-$DB_USERNAME}"
    src_db="${IMMICH_AIO_SOURCE_DB_NAME:-$DB_DATABASE_NAME}"
    src_password="${IMMICH_AIO_SOURCE_DB_PASSWORD:-$DB_PASSWORD}"

    log "starting read-only logical migration from ${IMMICH_AIO_SOURCE_DB_HOST}:${src_port}/${src_db}"
    log "source database is never modified; pg_dump is piped directly into the local PostgreSQL cluster"

    # Drop/recreate the empty target database to guarantee a clean restore target.
    runuser -u postgres -- /usr/lib/postgresql/14/bin/dropdb --if-exists --username "$DB_USERNAME" "$DB_DATABASE_NAME"
    runuser -u postgres -- /usr/lib/postgresql/14/bin/createdb --username "$DB_USERNAME" "$DB_DATABASE_NAME"

    export PGPASSWORD="$src_password"
    /usr/lib/postgresql/14/bin/pg_dump \
      --host="$IMMICH_AIO_SOURCE_DB_HOST" \
      --port="$src_port" \
      --username="$src_user" \
      --dbname="$src_db" \
      --no-owner --no-acl --format=plain \
      | runuser -u postgres -- /usr/lib/postgresql/14/bin/psql -v ON_ERROR_STOP=1 --username "$DB_USERNAME" --dbname "$DB_DATABASE_NAME"
    unset PGPASSWORD

    source_tables="$(PGPASSWORD="$src_password" /usr/lib/postgresql/14/bin/psql -h "$IMMICH_AIO_SOURCE_DB_HOST" -p "$src_port" -U "$src_user" -d "$src_db" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")"
    target_tables="$(runuser -u postgres -- /usr/lib/postgresql/14/bin/psql -U "$DB_USERNAME" -d "$DB_DATABASE_NAME" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")"
    if [ "$source_tables" != "$target_tables" ]; then
      log "migration validation failed: source public tables=$source_tables target public tables=$target_tables"
      exit 1
    fi

    # Compare counts for key Immich tables when present. This remains schema-version tolerant.
    for table in asset album "user"; do
      exists="$(runuser -u postgres -- /usr/lib/postgresql/14/bin/psql -U "$DB_USERNAME" -d "$DB_DATABASE_NAME" -Atc "SELECT to_regclass('public.\"$table\"') IS NOT NULL;")"
      if [ "$exists" = "t" ]; then
        src_count="$(PGPASSWORD="$src_password" /usr/lib/postgresql/14/bin/psql -h "$IMMICH_AIO_SOURCE_DB_HOST" -p "$src_port" -U "$src_user" -d "$src_db" -Atc "SELECT count(*) FROM \"$table\";")"
        dst_count="$(runuser -u postgres -- /usr/lib/postgresql/14/bin/psql -U "$DB_USERNAME" -d "$DB_DATABASE_NAME" -Atc "SELECT count(*) FROM \"$table\";")"
        log "migration validation $table: source=$src_count target=$dst_count"
        [ "$src_count" = "$dst_count" ] || { log "migration validation failed for $table"; exit 1; }
      fi
    done

    touch "$MIGRATION_MARKER"
    log "logical database migration completed and validated"
  fi

  runuser -u postgres -- /usr/lib/postgresql/14/bin/pg_ctl -D "$PGDATA" -m fast -w stop
fi

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
