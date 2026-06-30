import {
  Cluster,
  ContainerDefinition,
  Deployment,
  DescribeClustersCommand,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  ECSClient,
  ListClustersCommand,
  ListServicesCommand,
  ListTasksCommand,
  Service,
  Task,
} from "@aws-sdk/client-ecs";
import { fromIni } from "@aws-sdk/credential-providers";
import { loadSharedConfigFiles } from "@aws-sdk/shared-ini-file-loader";
import { AWS_URL_BASE } from "../constants";
import { isReadyToFetch } from "../util";

const ecsClient = new ECSClient({});

export async function fetchClusters(): Promise<Cluster[]> {
  if (!isReadyToFetch()) return [];
  const clustersArns = await listClusterArns(ecsClient);

  const { clusters } = await ecsClient.send(new DescribeClustersCommand({ clusters: clustersArns }));
  return clusters || [];
}

export async function fetchServices(clusterArn: string): Promise<Service[]> {
  if (!isReadyToFetch()) return [];

  return describeServices(clusterArn, ecsClient);
}

async function describeServices(clusterArn: string, client: ECSClient): Promise<Service[]> {
  const servicesArns = await listServiceArns(clusterArn, client);
  const serviceChunks: string[][] = getChunks(servicesArns, 10);

  const services = await Promise.all(
    serviceChunks.map((chunk) => client.send(new DescribeServicesCommand({ cluster: clusterArn, services: chunk }))),
  );

  return services.map((entry) => entry.services || []).flat(2);
}

export async function fetchTasks(clusterArn: string, serviceName: string): Promise<Task[]> {
  if (!isReadyToFetch()) return [];

  const taskArns = await fetchTasksArns(clusterArn, serviceName);
  const taskChunks: string[][] = getChunks(taskArns, 100);

  const tasks = await Promise.all(
    taskChunks.map((chunk) => ecsClient.send(new DescribeTasksCommand({ cluster: clusterArn, tasks: chunk }))),
  );

  return tasks.map((entry) => entry.tasks || []).flat(2);
}

export async function fetchTaskContainers(taskDefArn: string): Promise<ContainerDefinition[]> {
  if (!isReadyToFetch()) return [];

  const { taskDefinition } = await ecsClient.send(new DescribeTaskDefinitionCommand({ taskDefinition: taskDefArn }));

  return taskDefinition?.containerDefinitions || [];
}

export async function fetchServiceDeployments(clusterArn: string, serviceName: string): Promise<Deployment[]> {
  if (!isReadyToFetch()) return [];

  const { services } = await ecsClient.send(
    new DescribeServicesCommand({ cluster: clusterArn, services: [serviceName] }),
  );

  return services?.[0]?.deployments || [];
}

export type ActiveDeployment = {
  profile: string;
  region: string;
  clusterName: string;
  serviceName: string;
  serviceArn: string;
  taskDefinition: string;
  rolloutState: string;
  rolloutStateReason: string;
  desiredCount: number;
  runningCount: number;
  pendingCount: number;
  failedTasks: number;
};

export async function fetchActiveDeployments(
  profilesInput?: string,
  region?: string,
  clusterArn?: string,
): Promise<ActiveDeployment[]> {
  const requested = (profilesInput || "")
    .split(/[\s,]+/)
    .map((profile) => profile.trim())
    .filter(Boolean);

  const profiles = await resolveProfiles(requested);
  const perProfile = await Promise.all(profiles.map((profile) => scanProfile(profile, region, clusterArn)));

  return perProfile.flat();
}

async function resolveProfiles(requested: string[]): Promise<{ name: string; region?: string }[]> {
  const { configFile, credentialsFile } = await loadSharedConfigFiles();
  const source = Object.keys(configFile).length > 0 ? configFile : credentialsFile;
  const available = Object.entries(source).map(([name, config]) => ({ name, region: config.region }));

  if (requested.length > 0) {
    return available.filter((profile) => requested.includes(profile.name));
  }

  return available;
}

async function scanProfile(
  profile: { name: string; region?: string },
  regionOverride: string | undefined,
  clusterArn: string | undefined,
): Promise<ActiveDeployment[]> {
  const region = regionOverride || profile.region;
  if (!region) return [];

  const client = new ECSClient({ region, credentials: fromIni({ profile: profile.name }) });

  try {
    const clusters = clusterArn ? [clusterArn] : await listClusterArns(client);
    const perCluster = await Promise.all(
      clusters.map((cluster) => collectActiveDeployments(cluster, client, profile.name, region)),
    );

    return perCluster.flat();
  } catch {
    // Profiles that are not authenticated (e.g. an expired SSO session) or cannot be
    // reached are skipped so a single bad profile never breaks the menu bar.
    return [];
  }
}

