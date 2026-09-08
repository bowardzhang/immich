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
const SOURCE_VERIFY_TIMEOUT_MS = Number(process.env.STORAGE_PROVISION_SOURCE_VERIFY_TIMEOUT_MS || 60 * 1000);
const RETRY_COUNT = Number(process.env.RAILWAY_API_RETRY_COUNT || 4);

let lastProvisionAt = 0;
let running = false;
let successfulAuthMode = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function authHeaderCandidates() {
  if (PROJECT_TOKEN) {
    return [{ mode: 'project-token', headers: { 'Project-Access-Token': PROJECT_TOKEN } }];
  }
  if (API_TOKEN) {
    return [
      { mode: 'api-token', headers: { authorization: `Bearer ${API_TOKEN}` } },
      { mode: 'project-token-fallback', headers: { 'Project-Access-Token': API_TOKEN } },
    ];
  }
  throw new Error('RAILWAY_PROJECT_TOKEN or RAILWAY_API_TOKEN is not configured');
}

function retryableStatus(status) {
  return status === 429 || status >= 500;
}

function isUnauthorized(status, message) {
  return status === 401 || status === 403 || /not authorized|unauthorized/i.test(message);
}

async function gql(query, variables = {}) {
  let lastError;
  const candidates = authHeaderCandidates();

  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const candidate = candidates[candidateIndex];

    for (let attempt = 0; attempt <= RETRY_COUNT; attempt += 1) {
      try {
        const response = await fetch(API_URL, {
          method: 'POST',
          headers: { ...candidate.headers, 'content-type': 'application/json' },
          body: JSON.stringify({ query, variables }),
        });
        const body = await response.json().catch(() => ({}));

        if (response.ok && !body.errors?.length) {
          successfulAuthMode = candidate.mode;
          return body.data;
        }

        const message = body.errors?.map((error) => error.message).join('; ') || `Railway API ${response.status}`;
        lastError = new Error(message);

        if (isUnauthorized(response.status, message) && candidateIndex < candidates.length - 1) break;
        if (!retryableStatus(response.status) || attempt === RETRY_COUNT) throw lastError;

        const retryAfter = Number(response.headers.get('retry-after') || 0);
        await sleep(retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
      } catch (error) {
        lastError = error;
        if (attempt === RETRY_COUNT) {
          if (candidateIndex < candidates.length - 1 && /not authorized|unauthorized/i.test(String(error?.message || error))) {
            break;
          }
          throw error;
        }
        await sleep(500 * 2 ** attempt);
      }
    }
  }

  throw lastError || new Error('Railway API request failed');
}

async function listServices() {
  const data = await gql(
    `query project($id: String!) {
      project(id: $id) { services { edges { node { id name } } } }
    }`,
    { id: PROJECT_ID },
  );
  return data.project?.services?.edges?.map((edge) => edge.node) || [];
}

async function listVolumes() {
  const data = await gql(
    `query project($id: String!) {
      project(id: $id) {
        volumes {
          edges {
            node {
              id
              name
              volumeInstances { edges { node { id serviceId environmentId mountPath } } }
            }
          }
        }
      }
    }`,
    { id: PROJECT_ID },
  );
  return data.project?.volumes?.edges?.map((edge) => edge.node) || [];
}

async function listDeployments(serviceId) {
  const data = await gql(
    `query deployments($input: DeploymentListInput!) {
      deployments(input: $input, first: 10) { edges { node { id status createdAt } } }
    }`,
    { input: { projectId: PROJECT_ID, environmentId: ENVIRONMENT_ID, serviceId } },
  );
  return data.deployments?.edges?.map((edge) => edge.node) || [];
}

async function getServiceSource(serviceId) {
  const data = await gql(
    `query serviceSource($projectId: String!, $serviceId: String!, $environmentId: String!) {
      serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
        source { repo image branch }
      }
      deploymentTriggers(
        projectId: $projectId,
        serviceId: $serviceId,
        environmentId: $environmentId,
        first: 20
      ) {
        edges { node { id repository branch } }
      }
    }`,
    { projectId: PROJECT_ID, serviceId, environmentId: ENVIRONMENT_ID },
  );

  const source = data.serviceInstance?.source || {};
  const triggers = data.deploymentTriggers?.edges?.map((edge) => edge.node) || [];
  const expectedTrigger = triggers.find((item) => item.repository === REPO && item.branch === BRANCH);
  return {
    repo: source.repo,
    sourceBranch: source.branch,
    expectedTrigger,
    triggers,
  };
}

