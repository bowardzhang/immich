import http from 'node:http';
import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.REMOTE_STORAGE_TOKEN || '';
const WARNING_PERCENT = Number(process.env.STORAGE_WARNING_PERCENT || 85);
const CRITICAL_PERCENT = Number(process.env.STORAGE_CRITICAL_PERCENT || 95);
const CHECK_INTERVAL_MS = Number(process.env.STORAGE_CHECK_INTERVAL_MS || 15 * 60 * 1000);
const SELF_TEST_DELAY_MS = Number(process.env.STORAGE_SELF_TEST_DELAY_MS || 30 * 1000);
const ALERT_EMAIL_TO = process.env.ALERT_EMAIL_TO || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const ALERT_EMAIL_FROM = process.env.ALERT_EMAIL_FROM || 'Immich Storage <onboarding@resend.dev>';
const ALLOCATION_SAFETY_BYTES = Number(process.env.STORAGE_ALLOCATION_SAFETY_BYTES || 64 * 1024 * 1024);
const MAX_UPLOAD_SPOOL_BYTES = Number(process.env.STORAGE_MAX_UPLOAD_SPOOL_BYTES || 50 * 1024 ** 3);

function parseNodes() {
  const parsed = JSON.parse(process.env.STORAGE_NODES || '[]');
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('STORAGE_NODES must contain at least one node');
  if (parsed.length > 10) throw new Error('STORAGE_NODES cannot contain more than 10 volumes on Railway Hobby');
  return parsed.map((node, index) => ({
    name: node.name || `volume-${index + 1}`,
    url: String(node.url).replace(/\/$/, ''),
    token: node.token || TOKEN,
    healthy: true,
    lastError: null,
    lastCheckedAt: null,
  }));
}

const nodes = parseNodes();
let lastAlertLevel = 'normal';
let provisioningInProgress = false;

function headers(node, extra = {}) {
  return { ...(node.token ? { authorization: `Bearer ${node.token}` } : {}), ...extra };
}

async function request(node, pathname, init = {}) {
  const target = `${node.url}${pathname}`;
  try {
    const response = await fetch(target, { ...init, headers: headers(node, init.headers || {}) });
    node.healthy = true;
    node.lastError = null;
    node.lastCheckedAt = new Date().toISOString();
    return response;
  } catch (error) {
    node.healthy = false;
    node.lastError = error instanceof Error ? error.message : String(error);
    node.lastCheckedAt = new Date().toISOString();
    const cause = error?.cause;
    const details = [error?.message, cause?.code, cause?.message, cause?.address, cause?.port].filter(Boolean).join(' | ');
    throw new Error(`${node.name} upstream request failed (${target}): ${details || String(error)}`);
  }
}

async function findFile(relative) {
  const pathname = `/api/file?path=${encodeURIComponent(relative)}`;
  for (const node of nodes) {
    try {
      const response = await request(node, pathname, { method: 'HEAD' });
      if (response.ok) return { node, response };
      if (response.status !== 404) console.warn(`File lookup ${node.name}: ${response.status} ${response.statusText}`);
    } catch (error) {
      console.warn(`File lookup ${node.name} skipped: ${error.message}`);
    }
  }
  return null;
}

async function getStatus(node) {
  try {
    const response = await request(node, '/api/storage');
    if (!response.ok) throw new Error(`${node.name}: ${response.status} ${response.statusText}`);
    const data = await response.json();
    const totalBytes = Number(data.totalBytes || 0);
    const availableBytes = Number(data.availableBytes || data.freeBytes || 0);
    const usedBytes = Math.max(0, totalBytes - availableBytes);
    return {
      name: node.name,
      url: node.url,
      healthy: true,
      lastError: null,
      lastCheckedAt: node.lastCheckedAt,
      usedBytes,
      availableBytes,
      capacityBytes: totalBytes,
      usagePercent: totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 100,
    };
  } catch (error) {
    return {
      name: node.name,
      url: node.url,
      healthy: false,
      lastError: error.message,
      lastCheckedAt: node.lastCheckedAt,
      usedBytes: 0,
      availableBytes: 0,
      capacityBytes: 0,
      usagePercent: 100,
    };
  }
}

