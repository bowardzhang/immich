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
  COALESCE(MAX(af.path) FILTER (WHERE af.type = 'thumbnail' AND COALESCE(af."isEdited", false) = false), ''),
  CASE WHEN a.thumbhash IS NULL THEN '1' ELSE '0' END,
  COALESCE(a.width, 0)::text,
  COALESCE(a.height, 0)::text
FROM asset a
LEFT JOIN asset_file af ON af."assetId" = a.id
WHERE a."deletedAt" IS NULL
GROUP BY a.id, a."originalPath", a.thumbhash, a.width, a.height
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
  const [id, originalPath, previewPath, thumbnailPath, thumbhashMissing, width, height] = line.split('\t');
  return {
    id, originalPath, previewPath, thumbnailPath,
    thumbhashMissing: thumbhashMissing === '1',
    width: Number(width || 0),
    height: Number(height || 0),
  };
});

log('database rows loaded', { assets: assets.length });

const remoteFiles = new Map();
if (remoteUrl) {
  const headers = remoteToken ? { authorization: `Bearer ${remoteToken}` } : {};
  const response = await fetch(`${remoteUrl}/api/list?path=&recursive=true`, { headers });
  if (!response.ok) throw new Error(`Remote storage recursive list failed: HTTP ${response.status}`);
  const body = await response.json();
  for (const entry of body.entries || []) {
    if (entry?.path) {
      remoteFiles.set(String(entry.path).replace(/^\/+/, ''), {
        size: Number(entry.size || 0),
        mtime: entry.mtime || null,
      });
    }
  }
  log('remote storage index loaded', { files: remoteFiles.size });
}

const relativeRemote = (absolutePath) => {
  if (!absolutePath) return '';
  const prefix = `${mediaRoot}/`;
  if (absolutePath.startsWith(prefix)) return absolutePath.slice(prefix.length).replace(/^\/+/, '');
  if (absolutePath.startsWith('/data/')) return absolutePath.slice('/data/'.length).replace(/^\/+/, '');
  return absolutePath.replace(/^\/+/, '');
};

const fileInfo = async (absolutePath) => {
  if (!absolutePath) return { present: false, location: null, size: 0 };
  try {
    const stat = await fs.stat(absolutePath);
    if (stat.isFile()) return { present: true, location: 'local', size: stat.size };
  } catch {}
  const remote = remoteFiles.get(relativeRemote(absolutePath));
  if (remote) return { present: true, location: 'remote', size: remote.size };
  return { present: false, location: null, size: 0 };
};

const missingDerived = [];
const missingOriginal = [];
const zeroSizedDerived = [];
const missingPreviewRecord = [];
const missingThumbnailRecord = [];
const missingThumbhash = [];
const missingDimensions = [];
let previewPresent = 0;
let thumbnailPresent = 0;
let originalPresent = 0;
let previewLocal = 0;
let previewRemote = 0;
let thumbnailLocal = 0;
let thumbnailRemote = 0;

for (const asset of assets) {
  const original = await fileInfo(asset.originalPath);
  const preview = await fileInfo(asset.previewPath);
  const thumbnail = await fileInfo(asset.thumbnailPath);

  if (original.present) originalPresent++;
  else missingOriginal.push({ id: asset.id, originalPath: asset.originalPath });

  if (!asset.previewPath) missingPreviewRecord.push(asset.id);
  if (!asset.thumbnailPath) missingThumbnailRecord.push(asset.id);
  if (asset.thumbhashMissing) missingThumbhash.push(asset.id);
  if (asset.width <= 0 || asset.height <= 0) missingDimensions.push(asset.id);

  if (preview.present) {
    previewPresent++;
    if (preview.location === 'local') previewLocal++; else previewRemote++;
    if (preview.size <= 0) zeroSizedDerived.push({ id: asset.id, type: 'preview', path: asset.previewPath, ...preview });
  }
  if (thumbnail.present) {
    thumbnailPresent++;
    if (thumbnail.location === 'local') thumbnailLocal++; else thumbnailRemote++;
    if (thumbnail.size <= 0) zeroSizedDerived.push({ id: asset.id, type: 'thumbnail', path: asset.thumbnailPath, ...thumbnail });
  }

  if (!preview.present || !thumbnail.present || preview.size <= 0 || thumbnail.size <= 0) {
    missingDerived.push({
      id: asset.id,
      originalPath: asset.originalPath,
      originalPresent: original.present,
      originalLocation: original.location,
      originalSize: original.size,
      previewPath: asset.previewPath,
      previewPresent: preview.present,
      previewLocation: preview.location,
      previewSize: preview.size,
      thumbnailPath: asset.thumbnailPath,
      thumbnailPresent: thumbnail.present,
      thumbnailLocation: thumbnail.location,
      thumbnailSize: thumbnail.size,
      thumbhashMissing: asset.thumbhashMissing,
      width: asset.width,
      height: asset.height,
    });
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  assets: assets.length,
  originalPresent,
  previewPresent,
  thumbnailPresent,
  previewLocal,
  previewRemote,
  thumbnailLocal,
  thumbnailRemote,
  missingOriginalCount: missingOriginal.length,
  missingDerivedCount: missingDerived.length,
  zeroSizedDerivedCount: zeroSizedDerived.length,
  missingPreviewRecordCount: missingPreviewRecord.length,
  missingThumbnailRecordCount: missingThumbnailRecord.length,
  missingThumbhashCount: missingThumbhash.length,
  missingDimensionsCount: missingDimensions.length,
  repairableMissingDerivedCount: missingDerived.filter((item) => item.originalPresent).length,
  missingOriginal,
  missingDerived,
  zeroSizedDerived,
  missingPreviewRecord,
  missingThumbnailRecord,
  missingThumbhash,
  missingDimensions,
};

await fs.mkdir(auditPath.slice(0, auditPath.lastIndexOf('/')), { recursive: true });
await fs.writeFile(auditPath, JSON.stringify(report, null, 2));
log('summary', {
  assets: report.assets,
  originalPresent: report.originalPresent,
  previewPresent: report.previewPresent,
  thumbnailPresent: report.thumbnailPresent,
  previewLocal: report.previewLocal,
  previewRemote: report.previewRemote,
  thumbnailLocal: report.thumbnailLocal,
  thumbnailRemote: report.thumbnailRemote,
  missingOriginalCount: report.missingOriginalCount,
  missingDerivedCount: report.missingDerivedCount,
  zeroSizedDerivedCount: report.zeroSizedDerivedCount,
  repairableMissingDerivedCount: report.repairableMissingDerivedCount,
  missingPreviewRecordCount: report.missingPreviewRecordCount,
  missingThumbnailRecordCount: report.missingThumbnailRecordCount,
  missingThumbhashCount: report.missingThumbhashCount,
  missingDimensionsCount: report.missingDimensionsCount,
});
log('missing-derived-assets', missingDerived.slice(0, 250));
if (missingDerived.length > 250) log('missing-derived-assets-truncated', { total: missingDerived.length, shown: 250 });
if (zeroSizedDerived.length) log('zero-sized-derived-assets', zeroSizedDerived.slice(0, 250));
if (missingThumbhash.length) log('missing-thumbhash-assets', missingThumbhash.slice(0, 250));
if (missingDimensions.length) log('missing-dimension-assets', missingDimensions.slice(0, 250));
log('audit report saved', { path: auditPath });
