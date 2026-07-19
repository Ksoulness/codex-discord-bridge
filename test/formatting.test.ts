import test from "node:test";
import assert from "node:assert/strict";
import {
  formatDiscordChannelName,
  formatDiscordChannelStatusName,
  formatPausedDiscordChannelName,
  preserveDiscordChannelStatusPrefix,
  replaceTurnStatusSuffix,
  renderApprovalCard,
  renderStatusCard,
  renderTurnStatus
} from "../src/util/formatting.js";

test("turn status suffix updates in place and can be removed without changing commentary", () => {
  const commentary = "💭 **Codex**\n\n1. [10:00:00] 正在检查代码。";
  const running = replaceTurnStatusSuffix(
    commentary,
    renderTurnStatus("inProgress", new Date("2026-07-17T10:01:00.000Z"))
  );
  const waiting = replaceTurnStatusSuffix(
    running,
    renderTurnStatus("waitingApproval", new Date("2026-07-17T10:02:00.000Z"))
  );

  assert.match(running, /状态：进行中/);
  assert.doesNotMatch(waiting, /状态：进行中/);
  assert.match(waiting, /🔴 \*\*状态：等待授权\*\*/u);
  assert.equal(replaceTurnStatusSuffix(waiting, null), commentary);
});

test("turn status suffix collapses duplicate restored statuses into one", () => {
  const commentary = "🤖 **Codex**\n\n[12:53:27] 图片显示 12:53:13。";
  const firstCompleted = renderTurnStatus(
    "completed",
    new Date("2026-07-19T04:53:28.000Z")
  );
  const secondCompleted = renderTurnStatus(
    "completed",
    new Date("2026-07-19T04:53:29.000Z")
  );
  const duplicated = `${commentary}\n\n${firstCompleted}\n\n${secondCompleted}`;
  const refreshed = replaceTurnStatusSuffix(
    duplicated,
    renderTurnStatus("completed", new Date("2026-07-19T04:53:30.000Z"))
  );

  assert.equal((refreshed.match(/状态：/gu) ?? []).length, 1);
  assert.equal((refreshed.match(/更新时间：/gu) ?? []).length, 1);
  assert.match(refreshed, /<t:1784436810:R>$/u);
});

test("turn status suffix replaces a stopped status cleanly", () => {
  const commentary = "Codex commentary";
  const stopped = replaceTurnStatusSuffix(
    commentary,
    renderTurnStatus("stopped", new Date("2026-07-19T04:53:28.000Z"))
  );
  const completed = replaceTurnStatusSuffix(
    stopped,
    renderTurnStatus("completed", new Date("2026-07-19T04:53:29.000Z"))
  );

  assert.doesNotMatch(completed, /状态：已停止/u);
  assert.equal((completed.match(/状态：/gu) ?? []).length, 1);
  assert.match(completed, /状态：已完成/u);
});

test("turn status renders yellow reconnects and a concise red error reason", () => {
  const reconnecting = renderTurnStatus(
    "reconnecting",
    new Date("2026-07-17T10:03:00.000Z")
  );
  const networkError = renderTurnStatus(
    "networkError",
    new Date("2026-07-17T10:04:00.000Z"),
    "stream disconnected before completion: tls handshake eof"
  );

  assert.match(reconnecting, /🟡 \*\*状态：正在重连\*\*/u);
  assert.match(networkError, /🔴 \*\*状态：网络错误\*\*/u);
  assert.match(networkError, /原因：TLS handshake EOF/u);
  assert.doesNotMatch(networkError, /stream disconnected before completion/iu);
});

