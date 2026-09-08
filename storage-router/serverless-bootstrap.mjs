// Railway Serverless entry point for the fixed Photo Storage pool.
//
// Keep the Router request-driven so Railway can sleep it when idle.
// Apply narrow runtime compatibility/performance patches before loading server.mjs:
// 1) undici fetch() Response headers are immutable, so route diagnostics must be
//    merged into the outgoing Node response instead of mutating upstream.headers.
// 2) a transient HEAD/network failure on a sleeping indexed Photo Storage node
//    must not delete a correct persistent index entry. Only an explicit 404 may
//    invalidate the index.
// 3) GET/Range reads with a persistent index hit go straight to the indexed node
//    instead of doing HEAD + GET.
// 4) concurrent reads targeting the same cold node share one wake flight. The
//    first real read is the leader; followers wait for its response headers and
//    then continue. Recently-responsive nodes are cached as awake for four minutes.

import { readFile, writeFile } from 'node:fs/promises';

const nativeSetInterval = globalThis.setInterval;
const nativeSetTimeout = globalThis.setTimeout;

const monitorIntervalMs = Number(process.env.STORAGE_CHECK_INTERVAL_MS || 15 * 60 * 1000);
const selfTestDelayMs = Number(process.env.STORAGE_SELF_TEST_DELAY_MS || 30 * 1000);

function disabledTimer(kind, delay) {
  console.log(JSON.stringify({
    event: 'storage-serverless-background-task-disabled',
    kind,
    delayMs: delay,
  }));

  return {
    ref() { return this; },
    unref() { return this; },
    hasRef() { return false; },
    refresh() { return this; },
    [Symbol.toPrimitive]() { return 0; },
  };
}

globalThis.setInterval = function serverlessSetInterval(callback, delay, ...args) {
  const ms = Number(delay);
  if (Number.isFinite(ms) && ms === monitorIntervalMs) {
    return disabledTimer('storage-monitor', ms);
  }
  return nativeSetInterval(callback, delay, ...args);
};

globalThis.setTimeout = function serverlessSetTimeout(callback, delay, ...args) {
  const ms = Number(delay);
  if (Number.isFinite(ms) && ms === selfTestDelayMs) {
    return disabledTimer('storage-self-test', ms);
  }
  return nativeSetTimeout(callback, delay, ...args);
};

const sourceUrl = new URL('./server.mjs', import.meta.url);
const runtimeUrl = new URL('./server-runtime.mjs', import.meta.url);
let source = await readFile(sourceUrl, 'utf8');

const oldProxy = `async function proxyResponse(res, upstream) {\n  res.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));`;
const newProxy = `async function proxyResponse(res, upstream, extraHeaders = {}) {\n  res.writeHead(upstream.status, { ...Object.fromEntries(upstream.headers.entries()), ...extraHeaders });`;
const oldRoute = `      if (found.via === 'basename' || found.path !== relative) upstream.headers.set('x-storage-resolved-path', found.path);\n      upstream.headers.set('x-storage-route', found.via);\n      upstream.headers.set('x-storage-node', found.node.name);\n      return proxyResponse(res, upstream);`;
const newRoute = `      const routeHeaders = {\n        'x-storage-route': found.via,\n        'x-storage-node': found.node.name,\n        ...((found.via === 'basename' || found.path !== relative) ? { 'x-storage-resolved-path': found.path } : {}),\n      };\n      return proxyResponse(res, upstream, routeHeaders);`;

const oldIndexedProbe = `  const indexed = await indexLookup(relative);\n  if (indexed) {\n    try {\n      const response = await headOnNode(indexed.node, indexed.path);\n      if (response) {\n        pathCache.set(relative, indexed);\n        return { node: indexed.node, response, path: indexed.path, via: 'persistent-index' };\n      }\n    } catch {}\n    await indexDelete(relative);\n  }`;
const newIndexedProbe = `  const indexed = await indexLookup(relative);\n  if (indexed) {\n    try {\n      const response = await nodeFetch(indexed.node, \`/api/file?path=\${encodeURIComponent(indexed.path)}\`, { method: 'HEAD' }, 1);\n      if (response.ok) {\n        pathCache.set(relative, indexed);\n        return { node: indexed.node, response, path: indexed.path, via: 'persistent-index' };\n      }\n      if (response.status === 404) {\n        await indexDelete(relative);\n      } else {\n        console.warn(JSON.stringify({ event: 'storage-index-probe-deferred', path: relative, node: indexed.node.name, status: response.status }));\n        pathCache.set(relative, indexed);\n        return { node: indexed.node, response, path: indexed.path, via: 'persistent-index-unverified' };\n      }\n    } catch (error) {\n      console.warn(JSON.stringify({ event: 'storage-index-probe-deferred', path: relative, node: indexed.node.name, error: error instanceof Error ? error.message : String(error) }));\n      pathCache.set(relative, indexed);\n      return { node: indexed.node, response: new Response(null, { status: 200 }), path: indexed.path, via: 'persistent-index-unverified' };\n    }\n  }`;

