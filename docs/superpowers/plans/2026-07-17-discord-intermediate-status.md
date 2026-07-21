# Discord 中间状态 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Discord 已有的用户消息与 Codex 最终回复之间，维护一条可原地更新的中文中间状态，并在正常完成时自动删除、异常时保留。

**Architecture:** 新建 `TurnStatusCoordinator` 统一把状态附加到当前 Codex 过程消息末尾，并用独立 SQLite 表持久化目标消息 ID、目标类型与状态。过程消息尚不存在时使用临时状态消息，首条过程消息出现后自动迁移；Session JSONL、Desktop IPC、审批事件只传递结构化状态，不扫描普通聊天正文。

**Tech Stack:** TypeScript、Node.js、Discord.js、better-sqlite3、Vitest、现有 Desktop IPC 与 Codex session JSONL tailer。

---

### Task 1: 状态类型与持久化

**Files:**
- Modify: `src/domain.ts`
- Modify: `src/store/StateStore.ts`
- Test: `test/store.test.ts`

- [ ] **Step 1: 编写状态记录读写与删除的失败测试**

在 `test/store.test.ts` 增加测试，写入后应按 `threadId` 读回，并能删除：

```ts
const record = {
  threadId: "thread-status-1",
  turnId: "turn-1",
  discordMessageId: "message-1",
  statusKind: "inProgress" as const,
  updatedAt: "2026-07-17T10:00:00.000Z",
};
store.upsertTurnStatusMessage(record);
expect(store.getTurnStatusMessage(record.threadId)).toEqual(record);
store.deleteTurnStatusMessage(record.threadId);
expect(store.getTurnStatusMessage(record.threadId)).toBeNull();
```

- [ ] **Step 2: 运行测试并确认因 API 不存在而失败**

Run: `npm test -- test/store.test.ts`

Expected: FAIL，提示 `upsertTurnStatusMessage` 不存在。

- [ ] **Step 3: 增加领域类型与独立表**

在 `src/domain.ts` 定义：

```ts
export type TurnStatusKind =
  | "inProgress"
  | "waitingApproval"
  | "reconnecting"
  | "networkError"
  | "rateLimited"
  | "systemError";

export interface TurnStatusMessageRecord {
  threadId: string;
  turnId: string;
  discordMessageId: string;
  statusKind: TurnStatusKind;
  updatedAt: string;
}
```

在 `StateStore` 初始化中创建 `turn_status_messages` 表，并实现 `get`、`upsert`、`delete`、`list`。使用独立表，避免修改已有 `thread_bridges` 表结构。

- [ ] **Step 4: 运行持久化测试**

