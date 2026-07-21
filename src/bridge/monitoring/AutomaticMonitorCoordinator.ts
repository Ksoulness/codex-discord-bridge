import type {
  MonitorProjectRecord,
  MonitorThreadRecord
} from "../../domain.js";
import type { BridgeProvider } from "../../providers/types.js";
import type { StateStore } from "../../store/StateStore.js";
import type { MonitorLifecycleCoordinator } from "./MonitorLifecycleCoordinator.js";
import type {
  MonitorManagementSettings,
  MonitorSelectionService
} from "./MonitorSelectionService.js";

const AUTOMATIC_MONITOR_ACTOR = "automatic-monitor";

type LifecycleActions = Pick<
  MonitorLifecycleCoordinator,
  "pauseThread" | "resumeThread" | "cleanPausedThreads"
>;

export interface AutomaticMonitorPlan {
  projectKeys: string[];
  threadIdsByProject: Map<string, string[]>;
  desiredThreadIds: Set<string>;
}

export interface AutomaticMonitorReconcileResult {
  enabled: boolean;
  changed: boolean;
  projectCount: number;
  threadCount: number;
  errors: string[];
}

export function buildAutomaticMonitorPlan(
  projects: MonitorProjectRecord[],
  threads: MonitorThreadRecord[],
  settings: Pick<MonitorManagementSettings, "projectLimit" | "threadLimit">
): AutomaticMonitorPlan {
  const projectsByKey = new Map(projects.map((project) => [project.projectKey, project]));
  const threadsByProject = new Map<string, MonitorThreadRecord[]>();
  for (const thread of threads) {
    if (!thread.available || !projectsByKey.has(thread.projectKey)) {
      continue;
    }
    const projectThreads = threadsByProject.get(thread.projectKey) ?? [];
    projectThreads.push(thread);
    threadsByProject.set(thread.projectKey, projectThreads);
  }

  const projectKeys = [...threadsByProject.entries()]
    .map(([projectKey, projectThreads]) => ({
      projectKey,
      activityAtMs: Math.max(...projectThreads.map((thread) => recencyAtMs(thread)))
    }))
    .sort((left, right) =>
      right.activityAtMs - left.activityAtMs || left.projectKey.localeCompare(right.projectKey)
    )
    .slice(0, settings.projectLimit)
    .map((entry) => entry.projectKey);

  const threadIdsByProject = new Map<string, string[]>();
  const desiredThreadIds = new Set<string>();
  for (const projectKey of projectKeys) {
    const threadIds = [...(threadsByProject.get(projectKey) ?? [])]
      .sort((left, right) =>
        recencyAtMs(right) - recencyAtMs(left) || left.threadId.localeCompare(right.threadId)
      )
      .slice(0, settings.threadLimit)
      .map((thread) => thread.threadId);
    threadIdsByProject.set(projectKey, threadIds);
    for (const threadId of threadIds) {
      desiredThreadIds.add(threadId);
    }
  }

  return { projectKeys, threadIdsByProject, desiredThreadIds };
}

export class AutomaticMonitorCoordinator {
  private operation: Promise<void> = Promise.resolve();
  private lastReorderSignature: string | null = null;

  constructor(
    private readonly store: StateStore,
    private readonly provider: BridgeProvider,
    private readonly selection: MonitorSelectionService,
    private readonly lifecycle: LifecycleActions
  ) {}

  reconcile(force = false): Promise<AutomaticMonitorReconcileResult> {
    return this.serialize(() => this.reconcileInternal(force));
  }

