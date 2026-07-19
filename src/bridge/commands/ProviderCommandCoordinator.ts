import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  DiscordCommandResult,
  ThreadBridgeRecord,
  ThreadRuntimeState,
  WriteBackQueueRecord
} from "../../domain.js";
import type { ProviderActorContext, ProviderInboundAttachment } from "../../providers/types.js";
import { shortThreadId, statusLabel } from "../../util/formatting.js";
import { formatStartupTimingMs } from "../../util/startupTiming.js";
import { withLogScope } from "../../util/terminalLogging.js";
import type { BridgeRuntimeContext } from "../runtime/BridgeRuntimeContext.js";
import type {
  BridgeRuntimeState,
  CleanProgressReporter,
  HydrateThreadOptions
} from "../runtime/BridgeRuntimeState.js";
import {
  hasSteerableActiveTurn,
  markThreadTurnCompleted,
  markThreadTurnInProgress
} from "../runtime/BridgeRuntimeState.js";
import type { DesktopConversationState } from "../../codex/CodexDesktopIpcClient.js";
import { DesktopSteerPayloadBuilder, type DesktopSteerRestoreStateSource } from "./DesktopSteerPayloadBuilder.js";

type InternalSteerSource = "approval-feedback" | "internal" | "discord";
const WRITE_BACK_MAX_TEXT_LENGTH = 2000;
const PROPOSED_PLAN_ACTION_MAX_TEXT_LENGTH = 12000;
const WRITE_BACK_MAX_PENDING_PER_THREAD = 10;
const WRITE_BACK_PREVIEW_MAX_LENGTH = 180;
const BRIDGE_REMOTE_CLI_ORIGINATOR = "codex-mobile";
const CODEX_DEFAULT_MODEL_VALUE = "__codex_default__";
const DEFAULT_NEW_THREAD_MODEL = "gpt-5.6-terra";
const DEFAULT_NEW_THREAD_REASONING_EFFORT = "medium";
const DEFAULT_NEW_THREAD_MODEL_META_KEY = "discord-new-thread-default-model";
const DEFAULT_NEW_THREAD_REASONING_META_KEY = "discord-new-thread-default-reasoning-effort";
const MAX_DISCORD_IMAGE_COUNT = 4;
const MAX_DISCORD_IMAGE_BYTES = 8 * 1024 * 1024;
const STALE_DESKTOP_ACTIVE_GRACE_MS = 2 * 60 * 1000;
const DESKTOP_OWNER_RECOVERY_TIMEOUT_MS = 8_000;
const STEER_ACTIVE_TURN_RETRY_DELAYS_MS = [250, 750, 1_500, 2_500];
const DISCORD_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const DISCORD_IMAGE_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

class DesktopOriginalThreadUnavailableError extends Error {}

interface WriteBackTurnStartOptions {
  skipResumeForCliSession?: boolean;
}

interface QueueWriteBackOptions {
  sourceKind?: "slash" | "plain";
  discordMessageId?: string | null;
  requestedModel?: string | null;
  requestedReasoningEffort?: string | null;
  localImagePaths?: string[];
  plainMode?: boolean;
}

interface ProviderCommandCoordinatorDependencies {
  clearQueuedStatusUpdate(threadId: string): void;
  cleanupThread(threadId: string, reason: string, progressReporter?: CleanProgressReporter): Promise<number>;
  drainThreadEventQueue(threadIds?: Iterable<string>): Promise<void>;
  detachThread(threadId: string): ThreadBridgeRecord | null;
  pauseThread(threadId: string, actorUserId: string): Promise<void>;
  flushStatusUpdate(threadId: string): Promise<void>;
  hydrateThread(
    threadId: string,
    summary: import("../../domain.js").CodexThreadSummary,
    attachMode: "auto" | "manual",
    hydrateOptions?: HydrateThreadOptions
  ): Promise<import("../runtime/BridgeRuntimeState.js").HydratedThreadResult>;
  openCodexThreadInDesktop(threadId: string): void;
  pollThreadSessionEvents(threadId: string): Promise<void>;
  persistThreadState(state: ThreadRuntimeState): void;
  printProgress(message: string): void;
  readLatestTurnBackfillTurnId(threadId: string): Promise<string | null>;
  queueStatusUpdate(threadId: string): void;
  setTurnStatus(threadId: string, turnId: string, statusKind: import("../../domain.js").TurnStatusKind): Promise<void>;
  resetBridge(progressReporter?: CleanProgressReporter): Promise<{
    deletedCategories: number;
    deletedLocations: number;
  }>;
}

export class ProviderCommandCoordinator {
  private readonly desktopSteerPayload: DesktopSteerPayloadBuilder;
  private readonly newChannelOperations = new Map<string, Promise<DiscordCommandResult | null>>();

  constructor(
    private readonly context: BridgeRuntimeContext,
    private readonly runtime: BridgeRuntimeState,
    private readonly deps: ProviderCommandCoordinatorDependencies
  ) {
    this.desktopSteerPayload = new DesktopSteerPayloadBuilder({
      logger: context.logger,
      runtimeConfig: context.runtimeConfig,
      printProgress: deps.printProgress
    });
  }

  async handleStatusCommand(actor: ProviderActorContext): Promise<DiscordCommandResult> {
    const unauthorizedResult = this.authorizeCommand(actor);
    if (unauthorizedResult) {
      return unauthorizedResult;
    }

    const bridges = this.context.stateStore.listThreadBridgesByKind("conversation");
    if (bridges.length === 0) {
      return { content: "No Codex conversations are mapped yet." };
    }
    return {
      content: bridges
        .slice(0, 20)
        .map((bridge) => {
          const state = this.runtime.threadState.get(bridge.codexThreadId);
          const label = state ? statusLabel(state.status) : "Unknown";
          return `\`${shortThreadId(bridge.codexThreadId)}\` ${bridge.projectName} ${label} <#${bridge.discordChannelId}>`;
        })
        .join("\n")
    };
  }

  async steerActiveTurnInternally(
    text: string,
    threadId: string
  ): Promise<DiscordCommandResult> {
    const trimmedText = text.trim();
    if (!trimmedText) {
      return {
        content: "Steer text cannot be empty.",
        ephemeral: true
      };
    }

    const targetThreadId = threadId.trim();
    if (!targetThreadId) {
      return {
        content: "Thread id cannot be empty.",
        ephemeral: true
      };
    }

    return this.steerResolvedThread(targetThreadId, trimmedText, "internal");
  }

  async handleSendCommand(
    actor: ProviderActorContext,
    channelId: string,
    text: string,
    mode: "queue" | "steer"
  ): Promise<DiscordCommandResult> {
    const unauthorizedResult = this.authorizeMessageWriteBack(actor);
    if (unauthorizedResult) {
      return unauthorizedResult;
    }

    const target = this.resolveMappedThreadFromChannel(channelId);
    if (!target.ok) {
      return target.result;
    }

    const trimmedText = text.trim();
    const textError = this.validateWriteBackText(trimmedText);
    if (textError) {
      return textError;
    }

    if (mode === "steer") {
      return this.handleSteerWriteBack(actor, target.bridge, trimmedText);
    }

    return this.handleQueueWriteBack(actor, target.bridge, trimmedText);
  }

  async handlePlainMessage(
    actor: ProviderActorContext,
    channelId: string,
    messageId: string,
    text: string,
    attachments: ProviderInboundAttachment[] = [],
    parentChannelId: string | null = null,
    channelName: string | null = null
  ): Promise<DiscordCommandResult | null> {
    if (!this.context.runtimeConfig.messageWriteBacks.allowPlainMessages) {
      return null;
    }
    const unauthorizedResult = this.authorizeMessageWriteBack(actor);
    if (unauthorizedResult) {
      return unauthorizedResult;
    }
    const target = this.resolveMappedThreadFromChannel(channelId);
    if (!target.ok) {
      return this.handleFirstMessageInUnmappedChannel(
        actor,
        channelId,
        parentChannelId,
        channelName,
        messageId,
        text,
        attachments
      );
    }
    const localImagePaths = await this.cacheDiscordImageAttachments(messageId, attachments);
    const trimmedText = text.trim() || (localImagePaths.length > 0 ? "请查看附图。" : "");
    const textError = this.validateWriteBackText(trimmedText);
    if (textError) {
      if (attachments.length > 0 && !text.trim()) {
        return {
          content: "没有找到可发送给 Codex 的图片。请使用 PNG、JPG、WebP 或 GIF，单张不超过 8 MB。",
          ephemeral: true
        };
      }
      return textError;
    }
    const result = await this.handleQueueWriteBack(actor, target.bridge, trimmedText, {
      sourceKind: "plain",
      discordMessageId: messageId,
      requestedModel: this.context.stateStore.getDiscordThreadModelPreference(target.bridge.codexThreadId),
      requestedReasoningEffort: this.context.stateStore.getDiscordThreadReasoningEffortPreference(
        target.bridge.codexThreadId
      ),
      localImagePaths,
      plainMode: true
    });
    return result.content.startsWith("Started a new Codex turn.") ? null : result;
  }

  async handleModelCommand(
    actor: ProviderActorContext,
    channelId: string
  ): Promise<DiscordCommandResult> {
    const unauthorizedResult = this.authorizeMessageWriteBack(actor);
    if (unauthorizedResult) {
      return unauthorizedResult;
    }
    const target = this.resolveMappedThreadFromChannel(channelId);
    if (!target.ok) {
      return target.result;
    }

    try {
      const models = await this.context.codexAdapter.listModels();
      if (models.length === 0) {
        return {
          content: "Codex 当前没有返回可用模型，原有频道模型设置保持不变。",
          ephemeral: true
        };
      }
      return this.buildModelSelectionResult(target.bridge.codexThreadId, models);
    } catch (error) {
      this.context.logger.warn({ error, channelId }, "Failed to load Codex models for Discord.");
      return {
        content: "暂时无法读取 Codex 模型列表，原有频道模型设置保持不变。",
        ephemeral: true
      };
    }
  }

