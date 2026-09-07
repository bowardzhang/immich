# Immich Storage Router

A stateless Railway service that fronts up to 10 one-volume Photo Storage services and presents them to Immich as one logical storage pool.

## Architecture

Railway Hobby allows up to 10 volumes per project, while each Photo Storage service mounts one persistent volume. Immich talks only to the Storage Router:

```text
Immich Server
    |
    | /remote/photo-extern
    v
Storage Router
    +-- Photo Storage 1 -> Volume 1
    +-- Photo Storage 2 -> Volume 2
    +-- ...
    +-- Photo Storage 10 -> Volume 10
```

Set Immich's `IMMICH_MEDIA_LOCATION` to `/remote/photo-extern` and `REMOTE_STORAGE_URL` to the router's private-network URL. The database keeps the stable logical path; the router decides which physical volume contains each file.

## STORAGE_NODES

```json
[
  {"name":"photo-storage-1","url":"http://photo-storage-1.railway.internal:8080"},
  {"name":"photo-storage-2","url":"http://photo-storage-2.railway.internal:8080"}
]
```

`REMOTE_STORAGE_TOKEN` protects the router and is also propagated to automatically created Photo Storage services. A node may optionally provide its own token in `STORAGE_NODES`.

## Write routing

- Existing files are routed to the volume that already contains them.
- New files are allocated to the healthy volume with the most available space.
- `Content-Length` is used when available so a volume must have enough free space before allocation.
- A configurable safety margin (`STORAGE_ALLOCATION_SAFETY_BYTES`, default 64 MiB) reduces races around a nearly full volume.
- Failed uploads are retried on another eligible volume.
- `MOVE` stays on the same volume when possible; cross-volume moves stream the file to the new volume and delete the old copy only after the upload succeeds.

The router has no separate routing database. Logical paths are authoritative and existing files are located by probing the configured volumes.

## Capacity monitoring

The router reads real filesystem capacity from each Photo Storage service using `statfs` rather than assuming an exact 5 GiB size.

Defaults:

- `STORAGE_WARNING_PERCENT=85`
- `STORAGE_CRITICAL_PERCENT=95`
- `STORAGE_CHECK_INTERVAL_MS=900000` (15 minutes)
- `STORAGE_ALLOCATION_SAFETY_BYTES=67108864` (64 MiB)

Immich's `/api/server/storage` uses the router's aggregate capacity, so the mobile/web clients display the combined pool rather than the small local `/data` filesystem.

## Automatic Railway expansion

When every configured volume is healthy and above the warning threshold, `bootstrap.mjs` can automatically provision the next `Photo Storage N` service and volume.

Required runtime context:

- `RAILWAY_PROJECT_ID`
- `RAILWAY_ENVIRONMENT_ID`
- `RAILWAY_SERVICE_ID` (the Storage Router service)
- `REMOTE_STORAGE_TOKEN`
- a Railway token with access to the project

Preferred token variable:

- `RAILWAY_PROJECT_TOKEN` for a Railway Project Token

Backward compatibility:

- `RAILWAY_API_TOKEN` is also accepted. The provisioner first tries it as a Bearer API token and, if Railway returns an authorization failure, retries it as a Project Token using the `Project-Access-Token` header.

Optional controls:

- `STORAGE_AUTO_PROVISION=false` disables automatic expansion.
- `STORAGE_MAX_VOLUMES` defaults to `10`.
- `STORAGE_PROVISION_CHECK_INTERVAL_MS` defaults to 5 minutes.
- `STORAGE_PROVISION_COOLDOWN_MS` defaults to 1 hour.
- `STORAGE_PROVISION_DEPLOY_TIMEOUT_MS` defaults to 5 minutes.
- `STORAGE_PROVISION_HEALTH_TIMEOUT_MS` defaults to 2 minutes.

Provisioning sequence:

1. Reuse or create `Photo Storage N`.
2. Configure the service to run `/photo-storage`.
3. Reuse or create a volume mounted at `/photos_extern`.
4. Deploy the new service and poll until the deployment reaches `SUCCESS`.
5. Wait for its private `/health` endpoint.
6. Add the node to `STORAGE_NODES` without triggering an intermediate router deployment.
7. Explicitly redeploy the Storage Router.

The router performs an API-access self-check on startup and logs `storage-provision-access` with `PASS` or `FAIL` without printing the token value.

## Alerts

Capacity warnings can also be sent through Resend:

- `RESEND_API_KEY`
- `ALERT_EMAIL_TO`
- `ALERT_EMAIL_FROM` (optional)

At the 10-volume limit, alerts instruct the operator to migrate/resize storage or upgrade the Railway plan instead of attempting to create an 11th volume.

## Tests and temporary files

Production self-tests write files under `.storage-router-selftest/`, verify PUT/HEAD/GET/DELETE, and delete the test file in both the normal and cleanup paths. Upload request spooling uses the container's ephemeral `/tmp` and is deleted in `finally`, so it does not consume persistent Photo Storage volume space.

Repository regression tests such as `test-multi-volume.mjs` use in-memory mock volumes only. `test-storage.ps1` writes under `router-integration-test/` and has a best-effort `finally` cleanup. These test scripts are not copied into the production Storage Router image by the Dockerfile.

Do not manually delete Immich-managed `thumbs`, `encoded-video`, `profile`, `backups`, or similar `/data` content merely because it is not original media. These are application-managed derived or operational assets and should be cleaned only through Immich-supported maintenance workflows.

## Endpoints

- `GET /health`
- `GET /api/storage` — aggregate pool capacity
- `GET /api/storage/status` — per-volume usage and next-volume recommendation
- `GET|HEAD /api/file?path=...`
- `PUT /api/file?path=...`
- `DELETE /api/file?path=...`
- `MOVE /api/file?path=...&source=...`
- `GET /api/list?path=...&recursive=true|false`

The current design uses HTTP streaming plus local ephemeral staging inside Immich for FFmpeg, Sharp, and ExifTool operations that require a real filesystem path.

## Upgrading Immich

This fork is versioned against upstream Immich. Do not blindly point Railway at upstream `main` or merge a new major/minor release directly into the production branch.

Recommended upgrade flow:

1. Check the latest stable upstream Immich release.
2. Create a new version branch from that upstream tag, for example `3.2.0-remote`.
3. Re-apply or merge the remote-storage changes onto that branch.
4. Resolve conflicts in storage repository interfaces, media processing, server storage reporting, auth/API DTOs, and generated clients.
5. Run upstream server/mobile tests plus the Storage Router regression tests.
6. Deploy to a non-production Railway environment or temporary services first.
7. Verify database migrations, media read/write/delete/move, thumbnails/video processing, aggregate capacity, and multi-volume self-tests.
8. Only then repoint the production Railway services from the old `X.Y.Z-remote` branch to the new one.

Keep the old production branch until the new version has been verified so rollback remains straightforward.
