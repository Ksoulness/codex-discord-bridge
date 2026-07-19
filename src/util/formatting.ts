import path from "node:path";
import type {
  ApprovalCardView,
  CodexThreadStatus,
  DiscordBridgeKind,
  StatusCardView,
  TurnPlanProgress,
  TurnStatusKind
} from "../domain.js";
import { findNextToolInputQuestionIndex } from "./approvalDecisions.js";
import { escapeDiscordInlineCode, redactSensitiveText, truncateForDiscord } from "./redaction.js";

const DISCORD_NAME_FALLBACK = "codex";

export function shortThreadId(threadId: string): string {
  return threadId.slice(0, 8);
}

export function statusLabel(status: CodexThreadStatus): string {
  if (status.type === "active" && status.activeFlags?.includes("waitingOnApproval")) {
    return "Waiting on approval";
  }
  if (status.type === "active") {
    return "Running";
  }
  if (status.type === "idle") {
    return "Idle";
  }
  if (status.type === "systemError") {
    return "System error";
  }
  return "Stored";
}

export function attentionLabel(status: CodexThreadStatus): string {
  if (status.type === "active" && status.activeFlags?.includes("waitingOnApproval")) {
    return "Needs approval";
  }
  if (status.type === "systemError") {
    return "Needs review";
  }
  if (status.type === "active") {
    return "Monitoring";
  }
  return "None";
}

export function repoNameFromCwd(cwd: string | null): string | null {
  if (!cwd) {
    return null;
  }

  return path.basename(cwd);
}

export function projectNameFromMetadata(cwd: string | null, repoName: string | null): string {
  return repoName ?? repoNameFromCwd(cwd) ?? "No Workspace";
}

export function projectKeyFromMetadata(cwd: string | null, repoName: string | null): string {
  if (cwd) {
    return cwd.trim().toLowerCase();
  }

  if (repoName) {
    return `repo:${repoName.trim().toLowerCase()}`;
  }

  return "no-workspace";
}

export function kindLabel(kind: DiscordBridgeKind): string {
  return kind === "subagent" ? "Sub-agent" : "Conversation";
}

function approvalKindLabel(kind: ApprovalCardView["kind"]): string {
  return kind === "commandExecution"
    ? "Command execution"
    : kind === "fileChange"
      ? "File change"
      : kind === "toolUserInput"
        ? "Codex question"
        : kind === "permissions"
          ? "Permission"
          : "MCP approval";
}

export function renderStatusCard(view: StatusCardView): string {
  const lines = [
    `**${truncateForDiscord(view.title, 100)}**`,
    `Thread: \`${view.shortThreadId}\``,
    `Project: ${truncateForDiscord(view.projectLabel, 100)}`,
    `Last activity: ${view.lastActivityAt ? `<t:${Math.floor(view.lastActivityAt / 1000)}:R>` : "Unknown"}`
  ];

  return lines.join("\n");
}

export function renderTurnStatus(
  kind: TurnStatusKind,
  updatedAt: Date,
  rawReason: string | null = null,
  planProgress: TurnPlanProgress | null = null
): string {
  const labels: Record<TurnStatusKind, { color: string; label: string }> = {
    inProgress: { color: "🟡", label: "进行中" },
    waitingApproval: { color: "🔴", label: "等待授权" },
    reconnecting: { color: "🟡", label: "正在重连" },
    networkError: { color: "🔴", label: "网络错误" },
    rateLimited: { color: "🔴", label: "额度或限流" },
    systemError: { color: "🔴", label: "系统错误" },
    stopped: { color: "🟢", label: "已停止" },
    completed: { color: "🟢", label: "已完成" }
  };
  const progressSuffix = planProgress
    ? kind === "completed"
      ? ` · 第 ${planProgress.currentStep}/${planProgress.totalSteps} 步`
      : kind === "inProgress"
        ? ` · 第 ${planProgress.currentStep}/${planProgress.totalSteps} 步`
        : ` · 停在第 ${planProgress.currentStep}/${planProgress.totalSteps} 步`
    : "";
  const reason = summarizeTurnStatusReason(rawReason);
  return [
    `${labels[kind].color} **状态：${labels[kind].label}${progressSuffix}**`,
    ...(reason ? [`原因：${reason}`] : []),
    `更新时间：<t:${Math.floor(updatedAt.getTime() / 1000)}:R>`
  ].join("\n");
}