async function candidateNodes(requiredBytes = 0, exclude = new Set()) {
  const statuses = await Promise.all(nodes.map(async (node) => ({ node, status: await getStatus(node) })));
  const required = Math.max(0, requiredBytes) + ALLOCATION_SAFETY_BYTES;
  return statuses
    .filter(({ node, status }) => !exclude.has(node) && status.healthy && status.availableBytes >= required)
    .sort((a, b) => b.status.availableBytes - a.status.availableBytes);
}

async function chooseNode(relative, requiredBytes = 0) {
  const existing = await findFile(relative);
  if (existing) return existing.node;
  const candidates = await candidateNodes(requiredBytes);
  if (candidates.length === 0) throw new Error(`No healthy storage volume has enough free space for this file (required=${requiredBytes} bytes plus ${ALLOCATION_SAFETY_BYTES} bytes safety margin)`);
  return candidates[0].node;
}

async function spoolRequestBody(req, contentLength) {
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_SPOOL_BYTES) {
    throw new Error(`Upload exceeds STORAGE_MAX_UPLOAD_SPOOL_BYTES (${MAX_UPLOAD_SPOOL_BYTES} bytes)`);
  }
  const dir = await mkdtemp(`${tmpdir()}/storage-router-upload-`);
  const file = `${dir}/payload.bin`;
  try {
    await pipeline(req, createWriteStream(file));
    const fileStat = await stat(file);
    const actualBytes = fileStat.size;
    if (actualBytes > MAX_UPLOAD_SPOOL_BYTES) {
      throw new Error(`Upload exceeds STORAGE_MAX_UPLOAD_SPOOL_BYTES (${MAX_UPLOAD_SPOOL_BYTES} bytes)`);
    }
    if (contentLength > 0 && actualBytes !== contentLength) {
      throw new Error(`Upload size mismatch: declared=${contentLength} bytes actual=${actualBytes} bytes`);
    }
    return { dir, file, actualBytes };
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function putWithFailover(relative, spoolFile, headersIn, requiredBytes = 0, exclude = new Set()) {
  const candidates = await candidateNodes(requiredBytes, exclude);
  if (candidates.length === 0) throw new Error('No healthy storage volume is currently eligible for this write');
  let lastError;
  for (const { node } of candidates) {
    try {
      const body = createReadStream(spoolFile);
      const upstream = await request(node, `/api/file?path=${encodeURIComponent(relative)}`, {
        method: 'PUT',
        body,
        duplex: 'half',
        headers: headersIn,
      });
      if (upstream.ok || upstream.status < 500) return { node, upstream };
      lastError = new Error(`${node.name}: upstream returned ${upstream.status} ${upstream.statusText}`);
    } catch (error) {
      lastError = error;
    }
    console.warn(`PUT failover: ${node.name} failed; trying next eligible volume`);
  }
  throw lastError || new Error('All storage volumes rejected the write');
}

async function streamPutWithSpoolFailover(relative, req, contentLength = 0) {
  if (contentLength > MAX_UPLOAD_SPOOL_BYTES) {
    throw new Error(`Upload exceeds STORAGE_MAX_UPLOAD_SPOOL_BYTES (${MAX_UPLOAD_SPOOL_BYTES} bytes)`);
  }

  const candidates = await candidateNodes(contentLength);
  if (candidates.length === 0) throw new Error('No healthy storage volume is currently eligible for this write');
  const primary = candidates[0].node;
  const dir = await mkdtemp(`${tmpdir()}/storage-router-upload-`);
  const file = `${dir}/payload.bin`;
  const startedAt = Date.now();
  const spool = createWriteStream(file);
  const upstreamBody = new PassThrough();
  const contentType = req.headers['content-type'] || 'application/octet-stream';
  const primaryHeaders = {
    'content-type': contentType,
    ...(contentLength > 0 ? { 'content-length': String(contentLength) } : {}),
  };

  let primarySettled = false;
  const primaryPromise = request(primary, `/api/file?path=${encodeURIComponent(relative)}`, {
    method: 'PUT',
    body: upstreamBody,
    duplex: 'half',
    headers: primaryHeaders,
  }).then((upstream) => {
    primarySettled = true;
    if (!upstream.ok && upstream.status >= 500) {
      req.unpipe(upstreamBody);
      upstreamBody.destroy();
    }
    return { upstream, error: null };
  }).catch((error) => {
    primarySettled = true;
    req.unpipe(upstreamBody);
    upstreamBody.destroy();
    return { upstream: null, error };
  });

  try {
    req.pipe(spool);
    req.pipe(upstreamBody);
    await new Promise((resolve, reject) => {
      spool.once('finish', resolve);
      spool.once('error', reject);
      req.once('error', reject);
    });

    const fileStat = await stat(file);
    const actualBytes = fileStat.size;
    if (actualBytes > MAX_UPLOAD_SPOOL_BYTES) {
      req.unpipe(upstreamBody);
      upstreamBody.destroy();
      throw new Error(`Upload exceeds STORAGE_MAX_UPLOAD_SPOOL_BYTES (${MAX_UPLOAD_SPOOL_BYTES} bytes)`);
    }
    if (contentLength > 0 && actualBytes !== contentLength) {
      req.unpipe(upstreamBody);
      upstreamBody.destroy();
      throw new Error(`Upload size mismatch: declared=${contentLength} bytes actual=${actualBytes} bytes`);
    }

    if (!primarySettled) upstreamBody.end();
    const primaryResult = await primaryPromise;
    if (primaryResult.upstream && (primaryResult.upstream.ok || primaryResult.upstream.status < 500)) {
      console.log(JSON.stringify({ event: 'storage-put', mode: 'streamed-primary', node: primary.name, bytes: actualBytes, durationMs: Date.now() - startedAt }));
      return { node: primary, upstream: primaryResult.upstream, dir, file, actualBytes };
    }

    const failoverHeaders = {
      'content-type': contentType,
      'content-length': String(actualBytes),
    };
    const { node, upstream } = await putWithFailover(relative, file, failoverHeaders, actualBytes, new Set([primary]));
    console.log(JSON.stringify({ event: 'storage-put', mode: 'spool-failover', node: node.name, primary: primary.name, bytes: actualBytes, durationMs: Date.now() - startedAt, primaryError: primaryResult.error?.message || (primaryResult.upstream ? `${primaryResult.upstream.status} ${primaryResult.upstream.statusText}` : null) }));
    return { node, upstream, dir, file, actualBytes };
  } catch (error) {
    req.unpipe(upstreamBody);
    upstreamBody.destroy();
    if (!spool.destroyed) spool.destroy();
    throw error;
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
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

async function runNodeSelfTest(node) {
  const payload = `storage-router-selftest:${Date.now()}:${crypto.randomUUID()}`;
  const path = `.storage-router-selftest/${Date.now()}-${crypto.randomUUID()}.txt`;
  const encoded = encodeURIComponent(path);
  let written = false;
  try {
    const put = await request(node, `/api/file?path=${encoded}`, {
      method: 'PUT',
      body: payload,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(Buffer.byteLength(payload)) },
    });
    if (!put.ok) throw new Error(`PUT ${put.status} ${put.statusText}`);
    written = true;
    const head = await request(node, `/api/file?path=${encoded}`, { method: 'HEAD' });
    if (!head.ok) throw new Error(`HEAD ${head.status} ${head.statusText}`);
    const get = await request(node, `/api/file?path=${encoded}`);
    if (!get.ok) throw new Error(`GET ${get.status} ${get.statusText}`);
    const body = await get.text();
    if (body !== payload) throw new Error('GET content mismatch');
    const del = await request(node, `/api/file?path=${encoded}`, { method: 'DELETE' });
    if (!del.ok) throw new Error(`DELETE ${del.status} ${del.statusText}`);
    written = false;
    console.log(JSON.stringify({ event: 'storage-self-test', node: node.name, result: 'PASS' }));
    return true;
  } catch (error) {
    console.error(JSON.stringify({ event: 'storage-self-test', node: node.name, result: 'FAIL', error: error.message }));
    return false;
  } finally {
    if (written) {
      try { await request(node, `/api/file?path=${encoded}`, { method: 'DELETE' }); } catch {}
    }
  }
}

async function runBackgroundSelfTest() {
  const results = await Promise.all(nodes.map(runNodeSelfTest));
  console.log(JSON.stringify({ event: 'storage-self-test-summary', passed: results.filter(Boolean).length, total: results.length }));
}

async function sendAlert(statuses) {
  if (!RESEND_API_KEY || !ALERT_EMAIL_TO) return false;
  const level = statuses.every((item) => item.usagePercent >= CRITICAL_PERCENT) ? 'critical' : 'warning';
  if (level === lastAlertLevel) return false;
  const atLimit = nodes.length >= 10;
  const subject = atLimit
    ? 'Immich storage is full — Railway Hobby volume limit reached'
    : level === 'critical'
      ? 'Immich storage is critically full — automatic expansion required'
      : 'Immich storage capacity warning — automatic expansion preparing';
  const lines = statuses.map((item) => `${item.name}: ${item.healthy ? `${item.usagePercent.toFixed(1)}% (${(item.usedBytes / 1024 ** 3).toFixed(2)} / ${(item.capacityBytes / 1024 ** 3).toFixed(2)} GiB used)` : `UNHEALTHY (${item.lastError || 'unknown error'})`}`).join('\n');
  const action = atLimit
    ? 'All 10 configured volumes are in the warning range. Railway Hobby cannot add an 11th volume; migrate/resize storage or upgrade the plan.'
    : 'The Storage Router provisioning controller should create the next Photo Storage service and volume automatically when Railway API provisioning is enabled.';
  const text = `${subject}\n\n${lines}\n\n${action}`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: ALERT_EMAIL_FROM, to: [ALERT_EMAIL_TO], subject, text }),
  });
  if (!response.ok) throw new Error(`Resend returned ${response.status}`);
  lastAlertLevel = level;
  return true;
}

