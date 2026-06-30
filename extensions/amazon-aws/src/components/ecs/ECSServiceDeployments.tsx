import { Service } from "@aws-sdk/client-ecs";
import { Action, ActionPanel, Color, Icon, List } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { fetchServiceDeployments, getServiceUrl } from "../../actions";
import { rolloutStateColor } from "../../util";
import { AwsAction } from "../common/action";

function ECSServiceDeployments({ service }: { service: Service }) {
  const {
    data: deployments,
    isLoading,
    revalidate,
  } = useCachedPromise(fetchServiceDeployments, [service.clusterArn || "", service.serviceName || ""], {
    keepPreviousData: true,
  });

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={true}
      navigationTitle={`Deployments · ${service.serviceName}`}
      searchBarPlaceholder="Filter deployments by task definition"
    >
      {deployments && deployments.length > 0 ? (
        deployments.map((deployment) => {
          const version = deployment.taskDefinition?.split("/").pop() || deployment.id || "";

          return (
            <List.Item
              key={deployment.id}
              title={version}
              icon={{ source: Icon.Box, tintColor: rolloutStateColor(deployment.rolloutState) }}
              accessories={[
                {
                  tag: {
                    value: deployment.status || "",
                    color: deployment.status === "PRIMARY" ? Color.Blue : Color.SecondaryText,
                  },
                },
                {
                  text: `${deployment.runningCount}/${deployment.desiredCount}`,
                  tooltip: "Running / Desired",
                  icon: Icon.Play,
                },
              ]}
              detail={
                <List.Item.Detail
                  metadata={
                    <List.Item.Detail.Metadata>
                      <List.Item.Detail.Metadata.Label title="Task Definition" text={version} />
                      <List.Item.Detail.Metadata.TagList title="Rollout State">
                        <List.Item.Detail.Metadata.TagList.Item
                          text={deployment.rolloutState || "—"}
                          color={rolloutStateColor(deployment.rolloutState)}
                        />
                      </List.Item.Detail.Metadata.TagList>
                      <List.Item.Detail.Metadata.Label title="Status" text={deployment.status || "—"} />
                      <List.Item.Detail.Metadata.Separator />
                      <List.Item.Detail.Metadata.Label title="Desired" text={`${deployment.desiredCount}`} />
                      <List.Item.Detail.Metadata.Label title="Running" text={`${deployment.runningCount}`} />
                      <List.Item.Detail.Metadata.Label title="Pending" text={`${deployment.pendingCount}`} />
                      <List.Item.Detail.Metadata.Label title="Failed Tasks" text={`${deployment.failedTasks ?? 0}`} />
                      {deployment.rolloutStateReason ? (
                        <List.Item.Detail.Metadata.Label title="Reason" text={deployment.rolloutStateReason} />
                      ) : null}
                      <List.Item.Detail.Metadata.Separator />
                      <List.Item.Detail.Metadata.Label title="Created" text={deployment.createdAt?.toLocaleString()} />
                      <List.Item.Detail.Metadata.Label title="Updated" text={deployment.updatedAt?.toLocaleString()} />
                    </List.Item.Detail.Metadata>
                  }
                />
              }
              actions={
                <ActionPanel>
                  <Action icon={Icon.ArrowClockwise} title="Refresh" onAction={() => revalidate()} />
                  <AwsAction.Console url={getServiceUrl(service)} />
                  <Action.CopyToClipboard
                    title="Copy Task Definition ARN"
                    content={deployment.taskDefinition || ""}
                    shortcut={{ modifiers: ["opt"], key: "c" }}
                  />
                </ActionPanel>
              }
            />
          );
        })
      ) : (
        <List.EmptyView title="No Deployments Found" />
      )}
    </List>
  );
}

export default ECSServiceDeployments;
