import http from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const PORT = Number(process.env.STORAGE_INDEX_PORT || 3004);
const TOKEN = process.env.STORAGE_INDEX_TOKEN || process.env.REMOTE_STORAGE_TOKEN || '';
const INDEX_FILE = process.env.STORAGE_INDEX_FILE || '/data/.aio/storage-index.json';
const MAX_BODY_BYTES = Number(process.env.STORAGE_INDEX_MAX_BODY_BYTES || 16 * 1024 * 1024);

const entries = new Map();
let loadedAt = null;
let lastSavedAt = null;
let saveChain = Promise.resolve();

function normalizePath(value) {
  return String(value || '').replace(/^\/+/, '');
}

async function loadIndex() {
  try {
    const raw = await readFile(INDEX_FILE, 'utf8');
    const data = JSON.parse(raw);
    const source = data?.entries && typeof data.entries === 'object' ? data.entries : {};
    for (const [path, value] of Object.entries(source)) {
      if (!value?.node) continue;
      const normalized = normalizePath(path);
      if (!normalized) continue;
      entries.set(normalized, {
        node: String(value.node),
        path: normalizePath(value.path || normalized),
        updatedAt: value.updatedAt || null,
      });
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') console.error(JSON.stringify({ event: 'storage-index-load-error', error: String(error) }));
  }
  loadedAt = new Date().toISOString();
  console.log(JSON.stringify({ event: 'storage-index-loaded', file: INDEX_FILE, entries: entries.size }));
}

async function persistIndex() {
  const snapshot = Object.fromEntries(entries);
  const payload = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), entries: snapshot });
  const temp = `${INDEX_FILE}.tmp`;
  await mkdir(dirname(INDEX_FILE), { recursive: true });
  await writeFile(temp, payload, 'utf8');
  await rename(temp, INDEX_FILE);
  lastSavedAt = new Date().toISOString();
}

function queuePersist() {
  saveChain = saveChain.then(persistIndex, persistIndex);
  return saveChain;
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function authorized(req) {
  return !TOKEN || req.headers.authorization === `Bearer ${TOKEN}`;
}

await loadIndex();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, entries: entries.size, loadedAt, lastSavedAt });
    }
    if (!authorized(req)) return json(res, 401, { error: 'Unauthorized' });

    if (req.method === 'GET' && url.pathname === '/lookup') {
      const path = normalizePath(url.searchParams.get('path'));
      const found = entries.get(path);
      if (!found) return json(res, 404, { found: false, path });
      return json(res, 200, { found: true, requestedPath: path, ...found });
    }

    if (req.method === 'GET' && url.pathname === '/stats') {
      const byNode = {};
      for (const value of entries.values()) byNode[value.node] = (byNode[value.node] || 0) + 1;
      return json(res, 200, { entries: entries.size, byNode, file: INDEX_FILE, loadedAt, lastSavedAt });
    }

    if (req.method === 'POST' && url.pathname === '/upsert') {
      const body = await readJson(req);
      const path = normalizePath(body.path);
      const node = String(body.node || '');
      const resolvedPath = normalizePath(body.resolvedPath || body.path);
      if (!path || !node || !resolvedPath) return json(res, 400, { error: 'path, node and resolvedPath are required' });
      entries.set(path, { node, path: resolvedPath, updatedAt: new Date().toISOString() });
      await queuePersist();
      return json(res, 200, { ok: true, entries: entries.size });
    }

    if (req.method === 'POST' && url.pathname === '/bulk-upsert') {
      const body = await readJson(req);
      if (!Array.isArray(body.entries)) return json(res, 400, { error: 'entries must be an array' });
      let accepted = 0;
      for (const item of body.entries) {
        const path = normalizePath(item?.path);
        const node = String(item?.node || '');
        const resolvedPath = normalizePath(item?.resolvedPath || item?.path);
        if (!path || !node || !resolvedPath) continue;
        entries.set(path, { node, path: resolvedPath, updatedAt: new Date().toISOString() });
        accepted++;
      }
      await queuePersist();
      return json(res, 200, { ok: true, accepted, entries: entries.size });
    }

    if (req.method === 'POST' && url.pathname === '/delete') {
      const body = await readJson(req);
      const path = normalizePath(body.path);
      if (!path) return json(res, 400, { error: 'path is required' });
      const deleted = entries.delete(path);
      if (deleted) await queuePersist();
      return json(res, 200, { ok: true, deleted, entries: entries.size });
    }

    if (req.method === 'POST' && url.pathname === '/move') {
      const body = await readJson(req);
      const source = normalizePath(body.source);
      const path = normalizePath(body.path);
      const node = String(body.node || '');
      const resolvedPath = normalizePath(body.resolvedPath || body.path);
      if (!source || !path || !node || !resolvedPath) return json(res, 400, { error: 'source, path, node and resolvedPath are required' });
      entries.delete(source);
      entries.set(path, { node, path: resolvedPath, updatedAt: new Date().toISOString() });
      await queuePersist();
      return json(res, 200, { ok: true, entries: entries.size });
    }

    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(JSON.stringify({ event: 'storage-index-request-error', error: error instanceof Error ? error.message : String(error) }));
    return json(res, String(error).includes('body too large') ? 413 : 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'storage-index-listening', port: PORT, file: INDEX_FILE, entries: entries.size }));
});
