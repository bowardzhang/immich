import http from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.REMOTE_STORAGE_TOKEN || '';
const ALLOCATION_SAFETY_BYTES = Number(process.env.STORAGE_ALLOCATION_SAFETY_BYTES || 64 * 1024 * 1024);
const MAX_UPLOAD_SPOOL_BYTES = Number(process.env.STORAGE_MAX_UPLOAD_SPOOL_BYTES || 50 * 1024 ** 3);
const NODE_REQUEST_TIMEOUT_MS = Number(process.env.STORAGE_NODE_REQUEST_TIMEOUT_MS || 12_000);
const NODE_COLD_RETRY_DELAY_MS = Number(process.env.STORAGE_NODE_COLD_RETRY_DELAY_MS || 1_500);
const DEFAULT_NODE_CAPACITY_BYTES = Number(process.env.STORAGE_NODE_CAPACITY_BYTES || 4_838_498_304);
const INDEX_URL = String(process.env.STORAGE_INDEX_URL || '').replace(/\/$/, '');
const INDEX_TOKEN = process.env.STORAGE_INDEX_TOKEN || TOKEN;
const INDEX_TIMEOUT_MS = Number(process.env.STORAGE_INDEX_TIMEOUT_MS || 2_000);
const INDEX_REBUILD_ON_START = String(process.env.STORAGE_INDEX_REBUILD_ON_START || '').toLowerCase() === 'true';
const INDEX_REBUILD_BATCH_SIZE = Number(process.env.STORAGE_INDEX_REBUILD_BATCH_SIZE || 500);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseNodes() {
  const parsed = JSON.parse(process.env.STORAGE_NODES || '[]');
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('STORAGE_NODES must contain at least one node');
  if (parsed.length > 10) throw new Error('STORAGE_NODES cannot contain more than 10 volumes on Railway Hobby');
  return parsed.map((node, index) => ({
    name: node.name || `volume-${index + 1}`,
    url: String(node.url).replace(/\/$/, ''),
    token: node.token || TOKEN,
    configuredCapacityBytes: Number(node.capacityBytes || DEFAULT_NODE_CAPACITY_BYTES),
    healthy: true,
    lastError: null,
    lastCheckedAt: null,
    lastStorage: null,
  }));
}

const nodes = parseNodes();
const nodesByName = new Map(nodes.map((node) => [node.name, node]));
const pathCache = new Map();

function headers(node, extra = {}) {
  return { ...(node.token ? { authorization: `Bearer ${node.token}` } : {}), ...extra };
}

async function nodeFetch(node, pathname, init = {}, retries = 0) {
  const target = `${node.url}${pathname}`;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(target, {
        ...init,
        headers: headers(node, init.headers || {}),
        signal: init.signal || AbortSignal.timeout(NODE_REQUEST_TIMEOUT_MS),
      });
      node.healthy = true;
      node.lastError = null;
      node.lastCheckedAt = new Date().toISOString();
      return response;
    } catch (error) {
      lastError = error;
      node.healthy = false;
      node.lastError = error instanceof Error ? error.message : String(error);
      node.lastCheckedAt = new Date().toISOString();
      if (attempt < retries) await sleep(NODE_COLD_RETRY_DELAY_MS);
    }
  }
  const cause = lastError?.cause;
  const details = [lastError?.message, cause?.code, cause?.message, cause?.address, cause?.port].filter(Boolean).join(' | ');
  throw new Error(`${node.name} upstream request failed (${target}): ${details || String(lastError)}`);
}

