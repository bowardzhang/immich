# Immich Railway Multi-Volume Fork

<p align="center">
  <a href="https://github.com/bowardzhang/immich/actions/workflows/storage-router-test.yml"><img src="https://img.shields.io/github/actions/workflow/status/bowardzhang/immich/storage-router-test.yml?branch=3.1.0-remote&style=for-the-badge&label=Storage%20Router%20Tests" alt="Storage Router tests"></a>
  <a href="https://github.com/bowardzhang/immich/tree/3.1.0-remote"><img src="https://img.shields.io/badge/branch-3.1.0--remote-3F51B5?style=for-the-badge" alt="Production branch"></a>
  <a href="https://github.com/immich-app/immich/releases/tag/v3.1.0"><img src="https://img.shields.io/badge/upstream-Immich%20v3.1.0-18A999?style=for-the-badge" alt="Upstream Immich version"></a>
  <a href="https://github.com/bowardzhang/immich/commits/3.1.0-remote"><img src="https://img.shields.io/github/last-commit/bowardzhang/immich/3.1.0-remote?style=for-the-badge" alt="Last commit"></a>
  <a href="https://opensource.org/license/agpl-v3"><img src="https://img.shields.io/badge/License-AGPL_v3-blue.svg?style=for-the-badge" alt="License: AGPLv3"></a>
</p>

<p align="center">
  <img src="design/immich-logo-stacked-light.svg" width="230" alt="Immich">
</p>

<p align="center"><strong>Immich adapted for Railway with HTTP-backed multi-volume media storage, automatic expansion, aggregate capacity reporting, health monitoring and storage alerts.</strong></p>

