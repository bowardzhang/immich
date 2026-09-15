# Immich 3.2.1 Railway 升级与回滚方案

本文件定义 `3.2.1-remote` 的生产升级和 `3.1.0-remote` 的回滚边界。

## 基本原则

- `3.1.0-remote` 保持冻结，不把 3.2.1 的代码提交回旧分支。
- `3.2.1-remote` 用于移植 upstream Immich v3.2.1 与现有 Railway 多卷定制。
- 生产切换前记录所有 Railway 服务的当前 branch、deployment ID、环境变量、Volume mount 和数据库备份点。
- 升级期间不删除、不重新创建现有 Photo Storage volumes。
- 首次 3.2.1 部署必须先完成构建和兼容性验证，再切 Production。

## 必须验证

1. Immich server/web 能启动并通过 health check。
2. PostgreSQL migration 成功，且记录 migration 前数据库备份。
3. 现有照片和视频可读取，缩略图和视频播放正常。
4. 新照片/视频可上传，并实际写入 Storage Router 管理的 Photo Storage。
5. 删除、移动、metadata extraction、thumbnail/video jobs 正常。
6. `/api/storage` 聚合容量正确，所有现有 Photo Storage 节点 healthy。
7. 82% proactive provisioning、branch trigger、单 Volume 恢复逻辑仍有效。
8. Android Railway-tuned APK 能构建。

## 回滚到 3.1.0-remote

代码回滚本身很简单：将 Immich、Storage Router 和 Photo Storage 的 GitHub source branch 切回 `3.1.0-remote`，然后重新部署，并保持原有 volumes 和环境变量不变。

但数据库必须单独处理：如果 v3.2.1 执行了不能被 v3.1.0 server 向后兼容的 migration，仅切 Git branch 不足以安全回滚。此时必须同时恢复升级前 PostgreSQL 备份。禁止让旧版 server 直接长期运行在未经确认兼容的新版 schema 上。

因此生产升级前必须建立并验证数据库恢复点；只有同时具备“旧代码 + 升级前数据库备份 + 原 volumes”才视为完整 rollback path。

## 数据安全

Photo Storage volumes 保存媒体文件，升级和回滚都不得格式化或删除这些 volumes。数据库备份和媒体 volumes 是两类不同的数据保护对象，两者都必须保留。