async function indexFetch(pathname, init = {}) {
  if (!INDEX_URL) return null;
  return fetch(`${INDEX_URL}${pathname}`, {
    ...init,
    headers: {
      ...(INDEX_TOKEN ? { authorization: `Bearer ${INDEX_TOKEN}` } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
    signal: init.signal || AbortSignal.timeout(INDEX_TIMEOUT_MS),
  });
}

async function indexLookup(relative) {
  if (!INDEX_URL) return null;
  try {
    const response = await indexFetch(`/lookup?path=${encodeURIComponent(relative)}`);
    if (!response || response.status === 404) return null;
    if (!response.ok) throw new Error(`index lookup returned ${response.status}`);
    const data = await response.json();
    const node = nodesByName.get(data.node);
    if (!node) {
      await indexDelete(relative);
      return null;
    }
    return { node, path: String(data.path || relative) };
  } catch (error) {
    console.warn(JSON.stringify({ event: 'storage-index-unavailable', operation: 'lookup', path: relative, error: error instanceof Error ? error.message : String(error) }));
    return null;
  }
}

async function indexUpsert(relative, node, resolvedPath = relative) {
  if (!INDEX_URL) return;
  try {
    const response = await indexFetch('/upsert', {
      method: 'POST',
      body: JSON.stringify({ path: relative, node: node.name, resolvedPath }),
    });
    if (!response?.ok) throw new Error(`index upsert returned ${response?.status}`);
  } catch (error) {
    console.warn(JSON.stringify({ event: 'storage-index-unavailable', operation: 'upsert', path: relative, node: node.name, error: error instanceof Error ? error.message : String(error) }));
  }
}

async function indexDelete(relative) {
  if (!INDEX_URL) return;
  try {
    const response = await indexFetch('/delete', { method: 'POST', body: JSON.stringify({ path: relative }) });
    if (!response?.ok) throw new Error(`index delete returned ${response?.status}`);
  } catch (error) {
    console.warn(JSON.stringify({ event: 'storage-index-unavailable', operation: 'delete', path: relative, error: error instanceof Error ? error.message : String(error) }));
  }
}

async function indexMove(source, relative, node, resolvedPath = relative) {
  if (!INDEX_URL) return;
  try {
    const response = await indexFetch('/move', {
      method: 'POST',
      body: JSON.stringify({ source, path: relative, node: node.name, resolvedPath }),
    });
    if (!response?.ok) throw new Error(`index move returned ${response?.status}`);
  } catch (error) {
    console.warn(JSON.stringify({ event: 'storage-index-unavailable', operation: 'move', source, path: relative, node: node.name, error: error instanceof Error ? error.message : String(error) }));
  }
}

async function indexBulkUpsert(entries) {
  if (!INDEX_URL || entries.length === 0) return 0;
  let accepted = 0;
  for (let i = 0; i < entries.length; i += INDEX_REBUILD_BATCH_SIZE) {
    const batch = entries.slice(i, i + INDEX_REBUILD_BATCH_SIZE);
    const response = await indexFetch('/bulk-upsert', { method: 'POST', body: JSON.stringify({ entries: batch }) });
    if (!response?.ok) throw new Error(`index bulk-upsert returned ${response?.status}`);
    const data = await response.json();
    accepted += Number(data.accepted || 0);
  }
  return accepted;
}

async function headOnNode(node, relative) {
  const response = await nodeFetch(node, `/api/file?path=${encodeURIComponent(relative)}`, { method: 'HEAD' }, 1);
  return response.ok ? response : null;
}

async function findExactFile(relative) {
  const cached = pathCache.get(relative);
  if (cached) {
    try {
      const response = await headOnNode(cached.node, cached.path);
      if (response) return { node: cached.node, response, path: cached.path, via: 'cache' };
    } catch {}
    pathCache.delete(relative);
  }

  const indexed = await indexLookup(relative);
  if (indexed) {
    try {
      const response = await headOnNode(indexed.node, indexed.path);
      if (response) {
        pathCache.set(relative, indexed);
        return { node: indexed.node, response, path: indexed.path, via: 'persistent-index' };
      }
    } catch {}
    await indexDelete(relative);
  }

  const results = await Promise.allSettled(nodes.map(async (node) => {
    const response = await headOnNode(node, relative);
    return response ? { node, response, path: relative, via: 'exact' } : null;
  }));

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      pathCache.set(relative, { node: result.value.node, path: relative });
      await indexUpsert(relative, result.value.node, relative);
      return result.value;
    }
  }
  return null;
}

