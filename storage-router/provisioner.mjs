const API_URL = 'https://backboard.railway.com/graphql/v2';
const TOKEN = process.env.RAILWAY_API_TOKEN || '';
const PROJECT_ID = process.env.RAILWAY_PROJECT_ID || '';
const ENVIRONMENT_ID = process.env.RAILWAY_ENVIRONMENT_ID || '';
const ROUTER_SERVICE_ID = process.env.RAILWAY_SERVICE_ID || '';
const REPO = process.env.STORAGE_REPO || 'bowardzhang/immich';
const BRANCH = process.env.STORAGE_REPO_BRANCH || '3.1.0-remote';
const MOUNT_PATH = '/photos_extern';
const MAX_VOLUMES = Number(process.env.STORAGE_MAX_VOLUMES || 10);
const PROVISION_COOLDOWN_MS = Number(process.env.STORAGE_PROVISION_COOLDOWN_MS || 60 * 60 * 1000);
let lastProvisionAt = 0;
let running = false;

async function gql(query, variables = {}) {
  if (!TOKEN) throw new Error('RAILWAY_API_TOKEN is not configured; automatic provisioning is disabled');
  const response = await fetch(API_URL, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  const body = await response.json();
  if (!response.ok || body.errors?.length) throw new Error(body.errors?.map((e) => e.message).join('; ') || `Railway API ${response.status}`);
  return body.data;
}

async function listServices() {
  const data = await gql(`query project($id: String!) { project(id: $id) { services { edges { node { id name } } } } }`, { id: PROJECT_ID });
  return data.project?.services?.edges?.map((edge) => edge.node) || [];
}

async function createStorageService(index) {
  const name = `Photo Storage ${index}`;
  const data = await gql(`mutation serviceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }`, { input: { projectId: PROJECT_ID, name, source: { repo: REPO, branch: BRANCH } } });
  return data.serviceCreate;
}

async function configureService(serviceId, index) {
  await gql(`mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }`, { serviceId, environmentId: ENVIRONMENT_ID, input: { rootDirectory: '/photo-storage', startCommand: 'node server.mjs', healthcheckPath: '/health', restartPolicyType: 'ALWAYS' } });
  await gql(`mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`, { input: { projectId: PROJECT_ID, environmentId: ENVIRONMENT_ID, serviceId, variables: { REMOTE_STORAGE_TOKEN: '${{Photo Storage 1.REMOTE_STORAGE_TOKEN}}' } } });
}

async function createVolume(serviceId, index) {
  const data = await gql(`mutation volumeCreate($input: VolumeCreateInput!) { volumeCreate(input: $input) { id name } }`, { input: { projectId: PROJECT_ID, serviceId, mountPath: MOUNT_PATH, name: `Photo Storage Volume ${index}` } });
  return data.volumeCreate;
}

async function setRouterNodes(nodes) {
  await gql(`mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`, { input: { projectId: PROJECT_ID, environmentId: ENVIRONMENT_ID, serviceId: ROUTER_SERVICE_ID, variables: { STORAGE_NODES: JSON.stringify(nodes) } } });
}

async function deploy(serviceId) {
  await gql(`mutation serviceInstanceDeploy($serviceId: String!, $environmentId: String!) { serviceInstanceDeploy(serviceId: $serviceId, environmentId: $environmentId) }`, { serviceId, environmentId: ENVIRONMENT_ID });
}

export async function ensureNextVolume(currentNodes, force = false) {
  if (running) return { status: 'busy' };
  if (currentNodes.length >= MAX_VOLUMES) return { status: 'limit-reached', count: currentNodes.length };
  if (!force && Date.now() - lastProvisionAt < PROVISION_COOLDOWN_MS) return { status: 'cooldown' };
  if (!TOKEN) return { status: 'disabled', reason: 'RAILWAY_API_TOKEN missing' };
  running = true;
  try {
    const index = currentNodes.length + 1;
    const services = await listServices();
    let service = services.find((item) => item.name === `Photo Storage ${index}`);
    if (!service) service = await createStorageService(index);
    await configureService(service.id, index);
    await createVolume(service.id, index);
    await deploy(service.id);
    const nextNode = { name: `photo-storage-${index}`, url: `http://photo-storage-${index}.railway.internal:8080` };
    const nodes = [...currentNodes, nextNode];
    await setRouterNodes(nodes);
    await deploy(ROUTER_SERVICE_ID);
    lastProvisionAt = Date.now();
    console.log(JSON.stringify({ event: 'storage-provision', result: 'CREATED', index, serviceId: service.id, node: nextNode.name }));
    return { status: 'created', index, serviceId: service.id, node: nextNode };
  } finally { running = false; }
}

export function provisioningEnabled() { return Boolean(TOKEN && PROJECT_ID && ENVIRONMENT_ID && ROUTER_SERVICE_ID); }
