import { ensureNextVolume, provisioningEnabled, verifyProvisioningAccess } from './provisioner.mjs';

// Provisioning mode is intentionally separate from the normal serverless entrypoint.
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await nativeFetch(...args);
  try {
    const target = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    if (target === 'https://api.resend.com/emails' && !response.ok) {
      const body = await response.clone().text().catch(() => '');
      console.error(JSON.stringify({ event: 'resend-error', status: response.status, body }));
    }
  } catch {}
  return response;
};

await import('./server.mjs');

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.REMOTE_STORAGE_TOKEN || '';
const CHECK_MS = Number(process.env.STORAGE_PROVISION_CHECK_INTERVAL_MS || 60 * 1000);
const CONFIGURED_TRIGGER_PERCENT = Number(process.env.STORAGE_PROVISION_TRIGGER_PERCENT || 82);
const RETRY_MS = Number(process.env.STORAGE_PROVISION_RETRY_INTERVAL_MS || 15 * 1000);
const FORCE_PROVISION = process.env.STORAGE_PROVISION_FORCE === 'true';
let checkRunning = false;
let retryTimer = null;
let forceConsumed = false;

async function verifyProvisioning() {
  if (!provisioningEnabled()) {
    console.log(JSON.stringify({ event: 'storage-provision-access', enabled: false }));
    return;
  }
  try {
    const result = await verifyProvisioningAccess();
    console.log(JSON.stringify({ event: 'storage-provision-access', result: 'PASS', ...result }));
  } catch (error) {
    console.error(JSON.stringify({ event: 'storage-provision-access', result: 'FAIL', error: error instanceof Error ? error.message : String(error) }));
  }
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void checkProvisioning();
  }, RETRY_MS);
  retryTimer.unref();
}

async function checkProvisioning() {
  if (!provisioningEnabled() || checkRunning) return;
  checkRunning = true;
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/storage/status`, {
      headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
    });
    if (!response.ok) throw new Error(`router status ${response.status}`);
    const status = await response.json();
    const volumes = status.volumes || [];
    const warningPercent = Number(status.warningPercent || 85);
    const triggerPercent = Math.min(warningPercent, CONFIGURED_TRIGGER_PERCENT);
    const allTrigger = volumes.length > 0 && volumes.every((item) => item.healthy && item.usagePercent >= triggerPercent);
    const forceThisCheck = FORCE_PROVISION && !forceConsumed;
    if ((!allTrigger && !forceThisCheck) || status.volumeLimitReached) return;

    console.log(JSON.stringify({
      event: 'storage-provision-trigger',
      volumes: volumes.length,
      triggerPercent,
      warningPercent,
      forced: forceThisCheck,
      usages: volumes.map((item) => ({ name: item.name, usagePercent: item.usagePercent, healthy: item.healthy })),
    }));

    const result = await ensureNextVolume(volumes.map((item) => ({ name: item.name, url: item.url })), forceThisCheck);
    if (forceThisCheck && result?.status !== 'busy') forceConsumed = true;
    console.log(JSON.stringify({ event: 'storage-provision-result', triggerPercent, forced: forceThisCheck, result }));
    if (result?.status === 'busy') scheduleRetry();
  } catch (error) {
    console.error(`Automatic storage provisioning check failed: ${error instanceof Error ? error.message : String(error)}`);
    scheduleRetry();
  } finally {
    checkRunning = false;
  }
}

setTimeout(() => void verifyProvisioning(), 5_000).unref();
setTimeout(() => void checkProvisioning(), 10_000).unref();
setInterval(() => void checkProvisioning(), CHECK_MS).unref();

// 2026-09-08: one-shot source change to provision Photo Storage 9 after the final volume slot was released.
