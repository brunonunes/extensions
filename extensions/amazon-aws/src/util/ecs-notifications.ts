import { LocalStorage, captureException } from "@raycast/api";
import { runAppleScript } from "@raycast/utils";
import type { ActiveDeployment } from "../actions/ecs";

const STORAGE_KEY = "ecs-deployment-snapshots";

type Snapshot = {
  serviceName: string;
  taskDefinition: string;
  rolloutState: string;
  failedTasks: number;
};

type SnapshotMap = Record<string, Snapshot>;

// Menu-bar commands run in the background on the manifest `interval`, so this is where we
// detect rollout lifecycle transitions. Each run is a fresh process; we persist the last
// observed state per service in LocalStorage and diff against it to decide what to notify.
export async function notifyRolloutChanges(current: ActiveDeployment[]): Promise<void> {
  const raw = await LocalStorage.getItem<string>(STORAGE_KEY);
  const previous: SnapshotMap = raw ? safeParse(raw) : {};
  const next: SnapshotMap = {};
  const messages: { title: string; body: string }[] = [];

  for (const deployment of current) {
    const key = `${deployment.profile}:${deployment.serviceArn}`;
    const prev = previous[key];
    const title = deployment.serviceName;

    // A service we have never seen that is already rolling out -> rollout started.
    if (!prev && deployment.rolloutState === "IN_PROGRESS") {
      messages.push({ title, body: `Rollout iniciado · ${deployment.taskDefinition}` });
    }

    // The rollout reached a terminal state while still visible in the list.
    if (prev && prev.rolloutState === "IN_PROGRESS" && deployment.rolloutState === "COMPLETED") {
      messages.push({ title, body: `Rollout concluído · ${deployment.taskDefinition}` });
    }
    if (prev && prev.rolloutState !== "FAILED" && deployment.rolloutState === "FAILED") {
      messages.push({
        title,
        body: deployment.rolloutStateReason ? `Rollout falhou · ${deployment.rolloutStateReason}` : "Rollout falhou",
      });
    }

    // Notify on every newly failed task, including each retry. ECS only increments this
    // counter, so we emit one message per attempt that appeared since the last poll, framed
    // against the circuit-breaker threshold that triggers an automatic rollback.
    if (prev && deployment.failedTasks > prev.failedTasks) {
      const limit = circuitBreakerThreshold(deployment.desiredCount);
      for (let attempt = prev.failedTasks + 1; attempt <= deployment.failedTasks; attempt++) {
        messages.push({ title, body: `Erro no rollout. Tentativa ${attempt} de ${limit}.` });
      }
    }

    next[key] = {
      serviceName: deployment.serviceName,
      taskDefinition: deployment.taskDefinition,
      rolloutState: deployment.rolloutState,
      failedTasks: deployment.failedTasks,
    };
  }

  // A rollout that was in progress and dropped out of the list finished and drained. The
  // visible-COMPLETED path above usually fires first; this is the fallback for when the old
  // deployment drains between two polls and we never observed the COMPLETED state.
  for (const [key, prev] of Object.entries(previous)) {
    if (next[key]) continue;
    if (prev.rolloutState === "IN_PROGRESS") {
      messages.push({ title: prev.serviceName, body: `Rollout concluído · ${prev.taskDefinition}` });
    }
  }

  await LocalStorage.setItem(STORAGE_KEY, JSON.stringify(next));

  for (const message of messages) {
    await notify(message.title, message.body);
  }
}

// Amazon ECS deployment circuit breaker: it rolls back once the number of failed tasks
// reaches 0.5 * desired count, clamped to a minimum of 3 and a maximum of 200.
function circuitBreakerThreshold(desiredCount: number): number {
  return Math.min(200, Math.max(3, Math.round(0.5 * desiredCount)));
}

async function notify(title: string, body: string): Promise<void> {
  // macOS notifications are best-effort; a single failure must not drop the remaining ones or
  // leave the persisted snapshot out of sync with what the user was actually told.
  try {
    await runAppleScript(`display notification ${quote(body)} with title ${quote(title)}`);
  } catch (error) {
    captureException(error);
  }
}

// AppleScript string literals use double quotes with backslash escaping, which JSON encoding
// happens to match for the characters that appear in ARNs / service names.
function quote(value: string): string {
  return JSON.stringify(value);
}

function safeParse(raw: string): SnapshotMap {
  try {
    return JSON.parse(raw) as SnapshotMap;
  } catch {
    return {};
  }
}