async function collectActiveDeployments(
  clusterArn: string,
  client: ECSClient,
  profileName: string,
  region: string,
): Promise<ActiveDeployment[]> {
  const services = await describeServices(clusterArn, client);

  return services
    .filter(
      (service) =>
        (service.deployments?.length || 0) > 1 ||
        !!service.deployments?.some((deployment) => deployment.rolloutState === "IN_PROGRESS"),
    )
    .map((service) => {
      const primary = service.deployments?.find((deployment) => deployment.status === "PRIMARY");
      const deployment = primary || service.deployments?.[0];

      return {
        profile: profileName,
        region,
        clusterName: (service.clusterArn || clusterArn).split("/").pop() || "",
        serviceName: service.serviceName || "",
        serviceArn: service.serviceArn || "",
        taskDefinition: deployment?.taskDefinition?.split("/").pop() || "",
        rolloutState: deployment?.rolloutState || "",
        rolloutStateReason: deployment?.rolloutStateReason || "",
        desiredCount: deployment?.desiredCount ?? service.desiredCount ?? 0,
        runningCount: deployment?.runningCount ?? service.runningCount ?? 0,
        pendingCount: deployment?.pendingCount ?? service.pendingCount ?? 0,
        failedTasks: deployment?.failedTasks ?? 0,
      };
    });
}

function getChunks(arr: string[], chunkSize: number): string[][] {
  return arr.reduce<string[][]>((acc, item, index) => {
    const chunkIndex = Math.floor(index / chunkSize);
    if (!acc[chunkIndex]) {
      acc[chunkIndex] = []; // start a new chunk
    }
    acc[chunkIndex].push(item);
    return acc;
  }, []);
}

async function listClusterArns(client: ECSClient, token?: string, accClusters?: string[]): Promise<string[]> {
  const { clusterArns, nextToken } = await client.send(new ListClustersCommand({ nextToken: token }));
  const combinedClusters = [...(accClusters || []), ...(clusterArns || [])];

  if (nextToken) {
    return listClusterArns(client, nextToken, combinedClusters);
  }

  return combinedClusters;
}

async function listServiceArns(
  clusterArn: string,
  client: ECSClient,
  token?: string,
  accServices?: string[],
): Promise<string[]> {
  const { serviceArns, nextToken } = await client.send(
    new ListServicesCommand({ cluster: clusterArn, nextToken: token }),
  );

  const combinedServices = [...(accServices || []), ...(serviceArns || [])];

  if (nextToken) {
    return listServiceArns(clusterArn, client, nextToken, combinedServices);
  }

  return combinedServices;
}

async function fetchTasksArns(
  clusterArn: string,
  serviceName: string,
  token?: string,
  accTasks?: string[],
): Promise<string[]> {
  const { taskArns, nextToken } = await ecsClient.send(
    new ListTasksCommand({ cluster: clusterArn, serviceName, nextToken: token }),
  );

  const combinedTasks = [...(accTasks || []), ...(taskArns || [])];

  if (nextToken) {
    return fetchTasksArns(clusterArn, serviceName, nextToken, combinedTasks);
  }

  return combinedTasks;
}

export function getClusterUrl(cluster: Cluster) {
  return `${AWS_URL_BASE}/ecs/home?region=${process.env.AWS_REGION}#/clusters/${cluster.clusterName}/services`;
}

export function getServiceUrl(service: Service) {
  const clusterName = service.clusterArn?.split("/").pop() || "";
  return getServiceConsoleUrl(clusterName, service.serviceName || "", process.env.AWS_REGION);
}

export function getServiceConsoleUrl(clusterName: string, serviceName: string, region?: string) {
  return `${AWS_URL_BASE}/ecs/home?region=${region}#/clusters/${clusterName}/services/${serviceName}/details`;
}

export function getServiceTasksConsoleUrl(clusterName: string, serviceName: string, region?: string) {
  return `${AWS_URL_BASE}/ecs/home?region=${region}#/clusters/${clusterName}/services/${serviceName}/tasks`;
}

export function getTaskUrl(task: Task) {
  const clusterName = task.clusterArn?.split("/").pop();
  return `${AWS_URL_BASE}/ecs/home?region=${process.env.AWS_REGION}#/clusters/${clusterName}/tasks/${task.taskArn}/details`;
}

export function getTaskContainerUrl(taskDefinitionArn: string) {
  const taskDefinitionNameVersionFragments = taskDefinitionArn.split("/").pop()?.split(":");
  const taskDefinitionName = taskDefinitionNameVersionFragments?.[0];
  const taskDefinitionVersion = taskDefinitionNameVersionFragments?.[1];
  return `${AWS_URL_BASE}/ecs/home?region=${process.env.AWS_REGION}#/taskDefinitions/${taskDefinitionName}/${taskDefinitionVersion}`;
}
