// Railway Serverless entry point for the fixed Photo Storage pool.
//
// The core router still contains optional background monitoring/self-test timers
// for non-serverless/manual operation. In production we keep the Router purely
// request-driven so it can sleep when Immich is idle and so it does not wake
// sleeping Photo Storage nodes on its own.

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

await import('./server.mjs');

console.log(JSON.stringify({
  event: 'storage-router-mode',
  mode: 'serverless-request-driven',
  fixedNodePool: true,
  automaticProvisioning: false,
  periodicStorageMonitor: false,
  backgroundSelfTest: false,
}));
