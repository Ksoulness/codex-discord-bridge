import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { TurnStatusCoordinator } from "../src/bridge/status/TurnStatusCoordinator.js";
import { createLogger } from "../src/logger.js";
import type { BridgeProvider } from "../src/providers/types.js";
import { StateStore } from "../src/store/StateStore.js";

interface LiveTextCall {
  channelId: string;
  messageId: string;
  passedMessageId: string | null;
  content: string;
}

interface StatusSuffixCall {
  channelId: string;
  messageId: string;
  statusText: string | null;
}

interface ChannelNameCall {
  channelId: string;
  name: string;
}

function createHarness(options: {
  lastTurnId?: string;
  lastTurnStatus?: string;
  channelKind?: "conversation" | "subagent";
  withCommentary?: boolean;
  failStatusUpdates?: boolean;
  failChannelRenames?: number;
  holdFirstChannelRename?: boolean;
  channelRenameDelayMs?: number;
  channelRenameRetryDelayMs?: number;
  freshThreadName?: string;
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-turn-status-"));
  const stateStore = new StateStore(path.join(dir, "bridge.sqlite"));
  stateStore.upsertThreadBridge({
    codexThreadId: "thread-1",
    parentCodexThreadId: null,
    projectKey: "project-1",
    projectName: "Project 1",
    discordChannelId: "channel-1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "E:\\Code\\project-1",
    repoName: "project-1",
    lastSeenAt: "2026-07-17T10:00:00.000Z",
    attachMode: "auto",
    threadName: "Thread 1",
    lastStatusType: "active",
    lastTurnId: options.lastTurnId ?? null,
    lastTurnStatus: options.lastTurnStatus ?? null,
    channelKind: options.channelKind ?? "conversation",
    sourceKind: "app-server"
  });
  if (options.withCommentary) {
    stateStore.upsertMirroredItem({
      threadId: "thread-1",
      itemId: "commentary-1",
      turnId: options.lastTurnId ?? "turn-1",
      kind: "agentCommentary",
      discordMessageId: "commentary-message-1",
      groupKey: "agentCommentary",
      contentSignature: "[10:04:00] 正在检查",
      renderedContent: "[10:04:00] 正在检查",
      timestampMs: Date.parse("2026-07-17T10:04:00.000Z"),
      cursor: "0001",
      turnCursor: "turn:0001",
      updatedAt: "2026-07-17T10:04:00.000Z"
    });
  }

  const liveTextCalls: LiveTextCall[] = [];
  const deletedMessageIds: string[] = [];
  const statusSuffixCalls: StatusSuffixCall[] = [];
  const channelNameCalls: ChannelNameCall[] = [];
  let currentChannelName: string | null = null;
  let releaseFirstChannelRename: (() => void) | null = null;
  let markFirstChannelRenameStarted: (() => void) | null = null;
  const firstChannelRenameStarted = new Promise<void>((resolve) => {
    markFirstChannelRenameStarted = resolve;
  });
  const firstChannelRenameReleased = new Promise<void>((resolve) => {
    releaseFirstChannelRename = resolve;
  });
  let channelRenameCount = 0;
  let nextMessageId = 1;
  let remainingChannelRenameFailures = options.failChannelRenames ?? 0;
  const provider = {
    async upsertLiveTextMessage(
      channelId: string,
      passedMessageId: string | null,
      content: string
    ): Promise<string> {
      if (options.failStatusUpdates) {
        throw new Error("status message unavailable");
      }
      const messageId = passedMessageId ?? `status-${nextMessageId++}`;
      liveTextCalls.push({ channelId, messageId, passedMessageId, content });
      return messageId;
    },
    async updateLiveTextMessageStatus(
      channelId: string,
      messageId: string,
      statusText: string | null
    ): Promise<boolean> {
      statusSuffixCalls.push({ channelId, messageId, statusText });
      return true;
    },
    async updateConversationChannelName(channelId: string, name: string): Promise<boolean> {
      channelNameCalls.push({ channelId, name });
      channelRenameCount += 1;
      if (options.holdFirstChannelRename && channelRenameCount === 1) {
        markFirstChannelRenameStarted?.();
        await firstChannelRenameReleased;
      }
      if (remainingChannelRenameFailures > 0) {
        remainingChannelRenameFailures -= 1;
        throw new Error("channel rename unavailable");
      }
      currentChannelName = name;
      return true;
    },
    async deleteMessages(_channelId: string, messageIds: string[]): Promise<void> {
      deletedMessageIds.push(...messageIds);
    }
  } as unknown as BridgeProvider;
  const coordinator = new TurnStatusCoordinator({
    provider,
    stateStore,
    logger: createLogger("silent"),
    codexAdapter: options.freshThreadName
      ? ({
          async readThread() {
            return { name: options.freshThreadName };
          }
        } as any)
      : undefined
  },
  () => new Date("2026-07-17T10:05:00.000Z"),
  options.channelRenameDelayMs ?? 0,
  options.channelRenameRetryDelayMs ?? 15_000);

  return {
    channelNameCalls,
    coordinator,
    firstChannelRenameStarted,
    getCurrentChannelName: () => currentChannelName,
    deletedMessageIds,
    liveTextCalls,
    releaseFirstChannelRename: () => releaseFirstChannelRename?.(),
    stateStore,
    statusSuffixCalls
  };
}

test("one turn appends one editable status suffix to the Codex commentary message", async () => {
  const harness = createHarness({ withCommentary: true });

  await harness.coordinator.setStatus("thread-1", "turn-1", "inProgress");
  await harness.coordinator.setStatus("thread-1", "turn-1", "inProgress");
  await harness.coordinator.setStatus("thread-1", "turn-1", "waitingApproval");

  assert.equal(harness.liveTextCalls.length, 0);
  assert.equal(harness.statusSuffixCalls.length, 2);
  assert.equal(harness.statusSuffixCalls[0]?.messageId, "commentary-message-1");
  assert.equal(harness.statusSuffixCalls[1]?.messageId, "commentary-message-1");
  assert.match(harness.statusSuffixCalls[0]?.statusText ?? "", /进行中/);
  assert.match(harness.statusSuffixCalls[1]?.statusText ?? "", /等待授权/);
  assert.deepEqual(harness.stateStore.getTurnStatusMessage("thread-1"), {
    threadId: "thread-1",
    turnId: "turn-1",
    discordMessageId: "commentary-message-1",
    targetKind: "commentary",
    statusKind: "waitingApproval",
    errorReason: null,
    planCurrentStep: null,
    planTotalSteps: null,
    planCurrentStepText: null,
    planAllStepsCompleted: false,
    updatedAt: "2026-07-17T10:05:00.000Z"
  });

  harness.stateStore.close();
});

test("a channel status rename uses the latest Codex conversation title", async () => {
  const harness = createHarness({
    freshThreadName: "Renamed in Codex",
    channelRenameDelayMs: 0
  });

  await harness.coordinator.setStatus("thread-1", "turn-1", "inProgress");

  assert.match(harness.getCurrentChannelName() ?? "", /renamed-in-codex/);
  harness.stateStore.close();
});

test("a periodic title refresh does not rename an unchanged channel", async () => {
  const harness = createHarness({ channelRenameDelayMs: 0 });

  await harness.coordinator.setStatus("thread-1", "turn-1", "completed");
  await harness.coordinator.refreshChannelTitle("thread-1");
  await harness.coordinator.refreshChannelTitle("thread-1");

  assert.deepEqual(harness.channelNameCalls, [
    { channelId: "channel-1", name: "🟢-thread-1" }
  ]);
  harness.stateStore.close();
});

test("structured plan progress is appended to the existing running status", async () => {
  const harness = createHarness({ withCommentary: true });

  await harness.coordinator.setStatus("thread-1", "turn-1", "inProgress");
  await harness.coordinator.updatePlanProgress("thread-1", "turn-1", {
    currentStep: 2,
    totalSteps: 9,
    currentStepText: "阶段1：修复5174压力健康",
    allStepsCompleted: false
  });

  assert.match(
    harness.statusSuffixCalls.at(-1)?.statusText ?? "",
    /状态：进行中 · 第 2\/9 步/u
  );
  assert.deepEqual(
    {
      currentStep: harness.stateStore.getTurnStatusMessage("thread-1")?.planCurrentStep,
      totalSteps: harness.stateStore.getTurnStatusMessage("thread-1")?.planTotalSteps,
      currentStepText: harness.stateStore.getTurnStatusMessage("thread-1")?.planCurrentStepText
    },
    {
      currentStep: 2,
      totalSteps: 9,
      currentStepText: "阶段1：修复5174压力健康"
    }
  );

  harness.stateStore.close();
});

test("goal plan updates from an internal turn annotate the currently visible turn", async () => {
  const harness = createHarness({
    lastTurnId: "turn-visible",
    lastTurnStatus: "in_progress",
    withCommentary: true
  });

  await harness.coordinator.setStatus("thread-1", "turn-visible", "inProgress");
  await harness.coordinator.updatePlanProgress("thread-1", "turn-goal-internal", {
    currentStep: 3,
    totalSteps: 9,
    currentStepText: "Repair the research services.",
    allStepsCompleted: false
  });

  assert.match(harness.statusSuffixCalls.at(-1)?.statusText ?? "", /3\/9/u);
  assert.equal(harness.stateStore.getTurnStatusMessage("thread-1")?.turnId, "turn-visible");

  harness.stateStore.close();
});

test("an incomplete structured plan stays yellow when one turn completes", async () => {
  const harness = createHarness({ withCommentary: true });

  await harness.coordinator.setStatus("thread-1", "turn-1", "inProgress");
  await harness.coordinator.updatePlanProgress("thread-1", "turn-1", {
    currentStep: 4,
    totalSteps: 9,
    currentStepText: "Restore the research services.",
    allStepsCompleted: false
  });
  await harness.coordinator.clearNormalCompletion("thread-1", "turn-1");

  assert.match(harness.statusSuffixCalls.at(-1)?.statusText ?? "", /4\/9/u);
  assert.match(harness.statusSuffixCalls.at(-1)?.statusText ?? "", /状态：进行中/u);
  assert.equal(harness.stateStore.getTurnStatusMessage("thread-1")?.statusKind, "inProgress");
  assert.notEqual(harness.channelNameCalls.at(-1)?.name, "🟢-thread-1");

  harness.stateStore.close();
});

test("a fully completed structured plan turns green when the final turn completes", async () => {
  const harness = createHarness({ withCommentary: true });

  await harness.coordinator.setStatus("thread-1", "turn-1", "inProgress");
  await harness.coordinator.updatePlanProgress("thread-1", "turn-1", {
    currentStep: 9,
    totalSteps: 9,
    currentStepText: "Finish regression and close the plan.",
    allStepsCompleted: true
  });
  await harness.coordinator.clearNormalCompletion("thread-1", "turn-1");

  assert.match(harness.statusSuffixCalls.at(-1)?.statusText ?? "", /9\/9/u);
  assert.match(harness.statusSuffixCalls.at(-1)?.statusText ?? "", /状态：已完成/u);
  assert.equal(harness.stateStore.getTurnStatusMessage("thread-1")?.statusKind, "completed");
  assert.equal(harness.channelNameCalls.at(-1)?.name, "🟢-thread-1");

  harness.stateStore.close();
});

test("an active plan follows the next turn in the same conversation", async () => {
  const harness = createHarness({ withCommentary: true });

  await harness.coordinator.setStatus("thread-1", "turn-1", "inProgress");
  await harness.coordinator.updatePlanProgress("thread-1", "turn-1", {
    currentStep: 2,
    totalSteps: 9,
    currentStepText: "Repair pressure health.",
    allStepsCompleted: false
  });
  await harness.coordinator.setStatus("thread-1", "turn-2", "inProgress");

  assert.match(harness.liveTextCalls.at(-1)?.content ?? "", /2\/9/u);
  assert.equal(harness.stateStore.getTurnStatusMessage("thread-1")?.turnId, "turn-2");

  harness.stateStore.close();
});

test("normal completion keeps a green terminal status on commentary", async () => {
  const harness = createHarness({ withCommentary: true });

  await harness.coordinator.setStatus("thread-1", "turn-1", "networkError");
  await harness.coordinator.clearNormalCompletion("thread-1", "turn-1");

  assert.deepEqual(harness.deletedMessageIds, []);
  assert.equal(harness.statusSuffixCalls.at(-1)?.messageId, "commentary-message-1");
  assert.match(harness.statusSuffixCalls.at(-1)?.statusText ?? "", /状态：已完成/u);
  assert.equal(harness.stateStore.getTurnStatusMessage("thread-1")?.statusKind, "completed");

  harness.stateStore.close();
});

test("a new turn preserves the previous turn terminal status", async () => {
  const harness = createHarness({ withCommentary: true });

  await harness.coordinator.setStatus("thread-1", "turn-1", "completed");
  await harness.coordinator.setStatus("thread-1", "turn-2", "inProgress");

  assert.equal(
    harness.statusSuffixCalls.some((call) => call.messageId === "commentary-message-1" && call.statusText === null),
    false
  );
  assert.equal(harness.stateStore.getTurnStatusMessage("thread-1")?.turnId, "turn-2");
  assert.match(harness.liveTextCalls.at(-1)?.content ?? "", /状态：进行中/u);

  harness.stateStore.close();
});

test("a new turn removes the previous standalone terminal status", async () => {
  const harness = createHarness();

  await harness.coordinator.setStatus("thread-1", "turn-1", "stopped");
  const previousStatusId = harness.stateStore.getTurnStatusMessage("thread-1")?.discordMessageId;
  await harness.coordinator.setStatus("thread-1", "turn-2", "inProgress");

  assert.ok(previousStatusId);
  assert.deepEqual(harness.deletedMessageIds, [previousStatusId]);
  assert.equal(harness.stateStore.getTurnStatusMessage("thread-1")?.turnId, "turn-2");
  assert.match(harness.liveTextCalls.at(-1)?.content ?? "", /状态：进行中/u);

  harness.stateStore.close();
});

test("channel title light changes only when the status color changes", async () => {
  const harness = createHarness({ withCommentary: true });

  await harness.coordinator.setStatus("thread-1", "turn-1", "inProgress");
  await harness.coordinator.setStatus("thread-1", "turn-1", "reconnecting");
  await harness.coordinator.setStatus("thread-1", "turn-1", "waitingApproval");
  await harness.coordinator.setStatus("thread-1", "turn-1", "systemError");
  await harness.coordinator.setStatus("thread-1", "turn-1", "completed");

  assert.deepEqual(harness.channelNameCalls, [
    { channelId: "channel-1", name: "🟡-thread-1" },
    { channelId: "channel-1", name: "🔴-thread-1" },
    { channelId: "channel-1", name: "🟢-thread-1" }
  ]);

  harness.stateStore.close();
});

test("a stale event from an older turn cannot replace the current turn state", async () => {
  const harness = createHarness({ lastTurnId: "turn-new", lastTurnStatus: "in_progress" });

  await harness.coordinator.setStatus("thread-1", "turn-old", "systemError");

  assert.deepEqual(harness.liveTextCalls, []);
  assert.deepEqual(harness.channelNameCalls, []);
  assert.equal(harness.stateStore.getTurnStatusMessage("thread-1"), undefined);

  harness.stateStore.close();
});

test("channel title status still updates when the status message cannot be written", async () => {
  const harness = createHarness({ failStatusUpdates: true });

  await harness.coordinator.setStatus("thread-1", "turn-1", "inProgress");

  assert.deepEqual(harness.channelNameCalls, [
    { channelId: "channel-1", name: "🟡-thread-1" }
  ]);

  harness.stateStore.close();
});

test("rapid title status changes are coalesced to the latest color", async () => {
  const harness = createHarness({ withCommentary: true, channelRenameDelayMs: 20 });

  await harness.coordinator.setStatus("thread-1", "turn-1", "inProgress");
  await harness.coordinator.setStatus("thread-1", "turn-1", "waitingApproval");
  await harness.coordinator.setStatus("thread-1", "turn-1", "completed");

  assert.deepEqual(harness.channelNameCalls, []);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(harness.channelNameCalls, [
    { channelId: "channel-1", name: "🟢-thread-1" }
  ]);

  harness.coordinator.stop();
  harness.stateStore.close();
});

test("an in-flight stale yellow rename cannot overwrite a completed green title", async () => {
  const harness = createHarness({ withCommentary: true, holdFirstChannelRename: true });

  const yellowUpdate = harness.coordinator.setStatus("thread-1", "turn-1", "inProgress");
  await harness.firstChannelRenameStarted;
  await harness.coordinator.setStatus("thread-1", "turn-1", "completed");
  harness.releaseFirstChannelRename();
  await yellowUpdate;

  assert.equal(harness.getCurrentChannelName(), "🟢-thread-1");
  assert.equal(harness.channelNameCalls.at(-1)?.name, "🟢-thread-1");

  harness.coordinator.stop();
  harness.stateStore.close();
});

test("an in-flight channel rename queues only the latest requested color", async () => {
  const harness = createHarness({ withCommentary: true, holdFirstChannelRename: true });

  const yellowUpdate = harness.coordinator.setStatus("thread-1", "turn-1", "inProgress");
  await harness.firstChannelRenameStarted;
  await harness.coordinator.setStatus("thread-1", "turn-1", "waitingApproval");
  await harness.coordinator.setStatus("thread-1", "turn-1", "completed");

  assert.equal(harness.channelNameCalls.length, 1);
  harness.releaseFirstChannelRename();
  await yellowUpdate;

  assert.equal(harness.channelNameCalls.length, 2);
  assert.equal(harness.channelNameCalls[0]?.name, "🟡-thread-1");
  assert.equal(harness.channelNameCalls[1]?.name, "🟢-thread-1");
  assert.equal(harness.getCurrentChannelName(), "🟢-thread-1");

  harness.coordinator.stop();
  harness.stateStore.close();
});

test("a recreated Discord channel receives the current color even when the thread color is unchanged", async () => {
  const harness = createHarness({ withCommentary: true });

  await harness.coordinator.setStatus("thread-1", "turn-1", "completed");
  const bridge = harness.stateStore.getThreadBridge("thread-1");
  assert.ok(bridge);
  harness.stateStore.upsertThreadBridge({
    ...bridge,
    discordChannelId: "channel-2"
  });
  await harness.coordinator.setStatus("thread-1", "turn-1", "completed", { refresh: true });

  assert.deepEqual(harness.channelNameCalls, [
    { channelId: "channel-1", name: "🟢-thread-1" },
    { channelId: "channel-2", name: "🟢-thread-1" }
  ]);

  harness.coordinator.stop();
  harness.stateStore.close();
});

test("a failed channel title rename retries only the latest desired color", async () => {
  const harness = createHarness({
    withCommentary: true,
    failChannelRenames: 2,
    channelRenameRetryDelayMs: 20
  });

  await harness.coordinator.setStatus("thread-1", "turn-1", "inProgress");
  await harness.coordinator.setStatus("thread-1", "turn-1", "waitingApproval");

  assert.deepEqual(harness.channelNameCalls, [
    { channelId: "channel-1", name: "🟡-thread-1" },
    { channelId: "channel-1", name: "🔴-thread-1" }
  ]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(harness.channelNameCalls, [
    { channelId: "channel-1", name: "🟡-thread-1" },
    { channelId: "channel-1", name: "🔴-thread-1" },
    { channelId: "channel-1", name: "🔴-thread-1" }
  ]);

  harness.coordinator.stop();
  harness.stateStore.close();
});

test("a turn without Codex commentary uses a temporary standalone status", async () => {
  const harness = createHarness();

  await harness.coordinator.setStatus("thread-1", "turn-1", "inProgress");

  assert.equal(harness.liveTextCalls.length, 1);
  assert.match(harness.liveTextCalls[0]?.content ?? "", /进行中/);
  assert.deepEqual(harness.statusSuffixCalls, []);

  harness.stateStore.close();
});

test("an error keeps a sanitized reason in the Discord suffix and state store", async () => {
  const harness = createHarness({ withCommentary: true });

  await harness.coordinator.setStatus("thread-1", "turn-1", "networkError", {
    reason: "stream disconnected before completion: tls handshake eof"
  });

  assert.match(harness.statusSuffixCalls.at(-1)?.statusText ?? "", /原因：TLS handshake EOF/u);
  assert.equal(
    harness.stateStore.getTurnStatusMessage("thread-1")?.errorReason,
    "TLS handshake EOF"
  );

  harness.stateStore.close();
});

test("subagent channels do not receive intermediate status messages", async () => {
  const harness = createHarness({ channelKind: "subagent" });

  await harness.coordinator.setStatus("thread-1", "turn-1", "inProgress");

  assert.deepEqual(harness.liveTextCalls, []);
  assert.equal(harness.stateStore.getTurnStatusMessage("thread-1"), undefined);

  harness.stateStore.close();
});

test("startup reconciliation restores active and completed turn states", async () => {
  const active = createHarness({ lastTurnId: "turn-1", lastTurnStatus: "in_progress" });
  await active.coordinator.reconcileStartup();
  assert.match(active.liveTextCalls[0]?.content ?? "", /进行中/);
  active.stateStore.close();

  const completed = createHarness({ lastTurnId: "turn-1", lastTurnStatus: "completed" });
  completed.stateStore.upsertTurnStatusMessage({
    threadId: "thread-1",
    turnId: "turn-1",
    discordMessageId: "old-status",
    targetKind: "fallback",
    statusKind: "reconnecting",
    errorReason: null,
    planCurrentStep: null,
    planTotalSteps: null,
    planCurrentStepText: null,
    planAllStepsCompleted: false,
    updatedAt: "2026-07-17T10:00:00.000Z"
  });
  await completed.coordinator.reconcileStartup();
  assert.deepEqual(completed.deletedMessageIds, []);
  assert.equal(completed.stateStore.getTurnStatusMessage("thread-1")?.statusKind, "completed");
  assert.match(completed.liveTextCalls.at(-1)?.content ?? "", /状态：已完成/u);
  assert.equal(completed.channelNameCalls.at(-1)?.name, "🟢-thread-1");
  completed.stateStore.close();
});

test("periodic status refresh rechecks the channel light without rewriting unchanged status text", async () => {
  const harness = createHarness({
    lastTurnId: "turn-1",
    lastTurnStatus: "completed",
    channelRenameDelayMs: 0
  });
  await harness.coordinator.reconcileStartup();
  const liveTextCount = harness.liveTextCalls.length;
  const channelNameCount = harness.channelNameCalls.length;

  await harness.coordinator.refreshCurrentStatuses();

  assert.equal(harness.liveTextCalls.length, liveTextCount);
  assert.equal(harness.channelNameCalls.length, channelNameCount + 1);
  assert.equal(harness.channelNameCalls.at(-1)?.name, "🟢-thread-1");
  harness.stateStore.close();
});

test("startup reconciliation does not downgrade a previously completed structured plan", async () => {
  const harness = createHarness({ lastTurnId: "turn-1", lastTurnStatus: "completed" });
  harness.stateStore.upsertTurnStatusMessage({
    threadId: "thread-1",
    turnId: "turn-1",
    discordMessageId: "completed-status",
    targetKind: "fallback",
    statusKind: "completed",
    errorReason: null,
    planCurrentStep: 6,
    planTotalSteps: 6,
    planCurrentStepText: "Finish the audit.",
    planAllStepsCompleted: false,
    updatedAt: "2026-07-17T10:00:00.000Z"
  });

  await harness.coordinator.reconcileStartup();

  assert.equal(harness.stateStore.getTurnStatusMessage("thread-1")?.statusKind, "completed");
  assert.equal(harness.channelNameCalls.at(-1)?.name, "🟢-thread-1");

  harness.stateStore.close();
});
