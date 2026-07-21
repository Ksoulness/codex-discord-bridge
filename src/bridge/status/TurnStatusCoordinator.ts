import type {
  TurnPlanProgress,
  TurnStatusKind,
  TurnStatusMessageRecord
} from "../../domain.js";
import {
  formatDisconnectedDiscordChannelName,
  formatDiscordChannelStatusName,
  renderDesktopDisconnectedStatus,
  renderTurnStatus,
  shortThreadId,
  summarizeTurnStatusReason
} from "../../util/formatting.js";
import type { BridgeRuntimeContext } from "../runtime/BridgeRuntimeContext.js";

type TurnStatusContext = Pick<BridgeRuntimeContext, "logger" | "provider" | "stateStore"> &
  Partial<Pick<BridgeRuntimeContext, "codexAdapter">>;

const PRESERVED_TERMINAL_STATUS_KINDS = new Set<TurnStatusKind>([
  "networkError",
  "rateLimited",
  "systemError",
  "stopped",
  "completed"
]);

export class TurnStatusCoordinator {
  private readonly pendingChannelStatusTimers = new Map<string, NodeJS.Timeout>();
  private readonly appliedChannelNames = new Map<
    string,
    { channelId: string; name: string }
  >();
  private readonly channelStatusUpdatesInFlight = new Set<string>();
  private readonly queuedChannelStatuses = new Map<
    string,
    { record: TurnStatusMessageRecord; requireStoredRecord: boolean }
  >();
  private desktopConnected: boolean | null = null;
  private desktopConnectionRefreshTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly context: TurnStatusContext,
    private readonly now: () => Date = () => new Date(),
    private readonly channelRenameDelayMs = 1_500,
    private readonly channelRenameRetryDelayMs = 15_000
  ) {}

  async setStatus(
    threadId: string,
    turnId: string,
    statusKind: TurnStatusKind,
    options: {
      refresh?: boolean;
      reason?: string | null;
      planProgress?: TurnPlanProgress | null;
    } = {}
  ): Promise<void> {
    const bridge = this.context.stateStore.getThreadBridge(threadId);
    if (!bridge || bridge.channelKind !== "conversation" || !bridge.discordChannelId) {
      return;
    }
    if (bridge.lastTurnId && bridge.lastTurnId !== turnId) {
      return;
    }

    const existing = this.context.stateStore.getTurnStatusMessage(threadId);
    const agentTarget = this.findLatestAgentTarget(threadId, turnId, statusKind);
    const targetKind = agentTarget?.targetKind ?? "fallback";
    const targetMessageId = agentTarget?.discordMessageId ??
      (existing?.turnId === turnId && existing.targetKind === "fallback"
        ? existing.discordMessageId
        : null);
    const targetMatches =
      existing?.turnId === turnId &&
      existing.targetKind === targetKind &&
      existing.discordMessageId === targetMessageId;
    const errorReason = summarizeTurnStatusReason(options.reason);
    const canCarryPlanAcrossTurn =
      existing?.turnId !== turnId &&
      existing !== undefined &&
      !PRESERVED_TERMINAL_STATUS_KINDS.has(existing.statusKind);
    const existingPlanProgress = this.readPlanProgress(
      existing?.turnId === turnId || canCarryPlanAcrossTurn ? existing : null
    );
    const planProgress =
      options.planProgress === undefined ? existingPlanProgress : options.planProgress;
    const preserveMigratedCompletion =
      options.refresh === true &&
      existing?.turnId === turnId &&
      existing.statusKind === "completed" &&
      bridge.lastTurnStatus === "completed" &&
      planProgress !== null &&
      planProgress !== undefined &&
      planProgress.currentStep === planProgress.totalSteps;
    if (
      statusKind === "completed" &&
      planProgress &&
      !planProgress.allStepsCompleted &&
      !preserveMigratedCompletion
    ) {
      statusKind = "inProgress";
    }
    if (
      targetMatches &&
      existing.statusKind === statusKind &&
      existing.errorReason === errorReason &&
      existing.planCurrentStep === (planProgress?.currentStep ?? null) &&
      existing.planTotalSteps === (planProgress?.totalSteps ?? null) &&
      existing.planCurrentStepText === (planProgress?.currentStepText ?? null) &&
      existing.planAllStepsCompleted === (planProgress?.allStepsCompleted ?? false) &&
      !options.refresh
    ) {
      return;
    }

    if (existing && !targetMatches) {
      const preservePreviousTerminalStatus =
        existing.turnId !== turnId &&
        existing.targetKind !== "fallback" &&
        PRESERVED_TERMINAL_STATUS_KINDS.has(existing.statusKind);
      if (!preservePreviousTerminalStatus) {
        await this.clearTrackedTarget(bridge.discordChannelId, existing);
      }
      this.context.stateStore.deleteTurnStatusMessage(threadId);
    }

    const updatedAt = this.now();
    const statusText = this.desktopConnected === false
      ? renderDesktopDisconnectedStatus(updatedAt)
      : renderTurnStatus(statusKind, updatedAt, errorReason, planProgress);
    if (targetKind !== "fallback" && targetMessageId) {
      try {
        const updated = await this.context.provider.updateLiveTextMessageStatus(
          bridge.discordChannelId,
          targetMessageId,
          statusText
        );
        if (updated) {
          const record: TurnStatusMessageRecord = {
            threadId,
            turnId,
            discordMessageId: targetMessageId,
            targetKind,
            statusKind,
            errorReason,
            planCurrentStep: planProgress?.currentStep ?? null,
            planTotalSteps: planProgress?.totalSteps ?? null,
            planCurrentStepText: planProgress?.currentStepText ?? null,
            planAllStepsCompleted: planProgress?.allStepsCompleted ?? false,
            updatedAt: updatedAt.toISOString()
          };
          this.rememberStatus(record);
          await this.scheduleChannelStatus(record);
          return;
        }
      } catch (error) {
        this.logUpdateFailure(error, threadId, turnId, statusKind);
      }
    }

    const fallbackMessageId =
      existing?.turnId === turnId && existing.targetKind === "fallback"
        ? existing.discordMessageId
        : null;
    try {
      const discordMessageId = await this.context.provider.upsertLiveTextMessage(
        bridge.discordChannelId,
        fallbackMessageId,
        statusText
      );
      const record: TurnStatusMessageRecord = {
        threadId,
        turnId,
        discordMessageId,
        targetKind: "fallback",
        statusKind,
        errorReason,
        planCurrentStep: planProgress?.currentStep ?? null,
        planTotalSteps: planProgress?.totalSteps ?? null,
        planCurrentStepText: planProgress?.currentStepText ?? null,
        planAllStepsCompleted: planProgress?.allStepsCompleted ?? false,
        updatedAt: updatedAt.toISOString()
      };
      this.rememberStatus(record);
      await this.scheduleChannelStatus(record);
    } catch (error) {
      this.logUpdateFailure(error, threadId, turnId, statusKind);
      await this.scheduleChannelStatus(
        {
          threadId,
          turnId,
          discordMessageId: targetMessageId ?? "",
          targetKind,
          statusKind,
          errorReason,
          planCurrentStep: planProgress?.currentStep ?? null,
          planTotalSteps: planProgress?.totalSteps ?? null,
          planCurrentStepText: planProgress?.currentStepText ?? null,
          planAllStepsCompleted: planProgress?.allStepsCompleted ?? false,
          updatedAt: updatedAt.toISOString()
        },
        { requireStoredRecord: false }
      );
    }
  }

  async resumeStatus(threadId: string, turnId: string): Promise<void> {
    await this.setStatus(threadId, turnId, "inProgress");
  }

  async updatePlanProgress(
    threadId: string,
    turnId: string,
    planProgress: TurnPlanProgress
  ): Promise<void> {
    const bridge = this.context.stateStore.getThreadBridge(threadId);
    const existing = this.context.stateStore.getTurnStatusMessage(threadId);
    const targetTurnId = bridge?.lastTurnId ?? existing?.turnId ?? turnId;
    await this.setStatus(
      threadId,
      targetTurnId,
      "inProgress",
      {
        refresh: true,
        reason: null,
        planProgress
      }
    );
  }

  async clearNormalCompletion(threadId: string, turnId: string): Promise<void> {
    await this.setStatus(threadId, turnId, "completed");
  }

  async reconcileStartup(): Promise<void> {
    await this.reconcileStatuses(true);
  }

  setDesktopConnectionStatus(connected: boolean): Promise<void> {
    const changed = this.desktopConnected !== connected;
    this.desktopConnected = connected;
    if (!changed) {
      return this.desktopConnectionRefreshTail;
    }

    const refresh = this.desktopConnectionRefreshTail
      .catch(() => undefined)
      .then(async () => {
        await this.reconcileStatuses(true);
        await this.refreshAllChannelTitles();
      });
    this.desktopConnectionRefreshTail = refresh;
    return refresh;
  }

  async refreshCurrentStatuses(): Promise<void> {
    await this.reconcileStatuses(false);
    await this.refreshAllChannelTitles();
  }

  private async refreshAllChannelTitles(): Promise<void> {
    for (const bridge of this.context.stateStore.listThreadBridgesByKind("conversation")) {
      this.appliedChannelNames.delete(bridge.codexThreadId);
      const record = this.context.stateStore.getTurnStatusMessage(bridge.codexThreadId);
      if (record) {
        await this.refreshChannelTitle(bridge.codexThreadId);
        continue;
      }
      if (this.desktopConnected === null || !bridge.discordChannelId) {
        continue;
      }
      const underlyingStatusKind: TurnStatusKind =
        bridge.lastTurnStatus === "in_progress"
          ? "inProgress"
          : bridge.lastTurnStatus === "completed"
            ? "completed"
            : "stopped";
      const desiredName = await this.buildDesiredChannelName(
        bridge.codexThreadId,
        bridge.threadName,
        underlyingStatusKind
      );
      try {
        const updated = await this.context.provider.updateConversationChannelName(
          bridge.discordChannelId,
          desiredName
        );
        if (updated) {
          this.appliedChannelNames.set(bridge.codexThreadId, {
            channelId: bridge.discordChannelId,
            name: desiredName
          });
        }
      } catch (error) {
        this.context.logger.warn(
          { error, threadId: bridge.codexThreadId, desiredName },
          "Failed to update Discord conversation channel Desktop connection status"
        );
      }
    }
  }

  private async reconcileStatuses(refreshMessages: boolean): Promise<void> {
    for (const bridge of this.context.stateStore.listThreadBridgesByKind("conversation")) {
      if (!bridge.lastTurnId) {
        continue;
      }
      const existing = this.context.stateStore.getTurnStatusMessage(bridge.codexThreadId);
      if (bridge.lastTurnStatus === "in_progress") {
        await this.setStatus(
          bridge.codexThreadId,
          bridge.lastTurnId,
          existing?.turnId === bridge.lastTurnId ? existing.statusKind : "inProgress",
          {
            refresh: refreshMessages,
            reason: existing?.turnId === bridge.lastTurnId ? existing.errorReason : null
          }
        );
      } else if (bridge.lastTurnStatus === "completed") {
        await this.setStatus(bridge.codexThreadId, bridge.lastTurnId, "completed", {
          refresh: refreshMessages
        });
      } else if (
        existing?.turnId === bridge.lastTurnId &&
        PRESERVED_TERMINAL_STATUS_KINDS.has(existing.statusKind)
      ) {
        await this.setStatus(bridge.codexThreadId, bridge.lastTurnId, existing.statusKind, {
          refresh: refreshMessages,
          reason: existing.errorReason
        });
      }
    }

    for (const existing of this.context.stateStore.listTurnStatusMessages()) {
      const bridge = this.context.stateStore.getThreadBridge(existing.threadId);
      if (!bridge?.discordChannelId) {
        continue;
      }
      const isLatestTurn = bridge.lastTurnId === existing.turnId;
      const shouldKeepLatest =
        isLatestTurn &&
        (bridge.lastTurnStatus === "in_progress" ||
          PRESERVED_TERMINAL_STATUS_KINDS.has(existing.statusKind));
      if (shouldKeepLatest) {
        continue;
      }
      if (PRESERVED_TERMINAL_STATUS_KINDS.has(existing.statusKind)) {
        this.context.stateStore.deleteTurnStatusMessage(existing.threadId);
        continue;
      }
      if (await this.clearTrackedTarget(bridge.discordChannelId, existing)) {
        this.context.stateStore.deleteTurnStatusMessage(existing.threadId);
      }
    }
  }

  stop(): void {
    for (const timer of this.pendingChannelStatusTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingChannelStatusTimers.clear();
    this.queuedChannelStatuses.clear();
  }

  private findLatestAgentTarget(
    threadId: string,
    turnId: string,
    requestedStatusKind: TurnStatusKind
  ): Pick<TurnStatusMessageRecord, "discordMessageId" | "targetKind"> | null {
    const messages = this.context.stateStore
      .listMirroredItems(threadId)
      .filter((record) => record.turnId === turnId);
    if (requestedStatusKind === "completed") {
      const answer = messages.findLast((record) => record.kind === "agentAnswer");
      if (answer) {
        return { discordMessageId: answer.discordMessageId, targetKind: "answer" };
      }
    }
    const commentary = messages.findLast((record) => record.kind === "agentCommentary");
    return commentary
      ? { discordMessageId: commentary.discordMessageId, targetKind: "commentary" }
      : null;
  }

  private readPlanProgress(record: TurnStatusMessageRecord | null): TurnPlanProgress | null {
    if (
      !record ||
      record.planCurrentStep === null ||
      record.planTotalSteps === null ||
      !record.planCurrentStepText
    ) {
      return null;
    }
    return {
      currentStep: record.planCurrentStep,
      totalSteps: record.planTotalSteps,
      currentStepText: record.planCurrentStepText,
      allStepsCompleted: record.planAllStepsCompleted
    };
  }

  private rememberStatus(record: TurnStatusMessageRecord): void {
    this.context.stateStore.upsertTurnStatusMessage(record);
  }

  private async scheduleChannelStatus(
    record: TurnStatusMessageRecord,
    options: { requireStoredRecord?: boolean; delayMs?: number } = {}
  ): Promise<void> {
    const requireStoredRecord = options.requireStoredRecord !== false;
    const delayMs = options.delayMs ?? this.channelRenameDelayMs;
    const pending = this.pendingChannelStatusTimers.get(record.threadId);
    if (pending) {
      clearTimeout(pending);
      this.pendingChannelStatusTimers.delete(record.threadId);
    }
    if (delayMs <= 0) {
      await this.applyChannelStatus(record, requireStoredRecord);
      return;
    }
    const timer = setTimeout(() => {
      this.pendingChannelStatusTimers.delete(record.threadId);
      void this.applyChannelStatus(record, requireStoredRecord);
    }, delayMs);
    timer.unref?.();
    this.pendingChannelStatusTimers.set(record.threadId, timer);
  }

  private async applyChannelStatus(
    record: TurnStatusMessageRecord,
    requireStoredRecord: boolean
  ): Promise<void> {
    if (!this.isCurrentChannelStatus(record, requireStoredRecord)) {
      return;
    }
    if (this.channelStatusUpdatesInFlight.has(record.threadId)) {
      this.queuedChannelStatuses.set(record.threadId, { record, requireStoredRecord });
      return;
    }
    this.channelStatusUpdatesInFlight.add(record.threadId);
    try {
      await this.applyChannelStatusNow(record, requireStoredRecord);
    } finally {
      this.channelStatusUpdatesInFlight.delete(record.threadId);
      const queued = this.queuedChannelStatuses.get(record.threadId);
      this.queuedChannelStatuses.delete(record.threadId);
      if (queued && this.isCurrentChannelStatus(queued.record, queued.requireStoredRecord)) {
        await this.applyChannelStatus(queued.record, queued.requireStoredRecord);
      }
    }
  }

  private async applyChannelStatusNow(
    record: TurnStatusMessageRecord,
    requireStoredRecord: boolean
  ): Promise<void> {
    const bridge = this.context.stateStore.getThreadBridge(record.threadId);
    if (!bridge || bridge.channelKind !== "conversation" || !bridge.discordChannelId) {
      return;
    }
    if (bridge.lastTurnId && bridge.lastTurnId !== record.turnId) {
      return;
    }
    const desiredName = await this.buildDesiredChannelName(
      record.threadId,
      bridge.threadName,
      record.statusKind
    );
    const appliedChannelName = this.appliedChannelNames.get(record.threadId);
    if (
      appliedChannelName?.channelId === bridge.discordChannelId &&
      appliedChannelName.name === desiredName
    ) {
      return;
    }
    try {
      const updated = await this.context.provider.updateConversationChannelName(
        bridge.discordChannelId,
        desiredName
      );
      if (updated) {
        if (this.isCurrentChannelStatus(record, requireStoredRecord)) {
          this.appliedChannelNames.set(record.threadId, {
            channelId: bridge.discordChannelId,
            name: desiredName
          });
        } else {
          await this.reapplyLatestChannelStatus(record.threadId);
        }
      }
    } catch (error) {
      this.context.logger.warn(
        { error, threadId: record.threadId, turnId: record.turnId, desiredName },
        "Failed to update Discord conversation channel task status"
      );
      if (this.isCurrentChannelStatus(record, requireStoredRecord)) {
        await this.scheduleChannelStatus(record, {
          requireStoredRecord,
          delayMs: Math.max(1, this.channelRenameRetryDelayMs)
        });
      } else {
        await this.reapplyLatestChannelStatus(record.threadId);
      }
    }
  }

  async refreshChannelTitle(threadId: string): Promise<void> {
    const record = this.context.stateStore.getTurnStatusMessage(threadId);
    if (!record) {
      return;
    }
    await this.scheduleChannelStatus(record, { delayMs: 0 });
  }

  private async buildDesiredChannelName(
    threadId: string,
    fallbackName: string | null,
    statusKind: TurnStatusKind
  ): Promise<string> {
    const currentName = await this.readCurrentThreadName(threadId, fallbackName);
    const fallback = `thread-${shortThreadId(threadId)}`;
    return this.desktopConnected === false
      ? formatDisconnectedDiscordChannelName(currentName, fallback)
      : formatDiscordChannelStatusName(currentName, fallback, statusKind);
  }

  private async readCurrentThreadName(threadId: string, fallback: string | null): Promise<string> {
    if (!this.context.codexAdapter) {
      return fallback ?? "Codex conversation";
    }
    try {
      const thread = await this.context.codexAdapter.readThread(threadId, false);
      return thread.name?.trim() || fallback || "Codex conversation";
    } catch (error) {
      this.context.logger.debug({ error, threadId }, "Failed to refresh Codex title before renaming Discord channel");
      return fallback ?? "Codex conversation";
    }
  }

  private isCurrentChannelStatus(
    record: TurnStatusMessageRecord,
    requireStoredRecord: boolean
  ): boolean {
    const latest = this.context.stateStore.getTurnStatusMessage(record.threadId);
    if (!latest) {
      return !requireStoredRecord;
    }
    return (
      latest.turnId === record.turnId &&
      latest.statusKind === record.statusKind &&
      latest.updatedAt === record.updatedAt
    );
  }

  private async reapplyLatestChannelStatus(threadId: string): Promise<void> {
    this.appliedChannelNames.delete(threadId);
    const latest = this.context.stateStore.getTurnStatusMessage(threadId);
    if (latest) {
      await this.scheduleChannelStatus(latest, { delayMs: 0 });
    }
  }

  private async clearTrackedTarget(
    channelId: string,
    record: TurnStatusMessageRecord
  ): Promise<boolean> {
    try {
      if (record.targetKind !== "fallback") {
        return await this.context.provider.updateLiveTextMessageStatus(
          channelId,
          record.discordMessageId,
          null
        );
      }
      await this.context.provider.deleteMessages(channelId, [record.discordMessageId]);
      return true;
    } catch (error) {
      this.context.logger.warn(
        { error, threadId: record.threadId, turnId: record.turnId },
        "Failed to clear Discord intermediate status"
      );
      return false;
    }
  }

  private logUpdateFailure(
    error: unknown,
    threadId: string,
    turnId: string,
    statusKind: TurnStatusKind
  ): void {
    this.context.logger.warn(
      { error, threadId, turnId, statusKind },
      "Failed to update Discord intermediate status"
    );
  }
}
