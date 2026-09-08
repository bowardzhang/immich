# Immich All-in-One for Railway

This image is designed for the `Family-Photos` Railway project to consolidate Immich Server, PostgreSQL and Redis-compatible storage into a single service and a single persistent volume.

## Safety / rollout

The image has now passed an ephemeral validation deployment with local PostgreSQL, Redis, VectorChord/pgvector, the custom Immich server, and a read-only logical restore from the production database. The production cutover reuses the existing Immich `/data` Railway volume and stores local AIO state under `/data/.aio` while keeping Immich media at `/data`.

Machine Learning remains intentionally disabled during the first production cutover (`IMMICH_AIO_ENABLE_ML=false`) because facial recognition and Smart Search are rarely used. It will be added as an optional local process after the core server/database/Redis combination is stable.

## Shared volume layout

Production Immich service:

- `/data` — existing Immich media/system folders
- `/data/.aio/postgres/data` — PostgreSQL cluster
- `/data/.aio/redis` — Redis persistence
- `/data/.aio/ml-cache` — optional ML cache

Validation service defaults to the equivalent layout below `/persistent`.
