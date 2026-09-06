# Photo Storage service

A small HTTP service exposing one Railway Volume to the Immich remote-storage layer.

## Railway configuration

Create one Railway service from this directory and mount exactly one Volume at:

`/photos_extern`

Set:

- `PHOTO_STORAGE_ROOT=/photos_extern`
- `REMOTE_STORAGE_TOKEN=<long-random-secret>`

Each Railway service can have only one Volume, so future volumes are represented by additional Photo Storage services (`photo-storage-2`, `photo-storage-3`, etc.). The multi-volume `storage-router` service combines them into one logical storage endpoint.

## API

- `GET /health`
- `GET /api/list?path=<relative-path>&recursive=false`
- `HEAD /api/file?path=<relative-path>`
- `GET /api/file?path=<relative-path>`

`GET /api/file` supports HTTP Range requests, useful for video playback.

The service rejects paths escaping the configured storage root and requires the Bearer token when `REMOTE_STORAGE_TOKEN` is configured.
