// Railway Serverless entry point for the fixed Photo Storage pool.
//
// Keep the Router request-driven so Railway can sleep it when idle.
// Also apply a narrow runtime compatibility patch before loading server.mjs:
// undici fetch() Response headers are immutable, so route diagnostics must be
// merged into the outgoing Node response instead of mutating upstream.headers.

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

if (!source.includes(oldProxy) || !source.includes(oldRoute)) {
  throw new Error('Storage Router response-header compatibility patch no longer matches server.mjs');
}
source = source.replace(oldProxy, newProxy).replace(oldRoute, newRoute);
await writeFile(runtimeUrl, source, 'utf8');

console.log(JSON.stringify({ event: 'storage-router-response-header-patch', applied: true }));
await import('./server-runtime.mjs');

console.log(JSON.stringify({
  event: 'storage-router-mode',
  mode: 'serverless-request-driven',
  fixedNodePool: true,
  automaticProvisioning: false,
  periodicStorageMonitor: false,
  backgroundSelfTest: false,
}));