export function summarizeTurnStatusReason(rawReason: string | null | undefined): string | null {
  const normalized = redactSensitiveText(rawReason ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  if (/tls handshake eof/i.test(normalized)) {
    return "TLS handshake EOF";
  }
  if (/task_complete.*(?:final agent message|final result)|did not include a final agent message/i.test(normalized)) {
    return "任务结束时未返回最终结果";
  }
  if (/error sending request/i.test(normalized) && /backend-api\/codex\/responses/i.test(normalized)) {
    return "请求 Codex 服务失败";
  }
  if (/stream disconnected before completion/i.test(normalized)) {
    return "响应流在完成前断开";
  }
  return truncateForDiscord(normalized, 160);
}

const TURN_STATUS_SUFFIX_PATTERN =
  /(?:(?:^|\n\n)(?:🟡|🟠|🔵|⚪|🔴|🟢) \*\*状态：[^\n*]+\*\*(?:\n原因：[^\n]*)?\n更新时间：<t:\d+:R>)+$/u;

export function replaceTurnStatusSuffix(content: string, statusText: string | null): string {
  const base = content.replace(TURN_STATUS_SUFFIX_PATTERN, "").trimEnd();
  return statusText ? `${base}\n\n${statusText}`.trimStart() : base;
}

export function renderApprovalCard(
  view: ApprovalCardView,
  resolutionText?: string | null,
  options: { includeMention?: boolean } = {}
): string {
  const isToolInputCard = view.kind === "toolUserInput" && (view.toolInput?.questions.length ?? 0) > 0;
  const resolvedStatusText = resolutionText?.trim() || null;
  const statusText = resolvedStatusText
    ? resolvedStatusText
    : isToolInputCard && view.actionsEnabled
      ? "Waiting for your answer"
      : view.actionsEnabled
        ? "Waiting for a decision"
      : view.sourceKind === "cli-session"
        ? isToolInputCard
          ? "Answer this in Codex CLI"
          : "Resolve this in Codex CLI"
        : isToolInputCard
          ? "Answer this in Codex Desktop"
          : "Resolve this in Codex Desktop";
  const requestedTime = formatApprovalTime(view.createdAt);
  const actorLabel = truncateForDiscord(view.actorLabel?.trim() || "Codex", 80);
  const lines = [
    `\u{1F6A6} **${actorLabel}**`,
    requestedTime,
    `Status: ${statusText}`,
    `Type: ${approvalKindLabel(view.kind)}`,
    `Preview: \`${escapeDiscordInlineCode(truncateForDiscord(view.sanitizedPreview, 180))}\``
  ];
  if (isToolInputCard) {
    lines.push(...buildToolInputQuestionLines(view, { currentOnly: !resolvedStatusText && view.actionsEnabled }));
  }
  if (!resolvedStatusText) {
    lines.splice(4, 0, `Expires: <t:${Math.floor(view.expiresAt.getTime() / 1000)}:R>`);
  }

  if (options.includeMention && view.mentionText) {
    lines.unshift(view.mentionText);
  }

  lines.push(...buildApprovalContextLines(view, { cwdMaxLength: 180, reasonMaxLength: 300 }));

  return lines.join("\n");
}

function buildToolInputQuestionLines(
  view: ApprovalCardView,
  options: { currentOnly: boolean }
): string[] {
  const toolInput = view.toolInput;
  if (!toolInput) {
    return [];
  }
  const lines: string[] = [];
  const questions = options.currentOnly
    ? toolInput.questions
        .map((question, index) => ({ question, index }))
        .filter(({ index }) => index === findNextToolInputQuestionIndex(toolInput))
    : toolInput.questions.map((question, index) => ({ question, index }));
  const answeredCount = toolInput.questions.filter((question) => {
    const answer = toolInput.selectedAnswers[question.id];
    return typeof answer === "string" && answer.trim().length > 0;
  }).length;

  if (options.currentOnly && toolInput.questions.length > 1) {
    lines.push(`Answered: ${answeredCount} of ${toolInput.questions.length}`);
  }

  for (const { question, index } of questions) {
    const selected = toolInput.selectedAnswers[question.id];
    const prefix = toolInput.questions.length > 1 ? `Question ${index + 1} of ${toolInput.questions.length}` : "Question";
    lines.push(`${prefix}: ${truncateForDiscord(question.question, 240)}`);
    if (selected) {
      lines.push(`Answer: ${truncateForDiscord(selected, 180)}`);
    }
  }
  return lines;
}

export function renderApprovalDetails(view: ApprovalCardView): string {
  const lines = [
    `Thread: \`${view.threadId}\``,
    `Type: ${view.kind}`,
    `Requested: ${view.createdAt.toISOString()}`,
    `Expires: ${view.expiresAt.toISOString()}`
  ];
  lines.push(...buildApprovalContextLines(view, { reasonMaxLength: 600 }));

  lines.push("", truncateForDiscord(view.details, 1800));

  return lines.join("\n");
}

function buildApprovalContextLines(
  view: ApprovalCardView,
  options: { cwdMaxLength?: number; reasonMaxLength: number }
): string[] {
  const lines: string[] = [];
  if (view.cwd) {
    lines.push(
      `CWD: \`${escapeDiscordInlineCode(
        typeof options.cwdMaxLength === "number" ? truncateForDiscord(view.cwd, options.cwdMaxLength) : view.cwd
      )}\``
    );
  }
  if (view.reason) {
    lines.push(`Reason: ${truncateForDiscord(view.reason, options.reasonMaxLength)}`);
  }
  return lines;
}

function formatApprovalTime(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `[${hours}:${minutes}:${seconds}]`;
}

export function formatDiscordCategoryName(name: string): string {
  return truncateForDiscord(name.trim() || "Codex", 100);
}

export function formatDiscordChannelName(name: string, fallback: string): string {
  const trimmed = name.trim();
  const fullyRedacted = /^(?:\[\s*redacted(?:\s+[^\]]+)?\s*\]\s*)+$/iu.test(trimmed);
  const normalized = (fullyRedacted ? "" : trimmed)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  if (!normalized) {
    return truncateForDiscord(fallback || DISCORD_NAME_FALLBACK, 100);
  }

  return Array.from(normalized).slice(0, 100).join("").replace(/-+$/g, "");
}

