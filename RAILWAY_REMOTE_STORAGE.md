# Railway Remote Storage Fork Notes

This branch extends Immich with an HTTP-backed, multi-volume storage layer designed for Railway deployments where persistent storage is split across multiple services.

## Production model

The production layout is:

```text
Immich
  |-- local /data volume for Immich-managed operational/derived data
  |
  `-- /remote/photo-extern
          |
          v
     Storage Router
       |-- Photo Storage 1 -> persistent volume
       |-- Photo Storage 2 -> persistent volume
       `-- ... up to Photo Storage 10
```

Original photo/video media is stored through the Storage Router. The Immich `/data` volume must not be deleted just because original media has been migrated away from it; Immich still uses local paths for thumbnails, profile data, encoded video, backups, and other application-managed data.

The server storage API reports aggregate remote capacity when `REMOTE_STORAGE_URL` is configured, allowing Immich clients to display the combined Photo Storage pool.

## Cleanup policy

Safe-by-design temporary data:

- Storage Router upload spooling is created under the container's ephemeral `/tmp` and removed in `finally` blocks.
- Storage Router production self-tests use `.storage-router-selftest/` and delete test files after verification, with best-effort cleanup on failure.
- The Node multi-volume regression test uses in-memory mock volumes and never touches Railway persistent volumes.
- The PowerShell integration test uses `router-integration-test/<uuid>.txt` and attempts cleanup in `finally`.

Do not manually purge Immich-managed thumbnail, encoded-video, profile, backup, or library metadata directories merely to reclaim space. Use Immich-supported maintenance jobs when cleanup is required.

## Capacity and auto-provisioning

The Storage Router measures actual filesystem capacity from each Photo Storage node and allocates new files to the healthy node with the most available space.

Default thresholds:

- warning: 85%
- critical: 95%
- maximum Railway Hobby storage nodes: 10

When every configured volume is healthy and above the warning threshold, automatic provisioning can create `Photo Storage N`, attach a new volume, deploy it, wait for deployment success and health, update `STORAGE_NODES`, then redeploy the Storage Router.

A Railway Project Token should preferably be supplied as `RAILWAY_PROJECT_TOKEN`. For backward compatibility, `RAILWAY_API_TOKEN` is accepted and can fall back to Project Token authentication when Bearer authentication is rejected.

See [`storage-router/README.md`](storage-router/README.md) for detailed variables, routing behavior, tests, and provisioning sequence.

## Upstream Immich upgrades

This fork should track upstream Immich by release, not by blindly following upstream `main` in production.

Recommended process for a new stable Immich release `X.Y.Z`:

1. Keep the current production `*-remote` branch untouched as the rollback target.
2. Fetch/sync the upstream release/tag.
3. Create a new branch such as `X.Y.Z-remote` based on the upstream `vX.Y.Z` tag.
4. Port the remote-storage changes onto the new branch.
5. Resolve upstream API/storage/media-processing conflicts deliberately.
6. Run upstream compile/tests and the custom Storage Router tests.
7. Deploy the new branch to a non-production Railway environment or temporary services.
8. Validate database migrations and login.
9. Validate upload, download, delete, move, thumbnails, video transcoding, metadata extraction, and aggregate storage reporting.
10. Validate every configured Photo Storage node and Storage Router self-tests.
11. Repoint production Railway services only after all checks pass.
12. Keep the previous production deployment/branch available until the new release has been observed in production.

Railway services that track a GitHub branch will redeploy automatically when that branch receives a commit. Therefore changing the production services to a new version branch should be the final controlled step of an upgrade, not the first step.

## Current upstream baseline

At the time this document was updated (2026-09-07), the latest stable upstream Immich release is `v3.1.0`, which is also the baseline of the current `3.1.0-remote` branch. There is therefore no newer stable upstream release to port yet.
