#!/usr/bin/env bash
set -euo pipefail

pg_isready -h 127.0.0.1 -p "${DB_PORT:-5432}" -U "${DB_USERNAME:-postgres}" -d "${DB_DATABASE_NAME:-immich}" >/dev/null
redis-cli -h 127.0.0.1 -p "${REDIS_PORT:-6379}" ping | grep -q '^PONG$'
curl -fsS "http://127.0.0.1:${IMMICH_PORT:-2283}/api/server/ping" >/dev/null