Run: `npm test -- test/store.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交持久化改动**

```powershell
git add src/domain.ts src/store/StateStore.ts test/store.test.ts
git commit -m "feat: persist Discord turn status messages"
```

### Task 2: 过程消息末尾状态协调器

**Files:**
- Create: `src/bridge/status/TurnStatusCoordinator.ts`
- Modify: `src/util/formatting.ts`
- Modify: `src/providers/types.ts`
- Modify: `src/providers/discord/DiscordProvider.ts`
- Modify: `src/providers/local/LocalStoreProvider.ts`
- Create: `test/turnStatusCoordinator.test.ts`

- [ ] **Step 1: 编写附加、原地更新和正常清理的失败测试**

测试同一 `threadId + turnId` 先设置 `inProgress`、再设置 `waitingApproval` 时始终编辑同一条 Codex 过程消息；正常完成调用 `clearNormalCompletion` 后只移除状态后缀和数据库记录，过程正文仍保留：

```ts
await coordinator.setStatus("thread-1", "turn-1", "inProgress");
await coordinator.setStatus("thread-1", "turn-1", "waitingApproval");
expect(discord.statusSuffixUpdates).toHaveLength(2);
expect(discord.statusSuffixUpdates[1]?.messageId).toBe("commentary-message-1");
await coordinator.clearNormalCompletion("thread-1", "turn-1");
expect(discord.statusSuffixUpdates.at(-1)?.statusText).toBeNull();
```

- [ ] **Step 2: 运行测试并确认协调器尚不存在**

Run: `npm test -- test/turnStatusCoordinator.test.ts`

Expected: FAIL，提示无法导入 `TurnStatusCoordinator`。

- [ ] **Step 3: 实现状态渲染与协调器**

状态文本固定为简短中文，不包含项目名、任务标题、聊天正文或原始错误日志：

```ts
const labels: Record<TurnStatusKind, string> = {
  inProgress: "🟡 状态：进行中",
  waitingApproval: "🟠 状态：等待审批",
  reconnecting: "🔵 状态：正在重连",
  networkError: "🔴 状态：网络错误",
  rateLimited: "🔴 状态：额度或限流",
  systemError: "🔴 状态：系统错误",
};
```

`setStatus` 仅处理 conversation channel；优先从已镜像的 `agentCommentary` 找到本轮过程消息，通过 provider 的状态后缀 API 只替换末尾状态。没有过程消息时通过 `upsertLiveTextMessage` 创建临时状态，之后自动迁移。`clearNormalCompletion` 只移除后缀或删除临时消息；异常路径保留状态。

- [ ] **Step 4: 增加重启恢复测试并实现 `reconcileStartup`**

测试 active/in-progress turn 会复用已持久化状态，正常终态会删除遗留的 `inProgress`、`waitingApproval` 或 `reconnecting`，异常状态不会删除。

- [ ] **Step 5: 运行协调器测试**

Run: `npm test -- test/turnStatusCoordinator.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交协调器改动**

```powershell
git add src/bridge/status/TurnStatusCoordinator.ts src/util/formatting.ts test/turnStatusCoordinator.test.ts
git commit -m "feat: coordinate Discord intermediate status"
```

### Task 3: Session 结构化错误判定与误报过滤

**Files:**
- Modify: `src/codex/CodexSessionEventTailer.ts`
- Test: `test/sessionEventTailer.test.ts`

- [ ] **Step 1: 编写结构化完成、网络错误和限流的失败测试**

覆盖以下 JSONL 事件：`task_complete.last_agent_message` 有内容为正常完成，null/空为 `networkError`；任务级 `stream disconnected before completion`、`tls handshake eof` 为 `networkError`；明确的 429、`rate_limit`、`insufficient_quota` 为 `rateLimited`。

- [ ] **Step 2: 编写误报过滤的失败测试**

确认以下内容不会产生状态事件：普通 user/agent message、function call/output、`token_count.rate_limits`、全局 pubsub 重连、remote-control websocket 409、无关浏览器与描述生成错误。

- [ ] **Step 3: 运行 tailer 测试并确认缺少 `sessionTurnStatus` 事件**

Run: `npm test -- test/sessionEventTailer.test.ts`

Expected: FAIL，期望事件不存在。

- [ ] **Step 4: 实现严格的结构化分类器**

新增 `sessionTurnStatus` 事件，只读取任务生命周期字段或带 conversation/turn ID 的任务级错误。分类顺序为限流、网络、系统；普通消息正文和工具输出不进入分类器。

- [ ] **Step 5: 运行 tailer 测试**

