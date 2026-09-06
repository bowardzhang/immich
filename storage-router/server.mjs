import http from 'node:http';

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.REMOTE_STORAGE_TOKEN || '';
const WARNING_PERCENT = Number(process.env.STORAGE_WARNING_PERCENT || 85);
const CRITICAL_PERCENT = Number(process.env.STORAGE_CRITICAL_PERCENT || 95);
const CHECK_INTERVAL_MS = Number(process.env.STORAGE_CHECK_INTERVAL_MS || 15 * 60 * 1000);
const ALERT_EMAIL_TO = process.env.ALERT_EMAIL_TO || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const ALERT_EMAIL_FROM = process.env.ALERT_EMAIL_FROM || 'Immich Storage <onboarding@resend.dev>';
const ALLOCATION_SAFETY_BYTES = Number(process.env.STORAGE_ALLOCATION_SAFETY_BYTES || 64 * 1024 * 1024);

function parseNodes() {
  const parsed = JSON.parse(process.env.STORAGE_NODES || '[]');
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('STORAGE_NODES must contain at least one node');
  return parsed.map((node, index) => ({ name: node.name || `volume-${index + 1}`, url: String(node.url).replace(/\/$/, ''), token: node.token || TOKEN }));
}

const nodes = parseNodes();
let lastAlertLevel = 'normal';

function headers(node, extra = {}) { return { ...(node.token ? { authorization: `Bearer ${node.token}` } : {}), ...extra }; }
async function request(node, pathname, init = {}) { return fetch(`${node.url}${pathname}`, { ...init, headers: headers(node, init.headers || {}) }); }

async function findFile(relative) {
  const pathname = `/api/file?path=${encodeURIComponent(relative)}`;
  for (const node of nodes) {
    const response = await request(node, pathname, { method: 'HEAD' });
    if (response.ok) return { node, response };
    if (response.status !== 404) throw new Error(`${node.name}: ${response.status} ${response.statusText}`);
  }
  return null;
}

async function getStatus(node) {
  const response = await request(node, '/api/storage');
  if (!response.ok) throw new Error(`${node.name}: ${response.status} ${response.statusText}`);
  const data = await response.json();
  const totalBytes = Number(data.totalBytes || 0);
  const availableBytes = Number(data.availableBytes || data.freeBytes || 0);
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  return { name: node.name, usedBytes, availableBytes, capacityBytes: totalBytes, usagePercent: totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 100 };
}

async function chooseNode(relative, requiredBytes = 0) {
  const existing = await findFile(relative);
  if (existing) return existing.node;
  const statuses = await Promise.all(nodes.map(async (node) => ({ node, status: await getStatus(node) })));
  statuses.sort((a, b) => b.status.availableBytes - a.status.availableBytes);
  const required = Math.max(0, requiredBytes) + ALLOCATION_SAFETY_BYTES;
  const selected = statuses.find(({ status }) => status.availableBytes >= required);
  if (!selected) throw new Error(`No storage volume has enough free space for this file (required=${requiredBytes} bytes plus ${ALLOCATION_SAFETY_BYTES} bytes safety margin)`);
  return selected.node;
}

function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }

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
  } catch (error) { res.destroy(error); }
}

async function poolStatus() { return Promise.all(nodes.map(getStatus)); }

async function sendAlert(statuses) {
  if (!RESEND_API_KEY || !ALERT_EMAIL_TO) return false;
  const level = statuses.every((item) => item.usagePercent >= CRITICAL_PERCENT) ? 'critical' : 'warning';
  if (level === lastAlertLevel) return false;
  const subject = level === 'critical' ? 'Immich storage is critically full — create the next Railway Volume' : 'Immich storage capacity warning — prepare the next Railway Volume';
  const lines = statuses.map((item) => `${item.name}: ${item.usagePercent.toFixed(1)}% (${(item.usedBytes / 1024 ** 3).toFixed(2)} / ${(item.capacityBytes / 1024 ** 3).toFixed(2)} GiB used)`).join('\n');
  const text = `${subject}\n\n${lines}\n\nCreate the next Railway 5 GB Volume and Photo Storage service, then add it to STORAGE_NODES. No automatic provisioning is performed.`;
  const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${RESEND_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: ALERT_EMAIL_FROM, to: [ALERT_EMAIL_TO], subject, text }) });
  if (!response.ok) throw new Error(`Resend returned ${response.status}`);
  lastAlertLevel = level;
  return true;
}

