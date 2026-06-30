import {
  Color,
  Icon,
  LaunchType,
  MenuBarExtra,
  captureException,
  getPreferenceValues,
  launchCommand,
  open,
  updateCommandMetadata,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useEffect, useRef } from "react";
import { fetchActiveDeployments, getServiceTasksConsoleUrl } from "./actions";
import { notifyRolloutChanges } from "./util/ecs-notifications";

interface Preferences {
  profile?: string;
  region?: string;
  cluster?: string;
}

const preferences = getPreferenceValues<Preferences>();

export default function Command() {
  const {
    data: deployments = [],
    isLoading,
    revalidate,
  } = useCachedPromise(fetchActiveDeployments, [preferences.profile, preferences.region, preferences.cluster], {
    keepPreviousData: true,
  });

  const isInProgress = deployments.some((deployment) => deployment.rolloutState === "IN_PROGRESS");

  // While a rollout is in progress and the user has the menu open (the command stays
  // loaded), refresh every 10 seconds for live progress. When the menu is closed the
  // command unloads and the manifest `interval` (1 minute) drives the background refresh.
  useEffect(() => {
    if (!isInProgress) return;

    const id = setInterval(revalidate, 10_000);
    return () => clearInterval(id);
  }, [isInProgress, revalidate]);

  useEffect(() => {
    if (!isLoading) {
      updateCommandMetadata({ subtitle: deployments.length ? `${deployments.length} rolling out` : null });
    }
  }, [isLoading, deployments.length]);

  // Diff the latest poll against the persisted snapshot and fire notifications for rollout
  // lifecycle transitions and failed tasks. Guard on a signature so the same data rendered
  // twice (e.g. keepPreviousData) does not reconcile — and notify — more than once.
  const lastSignature = useRef<string | null>(null);
  useEffect(() => {
    if (isLoading) return;

    const signature = deployments
      .map((d) => `${d.profile}:${d.serviceArn}:${d.rolloutState}:${d.failedTasks}`)
      .sort()
      .join("|");
    if (signature === lastSignature.current) return;
    lastSignature.current = signature;

    notifyRolloutChanges(deployments).catch(captureException);
  }, [isLoading, deployments]);

  if (!isLoading && deployments.length === 0) {
    return null;
  }

  const hasFailed = deployments.some((deployment) => deployment.rolloutState === "FAILED");
  const showProfile = new Set(deployments.map((deployment) => deployment.profile)).size > 1;
  const openEcs = () => launchCommand({ name: "ecs", type: LaunchType.UserInitiated });

  // Show the rolling-out service name in the menu bar instead of a bare count. With more than
  // one, show the first and a "+N" suffix so the title stays short.
  const serviceNames = deployments.map((deployment) => deployment.serviceName);
  const title =
    serviceNames.length === 0
      ? undefined
      : serviceNames.length === 1
        ? serviceNames[0]
        : `${serviceNames[0]} +${serviceNames.length - 1}`;

  return (
    <MenuBarExtra
      isLoading={isLoading}
      icon={hasFailed ? { source: "aws-logo.png", tintColor: Color.Red } : "aws-logo.png"}
      title={title}
      tooltip="ECS deployments rolling out"
    >
      <MenuBarExtra.Section title="Rolling Out">
        {deployments.map((deployment) => (
          <MenuBarExtra.Item
            key={`${deployment.profile}:${deployment.serviceArn}`}
            title={`${deployment.clusterName} / ${deployment.serviceName}`}
            subtitle={[
              showProfile ? deployment.profile : undefined,
              deployment.taskDefinition,
              `${deployment.runningCount}/${deployment.desiredCount}`,
              deployment.rolloutState,
            ]
              .filter(Boolean)
              .join(" · ")}
            icon={{ source: Icon.Box, tintColor: deployment.rolloutState === "FAILED" ? Color.Red : Color.Blue }}
            tooltip="Open service tasks in the AWS Console (⌥ to open in Raycast)"
            onAction={() =>
              open(getServiceTasksConsoleUrl(deployment.clusterName, deployment.serviceName, deployment.region))
            }
            alternate={
              <MenuBarExtra.Item
                title={`${deployment.clusterName} / ${deployment.serviceName}`}
                subtitle="Open in Raycast"
                icon={Icon.AppWindow}
                onAction={openEcs}
              />
            }
          />
        ))}
      </MenuBarExtra.Section>
      <MenuBarExtra.Section>
        <MenuBarExtra.Item title="Open ECS Clusters" icon={Icon.AppWindowList} onAction={openEcs} />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
