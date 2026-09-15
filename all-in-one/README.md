# Immich Railway All-in-One 中文文档

<p align="center"><strong>简体中文</strong> · <a href="README.en.md">English</a></p>

本目录定义 `Family-Photos` 当前生产使用的 Immich All-in-One 镜像。它把 Immich Server、PostgreSQL 14 和 Redis 合并到一个 Railway 服务和一个 `/data` Persistent Volume 中。

## 当前生产结构

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

原始照片/视频主要通过 Storage Router 保存到 Photo Storage 1–9；`/data` 仍保存数据库、Redis 和 Immich 派生数据。

## 运行规则

- Immich AIO **保持常驻**，不要启用 Railway Serverless。
- PostgreSQL 数据目录：`/data/.aio/postgres/data`
- Redis 数据目录：`/data/.aio/redis`
- Machine Learning 默认关闭：`IMMICH_AIO_ENABLE_ML=false`
- 健康检查：`/api/server/ping`
- 不再依赖独立 PostgreSQL 或 Redis 服务。

## 远程媒体兼容

本 Fork 包含远程原图 staging 支持：当数据库路径仍指向 `/data/...`、但原图已经迁移到 Storage Router 时，Sharp/FFmpeg/ExifTool 等媒体处理任务可以临时从远程存储取回文件，处理完成后删除临时文件。

这使缩略图和 preview 可以正常生成，而不需要把整个媒体库重新复制回 `/data`。

## Web 缓存兼容

`patch-web-thumbnail-cache.mjs` 在本 `3.1.0-remote` 分支构建 Web 时加入固定缓存版本，用于避免历史缩略图失败响应继续被浏览器缓存。它是构建期兼容补丁，不会在运行时执行后台维修任务。

## 数据库迁移代码

`entrypoint.sh` 仍保留从外部 PostgreSQL 做只读 `pg_dump | psql` 迁移的能力，用于未来重新部署/灾难恢复场景。但当前生产已经完成迁移，外部 PostgreSQL 服务已删除，正常启动直接使用 `/data/.aio/postgres/data`。

## 已清理的一次性代码

缩略图故障排查完成后已经删除：

- `audit-thumbnails.mjs`
- Supervisor `thumbnail-audit` program
- Dockerfile 中的 audit 脚本 copy step

Supervisor 现在只管理：

```text
postgres
redis
immich
```

## `/data` 安全规则

不要删除或重新初始化生产 `/data` Volume。它现在包含生产 PostgreSQL 数据库以及 Immich 管理的缩略图、preview、转码文件和用户数据。

## 相关文档

- [`../RAILWAY_REMOTE_STORAGE.md`](../RAILWAY_REMOTE_STORAGE.md)
- [`../storage-router/README.md`](../storage-router/README.md)