  async handleModelSelect(
    actor: ProviderActorContext,
    channelId: string,
    model: string
  ): Promise<DiscordCommandResult> {
    const unauthorizedResult = this.authorizeMessageWriteBack(actor);
    if (unauthorizedResult) {
      return unauthorizedResult;
    }
    const target = this.resolveMappedThreadFromChannel(channelId);
    if (!target.ok) {
      return target.result;
    }

    if (model === CODEX_DEFAULT_MODEL_VALUE) {
      this.context.stateStore.setDiscordThreadModelPreference(target.bridge.codexThreadId, null, null);
      return {
        content:
          "已设置：跟随 Codex 默认模型\n只影响此频道以后由 Discord 发起的新一轮；引导沿用当前轮模型。",
        ephemeral: true
      };
    }

    try {
      const models = await this.context.codexAdapter.listModels();
      const selected = models.find((entry) => entry.id === model);
      if (!selected) {
        return {
          content: "所选模型不可用，原有频道模型设置保持不变。请重新运行 `/codex model`。",
          ephemeral: true
        };
      }
      const effort = selected.defaultReasoningEffort ?? selected.supportedReasoningEfforts?.[0] ?? null;
      this.context.stateStore.setDiscordThreadModelPreference(target.bridge.codexThreadId, selected.id, effort);
      return this.buildModelSelectionResult(target.bridge.codexThreadId, models);
    } catch (error) {
      this.context.logger.warn({ error, channelId, model }, "Failed to validate a Discord model selection.");
      return {
        content: "暂时无法验证所选模型，原有频道模型设置保持不变。",
        ephemeral: true
      };
    }
  }

  async handleReasoningEffortSelect(
    actor: ProviderActorContext,
    channelId: string,
    reasoningEffort: string
  ): Promise<DiscordCommandResult> {
    const unauthorizedResult = this.authorizeMessageWriteBack(actor);
    if (unauthorizedResult) {
      return unauthorizedResult;
    }
    const target = this.resolveMappedThreadFromChannel(channelId);
    if (!target.ok) {
      return target.result;
    }

    try {
      const models = await this.context.codexAdapter.listModels();
      const modelId = this.context.stateStore.getDiscordThreadModelPreference(target.bridge.codexThreadId);
      const selected = models.find((entry) => entry.id === modelId);
      if (!selected || !selected.supportedReasoningEfforts?.includes(reasoningEffort)) {
        return { content: "该推理强度不适用于当前模型，请重新运行 `/codex model`。", ephemeral: true };
      }
      this.context.stateStore.setDiscordThreadModelPreference(target.bridge.codexThreadId, selected.id, reasoningEffort);
      return this.buildModelSelectionResult(target.bridge.codexThreadId, models);
    } catch (error) {
      this.context.logger.warn({ error, channelId, reasoningEffort }, "Failed to validate a Discord reasoning effort selection.");
      return { content: "暂时无法保存推理强度，原设置保持不变。", ephemeral: true };
    }
  }

  async handleRetractCommand(
    actor: ProviderActorContext,
    channelId: string
  ): Promise<DiscordCommandResult> {
    const unauthorizedResult = this.authorizeMessageWriteBack(actor);
    if (unauthorizedResult) {
      return unauthorizedResult;
    }

    const target = this.resolveMappedThreadFromChannel(channelId);
    if (!target.ok) {
      return target.result;
    }

    const retracted = this.context.stateStore.retractLatestPendingWriteBackQueueItem(target.bridge.codexThreadId);
    if (!retracted) {
      return {
        content: "There is no pending queued Codex message to retract in this channel.",
        ephemeral: true
      };
    }

    this.appendWriteBackCanonicalEvent(retracted, "writeBackRetracted", "Retracted queued Discord message.");
    return {
      content: this.formatWriteBackMessage("Retracted the latest pending queued message.", retracted.text),
      ephemeral: true
    };
  }

  async handleWriteBackButton(
    actor: ProviderActorContext,
    action: "retract" | "steer",
    queueItemId: number
  ): Promise<DiscordCommandResult> {
    const unauthorizedResult = this.authorizeMessageWriteBack(actor);
    if (unauthorizedResult) {
      return unauthorizedResult;
    }

    if (!Number.isSafeInteger(queueItemId) || queueItemId <= 0) {
      return {
        content: "This queued Codex message could not be found.",
        ephemeral: true
      };
    }

    if (action === "retract") {
      const retracted = this.context.stateStore.markWriteBackQueueItemRetracted(queueItemId);
      if (!retracted) {
        return {
          content: "这条排队消息已经不在等待中。",
          ephemeral: true
        };
      }
      this.appendWriteBackCanonicalEvent(retracted, "writeBackRetracted", "Retracted queued Discord message.");
      return {
        content: this.formatWriteBackMessage(
          retracted.sourceKind === "plain" ? "已删除排队消息。" : "Retracted queued message.",
          retracted.text
        ),
        ephemeral: true
      };
    }

    const claimed = this.context.stateStore.claimWriteBackQueueItem(queueItemId);
    if (!claimed) {
      return {
        content: "This queued Codex message is no longer pending.",
        ephemeral: true
      };
    }

    try {
      if (this.isThreadSteerable(claimed.threadId)) {
        if (
          claimed.sourceKind === "plain" &&
          !(await this.ensureOriginalDesktopOwner(claimed.threadId))
        ) {
          throw new DesktopOriginalThreadUnavailableError(
            "The original Codex Desktop conversation is not connected or has no current Desktop owner."
          );
        }
      }
      if (this.isThreadSteerable(claimed.threadId)) {
        const steeredTurnId = await this.steerResolvedThreadOrThrow(
          claimed.threadId,
          claimed.text,
          "discord",
          claimed.localImagePaths
        );
        this.context.stateStore.markWriteBackQueueItemSent(claimed.id);
        const sent = this.context.stateStore.getWriteBackQueueItem(claimed.id) ?? claimed;
        this.appendWriteBackCanonicalEvent(
          sent,
          "writeBackSent",
          `Steered active turn ${steeredTurnId} from queued Discord message.`
        );
        return {
          content: this.formatWriteBackMessage("Sent queued message to the active turn.", claimed.text),
          ephemeral: true
        };
      }

      await this.startWriteBackTurn(claimed, { skipResumeForCliSession: true });
      this.markWriteBackTurnStarted(claimed.threadId);
      this.context.stateStore.markWriteBackQueueItemSent(claimed.id);
      const sent = this.context.stateStore.getWriteBackQueueItem(claimed.id) ?? claimed;
      this.appendWriteBackCanonicalEvent(
        sent,
        "writeBackSent",
        "Started a new Codex turn from the direct-send Discord button."
      );
      return {
        content: this.formatWriteBackMessage("Started a new Codex turn.", claimed.text),
        ephemeral: true
      };
    } catch (error) {
      if (this.isInactiveSteerError(error)) {
        try {
          await this.startWriteBackTurn(claimed, { skipResumeForCliSession: true });
          this.markWriteBackTurnStarted(claimed.threadId);
          this.context.stateStore.markWriteBackQueueItemSent(claimed.id);
          const sent = this.context.stateStore.getWriteBackQueueItem(claimed.id) ?? claimed;
          this.appendWriteBackCanonicalEvent(
            sent,
            "writeBackSent",
            "Started a new Codex turn after the active turn was no longer available."
          );
          return {
            content: this.formatWriteBackMessage("Started a new Codex turn.", claimed.text),
            ephemeral: true
          };
        } catch (startError) {
          error = startError;
        }
      }
      const errorMessage = this.formatErrorMessage(error, "Failed to steer queued Codex message.");
      this.context.stateStore.restoreWriteBackQueueItemPending(claimed.id, errorMessage);
      this.appendWriteBackCanonicalEvent(
        {
          ...claimed,
          status: "pending",
          error: errorMessage
        },
        "writeBackFailed",
        errorMessage
      );
      return {
        content: errorMessage,
        ephemeral: true,
        buttons: this.buildWriteBackButtons(claimed, this.isThreadSteerable(claimed.threadId))
      };
    }
  }

  async handleProposedPlanAction(
    actor: ProviderActorContext,
    token: string,
    action: "accept"
  ): Promise<DiscordCommandResult> {
    if (action !== "accept") {
      return { content: "This proposed-plan action is not available.", ephemeral: true };
    }
    return this.sendProposedPlanFollowUp(actor, token, "accepted");
  }

  async handleProposedPlanFeedback(
    actor: ProviderActorContext,
    token: string,
    feedback: string
  ): Promise<DiscordCommandResult> {
    const trimmedFeedback = feedback.trim();
    if (!trimmedFeedback) {
      return {
        content: "Enter a short note for Codex before sending this plan feedback.",
        ephemeral: true
      };
    }
    return this.sendProposedPlanFollowUp(actor, token, "feedbackSent", trimmedFeedback);
  }

  async drainNextQueuedWriteBackMessage(
    threadId: string,
    options: WriteBackTurnStartOptions = {}
  ): Promise<WriteBackQueueRecord | null> {
    if (this.isThreadBusy(threadId)) {
      return null;
    }

    const claimed = this.context.stateStore.claimNextPendingWriteBackQueueItem(threadId);
    if (!claimed) {
      return null;
    }

    try {
      await this.startWriteBackTurn(claimed, options);
      this.markWriteBackTurnStarted(claimed.threadId);
      this.context.stateStore.markWriteBackQueueItemSent(claimed.id);
      const sent = this.context.stateStore.getWriteBackQueueItem(claimed.id) ?? claimed;
      this.appendWriteBackCanonicalEvent(sent, "writeBackSent", "Started new Codex turn from queued Discord message.");
      return sent;
    } catch (error) {
      const errorMessage = this.formatErrorMessage(error, "Failed to start Codex turn from queued Discord message.");
      if (error instanceof DesktopOriginalThreadUnavailableError) {
        this.context.stateStore.restoreWriteBackQueueItemPending(claimed.id, errorMessage);
        this.appendWriteBackCanonicalEvent(
          { ...claimed, status: "pending", error: errorMessage },
          "writeBackFailed",
          errorMessage
        );
        return this.context.stateStore.getWriteBackQueueItem(claimed.id) ?? {
          ...claimed,
          status: "pending",
          error: errorMessage
        };
      }
      this.context.stateStore.markWriteBackQueueItemFailed(claimed.id, errorMessage);
      this.appendWriteBackCanonicalEvent(
        {
          ...claimed,
          status: "failed",
          error: errorMessage
        },
        "writeBackFailed",
        errorMessage
      );
      return this.context.stateStore.getWriteBackQueueItem(claimed.id) ?? {
        ...claimed,
        status: "failed",
        error: errorMessage
      };
    }
  }

