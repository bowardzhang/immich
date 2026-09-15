# Railway-tuned Immich Android APK

This fork publishes an optional Android APK tuned for large media backups to the Railway-hosted Immich deployment used by this repository.

> This is a downstream test build, not an official Immich mobile release. The normal Immich Android app remains the recommended default for standard Immich servers.

## Why this build exists

Large phone videos can take several minutes to upload over a mobile or slow Wi-Fi connection. Railway's public request path also has a practical upper bound for very long requests. A backup client that starts several large uploads at the same time can divide the available upstream bandwidth between them and make every request more likely to approach that limit.

The Railway-tuned APK changes the client behavior specifically to reduce that risk.

## Advantages

### 1. Longer Android network timeout

The Android HTTP client read/write timeout is increased from 60 seconds to **240 seconds**.

This gives slow uploads substantially more time to make progress instead of being cancelled by the Android client while the server is still receiving data.

### 2. Sequential automatic foreground backup

Automatic foreground backup uses **one upload worker** instead of three concurrent upload workers.

For large videos this is usually a better fit for a home Internet uplink or mobile connection: one file can use the available upstream bandwidth instead of three files competing for it. That lowers the chance that several uploads all become long-running requests at once.

This tuning is intentionally limited to the automatic foreground-backup path. It does not globally disable concurrency for unrelated operations.

### 3. Works with the server-side streaming upload path

The server side of this fork forwards original media through the remote-storage path:

```text
Android -> Immich streaming -> Storage Router temporary staging -> Photo Storage 1-9
```

The Router stages the received stream ephemerally so it can safely retry/fail over to another fixed Photo Storage node.

### 4. Better behavior for large videos

The combination of a longer client timeout, one automatic-backup upload worker and the streaming server path is intended to reduce failures seen with large videos that approach platform/network request-duration limits.

It does **not** make a single HTTP upload resumable. If one individual file still cannot finish before the platform/network limit, the next architectural step is chunked/resumable upload rather than an even larger timeout.

## Build and installation

The 3.2.1 build workflow is isolated to the `3.2.1-remote` branch. After a successful build, run the publish workflow with that build's GitHub Actions run ID. It publishes the 3.2.1-specific debug APK/release without reusing a 3.1.0 artifact.

The debug application can normally coexist with the Play Store Immich app, but it requires separate server configuration/login.

## When to use it

Use this APK when your Android backup contains large photos/videos and the standard client repeatedly times out or leaves long uploads stuck. If the standard Immich app already backs up reliably, there is no need to replace it.

## Compatibility

- Server baseline: Immich `v3.2.1`
- Fork branch: `3.2.1-remote`
- Android source baseline: Immich mobile `3.2.1`
- Remote pool: fixed `Photo Storage 1-9`
- Storage Router and Photo Storage nodes: Serverless
- Intended server: this repository's Railway multi-volume fork

## Branch isolation

Do not publish a 3.2.1 APK from `3.1.0-remote`, reuse a 3.1.0 build run, or point the 3.2.1 release at the old branch. The two remote branches are maintained independently so the production deployment can be rolled back without rewriting either branch.

## Safety notes

Keep the normal Immich application available until you have verified the test APK with your own library. A successful upload is not a backup strategy by itself; important photos and videos should still have an independent backup copy.
