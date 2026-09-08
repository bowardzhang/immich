import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const enabled = process.env.IMMICH_AIO_AUDIT_THUMBNAILS_ON_BOOT === 'true';
if (!enabled) process.exit(0);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message, data) => console.log(`[thumbnail-audit] ${message}${data === undefined ? '' : ` ${JSON.stringify(data)}`}`);

const dbUser = process.env.DB_USERNAME || process.env.POSTGRES_USER || 'postgres';
const dbName = process.env.DB_DATABASE_NAME || process.env.POSTGRES_DB || 'immich';
const dbPassword = process.env.DB_PASSWORD || process.env.POSTGRES_PASSWORD || '';
const mediaRoot = (process.env.IMMICH_MEDIA_LOCATION || '/data').replace(/\/$/, '');
const remoteUrl = (process.env.REMOTE_STORAGE_URL || '').replace(/\/$/, '');
const remoteToken = process.env.REMOTE_STORAGE_TOKEN || '';
const auditPath = `${process.env.IMMICH_AIO_ROOT || '/data/.aio'}/thumbnail-audit.json`;

for (let attempt = 1; attempt <= 120; attempt++) {
  try {
    execFileSync('/usr/bin/pg_isready', ['-h', '127.0.0.1', '-p', '5432', '-U', dbUser, '-d', dbName], { stdio: 'ignore' });
    break;
  } catch {
    if (attempt === 120) throw new Error('PostgreSQL did not become ready for thumbnail audit');
    await sleep(1000);
  }
}

const query = String.raw`
SELECT
  a.id,
  a."originalPath",
  COALESCE(MAX(af.path) FILTER (WHERE af.type = 'preview' AND COALESCE(af."isEdited", false) = false), ''),
  COALESCE(MAX(af.path) FILTER (WHERE af.type = 'thumbnail' AND COALESCE(af."isEdited", false) = false), '')
FROM asset a
LEFT JOIN asset_file af ON af."assetId" = a.id
WHERE a."deletedAt" IS NULL
GROUP BY a.id, a."originalPath"
ORDER BY a.id;
`;

const psql = execFileSync('/usr/lib/postgresql/14/bin/psql', [
  '-h', '127.0.0.1', '-p', '5432', '-U', dbUser, '-d', dbName,
  '-At', '-F', '\t', '-c', query,
], {
  encoding: 'utf8',
  env: { ...process.env, PGPASSWORD: dbPassword },
  maxBuffer: 32 * 1024 * 1024,
});

const assets = psql.trim().split('\n').filter(Boolean).map((line) => {
  const [id, originalPath, previewPath, thumbnailPath] = line.split('\t');
  return { id, originalPath, previewPath, thumbnailPath };
});

log('database rows loaded', { assets: assets.length });

const remotePaths = new Set();
if (remoteUrl) {
  const headers = remoteToken ? { authorization: `Bearer ${remoteToken}` } : {};
  const response = await fetch(`${remoteUrl}/api/list?path=&recursive=true`, { headers });
  if (!response.ok) throw new Error(`Remote storage recursive list failed: HTTP ${response.status}`);
  const body = await response.json();
  for (const entry of body.entries || []) {
    if (entry?.path) remotePaths.add(String(entry.path).replace(/^\/+/, ''));
  }
  log('remote storage index loaded', { files: remotePaths.size });
}

const existsLocal = async (absolutePath) => {
  if (!absolutePath) return false;
  try { await fs.access(absolutePath); return true; } catch { return false; }
};
const relativeRemote = (absolutePath) => {
  if (!absolutePath) return '';
  const prefix = `${mediaRoot}/`;
  if (absolutePath.startsWith(prefix)) return absolutePath.slice(prefix.length).replace(/^\/+/, '');
  if (absolutePath.startsWith('/data/')) return absolutePath.slice('/data/'.length).replace(/^\/+/, '');
  return absolutePath.replace(/^\/+/, '');
};
const existsAnywhere = async (absolutePath) => {
  if (!absolutePath) return false;
  if (await existsLocal(absolutePath)) return true;
  return remotePaths.has(relativeRemote(absolutePath));
};

const missingDerived = [];
const missingOriginal = [];
const missingPreviewRecord = [];
const missingThumbnailRecord = [];
let previewPresent = 0;
let thumbnailPresent = 0;
let originalPresent = 0;

for (const asset of assets) {
  const originalOk = await existsAnywhere(asset.originalPath);
  const previewOk = asset.previewPath ? await existsAnywhere(asset.previewPath) : false;
  const thumbnailOk = asset.thumbnailPath ? await existsAnywhere(asset.thumbnailPath) : false;

  if (originalOk) originalPresent++;
  else missingOriginal.push({ id: asset.id, originalPath: asset.originalPath });

  if (!asset.previewPath) missingPreviewRecord.push(asset.id);
  if (!asset.thumbnailPath) missingThumbnailRecord.push(asset.id);
  if (previewOk) previewPresent++;
  if (thumbnailOk) thumbnailPresent++;

  if (!previewOk || !thumbnailOk) {
    missingDerived.push({
      id: asset.id,
      originalPath: asset.originalPath,
      originalPresent: originalOk,
      previewPath: asset.previewPath,
      previewPresent: previewOk,
      thumbnailPath: asset.thumbnailPath,
      thumbnailPresent: thumbnailOk,
    });
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  assets: assets.length,
  originalPresent,
  previewPresent,
  thumbnailPresent,
  missingOriginalCount: missingOriginal.length,
  missingDerivedCount: missingDerived.length,
  missingPreviewRecordCount: missingPreviewRecord.length,
  missingThumbnailRecordCount: missingThumbnailRecord.length,
  repairableMissingDerivedCount: missingDerived.filter((item) => item.originalPresent).length,
  missingOriginal,
  missingDerived,
  missingPreviewRecord,
  missingThumbnailRecord,
};

await fs.mkdir(auditPath.slice(0, auditPath.lastIndexOf('/')), { recursive: true });
await fs.writeFile(auditPath, JSON.stringify(report, null, 2));
log('summary', {
  assets: report.assets,
  originalPresent: report.originalPresent,
  previewPresent: report.previewPresent,
  thumbnailPresent: report.thumbnailPresent,
  missingOriginalCount: report.missingOriginalCount,
  missingDerivedCount: report.missingDerivedCount,
  repairableMissingDerivedCount: report.repairableMissingDerivedCount,
  missingPreviewRecordCount: report.missingPreviewRecordCount,
  missingThumbnailRecordCount: report.missingThumbnailRecordCount,
});
log('missing-derived-assets', missingDerived.slice(0, 250));
if (missingDerived.length > 250) log('missing-derived-assets-truncated', { total: missingDerived.length, shown: 250 });
log('audit report saved', { path: auditPath });
