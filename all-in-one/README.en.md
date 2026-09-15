<p align="center"><a href="README.md">简体中文</a> · <strong>English</strong></p>

# Immich Railway All-in-One

This directory defines the production All-in-One image used by the `Family-Photos` Railway project. It combines Immich Server, PostgreSQL 14, and Redis in one Railway service backed by one persistent `/data` volume.

## Current production layout

```mermaid
flowchart TB
    A[Immich AIO Container]
    A --> I[Immich Server / Microservices]
    A --> P[PostgreSQL 14]
    A --> R[Redis]
    A --> D[(Railway /data Volume)]
    D --> PD[/data/.aio/postgres/data]
    D --> RD[/data/.aio/redis]
    D --> M[thumbs / previews / encoded-video / profiles]
    I --> SR[Storage Router]
```

Original photos and videos are primarily stored through Storage Router across Photo Storage 1–9. The local `/data` volume still holds the database, Redis persistence, and Immich-derived media.

## Runtime rules

- Immich AIO stays **always on**; do not enable Railway Serverless for this service.
- PostgreSQL data directory: `/data/.aio/postgres/data`
- Redis data directory: `/data/.aio/redis`
- Machine Learning is disabled by default: `IMMICH_AIO_ENABLE_ML=false`
- Healthcheck: `/api/server/ping`
- No separate PostgreSQL or Redis Railway service is required anymore.

## Remote-media compatibility

This fork supports temporary staging of remote originals. If the database still references `/data/...` while the original media has already moved behind Storage Router, Sharp/FFmpeg/ExifTool jobs can fetch the remote original into ephemeral local storage, process it, and delete the staged file afterwards.

This allows thumbnail and preview generation without copying the whole remote media library back into `/data`.

## Web cache compatibility

`patch-web-thumbnail-cache.mjs` adds a fixed cache version during the web build for this `3.1.0-remote` branch. It prevents historical failed thumbnail responses from continuing to be reused by browser caches. It is a build-time compatibility patch, not a runtime repair worker.

## Database migration capability

`entrypoint.sh` still retains the ability to perform a read-only logical migration from an external PostgreSQL instance using `pg_dump | psql`. This is useful for future rebuild/recovery workflows. Production migration has already completed, the old standalone PostgreSQL service has been removed, and normal startup now uses `/data/.aio/postgres/data` directly.

## One-shot repair cleanup

After the thumbnail incident was resolved, these temporary components were removed:

- `audit-thumbnails.mjs`
- the Supervisor `thumbnail-audit` program
- the Dockerfile step that copied the audit script

Supervisor now manages only:

```text
postgres
redis
immich
```

## `/data` safety rule

Do not delete or reinitialize the production `/data` volume. It now contains the production PostgreSQL database together with Immich-managed thumbnails, previews, encoded media, profiles, and related application data.

## Related documentation

- [Railway production architecture](../RAILWAY_REMOTE_STORAGE.en.md)
- [Storage Router](../storage-router/README.en.md)
