# Immich Storage Router

A stateless Railway service that fronts up to 10 one-volume Photo Storage services.

## Architecture

Railway Hobby allows up to 10 volumes per project, while a service can have only one volume. Each 5 GB volume is therefore exposed by its own Photo Storage service. Immich talks to this router through one logical path:

```text
Immich Server
    |
    v
Storage Router
    +-- Photo Storage 1 -> Volume 1
    +-- Photo Storage 2 -> Volume 2
    +-- ...
    +-- Photo Storage 10 -> Volume 10
```

Set Immich's `IMMICH_MEDIA_LOCATION` to `/remote/photo-extern` and `REMOTE_STORAGE_URL` to the router's private-network URL. The database keeps the stable logical path; the router decides which physical volume contains the file.

## STORAGE_NODES

```json
[
  {"name":"volume-1","url":"http://photo-storage-1.railway.internal","token":"..."},
  {"name":"volume-2","url":"http://photo-storage-2.railway.internal","token":"..."}
]
```

`REMOTE_STORAGE_TOKEN` protects the router itself. Each node may use the same or a different token.

## Write routing

- Existing files are routed to the volume that already contains them.
- New files are allocated to the volume with the most available space.
- `Content-Length` is used when available so a volume must have enough free space before allocation.
- A configurable safety margin (`STORAGE_ALLOCATION_SAFETY_BYTES`, default 64 MiB) reduces races around a full volume.
- `MOVE` stays on the same volume when possible; cross-volume moves stream the file to the new volume and delete the old copy only after the upload succeeds.

The router has no separate metadata database. Logical paths are the source of truth and existing files are located by probing the configured volumes.

## Capacity monitoring

The router reads real filesystem capacity from each Photo Storage service using `statfs` rather than assuming a fixed 5 GiB size.

Defaults:

- `STORAGE_WARNING_PERCENT=85`
- `STORAGE_CRITICAL_PERCENT=95`
- `STORAGE_CHECK_INTERVAL_MS=900000` (15 minutes)
- `STORAGE_ALLOCATION_SAFETY_BYTES=67108864` (64 MiB)

When every configured volume is above the warning threshold, the router can send an email through Resend:

- `RESEND_API_KEY`
- `ALERT_EMAIL_TO`
- `ALERT_EMAIL_FROM` (optional)

The email tells you to create the next 5 GB Railway Volume and Photo Storage service and add it to `STORAGE_NODES`. It does not attempt to modify Railway automatically.

## Endpoints

- `GET /health`
- `GET /api/storage` — aggregate pool capacity
- `GET /api/storage/status` — per-volume usage and next-volume recommendation
- `GET|HEAD /api/file?path=...`
- `PUT /api/file?path=...`
- `DELETE /api/file?path=...`
- `MOVE /api/file?path=...&source=...`
- `GET /api/list?path=...&recursive=true|false`

The current design uses HTTP streaming plus local ephemeral staging inside Immich for FFmpeg, Sharp, and ExifTool operations that require real filesystem paths.
