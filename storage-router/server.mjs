import http from 'node:http';

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.REMOTE_STORAGE_TOKEN || '';
const WARNING_PERCENT = Number(process.env.STORAGE_WARNING_PERCENT || 85);
const CRITICAL_PERCENT = Number(process.env.STORAGE_CRITICAL_PERCENT || 95);
const CHECK_INTERVAL_MS = Number(process.env.STORAGE_CHECK_INTERVAL_MS || 15 * 60 * 1000);
const VOLUME_SIZE_BYTES = Number(process.env.VOLUME_SIZE_BYTES || 5 * 1024 ** 3);
const ALERT_EMAIL_TO = process.env.ALERT_EMAIL_TO || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const ALERT_EMAIL_FROM = process.env.ALERT_EMAIL_FROM || 'Immich Storage <onboarding@resend.dev>';

function parseNodes() {
  const raw = process.env.STORAGE_NODES || '[]';
  const nodes = JSON.parse(raw);
  if (!Array.isArray(nodes) || nodes.length === 0) throw new Error('STORAGE_NODES must contain at least one node');
  return nodes.map((node, index) => ({
    name: node.name || `volume-${index + 1}`,
    url: String(node.url).replace(/\/$/, ''),
    token: node.token || TOKEN,
  }));
}

let nodes = parseNodes();
let lastAlertLevel = 'normal';

function headers(node, extra = {}) {
  return { ...(node.token ? { authorization: `Bearer ${node.token}` } : {}), ...extra };
}

async function request(node, pathname, init = {}) {
  return fetch(`${node.url}${pathname}`, { ...init, headers: headers(node, init.headers || {}) });
}

async function findFile(relative) {
  const path = `/api/file?path=${encodeURIComponent(relative)}`;
  for (const node of nodes) {
    const response = await request(node, path, { method: 'HEAD' });
    if (response.ok) return { node, response };
    if (response.status !== 404) throw new Error(`${node.name}: ${response.status} ${response.statusText}`);
  }
  return null;
}

async function getStatus(node) {
  const response = await request(node, `/api/list?path=&recursive=true`);
  if (!response.ok) throw new Error(`${node.name}: ${response.status} ${response.statusText}`);
  const data = await response.json();
  const usedBytes = data.entries.reduce((sum, entry) => sum + Number(entry.size || 0), 0);
  const usagePercent = (usedBytes / VOLUME_SIZE_BYTES) * 100;
  return { name: node.name, usedBytes, capacityBytes: VOLUME_SIZE_BYTES, usagePercent };
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function sendAlert(statuses) {
  if (!RESEND_API_KEY || !ALERT_EMAIL_TO) return false;
  const level = statuses.every((item) => item.usagePercent >= CRITICAL_PERCENT) ? 'critical' : 'warning';
  if (level === lastAlertLevel) return false;

  const subject = level === 'critical'
    ? 'Immich storage is critically full — create the next Railway Volume'
    : 'Immich storage capacity warning — prepare the next Railway Volume';
  const lines = statuses.map((item) => `${item.name}: ${item.usagePercent.toFixed(1)}% (${Math.round(item.usedBytes / 1024 ** 3)} / 5 GB)`).join('\n');
  const text = `${subject}\n\n${lines}\n\nPlease create the next 5 GB Railway Volume/Photo Storage service before storage reaches 100%.`;

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
    const statuses = await Promise.all(nodes.map(getStatus));
    const allWarning = statuses.every((item) => item.usagePercent >= WARNING_PERCENT);
    const allCritical = statuses.every((item) => item.usagePercent >= CRITICAL_PERCENT);
    if (!allWarning) lastAlertLevel = 'normal';
    if (allWarning) await sendAlert(statuses);
    console.log(JSON.stringify({ event: 'storage-status', statuses, allWarning, allCritical }));
  } catch (error) {
    console.error('Storage monitor failed:', error);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, { ok: true, nodes: nodes.length });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/storage/status') {
      const statuses = await Promise.all(nodes.map(getStatus));
      json(res, 200, {
        volumes: statuses,
        maxVolumes: 10,
        warningPercent: WARNING_PERCENT,
        criticalPercent: CRITICAL_PERCENT,
        nextVolumeRecommended: statuses.every((item) => item.usagePercent >= WARNING_PERCENT),
      });
      return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/file') {
      const relative = url.searchParams.get('path') || '';
      const found = await findFile(relative);
      if (!found) {
        json(res, 404, { error: 'File not found' });
        return;
      }
      const upstream = await request(found.node, `/api/file?path=${encodeURIComponent(relative)}`, {
        method: req.method,
        headers: req.headers.range ? { range: req.headers.range } : {},
      });
      res.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
      if (req.method === 'HEAD' || !upstream.body) {
        res.end();
      } else {
        const reader = upstream.body.getReader();
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.write(Buffer.from(value))) await new Promise((resolve) => res.once('drain', resolve));
          }
          res.end();
        };
        await pump();
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/list') {
      const relative = url.searchParams.get('path') || '';
      const recursive = url.searchParams.get('recursive') === 'true';
      const merged = new Map();
      for (const node of nodes) {
        const upstream = await request(node, `/api/list?path=${encodeURIComponent(relative)}&recursive=${recursive}`);
        if (!upstream.ok) continue;
        const data = await upstream.json();
        for (const entry of data.entries || []) {
          merged.set(entry.path, entry);
        }
      }
      json(res, 200, { entries: [...merged.values()] });
      return;
    }

    json(res, 404, { error: 'Not found' });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`Storage router listening on ${PORT}`));
setInterval(monitor, CHECK_INTERVAL_MS).unref();
void monitor();