test("turn status progress replaces the previous suffix and survives terminal states", () => {
  const commentary = "Codex commentary";
  const progress = {
    currentStep: 2,
    totalSteps: 9,
    currentStepText: "Implement the status coordinator.",
    allStepsCompleted: false
  };
  const running = replaceTurnStatusSuffix(
    commentary,
    renderTurnStatus("inProgress", new Date("2026-07-17T10:01:00.000Z"), null, progress)
  );
  const failed = replaceTurnStatusSuffix(
    running,
    renderTurnStatus(
      "networkError",
      new Date("2026-07-17T10:02:00.000Z"),
      "tls handshake eof",
      progress
    )
  );
  const completed = replaceTurnStatusSuffix(
    failed,
    renderTurnStatus("completed", new Date("2026-07-17T10:03:00.000Z"), null, progress)
  );

  assert.match(running, /2\/9/u);
  assert.match(failed, /2\/9/u);
  assert.match(completed, /2\/9/u);
  assert.equal((failed.match(/<t:/gu) ?? []).length, 1);
  assert.equal((completed.match(/<t:/gu) ?? []).length, 1);
});

test("formats Chinese Codex titles as readable Discord channel names", () => {
  assert.equal(formatDiscordChannelName("问题", "thread-019f60a6"), "问题");
  assert.equal(formatDiscordChannelName("不下单", "thread-019f60a6"), "不下单");
});

test("normalizes mixed Unicode titles and punctuation without dropping Chinese", () => {
  assert.equal(
    formatDiscordChannelName("任务指导 存档，到时候来对", "thread-019f60a6"),
    "任务指导-存档-到时候来对"
  );
  assert.equal(
    formatDiscordChannelName("  API___修复，，，第二轮  ", "thread-019f60a6"),
    "api-修复-第二轮"
  );
});

test("falls back when a title has no usable text or is fully redacted", () => {
  assert.equal(formatDiscordChannelName("!!! ", "thread-019f60a6"), "thread-019f60a6");
  assert.equal(formatDiscordChannelName("[redacted]", "thread-019f60a6"), "thread-019f60a6");
  assert.equal(
    formatDiscordChannelName("[redacted private key block]", "thread-019f60a6"),
    "thread-019f60a6"
  );
});

test("limits Unicode Discord channel names to 100 characters", () => {
  const result = formatDiscordChannelName("任".repeat(120), "thread-019f60a6");

  assert.equal(result, "任".repeat(100));
  assert.equal(Array.from(result).length, 100);
});

test("formats Discord conversation channel names with replaceable status lights", () => {
  assert.equal(
    formatDiscordChannelStatusName("清理执行", "thread-019f60a6", "inProgress"),
    "🟡-清理执行"
  );
  assert.equal(
    formatDiscordChannelStatusName("🟡-清理执行", "thread-019f60a6", "waitingApproval"),
    "🔴-清理执行"
  );
  assert.equal(
    formatDiscordChannelStatusName("清理执行", "thread-019f60a6", "completed"),
    "🟢-清理执行"
  );
  assert.equal(
    preserveDiscordChannelStatusPrefix("🔴-清理执行", "新的标题"),
    "🔴-新的标题"
  );
  assert.equal(formatPausedDiscordChannelName("🟢-清理执行"), "⚪-清理执行");
  assert.equal(
    preserveDiscordChannelStatusPrefix("⚪-清理执行", "新的标题"),
    "⚪-新的标题"
  );
  assert.equal(
    Array.from(formatDiscordChannelStatusName("任".repeat(120), "fallback", "completed")).length,
    100
  );
});

test("renders status cards with compact pinned fields", () => {
  const content = renderStatusCard({
    threadId: "019d5702-c814-7b21-b836-321b913e9859",
    title: "Build bridge",
    shortThreadId: "019d5702",
    kindLabel: "Conversation",
    parentShortThreadId: null,
    projectLabel: "codex-mobile",
    statusLabel: "Running",
    attentionLabel: "Monitoring",
    workspaceLabel: "codex-mobile",
    lastActivityAt: Date.now(),
    latestCommandPreview: "npm test",
    latestAgentMessage: "Working through the implementation."
  });

  assert.match(content, /Build bridge/);
  assert.match(content, /Thread: `019d5702`/);
  assert.match(content, /Project: codex-mobile/);
  assert.match(content, /Last activity:/);
  assert.doesNotMatch(content, /Type:/);
  assert.doesNotMatch(content, /Status:/);
  assert.doesNotMatch(content, /Attention:/);
  assert.doesNotMatch(content, /Workspace:/);
  assert.doesNotMatch(content, /Latest command:/);
  assert.doesNotMatch(content, /Latest final:/);
});