> [!IMPORTANT]
> This repository is a **downstream fork of [immich-app/immich](https://github.com/immich-app/immich)**. The upstream project provides the photo/video management application; this fork focuses on a Railway-oriented storage architecture that can grow beyond a single persistent volume while keeping the Immich client experience largely unchanged.

## What is different in this fork?

The original Immich application expects its media library to be available through filesystem storage. This fork adds an HTTP storage layer that lets original media span multiple Railway persistent volumes behind one logical storage endpoint.

| Area | Upstream Immich | This fork |
|---|---|---|
| Photo/video management | ✅ Full Immich feature set | ✅ Preserved |
| Original-media storage | Local/filesystem-oriented | **HTTP-backed storage pool** |
| Multiple Railway volumes | Manual/custom integration | **Storage Router + Photo Storage nodes** |
| Capacity shown in Immich | Local storage | **Aggregated remote capacity** |
| Node selection | N/A | **Most available healthy node** |
| Upload failover | N/A | **Retry on another eligible node** |
| Storage monitoring | External | **Per-volume health and usage** |
| Capacity alerts | External | **Resend email alerts** |
| Expansion | Manual | **Automatic `Photo Storage N` provisioning** |
| Maximum configured pool | Depends on deployment | **Up to 10 nodes by default** |

## Architecture

```mermaid
flowchart LR
    A[Immich Web / Mobile] --> B[Immich Server]
    B -->|logical media path| C[Storage Router]
    B --> D[(Immich /data)]

    C -->|HTTP| S1[Photo Storage 1]
    C -->|HTTP| S2[Photo Storage 2]
    C -->|HTTP| S3[Photo Storage 3]
    C -.->|auto-expand| SN[Photo Storage N]

    S1 --> V1[(Volume 1)]
    S2 --> V2[(Volume 2)]
    S3 --> V3[(Volume 3)]
    SN --> VN[(Volume N)]

    D --> D1[thumbnails / previews]
    D --> D2[encoded video]
    D --> D3[profiles / backups / app data]
```

The key design rule is that **original photos and videos are routed through Storage Router**, while Immich's own `/data` volume remains in place for application-managed and derived data. Do not delete `/data` after migrating original media.

## How a file is stored

```mermaid
sequenceDiagram
    participant I as Immich Server
    participant R as Storage Router
    participant S1 as Storage 1
    participant S2 as Storage 2
    participant S3 as Storage 3

    I->>R: PUT /api/file?path=...
    R->>S1: health + capacity
    R->>S2: health + capacity
    R->>S3: health + capacity
    R->>R: choose healthy node with most free space
    R->>S3: stream upload
    S3-->>R: success
    R-->>I: success
```

Existing files remain discoverable without a separate routing database: the router probes configured nodes for the logical path and routes subsequent operations to the node that owns the file.

## Automatic expansion

When all configured volumes are healthy and above the warning threshold, the router can provision the next storage node automatically.

```mermaid
flowchart TD
    A[Periodic storage check] --> B{All healthy nodes >= warning threshold?}
    B -- No --> Z[Keep current pool]
    B -- Yes --> C{Below max node count?}
    C -- No --> X[Send capacity alert]
    C -- Yes --> D[Create Photo Storage N]
    D --> E[Use repo + production branch]
    E --> F[Configure /photo-storage]
    F --> G[Create / attach persistent volume]
    G --> H[Deploy service]
    H --> I[Poll until SUCCESS]
    I --> J[Wait for /health]
    J --> K[Append node to STORAGE_NODES]
    K --> L[Redeploy Storage Router]
```

Current defaults:

- Warning threshold: `85%`
- Critical threshold: `95%`
- Maximum storage nodes: `10`
- Production branch fallback: `3.1.0-remote`
- Storage service root: `/photo-storage`
- Volume mount: `/photos_extern`

The provisioner explicitly supplies the repository, environment and branch when creating a new `Photo Storage N`, then waits for deployment success and health before adding it to the active pool.

## Main components added or changed

```text
immich/
├── server/                       # Immich server changes for remote media access
├── storage-router/
│   ├── server.mjs               # routing, capacity, file API, alerts
│   ├── bootstrap.mjs            # startup monitoring / provisioning bootstrap
│   ├── provisioner.mjs          # Railway automatic expansion
│   ├── selftest.mjs             # production-safe lifecycle checks
│   └── README.md                # detailed Router reference
├── photo-storage/
│   ├── server.mjs               # one-volume HTTP storage service
│   └── Dockerfile
├── .github/workflows/
│   └── storage-router-test.yml  # multi-volume regression CI
└── RAILWAY_REMOTE_STORAGE.md    # deployment / upgrade notes
```

## Configuration overview

### Immich Server

| Variable | Purpose |
|---|---|
| `IMMICH_MEDIA_LOCATION` | Logical media path, typically `/remote/photo-extern` |
| `REMOTE_STORAGE_URL` | Storage Router private-network URL |
| `REMOTE_STORAGE_TOKEN` | Shared authentication token |

### Storage Router

| Variable | Purpose |
|---|---|
| `STORAGE_NODES` | JSON list of Photo Storage private endpoints |
| `REMOTE_STORAGE_TOKEN` | Protects Router and Photo Storage API access |
| `STORAGE_WARNING_PERCENT` | Expansion / warning threshold |
| `STORAGE_CRITICAL_PERCENT` | Critical alert threshold |
| `STORAGE_AUTO_PROVISION` | Enable/disable automatic expansion |
| `RAILWAY_PROJECT_TOKEN` / `RAILWAY_API_TOKEN` | Railway project access for provisioning |
| `RESEND_API_KEY` | Optional alert delivery |
| `ALERT_EMAIL_TO` | Alert recipient |
| `ALERT_EMAIL_FROM` | Alert sender |

See **[storage-router/README.md](storage-router/README.md)** for the full variable list, endpoint reference and provisioning behavior.

## Storage Router API

```text
GET    /health
GET    /api/storage
GET    /api/storage/status
GET    /api/file?path=...
HEAD   /api/file?path=...
PUT    /api/file?path=...
DELETE /api/file?path=...
MOVE   /api/file?path=...&source=...
GET    /api/list?path=...&recursive=true|false
```

`/api/storage` returns aggregate pool capacity so Immich web/mobile clients can show the total capacity of all configured Photo Storage volumes rather than only the local `/data` filesystem.

## Reliability and safety

```mermaid
flowchart LR
    U[Upload] --> R{Selected node works?}
    R -- Yes --> OK[Commit file]
    R -- No --> F[Try another eligible node]
    F --> OK

    M[Move] --> S{Same node possible?}
    S -- Yes --> L[Local move]
    S -- No --> C[Copy to destination node]
    C --> V{Copy succeeded?}
    V -- Yes --> D[Delete source]
    V -- No --> K[Keep source intact]
```

The implementation also uses a free-space safety margin, real filesystem capacity from `statfs`, temporary upload staging under ephemeral `/tmp`, health checks, deployment polling, and cleanup of self-test files.

> [!WARNING]
> This storage design is **not a backup strategy**. Keep independent backups of important photos and videos and follow a 3-2-1 backup model.

## Upstream Immich

Immich is a high-performance, self-hosted photo and video management platform with mobile backup, albums, search, facial recognition, maps, sharing, RAW support and many other features.

This fork intentionally does not duplicate the upstream documentation. For standard Immich installation, user features, mobile clients and general administration, use the official resources:

- [Immich documentation](https://docs.immich.app/)
- [Immich project](https://github.com/immich-app/immich)
- [Immich releases](https://github.com/immich-app/immich/releases)

## Upgrade strategy

This repository tracks **stable upstream releases**, rather than deploying directly from upstream `main`.

```mermaid
flowchart LR
    U[New upstream vX.Y.Z] --> B[Create X.Y.Z-remote]
    B --> P[Port fork changes]
    P --> T[Compile + regression tests]
    T --> N[Non-production deployment]
    N --> V[Validate media + DB migrations]
    V --> R[Move production services to new branch]
    R --> K[Keep previous branch for rollback]
```

The current production baseline is `Immich v3.1.0` on branch `3.1.0-remote`. Detailed upgrade and operational notes are in **[RAILWAY_REMOTE_STORAGE.md](RAILWAY_REMOTE_STORAGE.md)**.

## Future work

Planned directions for the fork include:

- End-to-end validation of the next automatically provisioned storage node.
- Stronger repair/recovery logic for partially created Railway services.
- More explicit observability for routing decisions, node health and provisioning history.
- Optional use of the Immich administrator email as the alert recipient once sender-domain configuration allows it.
- Continued compatibility work as new upstream Immich stable releases change storage and media-processing internals.
- Broader automated regression coverage for upload, download, move, delete, transcoding and metadata workflows across multiple volumes.

## Documentation

- **[Railway remote-storage architecture and upgrade notes](RAILWAY_REMOTE_STORAGE.md)**
- **[Storage Router detailed reference](storage-router/README.md)**
- **[Upstream Immich documentation](https://docs.immich.app/)**

## License and attribution

This repository remains licensed under the upstream project's **GNU Affero General Public License v3.0 (AGPL-3.0)**. The majority of the application is derived from the excellent [Immich](https://github.com/immich-app/immich) project; the Railway multi-volume storage architecture and related integration code are downstream modifications maintained in this fork.
