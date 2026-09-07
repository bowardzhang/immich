const API_URL = 'https://backboard.railway.com/graphql/v2';
const PROJECT_TOKEN = process.env.RAILWAY_PROJECT_TOKEN || '';
const API_TOKEN = process.env.RAILWAY_API_TOKEN || '';
const PROJECT_ID = process.env.RAILWAY_PROJECT_ID || '';
const ENVIRONMENT_ID = process.env.RAILWAY_ENVIRONMENT_ID || '';
const ROUTER_SERVICE_ID = process.env.RAILWAY_SERVICE_ID || '';
const REMOTE_STORAGE_TOKEN = process.env.REMOTE_STORAGE_TOKEN || '';
const REPO = process.env.STORAGE_REPO || 'bowardzhang/immich';
const BRANCH = process.env.STORAGE_REPO_BRANCH || '3.1.0-remote';
const ROOT_DIRECTORY = process.env.STORAGE_PROVISION_ROOT_DIRECTORY || '/photo-storage';
const MOUNT_PATH = process.env.STORAGE_PROVISION_MOUNT_PATH || '/photos_extern';
const MAX_VOLUMES = Number(process.env.STORAGE_MAX_VOLUMES || 10);
const AUTO_PROVISION = process.env.STORAGE_AUTO_PROVISION !== 'false';
const PROVISION_COOLDOWN_MS = Number(process.env.STORAGE_PROVISION_COOLDOWN_MS || 60 * 60 * 1000);
const DEPLOY_TIMEOUT_MS = Number(process.env.STORAGE_PROVISION_DEPLOY_TIMEOUT_MS || 5 * 60 * 1000);
const HEALTH_TIMEOUT_MS = Number(process.env.STORAGE_PROVISION_HEALTH_TIMEOUT_MS || 2 * 60 * 1000);
const RETRY_COUNT = Number(process.env.RAILWAY_API_RETRY_COUNT || 4);
let lastProvisionAt = 0;
let running = false;

function authHeaders() {
  if (PROJECT_TOKEN) return { 'Project-Access-Token': PROJECT_TOKEN };
  if (API_TOKEN) return { authorization: `Bearer ${API_TOKEN}` };
  throw new Error('RAILWAY_PROJECT_TOKEN or RAILWAY_API_TOKEN is not configured');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryableStatus(status) {
  return status === 429 || status >= 500;
}

async function gql(query, variables = {}) {
  let lastError;
  for (let attempt = 0; attempt <= RETRY_COUNT; attempt += 1) {
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && !body.errors?.length) return body.data;
      const message = body.errors?.map((error) => error.message).join('; ') || `Railway API ${response.status}`;
      lastError = new Error(message);
      if (!retryableStatus(response.status) || attempt === RETRY_COUNT) throw lastError;
      const retryAfter = Number(response.headers.get('retry-after') || 0);
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
    } catch (error) {
      lastError = error;
      if (attempt === RETRY_COUNT) throw error;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastError || new Error('Railway API request failed');
}

async function listServices() {
  const data = await gql(
    `query project($id: String!) { project(id: $id) { services { edges { node { id name } } } } }`,
    { id: PROJECT_ID },
  );
  return data.project?.services?.edges?.map((edge) => edge.node) || [];
}

async function listVolumes() {
  const data = await gql(
    `query project($id: String!) { project(id: $id) { volumes { edges { node { id name createdAt } } } } }`,
    { id: PROJECT_ID },
  );
  return data.project?.volumes?.edges?.map((edge) => edge.node) || [];
}

async function listDeployments(serviceId) {
  const data = await gql(
    `query deployments($input: DeploymentListInput!) { deployments(input: $input, first: 5) { edges { node { id status createdAt } } } }`,
    { input: { projectId: PROJECT_ID, serviceId } },
  );
  return data.deployments?.edges?.map((edge) => edge.node) || [];
}

async function createStorageService(index) {
  const name = `Photo Storage ${index}`;
  const data = await gql(
    `mutation serviceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }`,
    {
      input: {
        projectId: PROJECT_ID,
        name,
        source: { repo: REPO },
        branch: BRANCH,
        variables: {
          REMOTE_STORAGE_TOKEN,
          PORT: '8080',
        },
      },
    },
  );
  return { id: data.serviceCreate.id, name };
}

async function configureService(serviceId) {
  await gql(
    `mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }`,
    {
      serviceId,
      environmentId: ENVIRONMENT_ID,
      input: {
        rootDirectory: ROOT_DIRECTORY,
        startCommand: 'node server.mjs',
        healthcheckPath: '/health',
      },
    },
  );
  await gql(
    `mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`,
    {
      input: {
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        serviceId,
        variables: { REMOTE_STORAGE_TOKEN, PORT: '8080' },
        skipDeploys: true,
      },
    },
  );
}

async function createOrReuseVolume(serviceId, index) {
  const expectedName = `Photo Storage Volume ${index}`;
  const existing = (await listVolumes()).find((volume) => volume.name === expectedName);
  if (existing) {
    console.log(JSON.stringify({ event: 'storage-provision', action: 'reuse-volume', index, volumeId: existing.id, name: expectedName }));
    return existing;
  }

  const created = await gql(
    `mutation volumeCreate($input: VolumeCreateInput!) { volumeCreate(input: $input) { id name } }`,
    {
      input: {
        projectId: PROJECT_ID,
        serviceId,
        environmentId: ENVIRONMENT_ID,
        mountPath: MOUNT_PATH,
      },
    },
  );
  const volume = created.volumeCreate;

  await gql(
    `mutation volumeUpdate($volumeId: String!, $input: VolumeUpdateInput!) { volumeUpdate(volumeId: $volumeId, input: $input) { id name } }`,
    { volumeId: volume.id, input: { name: expectedName } },
  );

  return { ...volume, name: expectedName };
}

async function setRouterNodes(nodes) {
  await gql(
    `mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`,
    {
      input: {
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        serviceId: ROUTER_SERVICE_ID,
        variables: { STORAGE_NODES: JSON.stringify(nodes) },
        skipDeploys: true,
      },
    },
  );
}

async function deploy(serviceId) {
  const data = await gql(
    `mutation serviceInstanceDeploy($serviceId: String!, $environmentId: String!) { serviceInstanceDeploy(serviceId: $serviceId, environmentId: $environmentId) }`,
    { serviceId, environmentId: ENVIRONMENT_ID },
  );
  return data.serviceInstanceDeploy;
}

async function waitForNewDeployment(serviceId, previousLatestId) {
  const deadline = Date.now() + DEPLOY_TIMEOUT_MS;
  let lastStatus = null;
  while (Date.now() < deadline) {
    const deployments = await listDeployments(serviceId);
    const deployment = deployments.find((item) => item.id !== previousLatestId) || (!previousLatestId ? deployments[0] : null);
    if (deployment) {
      lastStatus = deployment.status;
      if (deployment.status === 'SUCCESS') return deployment;
      if (['FAILED', 'CRASHED', 'REMOVED', 'SKIPPED'].includes(deployment.status)) {
        throw new Error(`Deployment ${deployment.id} ended with ${deployment.status}`);
      }
    }
    await sleep(5000);
  }
  throw new Error(`Timed out waiting for deployment of ${serviceId}; last status=${lastStatus || 'unknown'}`);
}

async function waitForHealth(index) {
  const url = `http://photo-storage-${index}.railway.internal:8080/health`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = 'not checked';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(3000);
  }
  throw new Error(`Photo Storage ${index} healthcheck timed out: ${lastError}`);
}