async function findUniqueBasename(relative) {
  const name = basename(relative);
  if (!name || name === '.' || name === '/') return null;

  const results = await Promise.allSettled(nodes.map(async (node) => {
    const response = await nodeFetch(node, '/api/list?path=&recursive=true', {}, 1);
    if (!response.ok) return [];
    const data = await response.json();
    return (data.entries || [])
      .filter((entry) => entry?.type === 'file' && basename(String(entry.path || '')) === name)
      .map((entry) => ({ node, path: String(entry.path) }));
  }));

  const matches = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  if (matches.length !== 1) {
    console.warn(JSON.stringify({ event: 'storage-basename-fallback', requestedPath: relative, basename: name, matches: matches.length, result: matches.length === 0 ? 'not-found' : 'ambiguous' }));
    return null;
  }

  const match = matches[0];
  const response = await headOnNode(match.node, match.path);
  if (!response) return null;
  pathCache.set(relative, { node: match.node, path: match.path });
  await indexUpsert(relative, match.node, match.path);
  await indexUpsert(match.path, match.node, match.path);
  console.warn(JSON.stringify({ event: 'storage-basename-fallback', requestedPath: relative, resolvedPath: match.path, node: match.node.name, result: 'unique-match' }));
  return { node: match.node, response, path: match.path, via: 'basename' };
}

async function findReadableFile(relative) {
  return (await findExactFile(relative)) || (await findUniqueBasename(relative));
}

async function getStatus(node) {
  try {
    const response = await nodeFetch(node, '/api/storage', {}, 1);
    if (!response.ok) throw new Error(`${node.name}: ${response.status} ${response.statusText}`);
    const data = await response.json();
    const capacityBytes = Number(data.totalBytes || node.configuredCapacityBytes || DEFAULT_NODE_CAPACITY_BYTES);
    const availableBytes = Number(data.availableBytes || data.freeBytes || 0);
    const usedBytes = Math.max(0, capacityBytes - availableBytes);
    const storage = { name: node.name, url: node.url, healthy: true, stale: false, lastError: null, lastCheckedAt: node.lastCheckedAt, usedBytes, availableBytes, capacityBytes, usagePercent: capacityBytes > 0 ? (usedBytes / capacityBytes) * 100 : 100 };
    node.lastStorage = storage;
    return storage;
  } catch (error) {
    const capacityBytes = node.lastStorage?.capacityBytes || node.configuredCapacityBytes || DEFAULT_NODE_CAPACITY_BYTES;
    const availableBytes = node.lastStorage?.availableBytes || 0;
    const usedBytes = Math.max(0, capacityBytes - availableBytes);
    return { name: node.name, url: node.url, healthy: false, stale: true, lastError: error instanceof Error ? error.message : String(error), lastCheckedAt: node.lastCheckedAt, usedBytes, availableBytes, capacityBytes, usagePercent: capacityBytes > 0 ? (usedBytes / capacityBytes) * 100 : 100 };
  }
}

async function candidateNodes(requiredBytes = 0, exclude = new Set()) {
  const statuses = await Promise.all(nodes.map(async (node) => ({ node, status: await getStatus(node) })));
  const required = Math.max(0, requiredBytes) + ALLOCATION_SAFETY_BYTES;
  return statuses.filter(({ node, status }) => !exclude.has(node) && status.healthy && status.availableBytes >= required).sort((a, b) => b.status.availableBytes - a.status.availableBytes);
}