  private async handleQueueWriteBack(
    actor: ProviderActorContext,
    bridge: ThreadBridgeRecord,
    trimmedText: string,
    options: QueueWriteBackOptions = {}
  ): Promise<DiscordCommandResult> {
    const pendingBefore = this.context.stateStore.countPendingWriteBackQueueItems(bridge.codexThreadId);
    if (pendingBefore >= WRITE_BACK_MAX_PENDING_PER_THREAD) {
      return {
        content: `This Codex thread already has ${WRITE_BACK_MAX_PENDING_PER_THREAD} pending queued message(s). Retract one before queueing another.`,
        ephemeral: true
      };
    }

    const queued = this.context.stateStore.createWriteBackQueueItem({
      threadId: bridge.codexThreadId,
      discordChannelId: bridge.discordChannelId,
      actorUserId: actor.userId,
      text: trimmedText,
      sourceKind: options.sourceKind ?? "slash",
      discordMessageId: options.discordMessageId ?? null,
      requestedModel: options.requestedModel ?? null,
      requestedReasoningEffort: options.requestedReasoningEffort ?? null,
      localImagePaths: options.localImagePaths ?? []
    });
    this.appendWriteBackCanonicalEvent(queued, "writeBackQueued", "Queued Discord message for Codex.");

    const busy = this.isThreadBusy(bridge.codexThreadId);
    if (!busy) {
      const sent = await this.drainNextQueuedWriteBackMessage(bridge.codexThreadId, {
        skipResumeForCliSession: true
      });
      if (sent?.id === queued.id && sent.status === "sent") {
        return {
          content: this.formatWriteBackMessage("Started a new Codex turn.", queued.text),
          ephemeral: true
        };
      }
      if (sent?.id === queued.id && sent.status === "failed") {
        return {
          content: sent.error ?? "Failed to start Codex turn from your message.",
          ephemeral: true
        };
      }
      if (sent?.id === queued.id && sent.status === "pending" && sent.error) {
        return {
          content: `原桌面对话暂时不可用，消息已保留在队列中。\n${sent.error}`,
          ephemeral: true,
          buttons: this.buildWriteBackButtons(queued, false, options.plainMode === true)
        };
      }
    }

    const position = this.context.stateStore
      .listWriteBackQueueItems(bridge.codexThreadId)
      .filter((record) => record.status === "pending")
      .findIndex((record) => record.id === queued.id) + 1;
    const canSteer = this.isThreadSteerable(bridge.codexThreadId);
    return {
      content:
        options.plainMode
          ? position > 0
            ? this.formatWriteBackMessage(`已排队，当前位置 ${position}。`, queued.text)
            : this.formatWriteBackMessage("已排队。", queued.text)
          : position > 0
            ? this.formatWriteBackMessage(`Queued for the next turn. Position ${position}.`, queued.text)
            : this.formatWriteBackMessage("Queued for the next turn.", queued.text),
      ephemeral: true,
      buttons: this.buildWriteBackButtons(queued, canSteer, options.plainMode === true)
    };
  }

  private async sendProposedPlanFollowUp(
    actor: ProviderActorContext,
    token: string,
    completionStatus: "accepted" | "feedbackSent",
    feedback?: string
  ): Promise<DiscordCommandResult> {
    const unauthorizedResult = this.authorizePlanAction(actor);
    if (unauthorizedResult) {
      return unauthorizedResult;
    }

    const existing = this.context.stateStore.findProposedPlanActionByToken(token);
    if (!existing) {
      return { content: "This proposed plan could not be found.", ephemeral: true };
    }
    if (Date.parse(existing.expiresAt) <= Date.now()) {
      return { content: "This proposed plan action has expired.", ephemeral: true };
    }
    if (existing.status !== "pending") {
      return {
        content: "This proposed plan has already been answered.",
        ephemeral: true
      };
    }

    const claimed = this.context.stateStore.claimPendingProposedPlanAction(token);
    if (!claimed) {
      return {
        content: "This proposed plan has already been answered.",
        ephemeral: true
      };
    }

    const bridge = this.context.stateStore.getThreadBridge(claimed.threadId);
    if (!bridge?.discordChannelId) {
      this.context.stateStore.restoreProposedPlanActionPending(token, "Mapped Discord channel was not found.");
      return {
        content: "This proposed plan is not attached to a mapped Discord channel anymore.",
        ephemeral: true
      };
    }

    const outboundText =
      completionStatus === "accepted"
        ? `PLEASE IMPLEMENT THIS PLAN:\n${claimed.planText.trim()}`
        : this.formatProposedPlanFeedback(feedback ?? "");
    const trimmedText = outboundText.trim();
    const textError = this.validateWriteBackText(trimmedText, PROPOSED_PLAN_ACTION_MAX_TEXT_LENGTH);
    if (textError) {
      this.context.stateStore.restoreProposedPlanActionPending(token, textError.content);
      return textError;
    }

    try {
      if (completionStatus === "feedbackSent") {
        if (claimed.turnId) {
          try {
            const steeredTurnId = await this.steerTurnInternally(claimed.threadId, claimed.turnId, trimmedText);
            this.context.stateStore.completeProposedPlanAction(token, completionStatus);
            await this.disableCompletedProposedPlanButtons(claimed, bridge.discordChannelId);
            this.appendWriteBackCanonicalEvent(
              {
                id: 0,
                threadId: claimed.threadId,
                discordChannelId: bridge.discordChannelId,
                actorUserId: actor.userId,
                text: trimmedText,
                sourceKind: "slash",
                discordMessageId: null,
                requestedModel: null,
                requestedReasoningEffort: null,
                localImagePaths: [],
                mirrorConsumedAt: null,
                status: "sent",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                sentAt: new Date().toISOString(),
                error: null
              },
              "writeBackSent",
              `Steered proposed-plan feedback into turn ${steeredTurnId}.`
            );
            return {
              content: this.formatWriteBackMessage("Sent plan feedback to Codex.", trimmedText),
              ephemeral: true
            };
          } catch (error) {
            if (!this.isInactiveSteerError(error)) {
              throw error;
            }
            this.context.logger.info(
              { error, token, threadId: claimed.threadId, turnId: claimed.turnId },
              "Proposed-plan feedback could not steer the original turn; falling back to a follow-up turn."
            );
          }
        }

        const fallbackResult = await this.handleQueueWriteBack(actor, bridge, trimmedText);
        if (!this.isAcceptedWriteBackResult(fallbackResult)) {
          this.context.stateStore.restoreProposedPlanActionPending(token, fallbackResult.content);
          return fallbackResult;
        }
        this.context.stateStore.completeProposedPlanAction(token, completionStatus);
        await this.disableCompletedProposedPlanButtons(claimed, bridge.discordChannelId);
        return {
          ...fallbackResult,
          content: this.formatProposedPlanFollowUpResult("Sent plan feedback to Codex.", fallbackResult)
        };
      }

      const result = await this.handleQueueWriteBack(actor, bridge, trimmedText);
      if (!this.isAcceptedWriteBackResult(result)) {
        this.context.stateStore.restoreProposedPlanActionPending(token, result.content);
        return result;
      }
      this.context.stateStore.completeProposedPlanAction(token, completionStatus);
      await this.disableCompletedProposedPlanButtons(claimed, bridge.discordChannelId);
      return {
        ...result,
        content:
          completionStatus === "accepted"
            ? this.formatProposedPlanFollowUpResult("Accepted the proposed plan.", result)
            : this.formatProposedPlanFollowUpResult("Sent plan feedback to Codex.", result)
      };
    } catch (error) {
      const errorMessage = this.formatErrorMessage(error, "Failed to send proposed-plan response.");
      this.context.stateStore.restoreProposedPlanActionPending(token, errorMessage);
      return {
        content: errorMessage,
        ephemeral: true
      };
    }
  }

  private formatProposedPlanFeedback(feedback: string): string {
    return `Please revise the proposed plan based on this feedback:\n${feedback.trim()}`;
  }

  private formatProposedPlanFollowUpResult(prefix: string, result: DiscordCommandResult): string {
    const startedTurnPrefix = "Started a new Codex turn.";
    const content = result.content.startsWith(`${startedTurnPrefix}\n`)
      ? result.content.slice(startedTurnPrefix.length + 1)
      : result.content === startedTurnPrefix
        ? ""
        : result.content;
    const trimmedContent = content.trim();
    return trimmedContent ? `${prefix}\n${trimmedContent}` : prefix;
  }

