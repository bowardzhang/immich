const API_URL = 'https://backboard.railway.com/graphql/v2';
const PROJECT_TOKEN = process.env.RAILWAY_PROJECT_TOKEN || '';
const API_TOKEN = process.env.RAILWAY_API_TOKEN || '';
const CLEANUP_IDS = (process.env.STORAGE_CLEANUP_VOLUME_IDS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

function authHeaders() {
  if (PROJECT_TOKEN) return { 'Project-Access-Token': PROJECT_TOKEN };
  if (API_TOKEN) return { authorization: `Bearer ${API_TOKEN}` };
  throw new Error('RAILWAY_PROJECT_TOKEN or RAILWAY_API_TOKEN is not configured');
}

async function gql(query, variables = {}) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.errors?.length) {
    throw new Error(body.errors?.map((error) => error.message).join('; ') || `Railway API ${response.status}`);
  }
  return body.data;
}

for (const volumeId of CLEANUP_IDS) {
  const data = await gql(
    `mutation volumeDelete($volumeId: String!) { volumeDelete(volumeId: $volumeId) }`,
    { volumeId },
  );
  if (data.volumeDelete !== true) throw new Error(`volumeDelete(${volumeId}) returned ${String(data.volumeDelete)}`);
  console.log(JSON.stringify({ event: 'storage-maintenance', action: 'volume-deleted', volumeId }));
}

if (CLEANUP_IDS.length > 0) {
  console.log(JSON.stringify({ event: 'storage-maintenance', action: 'cleanup-complete', deleted: CLEANUP_IDS.length }));
}

await import('./serverless-bootstrap.mjs');