Run: `npm test -- test/sessionEventTailer.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交解析器改动**

```powershell
git add src/codex/CodexSessionEventTailer.ts test/sessionEventTailer.test.ts
git commit -m "feat: classify structured Codex turn failures"
```

### Task 4: 接入消息、审批、重连和结束事件

**Files:**
- Modify: `src/bridge/BridgeCoordinatorGraph.ts`
- Modify: `src/bridge/BridgeService.ts`
- Modify: `src/bridge/events/SessionEventCoordinator.ts`
- Modify: `src/bridge/events/NotificationRouter.ts`
- Modify: `src/bridge/approval/ApprovalCoordinator.ts`
- Test: `test/bridge.mirroring.integration.test.ts`

- [ ] **Step 1: 编写会话生命周期的失败集成测试**

验证：用户消息正常镜像后出现一条 `进行中`；重复事件不新增消息；审批时原地更新为 `等待审批`；审批解决后回到 `进行中`；最终回复发布后状态消息被删除，最终回复仍保留。

- [ ] **Step 2: 编写异常与重连的失败集成测试**

验证：`systemError` 更新为 `系统错误`；同一 active turn 从 `systemError` 恢复时更新为 `正在重连`；结构化 network/rate-limit 事件更新为对应红色状态且不会在异常路径被删除。

- [ ] **Step 3: 运行集成测试并确认状态消息尚未接入**

Run: `npm test -- test/bridge.mirroring.integration.test.ts`

Expected: FAIL，Discord fake adapter 中没有中间状态消息。

- [ ] **Step 4: 将协调器注入事件图**

在 `BridgeCoordinatorGraph` 创建一个 `TurnStatusCoordinator`，向 session、notification 和 approval 协调器传入窄接口：

```ts
setTurnStatus(threadId, turnId, statusKind)
clearNormalTurnStatus(threadId, turnId)
resumeTurnStatus(threadId, turnId)
```

- [ ] **Step 5: 接入中间状态生命周期**

用户消息镜像成功后设置 `进行中`；审批卡发布后设置 `等待审批`；审批解决并继续执行时回到 `进行中`；`systemError` 设置异常，恢复 active 设置 `正在重连`；任务级错误按分类设置红色状态；正常最终消息成功发布后清理状态。

- [ ] **Step 6: 接入启动恢复**

在 `BridgeService.start()` 完成 provider、状态存储与 thread discovery 初始化后调用 `reconcileStartup()`。恢复失败只记录日志，不阻塞正常消息镜像。

- [ ] **Step 7: 运行集成与相关单元测试**

Run: `npm test -- test/bridge.mirroring.integration.test.ts test/sessionEventTailer.test.ts test/turnStatusCoordinator.test.ts test/store.test.ts`

Expected: PASS。

- [ ] **Step 8: 提交事件接入改动**

```powershell
git add src/bridge/BridgeCoordinatorGraph.ts src/bridge/BridgeService.ts src/bridge/events/SessionEventCoordinator.ts src/bridge/events/NotificationRouter.ts src/bridge/approval/ApprovalCoordinator.ts test/bridge.mirroring.integration.test.ts
git commit -m "feat: mirror Codex intermediate status to Discord"
```

### Task 5: 全量验证与实机重启

**Files:**
- Verify only; do not modify Telegram or proxy files.

- [ ] **Step 1: 运行静态检查和全量测试**

Run: `npm run check`

Expected: TypeScript、lint 与格式检查全部通过。

Run: `npm test`

Expected: 全部测试通过，无未处理 promise 或 provider 错误。

- [ ] **Step 2: 检查提交范围**

Run: `git status --short`

Expected: 本功能文件已提交；原有 `package.json`、`package-lock.json` 与 `scripts/proxy-bootstrap.cjs` 仍保持原样且未进入本功能提交。

- [ ] **Step 3: 精确重启 Discord Bridge guard**

重新读取进程命令行，仅停止命令行指向 `discord-bridge` guard/bridge 的进程树，再通过 `scripts/start-codex-guard.ps1` 隐藏启动；不停止 Telegram 与代理守护。

- [ ] **Step 4: 验证进程、日志与 Discord 实际消息**

Run: `npm run inspect:discord`

Expected: 当前任务频道存在一条中文中间状态；状态变化使用同一个 Discord message ID；服务日志无重复消息、未捕获异常或重启循环。正常最终回复后再次检查，状态消息已删除。

- [ ] **Step 5: 完成提交核对**

Run: `git log --oneline -6`

Expected: 设计、计划、持久化、分类器、状态协调器与事件接入提交清晰可追溯。
