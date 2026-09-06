import http from 'node:http';
import path from 'node:path';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

const ROOT = path.resolve(process.env.PHOTO_STORAGE_ROOT || '/photos_extern');
const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.REMOTE_STORAGE_TOKEN || '';

const mimeTypes = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.gif', 'image/gif'],
  ['.webp', 'image/webp'], ['.heic', 'image/heic'], ['.heif', 'image/heif'], ['.avif', 'image/avif'],
  ['.tif', 'image/tiff'], ['.tiff', 'image/tiff'], ['.dng', 'image/x-adobe-dng'], ['.raw', 'image/x-raw'],
  ['.mp4', 'video/mp4'], ['.mov', 'video/quicktime'], ['.m4v', 'video/x-m4v'], ['.avi', 'video/x-msvideo'],
  ['.mkv', 'video/x-matroska'], ['.3gp', 'video/3gpp'],
]);

function unauthorized(res) {
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
}

function safePath(value) {
  const relative = value || '';
  if (relative.includes('\0')) throw new Error('Invalid path');
  const resolved = path.resolve(ROOT, relative);
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : `${ROOT}${path.sep}`;
  if (resolved !== ROOT && !resolved.startsWith(rootWithSep)) throw new Error('Path traversal is not allowed');
  return resolved;
}

function relativePath(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function contentType(file) {
  return mimeTypes.get(path.extname(file).toLowerCase()) || 'application/octet-stream';
}

async function statPath(relative) {
  const file = safePath(relative);
  return { file, stat: await fs.stat(file) };
}

async function listImmediate(relative) {
  const { file } = await statPath(relative);
  const entries = await fs.readdir(file, { withFileTypes: true });
  return Promise.all(entries.map(async (entry) => {
    const child = path.join(file, entry.name);
    const stat = await fs.stat(child);
    return {
      path: relativePath(child),
      type: entry.isDirectory() ? 'directory' : 'file',
      size: entry.isFile() ? stat.size : undefined,
      mtime: stat.mtime.toISOString(),
    };
  }));
}

async function listRecursive(relative) {
  const results = [];
  const start = safePath(relative);
  const stack = [start];
  while (stack.length) {
    const current = stack.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      const stat = await fs.stat(child);
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile()) {
        results.push({ path: relativePath(child), type: 'file', size: stat.size, mtime: stat.mtime.toISOString() });
      }
    }
  }
  return results;
}

function parsePath(url) {
  return url.searchParams.get('path') || '';
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
      unauthorized(res);
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const relative = parsePath(url);

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/storage') {
      const stats = await fs.statfs(ROOT);
      sendJson(res, 200, {
        totalBytes: stats.blocks * stats.bsize,
        freeBytes: stats.bfree * stats.bsize,
        availableBytes: stats.bavail * stats.bsize,
      });
      return;
    }

    if (req.method === 'PUT' && url.pathname === '/api/file') {
      const file = safePath(relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.upload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      try {
        await pipeline(req, createWriteStream(temp, { flags: 'wx' }));
        await fs.rename(temp, file);
      } finally {
        await fs.rm(temp, { force: true });
      }
      sendJson(res, 201, { path: relativePath(file) });
      return;
    }

    if (req.method === 'DELETE' && url.pathname === '/api/file') {
      await fs.unlink(safePath(relative));
      sendJson(res, 200, { deleted: relative });
      return;
    }

    if (req.method === 'MOVE' && url.pathname === '/api/file') {
      const source = safePath(url.searchParams.get('source') || '');
      const target = safePath(relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(source, target);
      sendJson(res, 200, { source: url.searchParams.get('source'), path: relative });
      return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/file') {
      const { file, stat } = await statPath(relative);
      const headers = {
        'content-type': stat.isDirectory() ? 'application/octet-stream' : contentType(file),
        'content-length': String(stat.size),
        'last-modified': stat.mtime.toUTCString(),
        'x-remote-type': stat.isDirectory() ? 'directory' : 'file',
        'cache-control': 'no-cache',
      };

      if (req.method === 'HEAD' || stat.isDirectory()) {
        res.writeHead(200, headers);
        res.end();
        return;
      }

      const range = req.headers.range;
      let start = 0;
      let end = stat.size - 1;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (match) {
          if (match[1]) start = Number(match[1]);
          if (match[2]) end = Number(match[2]);
          else end = stat.size - 1;
          if (!match[1] && match[2]) start = Math.max(0, stat.size - Number(match[2]));
          if (start > end || start >= stat.size) {
            res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
            res.end();
            return;
          }
          headers['content-length'] = String(end - start + 1);
          headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
          headers['accept-ranges'] = 'bytes';
          res.writeHead(206, headers);
          createReadStream(file, { start, end }).pipe(res);
          return;
        }
      }

      res.writeHead(200, headers);
      createReadStream(file).pipe(res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/list') {
      const recursive = url.searchParams.get('recursive') === 'true';
      const entries = recursive ? await listRecursive(relative) : await listImmediate(relative);
      sendJson(res, 200, { entries });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    const code = error?.code === 'ENOENT' ? 404 : error?.code === 'EACCES' ? 403 : 400;
    sendJson(res, code, { error: error instanceof Error ? error.message : String(error) });
  }
});

await fs.access(ROOT, constants.R_OK | constants.W_OK);
// Railway legacy environments may expose private DNS as IPv6-only.
// Bind to the IPv6 unspecified address so the service accepts private IPv6 traffic.
server.listen(PORT, '::', () => console.log(`Photo storage listening on [::]:${PORT}, root=${ROOT}`));