  private async handleSteerWriteBack(
    actor: ProviderActorContext,
    bridge: ThreadBridgeRecord,
    trimmedText: string
  ): Promise<DiscordCommandResult> {
    const threadId = bridge.codexThreadId;
    if (!this.isThreadBusy(threadId)) {
      return {
        content: "This Codex thread is idle. Omit `mode` or use `mode:queue` to start a new turn.",
        ephemeral: true
      };
    }

    try {
      await this.steerResolvedThreadOrThrow(threadId, trimmedText, "discord");
      this.appendWriteBackCanonicalEvent(
        {
          id: 0,
          threadId,
          discordChannelId: bridge.discordChannelId,
          actorUserId: actor.userId,
          text: trimmedText,
          sourceKind: "slash",
          discordMessageId: null,
          requestedModel: null,
          requestedReasoningEffort: null,
          localImagePaths: [],
          mirrorConsumedAt: null,
          status: "sent",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          sentAt: new Date().toISOString(),
          error: null
        },
        "writeBackSent",
        "Steered active turn from Discord message."
      );
      return {
        content: this.formatWriteBackMessage("Sent to the active turn.", trimmedText),
        ephemeral: true
      };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === `There is no active Codex turn to steer in thread \`${threadId}\`.`
      ) {
        return {
          content: error.message,
          ephemeral: true
        };
      }
      return {
        content:
          error instanceof Error
            ? `Failed to steer Codex thread \`${threadId}\`: ${error.message}`
            : `Failed to steer Codex thread \`${threadId}\`.`,
        ephemeral: true
      };
    }
  }

  private resolveMappedThreadFromChannel(
    channelId: string
  ): { ok: true; bridge: ThreadBridgeRecord } | { ok: false; result: DiscordCommandResult } {
    const normalizedChannelId = channelId.trim();
    if (!normalizedChannelId) {
      return {
        ok: false,
        result: {
          content: "This command must be used from a mapped Codex Discord channel.",
          ephemeral: true
        }
      };
    }

    const bridge = this.context.stateStore.findThreadBridgeByDiscordChannelId(normalizedChannelId);
    if (!bridge) {
      return {
        ok: false,
        result: {
          content: "This Discord channel is not mapped to a Codex thread.",
          ephemeral: true
        }
      };
    }

    return { ok: true, bridge };
  }

  private async handleFirstMessageInUnmappedChannel(
    actor: ProviderActorContext,
    channelId: string,
    parentChannelId: string | null,
    channelName: string | null,
    messageId: string,
    text: string,
    attachments: ProviderInboundAttachment[]
  ): Promise<DiscordCommandResult | null> {
    if (!parentChannelId || !channelName?.trim()) {
      return {
        content: "此频道尚未绑定 Codex 对话。请在已启用项目的分类下新建文字频道，并发送第一条消息。",
        ephemeral: true
      };
    }
    const current = this.newChannelOperations.get(channelId);
    if (current) {
      return current;
    }
    const operation = this.createThreadForNewDiscordChannel(
      actor,
      channelId,
      parentChannelId,
      channelName.trim(),
      messageId,
      text,
      attachments
    );
    this.newChannelOperations.set(channelId, operation);
    try {
      return await operation;
    } finally {
      this.newChannelOperations.delete(channelId);
    }
  }

  private async createThreadForNewDiscordChannel(
    actor: ProviderActorContext,
    channelId: string,
    parentChannelId: string,
    channelName: string,
    messageId: string,
    text: string,
    attachments: ProviderInboundAttachment[]
  ): Promise<DiscordCommandResult | null> {
    const project = this.context.stateStore
      .listProjectBridges()
      .find((entry) => entry.discordCategoryId === parentChannelId);
    if (!project || !this.context.stateStore.getMonitorProject(project.projectKey)?.enabled) {
      return {
        content: "此频道所在分类未启用监控。请先在 `#监控管理` 勾选项目后再创建频道。",
        ephemeral: true
      };
    }

    const localImagePaths = await this.cacheDiscordImageAttachments(messageId, attachments);
    const trimmedText = text.trim() || (localImagePaths.length > 0 ? "请查看附图。" : "");
    const textError = this.validateWriteBackText(trimmedText);
    if (textError) {
      return textError;
    }

    try {
      const requestedModel =
        this.context.stateStore.getBridgeMetaValue(DEFAULT_NEW_THREAD_MODEL_META_KEY)?.trim() ||
        DEFAULT_NEW_THREAD_MODEL;
      const requestedReasoningEffort =
        this.context.stateStore.getBridgeMetaValue(DEFAULT_NEW_THREAD_REASONING_META_KEY)?.trim() ||
        DEFAULT_NEW_THREAD_REASONING_EFFORT;
      const started = await this.context.codexAdapter.startThread({
        cwd: project.projectKey,
        model: requestedModel,
        reasoningEffort: requestedReasoningEffort
      });
      await this.context.codexAdapter.setThreadName(started.id, channelName);
      const summary = { ...started, name: channelName };
      this.context.stateStore.upsertDiscoveredMonitorThread({
        threadId: started.id,
        projectKey: project.projectKey,
        projectName: project.projectName,
        threadName: channelName,
        threadStatus: summary.status.type,
        lastSeenAt: new Date().toISOString()
      });
      this.context.stateStore.setMonitorThreadSelected(started.id, true, actor.userId);
      await this.deps.hydrateThread(started.id, summary, "manual", {
        existingDiscordChannelId: channelId,
        preferredName: channelName,
        sourceKind: "app-server",
        allowFilesystemScan: false
      });
      const bridge = this.context.stateStore.getThreadBridge(started.id);
      if (!bridge) {
        throw new Error("New Codex thread was created but Discord mapping was not saved.");
      }
      this.context.stateStore.setDiscordThreadModelPreference(
        started.id,
        requestedModel,
        requestedReasoningEffort
      );
      const result = await this.handleQueueWriteBack(actor, bridge, trimmedText, {
        sourceKind: "plain",
        discordMessageId: messageId,
        requestedModel,
        requestedReasoningEffort,
        localImagePaths,
        plainMode: true
      });
      return result.content.startsWith("Started a new Codex turn.") ? null : result;
    } catch (error) {
      this.context.logger.warn({ error, channelId, projectKey: project.projectKey }, "Failed to create a Codex thread from a Discord channel.");
      return {
        content: error instanceof Error ? `创建 Codex 对话失败：${error.message}` : "创建 Codex 对话失败。",
        ephemeral: true
      };
    }
  }

  private validateWriteBackText(
    trimmedText: string,
    maxLength = WRITE_BACK_MAX_TEXT_LENGTH
  ): DiscordCommandResult | null {
    if (!trimmedText) {
      return {
        content: "Message text cannot be empty.",
        ephemeral: true
      };
    }
    if (trimmedText.length > maxLength) {
      return {
        content: `Message text is too long. Keep it at or below ${maxLength} characters.`,
        ephemeral: true
      };
    }
    return null;
  }

  private buildModelSelectionResult(
    threadId: string,
    models: Array<{
      id: string;
      displayName: string;
      supportedReasoningEfforts: string[];
      defaultReasoningEffort: string | null;
      isDefault: boolean;
    }>
  ): DiscordCommandResult {
    const current = this.context.stateStore.getDiscordThreadModelPreference(threadId);
    const currentReasoningEffort = this.context.stateStore.getDiscordThreadReasoningEffortPreference(threadId);
    const ordered = current
      ? [
          ...models.filter((entry) => entry.id === current),
          ...models.filter((entry) => entry.id !== current)
        ]
      : models;
    const options = ordered.slice(0, 24).map((entry) => ({
      label: entry.displayName.slice(0, 100),
      value: entry.id,
      default: entry.id === current
    }));
    const selected =
      ordered.find((entry) => entry.id === current) ??
      models.find((entry) => entry.isDefault) ??
      models[0] ??
      null;
    const selectedReasoningEffort = currentReasoningEffort ?? selected?.defaultReasoningEffort ?? null;
    const currentSelectionLabel = current
      ? `${selected?.displayName ?? current}${selectedReasoningEffort ? ` · ${selectedReasoningEffort}` : ""}`
      : "跟随 Codex 默认模型";
    const latestSent = this.context.stateStore
      .listWriteBackQueueItems(threadId)
      .filter((record) => record.status === "sent")
      .sort((left, right) => right.id - left.id)[0] ?? null;
    const latestModel = latestSent?.requestedModel
      ? models.find((entry) => entry.id === latestSent.requestedModel)
      : null;
    const latestSentLabel = latestSent
      ? latestSent.requestedModel
        ? `${latestModel?.displayName ?? latestSent.requestedModel}${
            latestSent.requestedReasoningEffort ? ` · ${latestSent.requestedReasoningEffort}` : ""
          }`
        : "跟随 Codex 默认模型"
      : "暂无 Discord 发送记录";
    const reasoningMenu = selected && (selected.supportedReasoningEfforts?.length ?? 0) > 0
      ? [{
          customId: "codex:reasoning-effort:select",
          placeholder: "选择推理强度",
          minValues: 1,
          maxValues: 1,
          options: selected.supportedReasoningEfforts.slice(0, 25).map((effort) => ({
            label: effort.slice(0, 100),
            value: effort,
            default: effort === (currentReasoningEffort ?? selected.defaultReasoningEffort)
          }))
        }]
      : [];
    return {
      content:
        "选择模型。只影响此频道以后由 Discord 发起的新一轮；引导沿用当前轮模型。\n\n" +
        `当前频道设置：**${currentSelectionLabel}**\n` +
        `最近一次 Discord 发送：**${latestSentLabel}**`,
      ephemeral: true,
      selectMenus: [
        {
          customId: "codex:model:select",
          placeholder: "选择下一轮模型",
          minValues: 1,
          maxValues: 1,
          options: [
            {
              label: "跟随 Codex 默认模型",
              value: CODEX_DEFAULT_MODEL_VALUE,
              default: current === null
            },
            ...options
          ]
        },
        ...reasoningMenu
      ]
    };
  }

  private isAcceptedWriteBackResult(result: DiscordCommandResult): boolean {
    return (
      result.content.startsWith("Started a new Codex turn.") ||
      result.content.startsWith("Queued for the next turn.")
    );
  }

  private isInactiveSteerError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    const message = error.message.toLowerCase();
    return (
      message.includes("active turn already ended") ||
      message.includes("no active codex turn to steer") ||
      message.includes("no active turn to steer")
    );
  }

  private async disableCompletedProposedPlanButtons(
    record: { token: string; discordMessageId: string | null },
    discordChannelId: string
  ): Promise<void> {
    if (!record.discordMessageId) {
      return;
    }

    try {
      const detailButtons = this.context.stateStore
        .listMessageDetailsByDiscordMessageId(record.discordMessageId)
        .map((detail) => ({
          token: detail.token,
          label: detail.buttonLabel
        }));
      await this.context.provider.updateMessageDetailsButtons(
        discordChannelId,
        record.discordMessageId,
        detailButtons
      );
    } catch (error) {
      this.context.logger.warn(
        { error, token: record.token, discordChannelId, discordMessageId: record.discordMessageId },
        "Failed to remove completed proposed-plan action buttons."
      );
    }
  }

  private isThreadBusy(threadId: string): boolean {
    this.reconcileCompletedTurnFromCanonicalEvents(threadId);
    const desktopBusyState = this.readDesktopThreadBusyState(threadId);
    if (desktopBusyState !== null) {
      return desktopBusyState;
    }
    const state = this.runtime.threadState.get(threadId);
    if (state) {
      return this.isRuntimeStateBusy(state);
    }
    const persisted = this.context.stateStore.getThreadBridge(threadId);
    return Boolean(
      persisted?.lastTurnStatus === "in_progress" ||
        persisted?.lastStatusType === "active"
    );
  }

  private isRuntimeStateBusy(state: ThreadRuntimeState | undefined): boolean {
    return Boolean(
      state?.lastTurnStatus === "in_progress" ||
        state?.status.type === "active"
    );
  }

  private isThreadSteerable(threadId: string): boolean {
    this.reconcileCompletedTurnFromCanonicalEvents(threadId);
    const desktopBusyState = this.readDesktopThreadBusyState(threadId);
    if (desktopBusyState === false) {
      return false;
    }
    const state = this.runtime.threadState.get(threadId);
    const recoveredState = this.recoverSteerableDesktopState(threadId);
    if (hasSteerableActiveTurn(recoveredState) || hasSteerableActiveTurn(state)) {
      return true;
    }
    return desktopBusyState === true && this.isRuntimeStateBusy(state);
  }

  async handleDesktopConversationStateChanged(
    threadId: string,
    desktopConversationState: DesktopConversationState
  ): Promise<void> {
    if (this.desktopSteerPayload.readDesktopThreadBusyState(desktopConversationState) !== false) {
      return;
    }
    await this.finishStaleDesktopTurn(threadId, desktopConversationState);
  }

  async reconcileStaleDesktopStatuses(): Promise<void> {
    const desktopIpcClient = this.context.desktopIpcClient;
    if (!desktopIpcClient?.isReady()) {
      return;
    }

    for (const bridge of this.context.stateStore.listThreadBridgesByKind("conversation")) {
      if (
        bridge.sourceKind !== "app-server" ||
        bridge.lastTurnStatus !== "in_progress" ||
        !bridge.lastTurnId
      ) {
        continue;
      }

      const desktopConversationState = desktopIpcClient.getConversationState(bridge.codexThreadId);
      if (desktopConversationState) {
        if (this.desktopSteerPayload.readDesktopThreadBusyState(desktopConversationState) === false) {
          await this.finishStaleDesktopTurn(bridge.codexThreadId, desktopConversationState);
        }
        continue;
      }

      const lastSeenAtMs = bridge.lastSeenAt ? Date.parse(bridge.lastSeenAt) : Number.NaN;
      if (
        !Number.isFinite(lastSeenAtMs) ||
        Date.now() - lastSeenAtMs < STALE_DESKTOP_ACTIVE_GRACE_MS
      ) {
        continue;
      }

      try {
        const summary = await this.context.codexAdapter.readThread(bridge.codexThreadId, false);
        if (summary.status.type !== "active") {
          await this.finishStaleDesktopTurn(bridge.codexThreadId, null);
        }
      } catch (error) {
        this.context.logger.debug(
          { error, threadId: bridge.codexThreadId },
          "Failed to reconcile a stale Desktop task status."
        );
      }
    }
  }

  private async finishStaleDesktopTurn(
    threadId: string,
    desktopConversationState: DesktopConversationState | null
  ): Promise<void> {
    const bridge = this.context.stateStore.getThreadBridge(threadId);
    if (!bridge?.lastTurnId || bridge.lastTurnStatus !== "in_progress") {
      return;
    }

    const completedGoal = desktopConversationState?.completedThreadGoal;
    const hasFinalAnswer = this.context.stateStore
      .listCanonicalThreadEvents(threadId, 100)
      .some(
        (event) =>
          event.eventKind === "content" &&
          event.itemKind === "agentAnswer" &&
          event.turnId === bridge.lastTurnId
      );
    const terminalStatus =
      hasFinalAnswer ||
      (completedGoal &&
        typeof completedGoal === "object" &&
        (completedGoal as { status?: unknown }).status === "complete")
        ? "completed"
        : "stopped";
    const state = this.runtime.threadState.get(threadId);
    if (state) {
      markThreadTurnCompleted(state, terminalStatus);
      this.deps.persistThreadState(state);
    } else {
      this.context.stateStore.upsertThreadBridge({
        ...bridge,
        lastStatusType: "idle",
        lastTurnStatus: terminalStatus
      });
    }
    this.deps.queueStatusUpdate(threadId);
    await this.deps.setTurnStatus(threadId, bridge.lastTurnId, terminalStatus);
  }

  private readDesktopThreadBusyState(threadId: string): boolean | null {
    const desktopIpcClient = this.context.desktopIpcClient;
    if (
      !desktopIpcClient ||
      typeof desktopIpcClient.isReady !== "function" ||
      !desktopIpcClient.isReady() ||
      typeof desktopIpcClient.canStartTurnInDesktopThread !== "function" ||
      !desktopIpcClient.canStartTurnInDesktopThread(threadId)
    ) {
      return null;
    }
    return this.desktopSteerPayload.readDesktopThreadBusyState(
      desktopIpcClient.getConversationState(threadId)
    );
  }

  private recoverSteerableDesktopState(threadId: string): ThreadRuntimeState | undefined {
    const desktopIpcClient = this.context.desktopIpcClient;
    if (
      !desktopIpcClient ||
      typeof desktopIpcClient.isReady !== "function" ||
      !desktopIpcClient.isReady() ||
      typeof desktopIpcClient.canStartTurnInDesktopThread !== "function" ||
      !desktopIpcClient.canStartTurnInDesktopThread(threadId)
    ) {
      return this.runtime.threadState.get(threadId);
    }

    const turnId = this.desktopSteerPayload.findDesktopInProgressTurnId(
      desktopIpcClient.getConversationState(threadId)
    );
    if (!turnId) {
      return this.runtime.threadState.get(threadId);
    }

    let state = this.runtime.threadState.get(threadId);
    if (!state) {
      const persisted = this.context.stateStore.getThreadBridge(threadId);
      if (!persisted) {
        return undefined;
      }
      state = {
        threadId,
        parentThreadId: persisted.parentCodexThreadId,
        projectKey: persisted.projectKey,
        projectName: persisted.projectName,
        channelKind: persisted.channelKind,
        sourceKind: persisted.sourceKind ?? "app-server",
        name: persisted.threadName,
        actorName: persisted.actorName ?? null,
        preview: null,
        cwd: persisted.cwd,
        repoName: persisted.repoName,
        status: { type: "active" },
        lastActivityAt: persisted.lastSeenAt ? new Date(persisted.lastSeenAt).getTime() : null,
        latestCommandPreview: null,
        latestAgentMessage: null,
        lastTurnId: turnId,
        lastTurnStatus: "in_progress"
      };
      this.runtime.threadState.set(threadId, state);
    } else {
      markThreadTurnInProgress(state, turnId);
    }
    this.deps.persistThreadState(state);
    return state;
  }

  private reconcileCompletedTurnFromCanonicalEvents(threadId: string): void {
    const state = this.runtime.threadState.get(threadId);
    const persisted = this.context.stateStore.getThreadBridge(threadId);
    const trackedTurnId =
      state?.lastTurnStatus === "in_progress"
        ? state.lastTurnId
        : persisted?.lastTurnStatus === "in_progress"
          ? persisted.lastTurnId
          : null;
    if (!trackedTurnId) {
      return;
    }

    const hasFinalAnswer = this.context.stateStore
      .listCanonicalThreadEvents(threadId, 100)
      .some(
        (event) =>
          event.eventKind === "content" &&
          event.itemKind === "agentAnswer" &&
          event.turnId === trackedTurnId
      );
    if (!hasFinalAnswer) {
      return;
    }

    if (state) {
      markThreadTurnCompleted(state, "completed");
      this.deps.persistThreadState(state);
      this.deps.queueStatusUpdate(threadId);
      return;
    }

    if (persisted) {
      this.context.stateStore.upsertThreadBridge({
        ...persisted,
        lastStatusType: "idle",
        lastTurnStatus: "completed"
      });
    }
  }

  private markWriteBackTurnStarted(threadId: string): void {
    const state = this.runtime.threadState.get(threadId);
    if (!state) {
      return;
    }
    state.lastTurnId = null;
    markThreadTurnInProgress(state, null);
    this.deps.persistThreadState(state);
    this.deps.queueStatusUpdate(threadId);
  }

  private appendWriteBackCanonicalEvent(
    record: WriteBackQueueRecord,
    eventKind: "writeBackQueued" | "writeBackSent" | "writeBackFailed" | "writeBackRetracted",
    summary: string
  ): void {
    this.context.stateStore.appendCanonicalThreadEvent({
      threadId: record.threadId,
      source: "discord",
      eventKind,
      itemKind: "writeBack",
      turnId: null,
      turnCursor: null,
      itemId: record.id > 0 ? `write-back:${record.id}` : null,
      requestId: null,
      summary,
      detail: JSON.stringify(
        {
          id: record.id,
          status: record.status,
          actorUserId: record.actorUserId,
          discordChannelId: record.discordChannelId,
          error: record.error
        },
        null,
        2
      ),
      createdAt: new Date().toISOString()
    });
  }

  private buildWriteBackButtons(
    record: WriteBackQueueRecord,
    _canSteer: boolean,
    plainMode = record.sourceKind === "plain"
  ): NonNullable<DiscordCommandResult["buttons"]> {
    return [
      {
        customId: `codex:writeback:steer:${record.id}`,
        label: plainMode ? "立即发送" : "Send now",
        style: "primary" as const
      },
      {
        customId: `codex:writeback:retract:${record.id}`,
        label: plainMode ? "删除" : "Retract",
        style: "danger" as const
      }
    ];
  }

  private formatWriteBackMessage(prefix: string, text: string): string {
    return `${prefix}\n> ${this.formatWriteBackPreview(text)}`;
  }

  private formatWriteBackPreview(text: string): string {
    const singleLine = text.trim().replace(/\s+/g, " ");
    if (singleLine.length <= WRITE_BACK_PREVIEW_MAX_LENGTH) {
      return singleLine;
    }
    return `${singleLine.slice(0, WRITE_BACK_PREVIEW_MAX_LENGTH - 3).trimEnd()}...`;
  }

  private formatErrorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? `${fallback} ${error.message}` : fallback;
  }

  private buildWriteBackInput(text: string, localImagePaths: string[]): unknown[] {
    return [
      { type: "text", text },
      ...localImagePaths.map((imagePath) => ({ type: "localImage", path: imagePath }))
    ];
  }

  private async cacheDiscordImageAttachments(
    messageId: string,
    attachments: ProviderInboundAttachment[]
  ): Promise<string[]> {
    const eligible = attachments.slice(0, MAX_DISCORD_IMAGE_COUNT).filter((attachment) => {
      if (attachment.size !== null && attachment.size > MAX_DISCORD_IMAGE_BYTES) {
        return false;
      }
      const extension = path.extname(attachment.name).toLowerCase();
      return attachment.contentType?.toLowerCase().startsWith("image/") === true ||
        DISCORD_IMAGE_EXTENSIONS.has(extension);
    });
    if (eligible.length === 0) {
      return [];
    }

    const cacheDirectory = path.join(
      path.dirname(this.context.runtimeConfig.configPath),
      "data",
      "discord-images"
    );
    await mkdir(cacheDirectory, { recursive: true });
    const cachedPaths: string[] = [];

    for (const attachment of eligible) {
      try {
        const attachmentUrl = new URL(attachment.url);
        if (attachmentUrl.protocol !== "https:" || !DISCORD_IMAGE_HOSTS.has(attachmentUrl.hostname.toLowerCase())) {
          continue;
        }
        const response = await fetch(attachmentUrl, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length === 0 || bytes.length > MAX_DISCORD_IMAGE_BYTES) {
          throw new Error("image size is outside the allowed range");
        }
        const extension = this.resolveDiscordImageExtension(attachment);
        if (!extension) {
          continue;
        }
        const safeMessageId = messageId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "message";
        const cachedPath = path.join(cacheDirectory, `${safeMessageId}-${randomUUID()}${extension}`);
        await writeFile(cachedPath, bytes);
        cachedPaths.push(cachedPath);
      } catch (error) {
        this.context.logger.warn(
          { error, attachmentName: attachment.name },
          "Failed to cache a Discord image attachment for Codex."
        );
      }
    }

    return cachedPaths;
  }

  private resolveDiscordImageExtension(attachment: ProviderInboundAttachment): string | null {
    const fromName = path.extname(attachment.name).toLowerCase();
    if (DISCORD_IMAGE_EXTENSIONS.has(fromName)) {
      return fromName;
    }
    switch (attachment.contentType?.toLowerCase()) {
      case "image/png":
        return ".png";
      case "image/jpeg":
        return ".jpg";
      case "image/webp":
        return ".webp";
      case "image/gif":
        return ".gif";
      default:
        return null;
    }
  }

  private async startWriteBackTurn(
    record: WriteBackQueueRecord,
    options: WriteBackTurnStartOptions = {}
  ): Promise<void> {
    const { threadId, text } = record;
    const sourceKind =
      this.runtime.threadState.get(threadId)?.sourceKind ??
      this.context.stateStore.getThreadBridge(threadId)?.sourceKind ??
      "app-server";
    if (sourceKind === "cli-session" && options.skipResumeForCliSession) {
      await this.context.codexAdapter.startTurn(threadId, text, {
        model: record.requestedModel,
        reasoningEffort: record.requestedReasoningEffort,
        localImagePaths: record.localImagePaths
      });
      return;
    }

    const desktopIpcClient = this.context.desktopIpcClient;
    const bridgeRemoteThread =
      sourceKind === "app-server" && (await this.isBridgeRemoteCliThread(threadId));
    if (
      record.sourceKind === "plain" &&
      sourceKind !== "cli-session"
    ) {
      await this.ensureOriginalDesktopOwner(threadId);
    }
    if (
      sourceKind !== "cli-session" &&
      desktopIpcClient &&
      typeof desktopIpcClient.canStartTurnInDesktopThread === "function" &&
      desktopIpcClient.canStartTurnInDesktopThread(threadId)
    ) {
      const turnStartParams = {
        input: this.buildWriteBackInput(text, record.localImagePaths),
        attachments: [],
        ...(record.requestedModel ? { model: record.requestedModel } : {}),
        ...(record.requestedReasoningEffort ? { reasoningEffort: record.requestedReasoningEffort } : {})
      };
      try {
        await desktopIpcClient.startTurn(threadId, turnStartParams);
        return;
      } catch (error) {
        if (record.sourceKind !== "plain" || !this.isNoClientFoundError(error)) {
          throw error;
        }
        const ownerRecovered = await this.ensureOriginalDesktopOwner(threadId, true);
        if (!ownerRecovered) {
          throw new DesktopOriginalThreadUnavailableError(
            "The original Codex Desktop conversation is not connected or has no current Desktop owner."
          );
        }
        try {
          await desktopIpcClient.startTurn(threadId, turnStartParams);
          return;
        } catch (retryError) {
          if (this.isNoClientFoundError(retryError)) {
            throw new DesktopOriginalThreadUnavailableError(
              "The original Codex Desktop conversation is not connected or has no current Desktop owner."
            );
          }
          throw retryError;
        }
      }
    }

    if (bridgeRemoteThread) {
      await this.context.codexAdapter.startTurn(threadId, text, {
        model: record.requestedModel,
        reasoningEffort: record.requestedReasoningEffort,
        localImagePaths: record.localImagePaths
      });
      return;
    }

    if (record.sourceKind === "plain" && sourceKind !== "cli-session") {
      throw new DesktopOriginalThreadUnavailableError(
        "The original Codex Desktop conversation is not connected or has no current Desktop owner."
      );
    }

    await this.context.codexAdapter.resumeThread(threadId);
    await this.context.codexAdapter.startTurn(threadId, text, {
      model: record.requestedModel,
      reasoningEffort: record.requestedReasoningEffort,
      localImagePaths: record.localImagePaths
    });
  }

  private async ensureOriginalDesktopOwner(threadId: string, forceOpen = false): Promise<boolean> {
    const desktopIpcClient = this.context.desktopIpcClient;
    if (
      !desktopIpcClient ||
      typeof desktopIpcClient.isReady !== "function" ||
      !desktopIpcClient.isReady() ||
      typeof desktopIpcClient.canStartTurnInDesktopThread !== "function"
    ) {
      return false;
    }
    if (!forceOpen && desktopIpcClient.canStartTurnInDesktopThread(threadId)) {
      return true;
    }

    try {
      this.deps.openCodexThreadInDesktop(threadId);
      if (typeof desktopIpcClient.waitForOwnerClientId === "function") {
        await desktopIpcClient.waitForOwnerClientId(threadId, DESKTOP_OWNER_RECOVERY_TIMEOUT_MS);
      }
    } catch (error) {
      this.context.logger.debug(
        { error, threadId },
        "Failed to reopen the original Codex Desktop conversation for Discord write-back."
      );
    }
    return desktopIpcClient.canStartTurnInDesktopThread(threadId);
  }

  private isNoClientFoundError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.toLowerCase().includes("no-client-found");
  }

  private async isBridgeRemoteCliThread(threadId: string): Promise<boolean> {
    try {
      const metadata = await this.context.codexAdapter.resolveMetadata(threadId, {
        allowFilesystemScan: false
      });
      return metadata.originator?.trim().toLowerCase() === BRIDGE_REMOTE_CLI_ORIGINATOR;
    } catch (error) {
      this.context.logger.debug({ error, threadId }, "Failed to resolve session originator for write-back route.");
      return false;
    }
  }

  async steerTurnInternally(targetThreadId: string, expectedTurnId: string, text: string): Promise<string> {
    const normalizedThreadId = targetThreadId.trim();
    if (!normalizedThreadId) {
      throw new Error("Thread id cannot be empty.");
    }

    const normalizedTurnId = expectedTurnId.trim();
    if (!normalizedTurnId) {
      throw new Error("Turn id cannot be empty.");
    }

    const trimmedText = text.trim();
    if (!trimmedText) {
      throw new Error("Steer text cannot be empty.");
    }

    const runtimeState = this.runtime.threadState.get(normalizedThreadId);
    this.logSteerState("before-resume", normalizedThreadId, runtimeState, "approval-feedback");
    await this.context.codexAdapter.resumeThread(normalizedThreadId);
    return this.sendSteerInstruction(
      normalizedThreadId,
      {
        lastTurnId: normalizedTurnId,
        sourceKind:
          runtimeState?.sourceKind ?? this.context.stateStore.getThreadBridge(normalizedThreadId)?.sourceKind ?? null
      },
      trimmedText,
      {
        preferredTurnId: normalizedTurnId,
        preservePreferredTurnId: true
      }
    );
  }

  private async steerResolvedThread(
    targetThreadId: string,
    trimmedText: string,
    source: InternalSteerSource
  ): Promise<DiscordCommandResult> {
    try {
      const steeredTurnId = await this.steerResolvedThreadOrThrow(targetThreadId, trimmedText, source);
      return {
        content: `Steered active turn \`${steeredTurnId}\` in Codex thread \`${targetThreadId}\`.`
      };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === `There is no active Codex turn to steer in thread \`${targetThreadId}\`.`
      ) {
        return {
          content: error.message,
          ephemeral: true
        };
      }
      return {
        content:
          error instanceof Error
            ? `Failed to steer Codex thread \`${targetThreadId}\`: ${error.message}`
            : `Failed to steer Codex thread \`${targetThreadId}\`.`,
        ephemeral: true
      };
    }
  }

  private async steerResolvedThreadOrThrow(
    targetThreadId: string,
    trimmedText: string,
    source: InternalSteerSource,
    localImagePaths: string[] = []
  ): Promise<string> {
    this.logSteerState("before-steer-resolution", targetThreadId, this.runtime.threadState.get(targetThreadId), source);
    const desktopIpcClient = this.context.desktopIpcClient;
    const desktopOwnsThread = Boolean(
      desktopIpcClient?.isReady() &&
        typeof desktopIpcClient.canStartTurnInDesktopThread === "function" &&
        desktopIpcClient.canStartTurnInDesktopThread(targetThreadId)
    );
    if (!desktopOwnsThread) {
      await this.context.codexAdapter.resumeThread(targetThreadId);
    }
    let state = await this.resolveSteerableActiveTurn(targetThreadId);
    if (!hasSteerableActiveTurn(state)) {
      for (const retryDelayMs of STEER_ACTIVE_TURN_RETRY_DELAYS_MS) {
        await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
        state = await this.resolveSteerableActiveTurn(targetThreadId);
        if (hasSteerableActiveTurn(state)) {
          break;
        }
      }
    }
    if (!hasSteerableActiveTurn(state)) {
      this.logSteerState("refusing-no-active-turn", targetThreadId, state, source);
      throw new Error(`There is no active Codex turn to steer in thread \`${targetThreadId}\`.`);
    }

    this.logSteerState("resolved-active-turn", targetThreadId, state, source);
    return this.sendSteerInstruction(targetThreadId, state, trimmedText, { localImagePaths });
  }

  private async resolveSteerableActiveTurn(targetThreadId: string) {
    let state = this.runtime.threadState.get(targetThreadId);
    this.logSteerState("runtime-check", targetThreadId, state);
    if (hasSteerableActiveTurn(state)) {
      return state;
    }

    state = this.recoverSteerableDesktopState(targetThreadId);
    this.logSteerState("after-desktop-recovery", targetThreadId, state);
    if (hasSteerableActiveTurn(state)) {
      return state;
    }

    try {
      await this.deps.drainThreadEventQueue([targetThreadId]);
    } catch (error) {
      this.context.logger.debug({ error, targetThreadId }, "Failed to drain pending thread events before steering.");
    }
    state = this.runtime.threadState.get(targetThreadId);
    this.logSteerState("after-drain", targetThreadId, state);
    if (hasSteerableActiveTurn(state)) {
      return state;
    }

    try {
      await this.deps.pollThreadSessionEvents(targetThreadId);
      await this.deps.drainThreadEventQueue([targetThreadId]);
    } catch (error) {
      this.context.logger.debug({ error, targetThreadId }, "Failed to poll fresh session events before steering.");
    }
    state = this.runtime.threadState.get(targetThreadId);
    this.logSteerState("after-session-poll", targetThreadId, state);
    if (hasSteerableActiveTurn(state)) {
      return state;
    }

    try {
      const recoveredTurnId = await this.deps.readLatestTurnBackfillTurnId(targetThreadId);
      if (recoveredTurnId) {
        if (state) {
          markThreadTurnInProgress(state, recoveredTurnId);
        }
      }
    } catch (error) {
      this.context.logger.debug(
        { error, targetThreadId },
        "Failed to recover an active turn from session backfill before steering."
      );
    }
    state = this.runtime.threadState.get(targetThreadId);
    this.logSteerState("after-session-backfill", targetThreadId, state);
    if (hasSteerableActiveTurn(state)) {
      return state;
    }

    const persistedBridge = this.context.stateStore.getThreadBridge(targetThreadId);
    if (persistedBridge?.lastTurnId && persistedBridge.lastTurnStatus === "in_progress") {
      if (state) {
        markThreadTurnInProgress(state, persistedBridge.lastTurnId);
      } else {
        state = {
          threadId: targetThreadId,
          parentThreadId: persistedBridge.parentCodexThreadId,
          projectKey: persistedBridge.projectKey,
          projectName: persistedBridge.projectName,
          channelKind: persistedBridge.channelKind,
          sourceKind: persistedBridge.sourceKind ?? "app-server",
          name: persistedBridge.threadName,
          actorName: persistedBridge.actorName ?? null,
          preview: null,
          cwd: persistedBridge.cwd,
          repoName: persistedBridge.repoName,
          status: { type: persistedBridge.lastStatusType === "active" ? "active" : "idle" },
          lastActivityAt: persistedBridge.lastSeenAt ? new Date(persistedBridge.lastSeenAt).getTime() : null,
          latestCommandPreview: null,
          latestAgentMessage: null,
          lastTurnId: persistedBridge.lastTurnId,
          lastTurnStatus: "in_progress"
        } as unknown as NonNullable<typeof state>;
        this.runtime.threadState.set(targetThreadId, state);
      }
    }
    this.logSteerState("after-store-recovery", targetThreadId, state);
    if (hasSteerableActiveTurn(state)) {
      return state;
    }

    try {
      const details = await this.context.codexAdapter.readThread(targetThreadId, true);
      const recoveredTurnId = this.desktopSteerPayload.findInProgressTurnId(details.turns);
      if (recoveredTurnId) {
        if (state) {
          markThreadTurnInProgress(state, recoveredTurnId);
        } else {
          state = {
            threadId: targetThreadId,
            parentThreadId: null,
            projectKey: "",
            projectName: "",
            channelKind: "conversation",
            sourceKind: "app-server",
            name: details.name ?? details.preview ?? targetThreadId,
            actorName: null,
            preview: details.preview ?? null,
            cwd: null,
            repoName: null,
            status: details.status,
            lastActivityAt: null,
            latestCommandPreview: null,
            latestAgentMessage: null,
            lastTurnId: recoveredTurnId,
            lastTurnStatus: "in_progress"
          } as unknown as NonNullable<typeof state>;
          this.runtime.threadState.set(targetThreadId, state);
        }
      }
    } catch (error) {
      this.context.logger.debug({ error, targetThreadId }, "Failed to recover an active turn from thread/read before steering.");
    }
    this.logSteerState("after-thread-read", targetThreadId, state);
    return state;
  }

  private async sendSteerInstruction(
    targetThreadId: string,
    state: { lastTurnId: string; sourceKind?: "app-server" | "cli-session" | null },
    trimmedText: string,
    options: {
      preferredTurnId?: string;
      preservePreferredTurnId?: boolean;
      localImagePaths?: string[];
    } = {}
  ): Promise<string> {
    const preferredTurnId =
      typeof options.preferredTurnId === "string" && options.preferredTurnId.trim().length > 0
        ? options.preferredTurnId.trim()
        : state.lastTurnId;
    const desktopIpcClient = this.context.desktopIpcClient;
    if (
      desktopIpcClient?.isReady() &&
      state.sourceKind !== "cli-session" &&
      !(state.sourceKind === "app-server" && (await this.isBridgeRemoteCliThread(targetThreadId)))
    ) {
      let restoreStateSource: DesktopSteerRestoreStateSource = "none";
      let desktopConversationState = desktopIpcClient.getConversationState(targetThreadId);
      let waitedForConversationState = false;
      let waitForConversationStateDurationMs = 0;
      if (!desktopConversationState) {
        waitedForConversationState = true;
        const waitStartedAt = Date.now();
        desktopConversationState = await desktopIpcClient.waitForConversationState(targetThreadId);
        waitForConversationStateDurationMs = Date.now() - waitStartedAt;
      }
      if (desktopConversationState) {
        restoreStateSource = "desktop-ipc";
      } else {
        desktopConversationState = await this.readSteerConversationStateFromThread(targetThreadId);
        if (desktopConversationState) {
          restoreStateSource = "thread-read";
        }
      }

      const fallbackCwd =
        this.runtime.threadState.get(targetThreadId)?.cwd ??
        this.context.stateStore.getThreadBridge(targetThreadId)?.cwd ??
        null;
      if (
        desktopConversationState &&
        fallbackCwd &&
        (typeof desktopConversationState.cwd !== "string" || desktopConversationState.cwd.trim().length === 0)
      ) {
        desktopConversationState = {
          ...desktopConversationState,
          cwd: fallbackCwd
        };
      }

      const desktopTurnId =
        options.preservePreferredTurnId
          ? preferredTurnId
          : this.desktopSteerPayload.findDesktopInProgressTurnId(desktopConversationState) ?? preferredTurnId;
      const restoreMessage =
        desktopConversationState !== null
          ? this.desktopSteerPayload.buildDesktopRestoreMessage(targetThreadId, desktopConversationState, desktopTurnId)
          : null;
      const steerPayloadSummary = this.desktopSteerPayload.summarizeDesktopSteerPayload(desktopConversationState, restoreMessage);
      this.deps.printProgress(
        withLogScope(
          "steer-payload",
          `Prepared Desktop steer payload for ${shortThreadId(targetThreadId)}: source=${restoreStateSource} turns=${steerPayloadSummary.conversationTurnCount ?? 0} items=${steerPayloadSummary.rollbackItemCount ?? 0} restore=${this.desktopSteerPayload.formatLogBytes(steerPayloadSummary.restoreMessageBytes)} thread=${this.desktopSteerPayload.formatLogBytes(steerPayloadSummary.restoreThreadBytes)} rollback=${this.desktopSteerPayload.formatLogBytes(steerPayloadSummary.restoreRollbackResponseBytes)} context=${this.desktopSteerPayload.formatLogBytes(steerPayloadSummary.restoreContextBytes)} dup=${this.desktopSteerPayload.formatLogBytes(steerPayloadSummary.estimatedDuplicatedThreadBytes)} wait=${formatStartupTimingMs(waitForConversationStateDurationMs)}.`
        )
      );

      this.context.logger.info(
        {
          scope: "steer-payload",
          targetThreadId,
          runtimeTurnId: state.lastTurnId,
          preferredTurnId,
          desktopTurnId,
          restoreStateSource,
          waitedForConversationState,
          waitForConversationStateDurationMs,
          ...steerPayloadSummary
        },
        withLogScope("steer-payload", "Prepared Desktop steer payload summary.")
      );

      this.context.logger.debug(
        {
          scope: "steer-payload",
          targetThreadId,
          runtimeTurnId: state.lastTurnId,
          preferredTurnId,
          desktopTurnId,
          restoreStateSource,
          waitedForConversationState,
          waitForConversationStateDurationMs,
          hasDesktopConversationState: Boolean(desktopConversationState),
          desktopConversationStateKeys: desktopConversationState ? Object.keys(desktopConversationState).slice(0, 12) : [],
          restoreMessageKeys: restoreMessage ? Object.keys(restoreMessage).slice(0, 16) : []
        },
        withLogScope("steer-payload", "Prepared Desktop steer payload context.")
      );
      void this.desktopSteerPayload.dumpOversizedDesktopSteerPayload({
        targetThreadId,
        runtimeTurnId: state.lastTurnId,
        preferredTurnId,
        desktopTurnId,
        restoreStateSource,
        waitedForConversationState,
        waitForConversationStateDurationMs,
        desktopConversationState,
        restoreMessage,
        steerPayloadSummary
      });

      if (!restoreMessage) {
        this.context.logger.info(
          {
            scope: "steer",
            targetThreadId,
            turnId: desktopTurnId,
            restoreStateSource
          },
          withLogScope(
            "steer",
            "Desktop turn details are incomplete; steering through app-server instead."
          )
        );
        await this.context.codexAdapter.steerTurn(targetThreadId, desktopTurnId, trimmedText, {
          localImagePaths: options.localImagePaths ?? []
        });
        return desktopTurnId;
      }

      try {
        await desktopIpcClient.steerTurn(
          targetThreadId,
          desktopTurnId,
          this.buildWriteBackInput(trimmedText, options.localImagePaths ?? []),
          {
            ...(restoreMessage ? { restoreMessage } : {})
          }
        );
        return desktopTurnId;
      } catch (error) {
        this.context.logger.warn(
          {
            scope: "steer",
            error,
            errorMessage: error instanceof Error ? error.message : String(error),
            targetThreadId,
            turnId: desktopTurnId
          },
          withLogScope("steer", "Desktop IPC steer failed; refusing to report success without follower confirmation.")
        );
        throw error instanceof Error ? error : new Error(String(error));
      }
    }

    await this.context.codexAdapter.steerTurn(targetThreadId, preferredTurnId, trimmedText, {
      localImagePaths: options.localImagePaths ?? []
    });
    return preferredTurnId;
  }

  private async readSteerConversationStateFromThread(
    targetThreadId: string
  ): Promise<DesktopConversationState | null> {
    try {
      const details = await this.context.codexAdapter.readThread(targetThreadId, true);
      if (!Array.isArray(details.turns) || details.turns.length === 0) {
        return null;
      }

      const runtimeState = this.runtime.threadState.get(targetThreadId);
      const persistedBridge = this.context.stateStore.getThreadBridge(targetThreadId);
      return {
        id: targetThreadId,
        turns: details.turns,
        requests: [],
        cwd: runtimeState?.cwd ?? persistedBridge?.cwd ?? null,
        updatedAt: details.updatedAt ?? null,
        threadRuntimeStatus: details.status
      };
    } catch (error) {
      this.context.logger.debug(
        { error, targetThreadId },
        "Failed to read thread turn params for Desktop steer restore fallback."
      );
      return null;
    }
  }

  private logSteerState(
    stage: string,
    targetThreadId: string,
    state: BridgeRuntimeState["threadState"] extends Map<string, infer T> ? T | undefined : unknown,
    source?: InternalSteerSource
  ): void {
    this.context.logger.debug(
      {
        stage,
        source: source ?? "resolver",
        targetThreadId,
        hasTrackedThreadState: Boolean(state),
        pendingThreadEventChain: this.runtime.threadEventChains.has(targetThreadId),
        statusType:
          state && typeof state === "object" && "status" in state && state.status && typeof state.status === "object"
            ? (state.status as { type?: unknown }).type ?? null
            : null,
        activeFlags:
          state &&
          typeof state === "object" &&
          "status" in state &&
          state.status &&
          typeof state.status === "object" &&
          Array.isArray((state.status as { activeFlags?: unknown }).activeFlags)
            ? (state.status as { activeFlags?: string[] }).activeFlags ?? []
            : [],
        lastTurnId:
          state && typeof state === "object" && "lastTurnId" in state
            ? (state.lastTurnId as string | null | undefined) ?? null
            : null,
        lastTurnStatus:
          state && typeof state === "object" && "lastTurnStatus" in state
            ? (state.lastTurnStatus as string | null | undefined) ?? null
            : null,
        hasCwd:
          state && typeof state === "object" && "cwd" in state
            ? Boolean((state as { cwd?: unknown }).cwd)
            : false,
        hasRepoName:
          state && typeof state === "object" && "repoName" in state
            ? Boolean((state as { repoName?: unknown }).repoName)
            : false,
        sourceKindTracked:
          state && typeof state === "object" && "sourceKind" in state
            ? ((state as { sourceKind?: unknown }).sourceKind as string | null | undefined) ?? null
            : null
      },
      "Steer state snapshot."
    );
  }

  async handleAttachCommand(
    actor: ProviderActorContext,
    threadId: string
  ): Promise<DiscordCommandResult> {
    const unauthorizedResult = this.authorizeCommand(actor);
    if (unauthorizedResult) {
      return unauthorizedResult;
    }

    const existing = this.context.stateStore.getThreadBridge(threadId);
    const details = await this.context.codexAdapter.readThread(threadId, false);
    await this.deps.hydrateThread(threadId, details, "manual");
    const hydratedBridge = this.context.stateStore.getThreadBridge(threadId);
    if (hydratedBridge) {
      this.context.stateStore.upsertDiscoveredMonitorThread({
        threadId,
        projectKey: hydratedBridge.projectKey,
        projectName: hydratedBridge.projectName,
        threadName: hydratedBridge.threadName,
        threadStatus:
          hydratedBridge.lastStatusType === "active" ||
          hydratedBridge.lastStatusType === "notLoaded" ||
          hydratedBridge.lastStatusType === "systemError"
            ? hydratedBridge.lastStatusType
            : "idle",
        lastSeenAt: hydratedBridge.lastSeenAt
      });
      this.context.stateStore.setMonitorProjectEnabled(hydratedBridge.projectKey, true, actor.userId);
      this.context.stateStore.setMonitorThreadSelected(threadId, true, actor.userId);
    }
    await this.context.codexAdapter.resumeThread(threadId);
    if (existing) {
      this.deps.queueStatusUpdate(threadId);
    } else {
      await this.deps.flushStatusUpdate(threadId);
    }
    const bridge = this.context.stateStore.getThreadBridge(threadId);
    return bridge
      ? { content: `Attached Codex thread \`${threadId}\` to <#${bridge.discordChannelId}>.` }
      : { content: `Attached Codex thread \`${threadId}\`.` };
  }

  async handleDetachCommand(
    actor: ProviderActorContext,
    threadId: string
  ): Promise<DiscordCommandResult> {
    const unauthorizedResult = this.authorizeCommand(actor);
    if (unauthorizedResult) {
      return unauthorizedResult;
    }

    const resolved = this.resolveMappedThreadId(threadId);
    if (!resolved.ok) {
      return resolved.result;
    }
    const { threadId: resolvedThreadId, bridge } = resolved;

    await this.deps.pauseThread(resolvedThreadId, actor.userId);
    return {
      content: `Stopped monitoring Codex thread \`${resolvedThreadId}\`. Discord history remains in <#${bridge.discordChannelId}>.`
    };
  }

  async handleCleanIdCommand(
    actor: ProviderActorContext,
    threadId: string
  ): Promise<DiscordCommandResult> {
    const unauthorizedResult = this.authorizeCommand(actor);
    if (unauthorizedResult) {
      return unauthorizedResult;
    }

    const resolved = this.resolveMappedThreadId(threadId);
    if (!resolved.ok) {
      return resolved.result;
    }
    const { threadId: resolvedThreadId } = resolved;

    const deletedLocations = await this.deps.cleanupThread(
      resolvedThreadId,
      `Clean Discord mapping for Codex thread ${resolvedThreadId}`
    );
    return {
      content: `Cleaned Codex thread \`${resolvedThreadId}\`. Deleted ${deletedLocations} Discord location(s).`
    };
  }

  async handleCleanAllCommand(actor: ProviderActorContext): Promise<DiscordCommandResult> {
    const unauthorizedResult = this.authorizeCommand(actor);
    if (unauthorizedResult) {
      return unauthorizedResult;
    }

    const result = await this.deps.resetBridge();
    return {
      content: `Cleaned the bridge. Deleted ${result.deletedLocations} Discord location(s) and ${result.deletedCategories} categor${result.deletedCategories === 1 ? "y" : "ies"}.`
    };
  }

  async handleHelpCommand(actor: ProviderActorContext): Promise<DiscordCommandResult> {
    const unauthorizedResult = this.authorizeCommand(actor);
    if (unauthorizedResult) {
      return unauthorizedResult;
    }

    return {
      content:
        "Use `/codex manage` for selective project and conversation monitoring. `/codex help`, `/codex attach <thread_id>`, `/codex detach <thread_id>`, `/codex cleanid <thread_id>`, `/codex cleanall`, and `/codex status` remain available."
    };
  }

  private resolveMappedThreadId(
    threadIdInput: string
  ): { ok: true; threadId: string; bridge: ThreadBridgeRecord } | { ok: false; result: DiscordCommandResult } {
    const normalizedInput = threadIdInput.trim();
    if (!normalizedInput) {
      return {
        ok: false,
        result: { content: "Thread id cannot be empty.", ephemeral: true }
      };
    }

    const exactBridge = this.context.stateStore.getThreadBridge(normalizedInput);
    if (exactBridge) {
      return { ok: true, threadId: exactBridge.codexThreadId, bridge: exactBridge };
    }

    const normalizedPrefix = normalizedInput.toLowerCase();
    const matches = this.context.stateStore
      .listThreadBridgesByKind("conversation")
      .filter((bridge) => bridge.codexThreadId.toLowerCase().startsWith(normalizedPrefix));
    if (matches.length === 1) {
      const bridge = matches[0]!;
      return { ok: true, threadId: bridge.codexThreadId, bridge };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        result: {
          content: `Codex thread id \`${normalizedInput}\` matches multiple mapped conversations. Use the full thread id:\n${matches
            .map((bridge) => `- \`${bridge.codexThreadId}\``)
            .join("\n")}`,
          ephemeral: true
        }
      };
    }

    return {
      ok: false,
      result: { content: `No Discord mapping exists for Codex thread \`${normalizedInput}\`.` }
    };
  }

  private authorizeCommand(actor: ProviderActorContext): DiscordCommandResult | null {
    try {
      this.context.policy.ensureCommandAuthorized(actor);
      return null;
    } catch (error) {
      return {
        content:
          error instanceof Error
            ? error.message
            : "This Discord user is not allowed to control the Codex bridge.",
        ephemeral: true
      };
    }
  }

  private authorizePlanAction(actor: ProviderActorContext): DiscordCommandResult | null {
    try {
      this.context.policy.ensureApprovalsEnabled();
      this.context.policy.ensureAuthorized(actor);
      return null;
    } catch (error) {
      return {
        content:
          error instanceof Error
            ? error.message
            : "This Discord user is not allowed to approve Codex actions.",
        ephemeral: true
      };
    }
  }

  private authorizeMessageWriteBack(actor: ProviderActorContext): DiscordCommandResult | null {
    try {
      this.context.policy.ensureMessageWriteBackAuthorized(actor);
      return null;
    } catch (error) {
      return {
        content:
          error instanceof Error
            ? error.message
            : "This Discord user is not allowed to send Codex messages.",
        ephemeral: true
      };
    }
  }

}