test("renders approval cards with expiry and preview", () => {
  const content = renderApprovalCard({
    token: "token",
    threadId: "thread",
    shortThreadId: "thread",
    kind: "commandExecution",
    createdAt: new Date("2026-04-07T06:40:10.000Z"),
    availableDecisions: ["accept", "decline"],
    actionsEnabled: true,
    sanitizedPreview: "npm install",
    cwd: "C:\\repo",
    reason: "Need dependencies",
    expiresAt: new Date(),
    details: "{}"
  });

  assert.match(content, /\*\*Codex\*\*/);
  assert.match(content, /\[\d{2}:\d{2}:\d{2}\]/);
  assert.match(content, /Waiting for a decision/);
  assert.match(content, /npm install/);
  assert.match(content, /Need dependencies/);
  assert.doesNotMatch(content, /Thread:/);
  assert.doesNotMatch(content, /Options:/);
});

test("renders resolved approval cards without the expiry line", () => {
  const content = renderApprovalCard(
    {
      token: "token",
      threadId: "thread",
      shortThreadId: "thread",
      kind: "commandExecution",
      createdAt: new Date("2026-04-07T06:40:10.000Z"),
      availableDecisions: ["accept", "decline"],
      actionsEnabled: true,
      sanitizedPreview: "npm install",
      cwd: "C:\\repo",
      reason: "Need dependencies",
      expiresAt: new Date("2026-04-07T06:50:10.000Z"),
      details: "{}"
    },
    "✅ Approved once in Discord"
  );

  assert.match(content, /Approved once in Discord/);
  assert.doesNotMatch(content, /Expires:/);
});

test("renders read-only CLI approval cards as CLI-local", () => {
  const content = renderApprovalCard({
    token: "token",
    threadId: "thread",
    shortThreadId: "thread",
    kind: "commandExecution",
    createdAt: new Date("2026-04-07T06:40:10.000Z"),
    availableDecisions: [],
    actionsEnabled: false,
    sourceKind: "cli-session",
    sanitizedPreview: "Start-Process 'https://www.wikipedia.org'",
    cwd: "C:\\repo",
    reason: "Need approval",
    expiresAt: new Date("2026-04-07T06:50:10.000Z"),
    details: "{}"
  });

  assert.match(content, /Resolve this in Codex CLI/);
  assert.doesNotMatch(content, /Resolve this in Codex Desktop/);
});

test("renders only the next unanswered tool input question while pending", () => {
  const content = renderApprovalCard({
    token: "token",
    threadId: "thread",
    shortThreadId: "thread",
    kind: "toolUserInput",
    createdAt: new Date("2026-04-07T06:40:10.000Z"),
    availableDecisions: [],
    actionsEnabled: true,
    sanitizedPreview: "Tool input requested (2 questions)",
    cwd: null,
    reason: null,
    expiresAt: new Date("2026-04-07T06:50:10.000Z"),
    details: "{}",
    toolInput: {
      questions: [
        {
          id: "color",
          question: "What color?",
          options: [{ label: "Blue" }]
        },
        {
          id: "food",
          question: "What food?",
          options: [{ label: "Pizza" }]
        }
      ],
      selectedAnswers: {
        color: "Blue"
      }
    }
  });

  assert.match(content, /Answered: 1 of 2/);
  assert.match(content, /Question 2 of 2: What food\?/);
  assert.doesNotMatch(content, /Question 1 of 2: What color\?/);
});
