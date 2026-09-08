# Immich All-in-One for Railway

This image is designed for the `Family-Photos` Railway project to consolidate Immich Server, PostgreSQL and Redis-compatible storage into a single service and a single persistent volume.

## Safety / rollout

The initial deployment runs without a Railway volume and uses ephemeral `/persistent` storage only for validation. Production database/media migration must happen only after the composite image is healthy and a verified logical PostgreSQL backup has been restored.

Machine Learning is intentionally disabled by default (`IMMICH_AIO_ENABLE_ML=false`) during the first validation phase because the deployment rarely uses facial recognition or Smart Search. It will be added as an optional local process after the core server/database/Redis combination is stable.

## Shared volume layout

- `/persistent/immich` — Immich local media/metadata files
- `/persistent/postgres/data` — PostgreSQL cluster
- `/persistent/redis` — Redis persistence
- `/persistent/ml-cache` — optional ML cache
