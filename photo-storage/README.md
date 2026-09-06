# Photo Storage service

Small read-only HTTP service for exposing a Railway Volume to the Immich remote external-library adapter.

## Railway configuration

Create a Railway service from this directory and mount its Volume at:

`/photos_extern`

Set:

- `PHOTO_STORAGE_ROOT=/photos_extern`
- `REMOTE_STORAGE_TOKEN=<long-random-secret>`

Railway should expose the service only through its private network. The Immich Server service uses:

- `REMOTE_STORAGE_URL=http://photo-extern.railway.internal`
- `REMOTE_STORAGE_TOKEN=<same-secret>`

The service listens on `$PORT` (Railway normally supplies this automatically).

## API

- `GET /health`
- `GET /api/list?path=<relative-path>&recursive=false`
- `HEAD /api/file?path=<relative-path>`
- `GET /api/file?path=<relative-path>`

`GET /api/file` supports HTTP Range requests, which is useful for video playback.

The service rejects paths escaping the configured storage root and requires the Bearer token when `REMOTE_STORAGE_TOKEN` is configured.
