import crypto from 'node:crypto';

const TOKEN = process.env.REMOTE_STORAGE_TOKEN || '';
const nodes = JSON.parse(process.env.STORAGE_NODES || '[]').map((node, index) => ({
  name: node.name || `volume-${index + 1}`,
  url: String(node.url).replace(/\/$/, ''),
  token: node.token || TOKEN,
}));

if (!Array.isArray(nodes) || nodes.length === 0) throw new Error('STORAGE_NODES must contain at least one node');

const payload = `storage-router-selftest:${Date.now()}:${crypto.randomUUID()}`;
const path = `.storage-router-selftest/${Date.now()}-${crypto.randomUUID()}.txt`;

function headers(node, extra = {}) {
  return { ...(node.token ? { authorization: `Bearer ${node.token}` } : {}), ...extra };
}

async function request(node, pathname, init = {}) {
  return fetch(`${node.url}${pathname}`, { ...init, headers: headers(node, init.headers || {}) });
}

async function testNode(node) {
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
    if (body !== payload) throw new Error(`GET content mismatch (expected ${payload.length} chars, got ${body.length})`);

    const del = await request(node, `/api/file?path=${encoded}`, { method: 'DELETE' });
    if (!del.ok) throw new Error(`DELETE ${del.status} ${del.statusText}`);
    written = false;

    console.log(JSON.stringify({ event: 'storage-self-test', node: node.name, result: 'PASS', operations: ['PUT', 'HEAD', 'GET', 'VERIFY', 'DELETE'] }));
  } catch (error) {
    console.error(JSON.stringify({ event: 'storage-self-test', node: node.name, result: 'FAIL', error: error instanceof Error ? error.message : String(error) }));
    throw error;
  } finally {
    if (written) {
      try { await request(node, `/api/file?path=${encoded}`, { method: 'DELETE' }); } catch (error) {
        console.error(JSON.stringify({ event: 'storage-self-test-cleanup', node: node.name, result: 'FAIL', error: error instanceof Error ? error.message : String(error) }));
      }
    }
  }
}

const results = [];
for (const node of nodes) {
  try {
    await testNode(node);
    results.push({ node: node.name, result: 'PASS' });
  } catch (error) {
    results.push({ node: node.name, result: 'FAIL', error: error instanceof Error ? error.message : String(error) });
  }
}

console.log(JSON.stringify({ event: 'storage-self-test-summary', passed: results.filter((item) => item.result === 'PASS').length, total: results.length, results }));
if (results.some((item) => item.result === 'FAIL')) process.exit(1);