const oldIndexFetchStart = `async function indexFetch(pathname, init = {}) {`;
const newIndexFetchStart = `const NODE_AWAKE_CACHE_MS = Number(process.env.STORAGE_NODE_AWAKE_CACHE_MS || 4 * 60 * 1000);\nconst nodeAwakeUntil = new Map();\nconst nodeWakeFlights = new Map();\n\nfunction markNodeAwake(node) {\n  nodeAwakeUntil.set(node.name, Date.now() + NODE_AWAKE_CACHE_MS);\n}\n\nasync function coordinatedNodeRead(node, pathname, init = {}) {\n  const awakeUntil = nodeAwakeUntil.get(node.name) || 0;\n  if (awakeUntil > Date.now()) {\n    try {\n      const response = await nodeFetch(node, pathname, init, 0);\n      markNodeAwake(node);\n      return response;\n    } catch (error) {\n      nodeAwakeUntil.delete(node.name);\n      console.warn(JSON.stringify({ event: 'storage-node-awake-cache-miss', node: node.name, error: error instanceof Error ? error.message : String(error) }));\n    }\n  }\n\n  const existingWake = nodeWakeFlights.get(node.name);\n  if (existingWake) {\n    console.log(JSON.stringify({ event: 'storage-node-wake-join', node: node.name }));\n    const ready = await existingWake;\n    if (!ready) {\n      await sleep(50);\n      return coordinatedNodeRead(node, pathname, init);\n    }\n    const response = await nodeFetch(node, pathname, init, 1);\n    markNodeAwake(node);\n    return response;\n  }\n\n  let settleWake;\n  const wakeFlight = new Promise((resolve) => { settleWake = resolve; });\n  nodeWakeFlights.set(node.name, wakeFlight);\n  const startedAt = Date.now();\n  console.log(JSON.stringify({ event: 'storage-node-wake-leader', node: node.name }));\n\n  try {\n    const response = await nodeFetch(node, pathname, init, 4);\n    markNodeAwake(node);\n    settleWake(true);\n    console.log(JSON.stringify({ event: 'storage-node-wake-ready', node: node.name, durationMs: Date.now() - startedAt, status: response.status }));\n    return response;\n  } catch (error) {\n    settleWake(false);\n    console.warn(JSON.stringify({ event: 'storage-node-wake-failed', node: node.name, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) }));\n    throw error;\n  } finally {\n    if (nodeWakeFlights.get(node.name) === wakeFlight) nodeWakeFlights.delete(node.name);\n  }\n}\n\nasync function indexFetch(pathname, init = {}) {`;

const oldReadBlock = `    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/file') {\n      const found = await findReadableFile(relative);\n      if (!found) return json(res, 404, { error: 'File not found' });\n      const upstream = await nodeFetch(found.node, \`/api/file?path=\${encodeURIComponent(found.path)}\`, { method: req.method, headers: req.headers.range ? { range: req.headers.range } : {} }, 1);\n      if (found.via === 'basename' || found.path !== relative) upstream.headers.set('x-storage-resolved-path', found.path);\n      upstream.headers.set('x-storage-route', found.via);\n      upstream.headers.set('x-storage-node', found.node.name);\n      return proxyResponse(res, upstream);\n    }`;
const newReadBlock = `    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/file') {\n      const indexedDirect = pathCache.get(relative) || await indexLookup(relative);\n      if (indexedDirect) {\n        try {\n          const directUpstream = await coordinatedNodeRead(indexedDirect.node, \`/api/file?path=\${encodeURIComponent(indexedDirect.path)}\`, { method: req.method, headers: req.headers.range ? { range: req.headers.range } : {} });\n          if (directUpstream.status !== 404) {\n            pathCache.set(relative, indexedDirect);\n            return proxyResponse(res, directUpstream, {\n              'x-storage-route': 'persistent-index-direct',\n              'x-storage-node': indexedDirect.node.name,\n              ...(indexedDirect.path !== relative ? { 'x-storage-resolved-path': indexedDirect.path } : {}),\n            });\n          }\n          pathCache.delete(relative);\n          await indexDelete(relative);\n        } catch (error) {\n          console.warn(JSON.stringify({ event: 'storage-index-direct-read-failed', path: relative, node: indexedDirect.node.name, error: error instanceof Error ? error.message : String(error) }));\n        }\n      }\n\n      const found = await findReadableFile(relative);\n      if (!found) return json(res, 404, { error: 'File not found' });\n      const upstream = await coordinatedNodeRead(found.node, \`/api/file?path=\${encodeURIComponent(found.path)}\`, { method: req.method, headers: req.headers.range ? { range: req.headers.range } : {} });\n      const routeHeaders = {\n        'x-storage-route': found.via,\n        'x-storage-node': found.node.name,\n        ...((found.via === 'basename' || found.path !== relative) ? { 'x-storage-resolved-path': found.path } : {}),\n      };\n      return proxyResponse(res, upstream, routeHeaders);\n    }`;

if (!source.includes(oldProxy) || !source.includes(oldIndexedProbe) || !source.includes(oldIndexFetchStart) || !source.includes(oldReadBlock)) {
  throw new Error('Storage Router runtime compatibility patch no longer matches server.mjs');
}
source = source
  .replace(oldProxy, newProxy)
  .replace(oldIndexedProbe, newIndexedProbe)
  .replace(oldIndexFetchStart, newIndexFetchStart)
  .replace(oldReadBlock, newReadBlock);
await writeFile(runtimeUrl, source, 'utf8');

console.log(JSON.stringify({ event: 'storage-router-response-header-patch', applied: true }));
console.log(JSON.stringify({ event: 'storage-router-persistent-index-probe-patch', applied: true, deleteOnlyOnExplicit404: true }));
console.log(JSON.stringify({ event: 'storage-router-direct-index-read-patch', applied: true, headPreflight: false, coldStartRetries: 4 }));
console.log(JSON.stringify({ event: 'storage-router-singleflight-wake-patch', applied: true, awakeCacheMs: 4 * 60 * 1000, leaderUsesRealRead: true }));
await import('./server-runtime.mjs');

console.log(JSON.stringify({
  event: 'storage-router-mode',
  mode: 'serverless-request-driven',
  fixedNodePool: true,
  automaticProvisioning: false,
  periodicStorageMonitor: false,
  backgroundSelfTest: false,
}));