  private async reconcileInternal(force: boolean): Promise<AutomaticMonitorReconcileResult> {
    const settings = this.selection.getManagementSettings();
    if (settings.mode !== "automatic") {
      this.lastReorderSignature = null;
      return {
        enabled: false,
        changed: false,
        projectCount: 0,
        threadCount: 0,
        errors: []
      };
    }

    const projects = this.store.listMonitorProjects();
    const threads = this.store.listMonitorThreads();
    if (threads.length === 0) {
      return {
        enabled: true,
        changed: false,
        projectCount: 0,
        threadCount: 0,
        errors: []
      };
    }

    const plan = buildAutomaticMonitorPlan(
      projects,
      threads.filter((thread) => this.selection.isWithinConfiguredScope(thread.threadId)),
      settings
    );
    const desiredProjectKeys = new Set(plan.projectKeys);
    const errors: string[] = [];
    let changed = false;

    for (const thread of threads) {
      if (plan.desiredThreadIds.has(thread.threadId)) {
        continue;
      }
      const hasDiscordCopy = Boolean(
        thread.pausedDiscordChannelId || this.store.getThreadBridge(thread.threadId)
      );
      if (!thread.selected && !hasDiscordCopy) {
        continue;
      }
      try {
        await this.lifecycle.pauseThread(thread.threadId, AUTOMATIC_MONITOR_ACTOR);
        if (hasDiscordCopy) {
          await this.lifecycle.cleanPausedThreads([thread.threadId], AUTOMATIC_MONITOR_ACTOR);
        }
        if (!thread.available) {
          this.store.deleteMonitorThreadIfUnselected(thread.threadId);
        }
        changed = true;
      } catch (error) {
        errors.push(`${thread.threadName ?? thread.threadId}: ${errorMessage(error)}`);
      }
    }

    for (const project of projects) {
      const shouldEnable = desiredProjectKeys.has(project.projectKey);
      if (project.enabled === shouldEnable) {
        continue;
      }
      this.selection.setProjectEnabled(project.projectKey, shouldEnable, AUTOMATIC_MONITOR_ACTOR);
      changed = true;
    }

    for (const projectKey of plan.projectKeys) {
      for (const threadId of plan.threadIdsByProject.get(projectKey) ?? []) {
        const monitor = this.store.getMonitorThread(threadId);
        if (monitor?.selected && this.store.getThreadBridge(threadId)) {
          continue;
        }
        if (!monitor?.pausedDiscordChannelId) {
          if (!monitor?.selected) {
            this.selection.setThreadSelected(threadId, true, AUTOMATIC_MONITOR_ACTOR);
            changed = true;
          }
          continue;
        }
        try {
          await this.lifecycle.resumeThread(threadId, AUTOMATIC_MONITOR_ACTOR);
          changed = true;
        } catch (error) {
          errors.push(`${monitor?.threadName ?? threadId}: ${errorMessage(error)}`);
        }
      }
    }

    await this.reorderDiscordCopies(plan, force);
    if (changed || errors.length > 0) {
      this.store.appendMonitorAudit({
        timestamp: new Date().toISOString(),
        actorUserId: AUTOMATIC_MONITOR_ACTOR,
        action: "automatic_reconcile",
        projectKey: null,
        threadId: null,
        detail: JSON.stringify({
          projects: plan.projectKeys.length,
          threads: plan.desiredThreadIds.size,
          errors: errors.length
        })
      });
    }

    return {
      enabled: true,
      changed,
      projectCount: plan.projectKeys.length,
      threadCount: plan.desiredThreadIds.size,
      errors
    };
  }

  private async reorderDiscordCopies(plan: AutomaticMonitorPlan, force: boolean): Promise<void> {
    if (!this.provider.reorderManagedLocations) {
      return;
    }
    const projectCategoryIds: string[] = [];
    const conversationChannelIdsByCategory: Array<{
      categoryId: string;
      channelIds: string[];
    }> = [];
    for (const projectKey of plan.projectKeys) {
      const projectBridge = this.store.getProjectBridge(projectKey);
      if (!projectBridge) {
        continue;
      }
      projectCategoryIds.push(projectBridge.discordCategoryId);
      const channelIds = (plan.threadIdsByProject.get(projectKey) ?? [])
        .map((threadId) => this.store.getThreadBridge(threadId))
        .filter((bridge) => bridge?.channelKind === "conversation")
        .map((bridge) => bridge!.discordChannelId);
      conversationChannelIdsByCategory.push({
        categoryId: projectBridge.discordCategoryId,
        channelIds
      });
    }
    const signature = JSON.stringify({ projectCategoryIds, conversationChannelIdsByCategory });
    if (!force && signature === this.lastReorderSignature) {
      return;
    }
    await this.provider.reorderManagedLocations({
      projectCategoryIds,
      conversationChannelIdsByCategory
    });
    this.lastReorderSignature = signature;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }
}

function recencyAtMs(thread: MonitorThreadRecord): number {
  const recency = Date.parse(thread.recencyAt || thread.lastSeenAt);
  if (Number.isFinite(recency)) {
    return recency;
  }
  const lastSeen = Date.parse(thread.lastSeenAt);
  return Number.isFinite(lastSeen) ? lastSeen : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
