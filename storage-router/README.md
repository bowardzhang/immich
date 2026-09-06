# Immich Storage Router

A stateless Railway service that fronts up to 10 one-volume Photo Storage services.

## Why this exists

Railway Hobby allows up to 10 volumes per project, but each service can only have one volume. Therefore each 5 GB volume is exposed by its own Photo Storage service, while Immich talks to this router as one logical storage backend.

## STORAGE_NODES

Set a JSON array such as:

```json
[
  {"name":"volume-1","url":"http://photo-storage-1.railway.internal","token":"..."},
  {"name":"volume-2","url":"http://photo-storage-2.railway.internal","token":"..."}
]
```

`REMOTE_STORAGE_TOKEN` protects the router itself. Each node may use the same or a different token.

## Capacity alert

The router periodically scans the storage nodes and calculates used bytes. Defaults:

- `VOLUME_SIZE_BYTES=5368709120` (5 GiB)
- `STORAGE_WARNING_PERCENT=85`
- `STORAGE_CRITICAL_PERCENT=95`
- `STORAGE_CHECK_INTERVAL_MS=900000` (15 minutes)

When every configured volume is above the warning threshold, it can send an email through Resend:

- `RESEND_API_KEY`
- `ALERT_EMAIL_TO`
- `ALERT_EMAIL_FROM` (optional)

The email tells you to create the next 5 GB Railway Volume and Photo Storage service. It does not attempt to modify Railway automatically.

## Important current limitation

This router is currently read-oriented. File writes, allocation of a new file to the volume with the most free space, and upload streaming are the next implementation stage. Do not switch production Immich writes to this router until that stage is complete.