async function monitor() {
  try {
    const statuses = await poolStatus();
    const allWarning = statuses.every((item) => item.usagePercent >= WARNING_PERCENT);
    const allCritical = statuses.every((item) => item.usagePercent >= CRITICAL_PERCENT);
    if (!allWarning) lastAlertLevel = 'normal';
    if (allWarning) await sendAlert(statuses);
    console.log(JSON.stringify({ event: 'storage-status', statuses, allWarning, allCritical }));
  } catch (error) { console.error('Storage monitor failed:', error); }
}

const server = http.createServer(async (req, res) => {
  try {
    if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { error: 'Unauthorized' });
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const relative = url.searchParams.get('path') || '';

    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, nodes: nodes.length });

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
      return json(res, 200, { volumes: statuses, maxVolumes: 10, warningPercent: WARNING_PERCENT, criticalPercent: CRITICAL_PERCENT, nextVolumeRecommended: statuses.every((item) => item.usagePercent >= WARNING_PERCENT) });
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/file') {
      const found = await findFile(relative);
      if (!found) return json(res, 404, { error: 'File not found' });
      const upstream = await request(found.node, `/api/file?path=${encodeURIComponent(relative)}`, { method: req.method, headers: req.headers.range ? { range: req.headers.range } : {} });
      return proxyResponse(res, upstream);
    }

    if (req.method === 'PUT' && url.pathname === '/api/file') {
      const requiredBytes = Number(req.headers['content-length'] || 0);
      const node = await chooseNode(relative, Number.isFinite(requiredBytes) ? requiredBytes : 0);
      const upstream = await request(node, `/api/file?path=${encodeURIComponent(relative)}`, {
        method: 'PUT', body: req, duplex: 'half',
        headers: { 'content-type': req.headers['content-type'] || 'application/octet-stream', ...(req.headers['content-length'] ? { 'content-length': req.headers['content-length'] } : {}) },
      });
      return proxyResponse(res, upstream);
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
      const targetNode = await chooseNode(relative, Number.isFinite(sourceSize) ? sourceSize : 0);
      if (targetNode === found.node) {
        const upstream = await request(targetNode, `/api/file?path=${encodeURIComponent(relative)}&source=${encodeURIComponent(source)}`, { method: 'MOVE' });
        return proxyResponse(res, upstream);
      }
      const sourceResponse = await request(found.node, `/api/file?path=${encodeURIComponent(source)}`);
      if (!sourceResponse.ok || !sourceResponse.body) throw new Error(`Unable to read source file: ${sourceResponse.status} ${sourceResponse.statusText}`);
      const uploadResponse = await request(targetNode, `/api/file?path=${encodeURIComponent(relative)}`, {
        method: 'PUT', body: sourceResponse.body, duplex: 'half',
        headers: { 'content-type': sourceResponse.headers.get('content-type') || 'application/octet-stream', ...(sourceResponse.headers.get('content-length') ? { 'content-length': sourceResponse.headers.get('content-length') } : {}) },
      });
      if (!uploadResponse.ok) throw new Error(`Unable to write target file: ${uploadResponse.status} ${uploadResponse.statusText}`);
      const deleteResponse = await request(found.node, `/api/file?path=${encodeURIComponent(source)}`, { method: 'DELETE' });
      if (!deleteResponse.ok) throw new Error(`Target written but source deletion failed: ${deleteResponse.status} ${deleteResponse.statusText}`);
      return json(res, 200, { source, path: relative });
    }

    if (req.method === 'GET' && url.pathname === '/api/list') {
      const recursive = url.searchParams.get('recursive') === 'true';
      const merged = new Map();
      for (const node of nodes) {
        const upstream = await request(node, `/api/list?path=${encodeURIComponent(relative)}&recursive=${recursive}`);
        if (!upstream.ok) continue;
        const data = await upstream.json();
        for (const entry of data.entries || []) merged.set(entry.path, entry);
      }
      return json(res, 200, { entries: [...merged.values()] });
    }

    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes('No storage volume has enough free space') ? 507 : 500;
    return json(res, status, { error: message });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`Storage router listening on ${PORT}`));
setInterval(monitor, CHECK_INTERVAL_MS).unref();
void monitor();