const DISCORD_CHANNEL_STATUS_PREFIX = /^(🟡|🔴|🟢|⚪)-/u;

export function formatPausedDiscordChannelName(name: string, fallback = "codex-paused"): string {
  const baseName = formatDiscordChannelName(
    name.replace(DISCORD_CHANNEL_STATUS_PREFIX, ""),
    fallback
  );
  return Array.from(`⚪-${baseName}`).slice(0, 100).join("").replace(/-+$/g, "");
}

export function formatDiscordChannelStatusName(
  name: string,
  fallback: string,
  statusKind: TurnStatusKind
): string {
  const baseName = formatDiscordChannelName(
    name.replace(DISCORD_CHANNEL_STATUS_PREFIX, ""),
    fallback
  );
  const indicator =
    statusKind === "completed" || statusKind === "stopped"
      ? "🟢"
      : statusKind === "waitingApproval" ||
          statusKind === "networkError" ||
          statusKind === "rateLimited" ||
          statusKind === "systemError"
        ? "🔴"
        : "🟡";
  return Array.from(`${indicator}-${baseName}`).slice(0, 100).join("").replace(/-+$/g, "");
}

export function preserveDiscordChannelStatusPrefix(
  currentName: string,
  desiredBaseName: string
): string {
  const match = currentName.match(DISCORD_CHANNEL_STATUS_PREFIX);
  if (!match) {
    return desiredBaseName;
  }
  const baseName = desiredBaseName.replace(DISCORD_CHANNEL_STATUS_PREFIX, "");
  return Array.from(`${match[1]}-${baseName}`).slice(0, 100).join("").replace(/-+$/g, "");
}

export function formatDiscordThreadName(name: string, fallback: string): string {
  const normalized = name.trim() || fallback || "Codex sub-agent";
  return truncateForDiscord(normalized, 100);
}