async function putWithFailover(relative, spoolFile, headersIn, requiredBytes = 0, exclude = new Set()) {
  const candidates = await candidateNodes(requiredBytes, exclude);
  if (candidates.length === 0) throw new Error('No healthy storage volume is currently eligible for this write');
  let lastError;
  for (const { node } of candidates) {
    try {
      const body = createReadStream(spoolFile);
      const upstream = await nodeFetch(node, `/api/file?path=${encodeURIComponent(relative)}`, { method: 'PUT', body, duplex: 'half', headers: headersIn });
      if (upstream.ok || upstream.status < 500) {
        pathCache.set(relative, { node, path: relative });
        await indexUpsert(relative, node, relative);
        return { node, upstream };
      }
      lastError = new Error(`${node.name}: upstream returned ${upstream.status} ${upstream.statusText}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('All storage volumes rejected the write');
}

async function streamPutWithSpoolFailover(relative, req, contentLength = 0) {
  if (contentLength > MAX_UPLOAD_SPOOL_BYTES) throw new Error(`Upload exceeds STORAGE_MAX_UPLOAD_SPOOL_BYTES (${MAX_UPLOAD_SPOOL_BYTES} bytes)`);
  const candidates = await candidateNodes(contentLength);
  if (candidates.length === 0) throw new Error('No healthy storage volume is currently eligible for this write');

  const primary = candidates[0].node;
  const dir = await mkdtemp(`${tmpdir()}/storage-router-upload-`);
  const file = `${dir}/payload.bin`;
  const spool = createWriteStream(file);
  const upstreamBody = new PassThrough();
  const contentType = req.headers['content-type'] || 'application/octet-stream';
  const primaryHeaders = { 'content-type': contentType, ...(contentLength > 0 ? { 'content-length': String(contentLength) } : {}) };
  const primaryPromise = nodeFetch(primary, `/api/file?path=${encodeURIComponent(relative)}`, { method: 'PUT', body: upstreamBody, duplex: 'half', headers: primaryHeaders }).then((upstream) => ({ upstream, error: null })).catch((error) => ({ upstream: null, error }));

  try {
    req.pipe(spool);
    req.pipe(upstreamBody);
    await new Promise((resolve, reject) => {
      const onFinish = () => resolve();
      const onError = (error) => reject(error);
      const onAborted = () => reject(new Error('Client aborted upload'));
      spool.once('finish', onFinish);
      spool.once('error', onError);
      req.once('error', onError);
      req.once('aborted', onAborted);
    });
    upstreamBody.end();

    const fileStat = await stat(file);
    const actualBytes = fileStat.size;
    if (actualBytes > MAX_UPLOAD_SPOOL_BYTES) throw new Error(`Upload exceeds STORAGE_MAX_UPLOAD_SPOOL_BYTES (${MAX_UPLOAD_SPOOL_BYTES} bytes)`);
    if (contentLength > 0 && actualBytes !== contentLength) throw new Error(`Upload size mismatch: declared=${contentLength} actual=${actualBytes}`);

    const primaryResult = await primaryPromise;
    if (primaryResult.upstream && (primaryResult.upstream.ok || primaryResult.upstream.status < 500)) {
      pathCache.set(relative, { node: primary, path: relative });
      await indexUpsert(relative, primary, relative);
      return { node: primary, upstream: primaryResult.upstream, dir };
    }

    const { node, upstream } = await putWithFailover(relative, file, { 'content-type': contentType, 'content-length': String(actualBytes) }, actualBytes, new Set([primary]));
    return { node, upstream, dir };
  } catch (error) {
    req.unpipe(spool);
    req.unpipe(upstreamBody);
    upstreamBody.destroy();
    if (!spool.destroyed) spool.destroy();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function rebuildPersistentIndex() {
  if (!INDEX_URL) throw new Error('STORAGE_INDEX_URL is not configured');
  const results = await Promise.allSettled(nodes.map(async (node) => {
    const response = await nodeFetch(node, '/api/list?path=&recursive=true', {}, 1);
    if (!response.ok) throw new Error(`${node.name}: list returned ${response.status}`);
    const data = await response.json();
    return { node, files: (data.entries || []).filter((entry) => entry?.type === 'file').map((entry) => String(entry.path || '')).filter(Boolean) };
  }));

  const candidates = new Map();
  const failedNodes = [];
  for (const result of results) {
    if (result.status !== 'fulfilled') {
      failedNodes.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
      continue;
    }
    for (const path of result.value.files) {
      const list = candidates.get(path) || [];
      list.push(result.value.node);
      candidates.set(path, list);
    }
  }

  const unique = [];
  let duplicatePaths = 0;
  for (const [path, owners] of candidates) {
    if (owners.length !== 1) {
      duplicatePaths++;
      continue;
    }
    unique.push({ path, node: owners[0].name, resolvedPath: path });
  }
  const accepted = await indexBulkUpsert(unique);
  console.log(JSON.stringify({ event: 'storage-index-rebuild-complete', uniquePaths: unique.length, accepted, duplicatePaths, failedNodes }));
  return { uniquePaths: unique.length, accepted, duplicatePaths, failedNodes };
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function proxyResponse(res, upstream) {
  res.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
  if (!upstream.body) return res.end();
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) await new Promise((resolve) => res.once('drain', resolve));
    }
    res.end();
  } catch (error) {
    res.destroy(error);
  }
}

async function poolStatus() {
  return Promise.all(nodes.map(getStatus));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const relative = url.searchParams.get('path') || '';

    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, nodes: nodes.length, fixedNodePool: true, persistentIndex: Boolean(INDEX_URL) });
    if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { error: 'Unauthorized' });

    if (req.method === 'GET' && url.pathname === '/api/storage') {
      const statuses = await poolStatus();
      return json(res, 200, { totalBytes: statuses.reduce((sum, item) => sum + item.capacityBytes, 0), availableBytes: statuses.reduce((sum, item) => sum + item.availableBytes, 0), freeBytes: statuses.reduce((sum, item) => sum + item.availableBytes, 0), volumes: statuses });
    }

    if (req.method === 'GET' && url.pathname === '/api/storage/status') {
      const statuses = await poolStatus();
      return json(res, 200, { volumes: statuses, maxVolumes: nodes.length, fixedNodePool: true, persistentIndex: Boolean(INDEX_URL) });
    }

    if (req.method === 'POST' && url.pathname === '/api/index/rebuild') {
      return json(res, 200, await rebuildPersistentIndex());
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/file') {
      const found = await findReadableFile(relative);
      if (!found) return json(res, 404, { error: 'File not found' });
      const upstream = await nodeFetch(found.node, `/api/file?path=${encodeURIComponent(found.path)}`, { method: req.method, headers: req.headers.range ? { range: req.headers.range } : {} }, 1);
      if (found.via === 'basename' || found.path !== relative) upstream.headers.set('x-storage-resolved-path', found.path);
      upstream.headers.set('x-storage-route', found.via);
      upstream.headers.set('x-storage-node', found.node.name);
      return proxyResponse(res, upstream);
    }

    if (req.method === 'PUT' && url.pathname === '/api/file') {
      const declaredBytes = Number(req.headers['content-length'] || 0);
      const contentLength = Number.isFinite(declaredBytes) && declaredBytes > 0 ? declaredBytes : 0;
      const result = await streamPutWithSpoolFailover(relative, req, contentLength);
      try {
        return proxyResponse(res, result.upstream);
      } finally {
        await rm(result.dir, { recursive: true, force: true }).catch(() => {});
      }
    }

    if (req.method === 'DELETE' && url.pathname === '/api/file') {
      const found = await findExactFile(relative);
      if (!found) return json(res, 404, { error: 'File not found' });
      const upstream = await nodeFetch(found.node, `/api/file?path=${encodeURIComponent(found.path)}`, { method: 'DELETE' });
      if (upstream.ok) {
        pathCache.delete(relative);
        await indexDelete(relative);
        if (found.path !== relative) await indexDelete(found.path);
      }
      return proxyResponse(res, upstream);
    }

    if (req.method === 'MOVE' && url.pathname === '/api/file') {
      const source = url.searchParams.get('source') || '';
      const found = await findExactFile(source);
      if (!found) return json(res, 404, { error: 'Source file not found' });
      const sourceSize = Number(found.response.headers.get('content-length') || 0);
      const candidates = await candidateNodes(Number.isFinite(sourceSize) ? sourceSize : 0, new Set([found.node]));
      if (candidates.length === 0) {
        const upstream = await nodeFetch(found.node, `/api/file?path=${encodeURIComponent(relative)}&source=${encodeURIComponent(found.path)}`, { method: 'MOVE' });
        if (upstream.ok) {
          pathCache.delete(source);
          pathCache.set(relative, { node: found.node, path: relative });
          await indexMove(source, relative, found.node, relative);
        }
        return proxyResponse(res, upstream);
      }

      let lastError;
      for (const { node: targetNode } of candidates) {
        try {
          const sourceResponse = await nodeFetch(found.node, `/api/file?path=${encodeURIComponent(found.path)}`);
          if (!sourceResponse.ok || !sourceResponse.body) throw new Error(`Unable to read source: ${sourceResponse.status}`);
          const uploadResponse = await nodeFetch(targetNode, `/api/file?path=${encodeURIComponent(relative)}`, { method: 'PUT', body: sourceResponse.body, duplex: 'half', headers: { 'content-type': sourceResponse.headers.get('content-type') || 'application/octet-stream', ...(sourceResponse.headers.get('content-length') ? { 'content-length': sourceResponse.headers.get('content-length') } : {}) } });
          if (!uploadResponse.ok) throw new Error(`${targetNode.name}: target write ${uploadResponse.status}`);
          const deleteResponse = await nodeFetch(found.node, `/api/file?path=${encodeURIComponent(found.path)}`, { method: 'DELETE' });
          if (!deleteResponse.ok) throw new Error(`source deletion failed: ${deleteResponse.status}`);
          pathCache.delete(source);
          pathCache.set(relative, { node: targetNode, path: relative });
          await indexMove(source, relative, targetNode, relative);
          return json(res, 200, { source, path: relative, node: targetNode.name });
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error('Cross-volume MOVE failed');
    }

    if (req.method === 'GET' && url.pathname === '/api/list') {
      const recursive = url.searchParams.get('recursive') === 'true';
      const results = await Promise.allSettled(nodes.map(async (node) => {
        const upstream = await nodeFetch(node, `/api/list?path=${encodeURIComponent(relative)}&recursive=${recursive}`, {}, 1);
        if (!upstream.ok) return [];
        const data = await upstream.json();
        return data.entries || [];
      }));
      const merged = new Map();
      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        for (const entry of result.value) merged.set(entry.path, entry);
      }
      return json(res, 200, { entries: [...merged.values()] });
    }

    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes('No healthy storage volume') ? 507 : message.includes('STORAGE_MAX_UPLOAD_SPOOL_BYTES') ? 413 : 500;
    return json(res, status, { error: message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'storage-router-mode', mode: 'serverless-request-driven', fixedNodePool: true, nodes: nodes.length, automaticProvisioning: false, capacityFallbackBytesPerNode: DEFAULT_NODE_CAPACITY_BYTES, basenameReadFallback: 'unique-match-only', persistentIndex: Boolean(INDEX_URL), indexUrl: INDEX_URL || null }));
  console.log(`Storage router listening on ${PORT}`);
  if (INDEX_REBUILD_ON_START) {
    rebuildPersistentIndex().catch((error) => console.error(JSON.stringify({ event: 'storage-index-rebuild-error', error: error instanceof Error ? error.message : String(error) })));
  }
});
