import './server.mjs';
import { ensureNextVolume, provisioningEnabled, verifyProvisioningAccess } from './provisioner.mjs';

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.REMOTE_STORAGE_TOKEN || '';
const CHECK_MS = Number(process.env.STORAGE_PROVISION_CHECK_INTERVAL_MS || 5 * 60 * 1000);

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

async function checkProvisioning() {
  if (!provisioningEnabled()) return;
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/storage/status`, {
      headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
    });
    if (!response.ok) throw new Error(`router status ${response.status}`);
    const status = await response.json();
    const volumes = status.volumes || [];
    const allWarning = volumes.length > 0 && volumes.every((item) => item.healthy && item.usagePercent >= status.warningPercent);
    if (!allWarning || status.volumeLimitReached) return;
    console.log(JSON.stringify({ event: 'storage-provision-trigger', volumes: volumes.length, warningPercent: status.warningPercent }));
    await ensureNextVolume(volumes.map((item) => ({ name: item.name, url: item.url })));
  } catch (error) {
    console.error(`Automatic storage provisioning check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

setTimeout(() => void verifyProvisioning(), 5_000).unref();
setTimeout(() => void checkProvisioning(), 15_000).unref();
setInterval(() => void checkProvisioning(), CHECK_MS).unref();
