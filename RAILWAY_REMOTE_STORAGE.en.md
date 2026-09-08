<p align="center"><a href="RAILWAY_REMOTE_STORAGE.md">简体中文</a> · <strong>English</strong></p>

# Railway Multi-Volume Architecture

[![Branch](https://img.shields.io/badge/branch-3.1.0--remote-3F51B5)](https://github.com/bowardzhang/immich/tree/3.1.0-remote)
[![Upstream](https://img.shields.io/badge/upstream-Immich%20v3.1.0-18A999)](https://github.com/immich-app/immich/releases/tag/v3.1.0)
[![Storage Router CI](https://img.shields.io/github/actions/workflow/status/bowardzhang/immich/storage-router-test.yml?branch=3.1.0-remote&label=storage-router)](https://github.com/bowardzhang/immich/actions/workflows/storage-router-test.yml)
[![Last commit](https://img.shields.io/github/last-commit/bowardzhang/immich/3.1.0-remote)](https://github.com/bowardzhang/immich/commits/3.1.0-remote)

This document describes the downstream architecture added by this repository. For ordinary Immich behavior and user documentation, use the [official Immich documentation](https://docs.immich.app/).

## Design goal

Railway persistent volumes are attached to individual services. This fork turns several one-volume storage services into one logical media pool that Immich can use without exposing physical volume placement to the database or clients.

```mermaid
flowchart TB
    subgraph Clients
      W[Immich Web]
      M[Immich Mobile]
    end

    W --> I[Immich Server]
    M --> I

    I --> D[(Local /data)]
    I --> R[Storage Router]

    subgraph RemoteMedia[Remote original-media pool]
      R --> S1[Photo Storage 1]
      R --> S2[Photo Storage 2]
      R --> S3[Photo Storage 3]
      R -.-> SN[Photo Storage N]
      S1 --> V1[(Volume 1)]
      S2 --> V2[(Volume 2)]
      S3 --> V3[(Volume 3)]
      SN --> VN[(Volume N)]
    end

    D --> O[thumbnails / previews / encoded video / profiles / backups]
```

Original photo/video media is stored through the Storage Router. The Immich `/data` volume remains required for application-managed and derived data; it must not be removed just because original media has moved to remote storage.

## Main fork-specific behavior

### Multi-volume routing

The Storage Router exposes one HTTP API to Immich and manages multiple Photo Storage nodes behind it. New files are allocated to the healthy node with the most free space. Existing files are found by logical path, so no separate routing database is required.

### Aggregate storage reporting

When `REMOTE_STORAGE_URL` is enabled, Immich's storage API reports the combined capacity of the remote storage pool rather than the size of the small local `/data` filesystem. This keeps web/mobile capacity display aligned with the actual media pool.

### Automatic expansion

Automatic expansion is proactive: when all healthy storage nodes reach **82%**, the provisioner starts creating or recovering the next `Photo Storage N` before the normal 85% warning threshold. The critical threshold remains 95%.

```mermaid
sequenceDiagram
    participant Monitor as Storage Monitor
    participant Railway as Railway API
    participant Node as Photo Storage N
    participant Router as Storage Router

    Monitor->>Monitor: all healthy nodes >= 82%
    Monitor->>Railway: create/recover service and verify repo + branch
    Railway->>Railway: create or reuse exactly one persistent volume
    Monitor->>Railway: deploy
    Monitor->>Railway: poll deployment status
    Railway-->>Monitor: SUCCESS
    Monitor->>Node: GET /health
    Node-->>Monitor: 200 OK
    Monitor->>Router: update STORAGE_NODES
    Monitor->>Railway: redeploy Router
```

The expansion controller checks every **60 seconds**. If provisioning fails after the trigger is reached, it retries after **15 seconds**. Creation and recovery explicitly verify the GitHub repository and `3.1.0-remote` deployment branch, preventing a partially configured service from being deployed against the wrong or missing branch.

### Monitoring and alerts

Each Photo Storage node reports actual filesystem capacity. The router logs per-node health, used bytes, free bytes and usage percentage, and can send warning/critical email alerts through Resend.

Current defaults:

| Setting | Default |
|---|---:|
| Proactive expansion trigger | 82% |
| Warning | 85% |
| Critical | 95% |
| Capacity check interval | 60 seconds |
| Provisioning check interval | 60 seconds |
| Provisioning retry after failure | 15 seconds |
| Max storage nodes | 10 |
| Allocation safety margin | 64 MiB |

## Data flow

### Upload

```mermaid
flowchart LR
    A[Immich writes logical path] --> B[Storage Router]
    B --> C{Healthy nodes with enough free space}
    C --> D[Choose most free space]
    D --> E[Stream upload + temporary spool]
    E --> F{Primary upload succeeds?}
    F -- Yes --> G[Return success + clean spool]
    F -- No --> H[Replay spool to another eligible node]
```

The router streams the request to the selected Photo Storage node while simultaneously spooling the same bytes to ephemeral `/tmp`. The normal success path does not require a second full copy; the spool is replayed only if the primary node fails. Client-aborted uploads clean up unfinished temporary files.

### Existing file access

```mermaid
flowchart LR
    A[GET / HEAD / DELETE / MOVE] --> B[Probe configured nodes]
    B --> C{Path found?}
    C -- Yes --> D[Operate on owning node]
    C -- No --> E[Return not found]
```

### Cross-volume move

A same-volume move is handled locally where possible. If a move must cross volumes, the router copies the file first and only deletes the original after the destination write succeeds.

## Service responsibilities

| Component | Responsibility |
|---|---|
| Immich Server | Standard Immich APIs plus remote media integration and aggregate capacity reporting |
| Storage Router | Routing, failover, capacity aggregation, monitoring, alerts, provisioning trigger |
| Photo Storage N | Minimal HTTP file service backed by one persistent volume |
| Railway Provisioner | Creates/configures/deploys the next storage node and updates Router membership |
| `/data` volume | Immich-managed operational and derived data |

## Key configuration

### Immich

```text
IMMICH_MEDIA_LOCATION=/remote/photo-extern
REMOTE_STORAGE_URL=http://storage-router.railway.internal:8080
REMOTE_STORAGE_TOKEN=<shared secret>
```

### Storage Router

The central node list is a JSON array:

```json
[
  {"name":"photo-storage-1","url":"http://photo-storage-1.railway.internal:8080"},
  {"name":"photo-storage-2","url":"http://photo-storage-2.railway.internal:8080"},
  {"name":"photo-storage-3","url":"http://photo-storage-3.railway.internal:8080"}
]
```

Important variables include:

```text
STORAGE_NODES
REMOTE_STORAGE_TOKEN
STORAGE_WARNING_PERCENT
STORAGE_CRITICAL_PERCENT
STORAGE_AUTO_PROVISION
STORAGE_MAX_VOLUMES
RAILWAY_PROJECT_TOKEN or RAILWAY_API_TOKEN
RESEND_API_KEY
ALERT_EMAIL_TO
ALERT_EMAIL_FROM
```

See [`storage-router/README.md`](storage-router/README.md) for the complete reference.

## Automatic expansion recovery

The provisioner is designed to recover partially completed expansion attempts rather than only handling brand-new services:

1. Determine the next `Photo Storage N`.
2. Reuse an existing service if it was already created.
3. Explicitly verify the GitHub repository and deployment branch trigger.
4. Reuse the existing persistent volume if exactly one is already attached; do not attach a second one accidentally.
5. Configure the `/photo-storage` root directory, environment variables, and `/photos_extern` mount.
6. Start deployment and poll it to a terminal state.
7. Add the node to `STORAGE_NODES` only after deployment reaches `SUCCESS` and `/health` succeeds.
8. Update Router configuration and redeploy Storage Router.
9. Retry recoverable provisioning failures after 15 seconds while the capacity trigger remains active.

This prevents a half-created service, volume, or deployment from leaving automatic expansion permanently stuck.

## Cleanup and persistence policy

Temporary data is intentionally kept away from persistent Photo Storage volumes where possible:

- Router upload spooling uses ephemeral `/tmp` and is removed in `finally` cleanup paths.
- Production self-tests use `.storage-router-selftest/` and delete their test files after verification.
- Repository regression tests use in-memory mock volumes.
- Integration test files are placed under dedicated temporary prefixes and use best-effort cleanup.

Do not manually purge Immich-managed thumbnail, encoded-video, profile, backup or related `/data` directories to reclaim space. Those are application-owned assets and should be maintained through Immich-supported workflows.

## Failure handling

```mermaid
flowchart TD
    A[Storage operation] --> B{Node healthy?}
    B -- No --> C[Exclude node from new allocation]
    B -- Yes --> D[Attempt operation]
    D --> E{Operation succeeded?}
    E -- Yes --> F[Complete]
    E -- No --> G{Alternative node valid?}
    G -- Yes --> H[Retry / fail over]
    G -- No --> I[Return error + log state]
```

Provisioning has separate deployment and health timeouts. A newly created node is not appended to the active Router list until deployment reaches `SUCCESS` and `/health` responds successfully.

## Railway Watch Paths

Production services use Railway Watch Paths so documentation, tests, or unrelated application changes do not cause unnecessary storage-service restarts. Storage Router watches only files that actually affect its production image. README and test-only changes therefore do not restart the production Router, which is useful while mobile backups are running.

## Upgrade model

This fork follows upstream stable releases while isolating custom storage changes in versioned `*-remote` branches.

```mermaid
flowchart TD
    A[Upstream stable vX.Y.Z] --> B[Create X.Y.Z-remote]
    B --> C[Port remote-storage changes]
    C --> D[Resolve upstream conflicts]
    D --> E[Compile + automated tests]
    E --> F[Test deployment]
    F --> G[Validate DB migrations]
    G --> H[Validate upload/read/delete/move]
    H --> I[Validate thumbnails/transcoding/metadata]
    I --> J[Validate all storage nodes]
    J --> K[Switch production branch]
    K --> L[Keep old branch for rollback]
```

Do not point production directly at upstream `main`. Railway services tracking a GitHub branch may redeploy automatically when that branch changes, so the production branch switch should be the final controlled step.

## Future work

The main development directions are:

- End-to-end validation of the next automatically provisioned storage node.
- Recovery logic for partially created or misconfigured Railway services.
- Better observability of routing decisions, capacity history and provisioning events.
- Optional alert-recipient discovery from the Immich administrator account.
- Stronger multi-volume regression coverage around media processing workflows.
- Continued adaptation to upstream Immich storage/API changes.

## Current baseline

As of 2026-09-08, this fork is based on upstream **Immich v3.1.0**, using production branch **`3.1.0-remote`**.


## Related documentation

- [中文版本（默认）](RAILWAY_REMOTE_STORAGE.md)
- [Fork overview — English](README.en.md)
- [Storage Router — English](storage-router/README.en.md)
- [Official Immich documentation](https://docs.immich.app/)
