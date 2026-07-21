import type {
  CodexThreadSummary,
  ThreadBridgeRecord
} from "../../domain.js";
import type { StateStore } from "../../store/StateStore.js";
import { formatPausedDiscordChannelName } from "../../util/formatting.js";
import type { BridgeProvider } from "../../providers/types.js";
import type { HydratedThreadResult } from "../runtime/BridgeRuntimeState.js";
import type { MonitorSelectionService } from "./MonitorSelectionService.js";

interface MonitorLifecycleDependencies {
  detachMappedThread(threadId: string): ThreadBridgeRecord | null;
  drainThreadEventQueue(threadIds: Iterable<string>): Promise<void>;
  fastForwardThread(threadId: string): Promise<boolean>;
  hydrateThread(
    threadId: string,
    summary: CodexThreadSummary,
    attachMode: "auto" | "manual",
    options: { existingDiscordChannelId?: string | null; allowFilesystemScan?: boolean }
  ): Promise<HydratedThreadResult>;
  queueStatusUpdate(threadId: string): void;
  tryReadThread(threadId: string): Promise<CodexThreadSummary | null>;
}

export class MonitorLifecycleCoordinator {
  private operation: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: StateStore,
    private readonly provider: BridgeProvider,
    private readonly selection: MonitorSelectionService,
    private readonly deps: MonitorLifecycleDependencies
  ) {}

  pauseThread(
    threadId: string,
    actorUserId: string,
    options: { preserveSelection?: boolean } = {}
  ): Promise<void> {
    return this.serialize(async () => {
      const bridge = this.store.getThreadBridge(threadId);
      const monitor = this.store.getMonitorThread(threadId);
      if (!bridge && !monitor?.pausedDiscordChannelId) {
        if (!options.preserveSelection) {
          this.selection.setThreadSelected(threadId, false, actorUserId);
        }
        return;
      }

      const descendants = bridge
        ? this.collectDescendantBridgeIds(threadId)
        : [];
      const threadIds = [threadId, ...descendants];
      await this.deps.drainThreadEventQueue(threadIds);
      for (const mappedThreadId of threadIds) {
        await this.deps.fastForwardThread(mappedThreadId);
      }
      for (const childThreadId of descendants.reverse()) {
        this.deps.detachMappedThread(childThreadId);
      }
      const detached = this.deps.detachMappedThread(threadId) ?? bridge;
      const channelId = detached?.discordChannelId ?? monitor?.pausedDiscordChannelId ?? null;
      if (channelId) {
        this.store.setMonitorThreadPausedDiscordChannelId(threadId, channelId);
        await this.provider.updateConversationChannelName(
          channelId,
          formatPausedDiscordChannelName(detached?.threadName ?? monitor?.threadName ?? "Codex conversation")
        );
      }
      if (!options.preserveSelection) {
        this.selection.setThreadSelected(threadId, false, actorUserId);
      }
      this.store.appendMonitorAudit({
        timestamp: new Date().toISOString(),
        actorUserId,
        action: "pause-thread",
        projectKey: monitor?.projectKey ?? detached?.projectKey ?? null,
        threadId,
        detail: channelId
      });
    });
  }

  resumeThread(threadId: string, actorUserId: string): Promise<void> {
    return this.serialize(async () => {
      const monitor = this.store.getMonitorThread(threadId);
      if (!monitor) {
        throw new Error(`Unknown monitored conversation: ${threadId}`);
      }
      const project = this.store.getMonitorProject(monitor.projectKey);
      if (!project?.enabled) {
        throw new Error(`Project is not enabled for monitoring: ${project?.projectName ?? monitor.projectKey}`);
      }
      this.selection.setThreadSelected(threadId, true, actorUserId);
      await this.deps.fastForwardThread(threadId);
      const summary = await this.deps.tryReadThread(threadId);
      if (!summary) {
        this.selection.setThreadSelected(threadId, false, actorUserId);
        throw new Error(`Codex conversation is unavailable: ${threadId}`);
      }
      await this.deps.hydrateThread(threadId, summary, "manual", {
        existingDiscordChannelId: monitor.pausedDiscordChannelId,
        allowFilesystemScan: true
      });
      this.store.setMonitorThreadPausedDiscordChannelId(threadId, null);
      this.deps.queueStatusUpdate(threadId);
      this.store.appendMonitorAudit({
        timestamp: new Date().toISOString(),
        actorUserId,
        action: "resume-thread",
        projectKey: monitor.projectKey,
        threadId,
        detail: monitor.pausedDiscordChannelId
      });
    });
  }

  cleanPausedThreads(threadIds: string[], actorUserId: string): Promise<number> {
    let deletedCount = 0;
    return this.serialize(async () => {
      for (const threadId of [...new Set(threadIds)]) {
        const monitor = this.store.getMonitorThread(threadId);
        const bridge = this.store.getThreadBridge(threadId);
        const projectEnabled = monitor
          ? this.store.getMonitorProject(monitor.projectKey)?.enabled === true
          : false;
        if (
          !monitor ||
          (!monitor.pausedDiscordChannelId && !bridge) ||
          (monitor.selected && projectEnabled)
        ) {
          continue;
        }

        const locationIds = new Set<string>();
        if (monitor.pausedDiscordChannelId) {
          locationIds.add(monitor.pausedDiscordChannelId);
        }
        if (bridge) {
          const descendants = this.collectDescendantBridgeIds(threadId);
          const mappedThreadIds = [threadId, ...descendants];
          await this.deps.drainThreadEventQueue(mappedThreadIds);
          for (const mappedThreadId of mappedThreadIds) {
            await this.deps.fastForwardThread(mappedThreadId);
          }
          for (const childThreadId of descendants.reverse()) {
            this.deps.detachMappedThread(childThreadId);
          }
          const detached = this.deps.detachMappedThread(threadId) ?? bridge;
          locationIds.add(detached.discordChannelId);
        }

        for (const locationId of locationIds) {
          await this.provider.deleteDiscordLocation(
            locationId,
            "Delete stopped Codex Discord mirror"
          );
          deletedCount += 1;
        }
        this.store.setMonitorThreadPausedDiscordChannelId(threadId, null);
        this.store.appendMonitorAudit({
          timestamp: new Date().toISOString(),
          actorUserId,
          action: "clean-discord-copy",
          projectKey: monitor.projectKey,
          threadId,
          detail: [...locationIds].join(",")
        });
        await this.deleteEmptyProjectCategory(monitor.projectKey);
      }
    }).then(() => deletedCount);
  }

  private async deleteEmptyProjectCategory(projectKey: string): Promise<void> {
    const projectBridge = this.store.getProjectBridge(projectKey);
    if (!projectBridge?.createdByBridge) {
      return;
    }
    const hasDiscordCopies =
      this.store.listThreadBridges().some((bridge) => bridge.projectKey === projectKey) ||
      this.store.listMonitorThreads(projectKey).some((thread) => Boolean(thread.pausedDiscordChannelId));
    if (hasDiscordCopies) {
      return;
    }
    await this.provider.deleteDiscordLocation(
      projectBridge.discordCategoryId,
      "Delete empty Codex Discord project category"
    );
    this.store.deleteProjectBridge(projectKey);
  }

  private collectDescendantBridgeIds(parentThreadId: string): string[] {
    const result: string[] = [];
    const visit = (threadId: string): void => {
      for (const child of this.store.listThreadBridges().filter(
        (record) => record.parentCodexThreadId === threadId
      )) {
        result.push(child.codexThreadId);
        visit(child.codexThreadId);
      }
    };
    visit(parentThreadId);
    return result;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }
}
