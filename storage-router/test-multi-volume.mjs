import http from 'node:http';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';

const TOKEN = 'local-test-token';
const volumes = [new Map(), new Map()];
const capacities = [1000, 10000];
const failNextPut = [false, false];

function startMock(index) {
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end();
    const url = new URL(req.url, 'http://localhost');
    const path = url.searchParams.get('path') || '';
    const store = volumes[index];
    if (req.method === 'GET' && url.pathname === '/api/storage') {
      const used = [...store.values()].reduce((n, b) => n + b.length, 0);
      return json(res, 200, { totalBytes: capacities[index], availableBytes: capacities[index] - used });
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/file') {
      const body = store.get(path);
      if (!body) return json(res, 404, { error: 'File not found' });
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
      return req.method === 'HEAD' ? res.end() : res.end(body);
    }
    if (req.method === 'PUT' && url.pathname === '/api/file') {
      if (failNextPut[index]) {
        failNextPut[index] = false;
        res.writeHead(503).end('simulated write failure');
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      store.set(path, Buffer.concat(chunks));
      return res.writeHead(201).end();
    }
    if (req.method === 'DELETE' && url.pathname === '/api/file') {
      if (!store.delete(path)) return json(res, 404, { error: 'File not found' });
      return res.writeHead(200).end();
    }
    if (req.method === 'MOVE' && url.pathname === '/api/file') {
      const source = url.searchParams.get('source') || '';
      const body = store.get(source);
      if (!body) return json(res, 404, { error: 'Source file not found' });
      store.set(path, body); store.delete(source);
      return res.writeHead(200).end();
    }
    if (req.method === 'GET' && url.pathname === '/api/list') {
      return json(res, 200, { entries: [...store.keys()].map((p) => ({ path: p, type: 'file' })) });
    }
    return json(res, 404, { error: 'Not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
function port(server) { return server.address().port; }
async function request(base, path, options = {}) {
  const response = await fetch(`${base}/api/file?path=${encodeURIComponent(path)}`, { ...options, headers: { authorization: `Bearer ${TOKEN}`, ...(options.headers || {}) } });
  return response;
}
async function waitForHealth(base) {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Router did not become ready');
}

const mocks = await Promise.all([startMock(0), startMock(1)]);
const router = spawn(process.execPath, ['storage-router/server.mjs'], {
  env: {
    ...process.env,
    PORT: '0',
    REMOTE_STORAGE_TOKEN: TOKEN,
    STORAGE_ALLOCATION_SAFETY_BYTES: '0',
    STORAGE_CHECK_INTERVAL_MS: '3600000',
    STORAGE_NODES: JSON.stringify([
      { name: 'volume-1', url: `http://127.0.0.1:${port(mocks[0])}` },
      { name: 'volume-2', url: `http://127.0.0.1:${port(mocks[1])}` },
    ]),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

try {
  // Router does not accept PORT=0 through the child environment because it logs the actual bound port
  // only through listen's callback; use a fixed free-enough test port instead.
  router.kill();
  await new Promise((resolve) => router.once('exit', resolve));
  const routerPort = 18180;
  const routerProcess = spawn(process.execPath, ['storage-router/server.mjs'], {
    env: { ...process.env, PORT: String(routerPort), REMOTE_STORAGE_TOKEN: TOKEN, STORAGE_ALLOCATION_SAFETY_BYTES: '0', STORAGE_CHECK_INTERVAL_MS: '3600000', STORAGE_NODES: JSON.stringify([
      { name: 'volume-1', url: `http://127.0.0.1:${port(mocks[0])}` },
      { name: 'volume-2', url: `http://127.0.0.1:${port(mocks[1])}` },
    ]) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  routerProcess.stderr.on('data', (d) => process.stderr.write(d));
  const base = `http://127.0.0.1:${routerPort}`;
  await waitForHealth(base);

  // Seed a file on volume 1 and verify the router can discover it there.
  volumes[0].set('existing/on-volume-1.txt', Buffer.from('volume-one'));
  let r = await request(base, 'existing/on-volume-1.txt');
  assert(r.status === 200 && (await r.text()) === 'volume-one', 'existing file lookup failed');

  // New files should go to the volume with the most free space.
  r = await request(base, 'new/on-volume-2.txt', { method: 'PUT', body: 'volume-two' });
  assert(r.status === 201, `new-file PUT returned ${r.status}`);
  assert(volumes[0].has('new/on-volume-2.txt') === false, 'new file incorrectly allocated to volume 1');
  assert(volumes[1].has('new/on-volume-2.txt'), 'new file was not allocated to volume 2');

  // Chunked uploads without Content-Length must stream successfully to the primary volume.
  const chunkedPath = 'new/chunked-stream.txt';
  const chunkedBody = Readable.from([Buffer.from('chunked-'), Buffer.from('stream')]);
  r = await request(base, chunkedPath, { method: 'PUT', body: chunkedBody, duplex: 'half' });
  assert(r.status === 201, `chunked PUT returned ${r.status}`);
  assert(volumes[1].get(chunkedPath)?.toString() === 'chunked-stream', 'chunked upload content mismatch');

  // If the streamed primary write fails, the completed spool must be replayed to another eligible volume.
  const failoverPath = 'new/stream-failover.txt';
  failNextPut[1] = true;
  const failoverBody = Readable.from([Buffer.from('stream-'), Buffer.from('failover')]);
  r = await request(base, failoverPath, { method: 'PUT', body: failoverBody, duplex: 'half' });
  assert(r.status === 201, `stream failover PUT returned ${r.status}`);
  assert(!volumes[1].has(failoverPath), 'failed primary unexpectedly retained the failover file');
  assert(volumes[0].get(failoverPath)?.toString() === 'stream-failover', 'spool failover did not preserve upload content');

  // LIST must merge both volumes.
  r = await fetch(`${base}/api/list?path=&recursive=true`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const listed = await r.json();
  const paths = new Set(listed.entries.map((e) => e.path));
  assert(paths.has('existing/on-volume-1.txt') && paths.has('new/on-volume-2.txt') && paths.has(chunkedPath) && paths.has(failoverPath), 'merged LIST is incomplete');

  // Cross-volume MOVE: source on volume 1 -> destination selected on volume 2.
  const moveTarget = 'moved/to-volume-2.txt';
  r = await fetch(`${base}/api/file?path=${encodeURIComponent(moveTarget)}&source=${encodeURIComponent('existing/on-volume-1.txt')}`, { method: 'MOVE', headers: { authorization: `Bearer ${TOKEN}` } });
  assert(r.status === 200, `cross-volume MOVE returned ${r.status}`);
  assert(!volumes[0].has('existing/on-volume-1.txt'), 'MOVE did not delete source from volume 1');
  assert(volumes[1].has(moveTarget), 'MOVE did not create target on volume 2');

  console.log('ALL MULTI-VOLUME ROUTING TESTS PASSED');
  routerProcess.kill();
  await new Promise((resolve) => routerProcess.once('exit', resolve));
} finally {
  for (const server of mocks) server.close();
}

function assert(condition, message) { if (!condition) throw new Error(message); }
