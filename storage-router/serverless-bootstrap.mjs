// Serverless entry point for Railway.
//
// The normal server keeps two background timers alive:
//   1. a periodic pool monitor that calls /api/storage on every Photo Storage node;
//   2. a delayed self-test that performs PUT/HEAD/GET/DELETE on every node.
//
// Those background calls wake sleeping Photo Storage services and also generate
// outbound traffic from this service, which prevents Railway Serverless from
// keeping the Router asleep.  In serverless mode we make the Router purely
// request-driven: storage nodes are contacted only while handling an actual
// Immich/API request.

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

  // server.mjs immediately calls .unref() on both timer handles.  Return a
  // timer-compatible no-op handle instead of scheduling work.
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

// Import server.mjs directly rather than bootstrap.mjs.  bootstrap.mjs contains
// automatic provisioning timers that periodically query the whole storage pool;
// with pre-provisioned volumes that is deliberately disabled in Serverless mode.
await import('./server.mjs');

console.log(JSON.stringify({
  event: 'storage-router-mode',
  mode: 'serverless-request-driven',
  automaticProvisionPolling: false,
  periodicStorageMonitor: false,
  backgroundSelfTest: false,
}));