export async function verifyProvisioningAccess() {
  if (!provisioningEnabled()) {
    return { enabled: false, reason: 'automatic provisioning disabled or Railway credentials/IDs missing' };
  }
  const services = await listServices();
  return {
    enabled: true,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    routerServiceId: ROUTER_SERVICE_ID,
    serviceCount: services.length,
    maxVolumes: MAX_VOLUMES,
  };
}

export async function ensureNextVolume(currentNodes, force = false) {
  if (running) return { status: 'busy' };
  if (currentNodes.length >= MAX_VOLUMES) return { status: 'limit-reached', count: currentNodes.length };
  if (!force && Date.now() - lastProvisionAt < PROVISION_COOLDOWN_MS) return { status: 'cooldown' };
  if (!provisioningEnabled()) return { status: 'disabled', reason: 'Railway provisioning credentials or IDs missing' };
  if (!REMOTE_STORAGE_TOKEN) return { status: 'disabled', reason: 'REMOTE_STORAGE_TOKEN is missing' };

  running = true;
  try {
    const index = currentNodes.length + 1;
    const serviceName = `Photo Storage ${index}`;
    const services = await listServices();
    let service = services.find((item) => item.name === serviceName);
    if (!service) {
      service = await createStorageService(index);
      console.log(JSON.stringify({ event: 'storage-provision', action: 'create-service', index, serviceId: service.id }));
    } else {
      console.log(JSON.stringify({ event: 'storage-provision', action: 'reuse-service', index, serviceId: service.id }));
    }

    await configureService(service.id);
    const volume = await createOrReuseVolume(service.id, index);
    console.log(JSON.stringify({ event: 'storage-provision', action: 'volume-ready', index, serviceId: service.id, volumeId: volume.id }));

    const before = await listDeployments(service.id);
    const previousLatestId = before[0]?.id || null;
    await deploy(service.id);
    const deployment = await waitForNewDeployment(service.id, previousLatestId);
    await waitForHealth(index);

    const nextNode = {
      name: `photo-storage-${index}`,
      url: `http://photo-storage-${index}.railway.internal:8080`,
    };
    const nodes = [...currentNodes.filter((node) => node.name !== nextNode.name), nextNode];
    await setRouterNodes(nodes);

    lastProvisionAt = Date.now();
    console.log(
      JSON.stringify({
        event: 'storage-provision',
        result: 'CREATED',
        index,
        serviceId: service.id,
        volumeId: volume.id,
        deploymentId: deployment.id,
        node: nextNode.name,
      }),
    );

    await deploy(ROUTER_SERVICE_ID);
    return { status: 'created', index, serviceId: service.id, volumeId: volume.id, node: nextNode };
  } finally {
    running = false;
  }
}

export function provisioningEnabled() {
  return Boolean(AUTO_PROVISION && (PROJECT_TOKEN || API_TOKEN) && PROJECT_ID && ENVIRONMENT_ID && ROUTER_SERVICE_ID);
}