async function monitor() {
  try {
    const statuses = await poolStatus();
    const allWarning = statuses.every((item) => item.usagePercent >= WARNING_PERCENT);
    const allCritical = statuses.every((item) => item.usagePercent >= CRITICAL_PERCENT);
    const healthyCount = statuses.filter((item) => item.healthy).length;
    if (!allWarning && healthyCount === statuses.length) lastAlertLevel = 'normal';
    if (allWarning || healthyCount < statuses.length) await sendAlert(statuses);
    console.log(JSON.stringify({ event: 'storage-status', statuses, allWarning, allCritical, healthyCount, volumeLimitReached: nodes.length >= 10, provisioningInProgress }));
  } catch (error) {
    console.error('Storage monitor failed:', error);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const relative = url.searchParams.get('path') || '';
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, nodes: nodes.length, healthyNodes: nodes.filter((node) => node.healthy).length, maxVolumes: 10 });
    }
    if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { error: 'Unauthorized' });
    if (req.method === 'GET' && url.pathname === '/api/storage') {
      const statuses = await poolStatus();
      return json(res, 200, {
        totalBytes: statuses.reduce((sum, item) => sum + item.capacityBytes, 0),
        availableBytes: statuses.reduce((sum, item) => sum + item.availableBytes, 0),
        freeBytes: statuses.reduce((sum, item) => sum + item.availableBytes, 0),
        volumes: statuses,
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/storage/status') {
      const statuses = await poolStatus();
      return json(res, 200, {
        volumes: statuses,
        maxVolumes: 10,
        warningPercent: WARNING_PERCENT,
        criticalPercent: CRITICAL_PERCENT,
        nextVolumeRecommended: nodes.length < 10 && statuses.every((item) => item.usagePercent >= WARNING_PERCENT),
        volumeLimitReached: nodes.length >= 10,
        provisioningInProgress,
      });
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/file') {
      const found = await findFile(relative);
      if (!found) return json(res, 404, { error: 'File not found' });
      const upstream = await request(found.node, `/api/file?path=${encodeURIComponent(relative)}`, {
        method: req.method,
        headers: req.headers.range ? { range: req.headers.range } : {},
      });
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
      const found = await findFile(relative);
      if (!found) return json(res, 404, { error: 'File not found' });
      const upstream = await request(found.node, `/api/file?path=${encodeURIComponent(relative)}`, { method: 'DELETE' });
      return proxyResponse(res, upstream);
    }
    if (req.method === 'MOVE' && url.pathname === '/api/file') {
      const source = url.searchParams.get('source') || '';
      const found = await findFile(source);
      if (!found) return json(res, 404, { error: 'Source file not found' });
      const sourceSize = Number(found.response.headers.get('content-length') || 0);
      const candidates = await candidateNodes(Number.isFinite(sourceSize) ? sourceSize : 0, new Set([found.node]));
      if (candidates.length === 0) {
        const upstream = await request(found.node, `/api/file?path=${encodeURIComponent(relative)}&source=${encodeURIComponent(source)}`, { method: 'MOVE' });
        return proxyResponse(res, upstream);
      }
      let lastError;
      for (const { node: targetNode } of candidates) {
        try {
          const sourceResponse = await request(found.node, `/api/file?path=${encodeURIComponent(source)}`);
          if (!sourceResponse.ok || !sourceResponse.body) throw new Error(`Unable to read source: ${sourceResponse.status}`);
          const uploadHeaders = {
            'content-type': sourceResponse.headers.get('content-type') || 'application/octet-stream',
            ...(sourceResponse.headers.get('content-length') ? { 'content-length': sourceResponse.headers.get('content-length') } : {}),
          };
          const uploadResponse = await request(targetNode, `/api/file?path=${encodeURIComponent(relative)}`, {
            method: 'PUT',
            body: sourceResponse.body,
            duplex: 'half',
            headers: uploadHeaders,
          });
          if (!uploadResponse.ok) throw new Error(`${targetNode.name}: target write ${uploadResponse.status}`);
          const deleteResponse = await request(found.node, `/api/file?path=${encodeURIComponent(source)}`, { method: 'DELETE' });
          if (!deleteResponse.ok) throw new Error(`source deletion failed: ${deleteResponse.status}`);
          return json(res, 200, { source, path: relative, node: targetNode.name });
        } catch (error) {
          lastError = error;
          console.warn(`MOVE failover: ${targetNode.name} failed; trying next target`);
        }
      }
      throw lastError || new Error('Cross-volume MOVE failed');
    }
    if (req.method === 'GET' && url.pathname === '/api/list') {
      const recursive = url.searchParams.get('recursive') === 'true';
      const merged = new Map();
      for (const node of nodes) {
        try {
          const upstream = await request(node, `/api/list?path=${encodeURIComponent(relative)}&recursive=${recursive}`);
          if (!upstream.ok) continue;
          const data = await upstream.json();
          for (const entry of data.entries || []) merged.set(entry.path, entry);
        } catch (error) {
          console.warn(`List ${node.name} skipped: ${error.message}`);
        }
      }
      return json(res, 200, { entries: [...merged.values()] });
    }
    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes('No healthy storage volume')
      ? 507
      : message.includes('STORAGE_MAX_UPLOAD_SPOOL_BYTES')
        ? 413
        : 500;
    return json(res, status, { error: message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Storage router listening on ${PORT}`);
  setTimeout(() => void runBackgroundSelfTest(), SELF_TEST_DELAY_MS).unref();
});
setInterval(monitor, CHECK_INTERVAL_MS).unref();
void monitor();