async function configureService(serviceId) {
  await gql(
    `mutation serviceInstanceUpdate(
      $serviceId: String!,
      $environmentId: String!,
      $input: ServiceInstanceUpdateInput!
    ) {
      serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
    }`,
    {
      serviceId,
      environmentId: ENVIRONMENT_ID,
      input: {
        source: { repo: REPO },
        rootDirectory: ROOT_DIRECTORY,
        startCommand: 'node server.mjs',
        healthcheckPath: '/health',
      },
    },
  );

  await gql(
    `mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
      variableCollectionUpsert(input: $input)
    }`,
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

async function ensureDeploymentTrigger(serviceId, index) {
  await configureService(serviceId);

  let state = await getServiceSource(serviceId);
  if (state.repo === REPO && state.expectedTrigger) return state;

  console.warn(JSON.stringify({
    event: 'storage-provision',
    action: 'repair-source-trigger',
    index,
    serviceId,
    expectedRepo: REPO,
    expectedBranch: BRANCH,
    currentRepo: state.repo || null,
    currentSourceBranch: state.sourceBranch || null,
    currentTriggers: state.triggers.map((item) => ({ repository: item.repository, branch: item.branch })),
  }));

  if (!state.expectedTrigger) {
    try {
      const data = await gql(
        `mutation deploymentTriggerCreate($input: DeploymentTriggerCreateInput!) {
          deploymentTriggerCreate(input: $input) {
            id
            repository
            branch
            serviceId
            environmentId
          }
        }`,
        {
          input: {
            projectId: PROJECT_ID,
            environmentId: ENVIRONMENT_ID,
            serviceId,
            provider: 'github',
            repository: REPO,
            branch: BRANCH,
          },
        },
      );

      console.log(JSON.stringify({
        event: 'storage-provision',
        action: 'deployment-trigger-created',
        index,
        serviceId,
        triggerId: data.deploymentTriggerCreate?.id || null,
        repo: data.deploymentTriggerCreate?.repository || REPO,
        branch: data.deploymentTriggerCreate?.branch || BRANCH,
      }));
    } catch (error) {
      if (!/already|duplicate|exists/i.test(String(error?.message || error))) throw error;
      console.warn(JSON.stringify({
        event: 'storage-provision',
        action: 'deployment-trigger-already-exists',
        index,
        serviceId,
        message: String(error?.message || error),
      }));
    }
  }

  const deadline = Date.now() + SOURCE_VERIFY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    state = await getServiceSource(serviceId);
    if (state.repo === REPO && state.expectedTrigger) return state;
    await sleep(2000);
  }

  throw new Error(
    `Photo Storage ${index} source trigger is not ready: expected repo=${REPO} branch=${BRANCH}, ` +
    `got repo=${state.repo || 'missing'} sourceBranch=${state.sourceBranch || 'missing'} ` +
    `triggers=${JSON.stringify(state.triggers.map((item) => ({ repository: item.repository, branch: item.branch })))}.`,
  );
}

async function createStorageService(index) {
  const name = `Photo Storage ${index}`;
  const data = await gql(
    `mutation serviceCreate($input: ServiceCreateInput!) {
      serviceCreate(input: $input) { id name }
    }`,
    {
      input: {
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
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
  return { id: data.serviceCreate.id, name: data.serviceCreate.name || name };
}

async function createOrReuseVolume(serviceId, index) {
  const volumes = await listVolumes();
  const attached = volumes.find((volume) =>
    volume.volumeInstances?.edges?.some(
      (edge) => edge.node?.serviceId === serviceId && edge.node?.environmentId === ENVIRONMENT_ID,
    ),
  );

  if (attached) {
    console.log(JSON.stringify({
      event: 'storage-provision',
      action: 'reuse-attached-volume',
      index,
      serviceId,
      volumeId: attached.id,
      name: attached.name,
    }));
    return attached;
  }

  const data = await gql(
    `mutation volumeCreate($input: VolumeCreateInput!) {
      volumeCreate(input: $input) { id name }
    }`,
    {
      input: {
        projectId: PROJECT_ID,
        serviceId,
        environmentId: ENVIRONMENT_ID,
        mountPath: MOUNT_PATH,
      },
    },
  );

  return data.volumeCreate;
}

async function triggerInitialDeployment(serviceId, index) {
  const before = await listDeployments(serviceId);
  const previousIds = new Set(before.map((item) => item.id));

  const data = await gql(
    `mutation environmentTriggersDeploy($input: EnvironmentTriggersDeployInput!) {
      environmentTriggersDeploy(input: $input)
    }`,
    {
      input: {
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        serviceId,
      },
    },
  );

  if (data.environmentTriggersDeploy !== true) {
    throw new Error(`environmentTriggersDeploy returned ${String(data.environmentTriggersDeploy)}`);
  }

  console.log(JSON.stringify({
    event: 'storage-provision',
    action: 'initial-deploy-triggered',
    index,
    serviceId,
  }));

  const deadline = Date.now() + DEPLOY_TIMEOUT_MS;
  let lastStatus = 'NONE';

  while (Date.now() < deadline) {
    const deployments = await listDeployments(serviceId);
    const deployment =
      deployments.find((item) => !previousIds.has(item.id)) ||
      (before.length === 0 ? deployments[0] : null);

    if (deployment) {
      lastStatus = deployment.status;
      if (deployment.status === 'SUCCESS') return deployment;
      if (['FAILED', 'CRASHED', 'REMOVED', 'SKIPPED'].includes(deployment.status)) {
        throw new Error(`Deployment ${deployment.id} ended with ${deployment.status}`);
      }
    }

    await sleep(5000);
  }

  throw new Error(`Timed out waiting for initial deployment of ${serviceId}; last status=${lastStatus}`);
}

async function redeployExistingService(serviceId) {
  const data = await gql(
    `mutation serviceInstanceDeploy($serviceId: String!, $environmentId: String!) {
      serviceInstanceDeploy(serviceId: $serviceId, environmentId: $environmentId)
    }`,
    { serviceId, environmentId: ENVIRONMENT_ID },
  );
  return data.serviceInstanceDeploy;
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

async function setRouterNodes(nodes) {
  await gql(
    `mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
      variableCollectionUpsert(input: $input)
    }`,
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

export function provisioningEnabled() {
  return Boolean(
    AUTO_PROVISION &&
    (PROJECT_TOKEN || API_TOKEN) &&
    PROJECT_ID &&
    ENVIRONMENT_ID &&
    ROUTER_SERVICE_ID,
  );
}

export async function verifyProvisioningAccess() {
  if (!provisioningEnabled()) {
    return { enabled: false, reason: 'automatic provisioning disabled or Railway credentials/IDs missing' };
  }

  const services = await listServices();
  return {
    enabled: true,
    authMode: successfulAuthMode,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    routerServiceId: ROUTER_SERVICE_ID,
    serviceCount: services.length,
    maxVolumes: MAX_VOLUMES,
    repo: REPO,
    branch: BRANCH,
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
      console.log(JSON.stringify({
        event: 'storage-provision',
        action: 'create-service',
        index,
        serviceId: service.id,
      }));
    } else {
      console.log(JSON.stringify({
        event: 'storage-provision',
        action: 'recover-existing-service',
        index,
        serviceId: service.id,
      }));
    }

    const source = await ensureDeploymentTrigger(service.id, index);
    console.log(JSON.stringify({
      event: 'storage-provision',
      action: 'source-verified',
      index,
      serviceId: service.id,
      repo: source.repo,
      branch: BRANCH,
      triggerId: source.expectedTrigger?.id || null,
    }));

    const volume = await createOrReuseVolume(service.id, index);
    console.log(JSON.stringify({
      event: 'storage-provision',
      action: 'volume-ready',
      index,
      serviceId: service.id,
      volumeId: volume.id,
    }));

    const deployments = await listDeployments(service.id);
    let deployment;

    if (deployments.length === 0) {
      deployment = await triggerInitialDeployment(service.id, index);
    } else {
      const previousLatestId = deployments[0]?.id;
      await redeployExistingService(service.id);

      const deadline = Date.now() + DEPLOY_TIMEOUT_MS;
      let lastStatus = 'NONE';
      while (Date.now() < deadline) {
        const next = await listDeployments(service.id);
        const candidate = next.find((item) => item.id !== previousLatestId);
        if (candidate) {
          lastStatus = candidate.status;
          if (candidate.status === 'SUCCESS') {
            deployment = candidate;
            break;
          }
          if (['FAILED', 'CRASHED', 'REMOVED', 'SKIPPED'].includes(candidate.status)) {
            throw new Error(`Deployment ${candidate.id} ended with ${candidate.status}`);
          }
        }
        await sleep(5000);
      }
      if (!deployment) throw new Error(`Timed out waiting for redeployment of ${service.id}; last status=${lastStatus}`);
    }

    await waitForHealth(index);

    const nextNode = {
      name: `photo-storage-${index}`,
      url: `http://photo-storage-${index}.railway.internal:8080`,
    };
    const nodes = [...currentNodes.filter((node) => node.name !== nextNode.name), nextNode];
    await setRouterNodes(nodes);

    lastProvisionAt = Date.now();

    console.log(JSON.stringify({
      event: 'storage-provision',
      result: 'CREATED',
      index,
      serviceId: service.id,
      volumeId: volume.id,
      deploymentId: deployment.id,
      node: nextNode.name,
    }));

    await redeployExistingService(ROUTER_SERVICE_ID);

    return {
      status: 'created',
      index,
      serviceId: service.id,
      volumeId: volume.id,
      node: nextNode,
    };
  } finally {
    running = false;
  }
}
