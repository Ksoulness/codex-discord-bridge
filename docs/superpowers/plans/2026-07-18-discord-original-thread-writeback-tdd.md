# Discord 原对话双向写回 TDD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让控制者在 Discord 已监控频道发送普通文字，可靠写入桌面端同一个 Codex 原对话，并提供持久排队、插队、撤回、来源去重和按频道选择下一轮模型。

**Architecture:** 普通 Discord 消息只新增一个 provider 入站入口，之后复用现有 `ProviderCommandCoordinator`、`write_back_queue`、Desktop IPC 和 steer 流程。所有消息先持久入队，Desktop 对话必须由原 owner 的 IPC 写入且失败关闭；模型偏好按线程保存并在入队时快照。Discord 来源的 `userMessage` 通过一次性持久关联跳过镜像，桌面来源保持现有 `You` 行为。

**Tech Stack:** TypeScript 5.9、Node.js 24、discord.js 14、better-sqlite3、node:test、Codex Desktop IPC、Codex app-server。

---

## File Structure

**Create**

- `src/bridge/commands/DiscordPlainMessageCoordinator.ts`: 普通消息鉴权、映射、入队和控制结果，避免继续膨胀现有命令协调器。
- `test/discordPlainMessageCoordinator.test.ts`: 普通消息策略、权限、空闲/忙碌与失败关闭单元测试。
- `test/bridge.writeback.integration.test.ts`: 从 Discord 入站到 Desktop IPC、队列排空和镜像抑制的集成测试。

**Modify**

- `src/config.ts`: `allowPlainMessages` 配置与默认关闭策略。
- `config/presets/recommended.json`: 明确保持普通消息入口默认关闭。
- `bridge.config.example.jsonc`: 记录可选开关，不改真实配置直到实机验收。
- `src/domain.ts`: 普通消息来源、模型偏好及队列扩展字段。
- `src/store/StateStore.ts`: 队列迁移、来源消费和线程模型偏好。
- `src/providers/types.ts`: 普通消息、模型命令和选择菜单 handler。
- `src/providers/discord/DiscordProvider.ts`: Gateway intents、`messageCreate`、`/codex model` 与模型菜单路由。
- `src/providers/local/LocalStoreProvider.ts`: 测试 provider 的新增窄接口。
- `src/codex/CodexDesktopIpcClient.ts`: 原对话 owner 可用性检查。
- `src/codex/CodexAdapter.ts`: 动态模型列表及带可选模型的 `turn/start`。
- `src/bridge/commands/ProviderCommandCoordinator.ts`: 队列投递模型快照、Desktop 失败关闭、插队恢复。
- `src/bridge/BridgeCoordinatorGraph.ts`: 创建普通消息协调器并注入依赖。
- `src/bridge/BridgeService.ts`: 注册普通消息和模型交互 handler。
- `src/bridge/events/NotificationRouter.ts`: 在发布 `You` 前消费 Discord 普通消息来源标记。
- `src/bridge/mirror/MirrorPublisher.ts`: 接受明确的“跳过用户消息发布”决策，不改变其他镜像。
- `test/config.test.ts`, `test/store.test.ts`, `test/discordProvider.test.ts`, `test/codexDesktopIpcClient.test.ts`, `test/codexAdapter.test.ts`, `test/providerCommandCoordinator.test.ts`, `test/bridge.mirroring.integration.test.ts`, `test/run.ts`: 聚焦回归覆盖。
- `README.md`: 普通消息、队列按钮、模型作用范围和 Discord Intent 配置。

## Task 1: 配置开关与 Provider 契约

**Files:**
- Modify: `src/config.ts`
- Modify: `config/presets/recommended.json`
- Modify: `bridge.config.example.jsonc`
- Modify: `src/providers/types.ts`
- Test: `test/config.test.ts`

- [ ] **Step 1: 写入默认关闭的失败测试**

在 `test/config.test.ts` 增加：

```ts
test("plain Discord messages remain disabled unless explicitly enabled", () => {
  const config = createBridgeConfigFromPreset("recommended", {
    allowedUserIds: ["controller"]
  });
  assert.equal(config.messageWriteBacks.allowFromDiscord, true);
  assert.equal(config.messageWriteBacks.allowPlainMessages, false);
});

test("plain Discord messages can be enabled without changing slash write-back", () => {
  const config = createBridgeConfigFromPreset(
    "recommended",
    { allowedUserIds: ["controller"] },
    { messageWriteBacks: { allowFromDiscord: true, allowPlainMessages: true } }
  );
  assert.equal(config.messageWriteBacks.allowPlainMessages, true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```powershell
npm run build
node --test dist/test/config.test.js
```

Expected: TypeScript 报告 `allowPlainMessages` 不存在。

- [ ] **Step 3: 增加最小配置和 handler 类型**

将 `BridgeMessageWriteBackConfig` 扩展为：

```ts
export interface BridgeMessageWriteBackConfig {
  allowFromDiscord: boolean;
  allowPlainMessages: boolean;
  allowedUserIds: string[];
}
```

`recommended` preset 明确设置 `allowPlainMessages: false`。在 `BridgeProviderHandlers` 增加：

```ts
onPlainMessage(input: {
  actor: ProviderActorContext;
  channelId: string;
  messageId: string;
  text: string;
}): Promise<DiscordCommandResult | null>;

onModelCommand(actor: ProviderActorContext, channelId: string): Promise<DiscordCommandResult>;
onModelSelect(actor: ProviderActorContext, channelId: string, model: string | null): Promise<DiscordCommandResult>;
```

- [ ] **Step 4: 运行配置测试**

Run: `npm run build; node --test dist/test/config.test.js`

Expected: PASS，现有 `allowFromDiscord` 行为不变。

- [ ] **Step 5: 提交配置契约**

```powershell
git add src/config.ts config/presets/recommended.json bridge.config.example.jsonc src/providers/types.ts test/config.test.ts
git commit -m "feat: define guarded Discord plain-message write-back"
```

## Task 2: 持久化普通消息来源与模型偏好

**Files:**
- Modify: `src/domain.ts`
- Modify: `src/store/StateStore.ts`
- Test: `test/store.test.ts`

- [ ] **Step 1: 编写数据库迁移失败测试**

```ts
test("write-back queue persists plain-message origin and model snapshot", () => {
  const store = createTestStore();
  const record = store.createWriteBackQueueItem({
    threadId: "thr_plain",
    discordChannelId: "channel_1",
    discordMessageId: "message_1",
    actorUserId: "controller",
    text: "检查当前任务",
    sourceKind: "plain",
    requestedModel: "gpt-5.6-sol"
  });

  assert.equal(record.sourceKind, "plain");
  assert.equal(record.discordMessageId, "message_1");
  assert.equal(record.requestedModel, "gpt-5.6-sol");
  assert.equal(record.mirrorConsumedAt, null);
});

test("thread model preference survives restart", () => {
  const store = createTestStore();
  store.setDiscordThreadModelPreference("thr_plain", "gpt-5.6-sol", "controller");
  assert.equal(store.getDiscordThreadModelPreference("thr_plain")?.model, "gpt-5.6-sol");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build; node --test dist/test/store.test.js`

Expected: 新字段和偏好 API 不存在。

- [ ] **Step 3: 增加向后兼容迁移**

扩展 `WriteBackQueueRecord`：

```ts
export type WriteBackSourceKind = "slash" | "plain";

export interface DiscordThreadPreferenceRecord {
  threadId: string;
  model: string | null;
  updatedBy: string;
  updatedAt: string;
}
```

对现有 `write_back_queue` 使用 `PRAGMA table_info` 后逐列 `ALTER TABLE`：

```sql
source_kind TEXT NOT NULL DEFAULT 'slash'
discord_message_id TEXT
requested_model TEXT
mirror_consumed_at TEXT
```

创建 `discord_thread_preferences`，主键为 `codex_thread_id`。普通 discovery 和频道改名不得改写模型偏好。

- [ ] **Step 4: 实现一次性来源消费**

增加事务方法：

```ts
claimSentPlainWriteBackForMirror(input: {
  threadId: string;
  normalizedText: string;
  observedAt: string;
}): WriteBackQueueRecord | null;
```

只匹配 `source_kind='plain'`、`status='sent'`、`mirror_consumed_at IS NULL`、同一线程、完整规范化文本一致且 `sent_at` 在最近十分钟内的最早一条记录；命中后原子设置 `mirror_consumed_at`。

- [ ] **Step 5: 运行持久化测试**

Run: `npm run build; node --test dist/test/store.test.js`

Expected: 新老数据库、一次性消费和偏好重启测试全部 PASS。

- [ ] **Step 6: 提交持久化改动**

```powershell
git add src/domain.ts src/store/StateStore.ts test/store.test.ts
git commit -m "feat: persist Discord write-back provenance and models"
```

## Task 3: Discord 普通消息监听

**Files:**
- Modify: `src/providers/discord/DiscordProvider.ts`
- Test: `test/discordProvider.test.ts`

- [ ] **Step 1: 编写普通消息分发失败测试**

```ts
test("controller plain text dispatches channel and message identity", async () => {
  const provider = createProvider();
  let received: unknown = null;
  setHandlers(provider, {
    onPlainMessage: async (input) => {
      received = input;
      return null;
    }
  });

  await invokeMessage(provider, {
    id: "message_1",
    channelId: "channel_1",
    content: "继续检查",
    author: { id: "controller", username: "ka", bot: false },
    webhookId: null
  });

  assert.deepEqual(received, {
    actor: { userId: "controller", username: "ka", roleIds: [] },
    channelId: "channel_1",
    messageId: "message_1",
    text: "继续检查"
  });
});
```

另写测试确认 Bot、Webhook、空文本与私信不分发。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build; node --test dist/test/discordProvider.test.js`

Expected: `messageCreate` listener 和 `onPlainMessage` 调用不存在。

- [ ] **Step 3: 增加最小 Gateway 入口**

客户端 intents 改为：

```ts
intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent
]
```

`start()` 注册 `messageCreate`，`stop()` 对称移除。handler 只提取消息身份和纯文字，不在 provider 内判断线程状态。

- [ ] **Step 4: 运行 provider 测试**

Run: `npm run build; node --test dist/test/discordProvider.test.js`

Expected: 普通消息和所有忽略条件 PASS，现有 interaction 测试不变。

- [ ] **Step 5: 提交 Discord 入站入口**

```powershell
git add src/providers/discord/DiscordProvider.ts test/discordProvider.test.ts
git commit -m "feat: receive controller messages from Discord"
```

## Task 4: 普通消息策略与队列控制

**Files:**
- Create: `src/bridge/commands/DiscordPlainMessageCoordinator.ts`
- Create: `test/discordPlainMessageCoordinator.test.ts`
- Modify: `src/bridge/BridgeCoordinatorGraph.ts`
- Modify: `src/bridge/BridgeService.ts`
- Modify: `src/providers/local/LocalStoreProvider.ts`
- Modify: `test/run.ts`

- [ ] **Step 1: 编写鉴权和映射失败测试**

覆盖：功能开关关闭、非控制者、未映射频道、暂停/未选择对话、子代理线程、空文本和超长文本。所有情况都必须不创建队列项。

```ts
const result = await coordinator.handlePlainMessage({
  actor: controller,
  channelId: "unmapped",
  messageId: "message_1",
  text: "继续"
});
assert.match(result?.content ?? "", /未绑定/);
assert.equal(store.listWriteBackQueueItems().length, 0);
```

- [ ] **Step 2: 编写空闲与忙碌失败测试**

```ts
test("idle mapped thread queues then drains immediately", async () => {
  const fixture = createFixture({ busy: false, model: "gpt-5.6-sol" });
  const result = await fixture.coordinator.handlePlainMessage(plainInput("立即执行"));
  assert.equal(result, null);
  assert.equal(fixture.queue[0]?.status, "sent");
  assert.equal(fixture.queue[0]?.requestedModel, "gpt-5.6-sol");
});

test("busy mapped thread stays queued with insert and retract controls", async () => {
  const fixture = createFixture({ busy: true });
  const result = await fixture.coordinator.handlePlainMessage(plainInput("下一步处理"));
  assert.match(result?.content ?? "", /已排队.*第 1 条/);
  assert.deepEqual(result?.buttons?.map((button) => button.label), ["插队当前轮", "撤回"]);
  assert.equal(fixture.queue[0]?.status, "pending");
});
```

- [ ] **Step 3: 实现最小协调器**

协调器复用现有 `Policy` 鉴权和 `StateStore.findThreadBridgeByDiscordChannelId`。所有普通消息先调用 `createWriteBackQueueItem(sourceKind="plain")`；空闲时调用现有 drain，忙碌时返回公开控制条。不得直接调用 Codex。

- [ ] **Step 4: 接入 BridgeService**

`BridgeCoordinatorGraph` 构造协调器，`BridgeService.start()` 将 provider 的 `onPlainMessage` 接到协调器。只有返回非空结果时 provider 才回复；成功立即投递不产生额外 Bot 消息。

- [ ] **Step 5: 运行策略测试**

Run:

```powershell
npm run build
node --test dist/test/discordPlainMessageCoordinator.test.js dist/test/discordProvider.test.js
```

Expected: PASS，当前 `/codex send` 测试继续通过。

- [ ] **Step 6: 提交普通消息协调器**

```powershell
git add src/bridge/commands/DiscordPlainMessageCoordinator.ts src/bridge/BridgeCoordinatorGraph.ts src/bridge/BridgeService.ts src/providers/local/LocalStoreProvider.ts test/discordPlainMessageCoordinator.test.ts test/run.ts
git commit -m "feat: queue Discord plain messages for Codex"
```

## Task 5: 桌面原对话失败关闭

**Files:**
- Modify: `src/codex/CodexDesktopIpcClient.ts`
- Modify: `src/bridge/commands/ProviderCommandCoordinator.ts`
- Test: `test/codexDesktopIpcClient.test.ts`
- Test: `test/providerCommandCoordinator.test.ts`

- [ ] **Step 1: 编写 owner 可用性失败测试**

```ts
assert.equal(client.canStartTurnInDesktopThread("thr_owned"), true);
assert.equal(client.canStartTurnInDesktopThread("thr_missing"), false);
```

测试 IPC 断开、没有 owner、owner 已移除都返回 `false`。

- [ ] **Step 2: 编写同一原对话路由失败测试**

```ts
test("desktop write-back uses the bound conversation and never adapter fallback", async () => {
  const harness = createHarness({
    sourceKind: "app-server",
    desktopOwner: "desktop-client"
  });
  await harness.coordinator.drainNextQueuedWriteBackMessage("thr_original");
  assert.deepEqual(harness.desktopStarts, [{
    conversationId: "thr_original",
    text: "从 Discord 发送",
    model: "gpt-5.6-sol"
  }]);
  assert.equal(harness.adapterStarts.length, 0);
});

test("missing desktop owner keeps the message queued", async () => {
  const harness = createHarness({ sourceKind: "app-server", desktopOwner: null });
  const result = await harness.coordinator.drainNextQueuedWriteBackMessage("thr_original");
  assert.equal(result?.status, "pending");
  assert.match(result?.error ?? "", /桌面连接不可用/);
  assert.equal(harness.adapterStarts.length, 0);
});
```

- [ ] **Step 3: 实现 owner 检查和可恢复失败**

增加：

```ts
canStartTurnInDesktopThread(conversationId: string): boolean {
  return this.connected && this.ownerClientIdsByThread.has(conversationId);
}
```

`startWriteBackTurn` 对 Desktop 对话必须先检查该方法。缺少 owner 时抛出可识别的 `DesktopWriteBackUnavailableError`；drain 捕获后使用 `restoreWriteBackQueueItemPending`，而不是标记 `failed` 或调用 adapter。

- [ ] **Step 4: 验证插队竞态**

补测试：点击插队后 `turn/steer` 报当前轮结束，记录恢复 `pending`；下一次完成事件触发 drain 后只发送一次。

- [ ] **Step 5: 运行路由测试**

Run:

```powershell
npm run build
node --test dist/test/codexDesktopIpcClient.test.js dist/test/providerCommandCoordinator.test.js
```

Expected: Desktop 原 thread ID、无 adapter fallback、队列恢复和插队竞态测试全部 PASS。

- [ ] **Step 6: 提交桌面路由保护**

```powershell
git add src/codex/CodexDesktopIpcClient.ts src/bridge/commands/ProviderCommandCoordinator.ts test/codexDesktopIpcClient.test.ts test/providerCommandCoordinator.test.ts
git commit -m "fix: keep Discord write-back in the original desktop thread"
```

## Task 6: 抑制 Discord 来源的重复 `You`

**Files:**
- Modify: `src/bridge/events/NotificationRouter.ts`
- Modify: `src/bridge/mirror/MirrorPublisher.ts`
- Test: `test/bridge.mirroring.integration.test.ts`
- Test: `test/store.test.ts`

- [ ] **Step 1: 编写来源去重失败测试**

```ts
test("a plain Discord write-back is not mirrored back as You", async () => {
  const fixture = await createBridgeFixture();
  fixture.store.createSentPlainWriteBack({
    threadId: "thr_original",
    discordMessageId: "message_ka",
    text: "继续检查"
  });

  fixture.codex.emitUserMessage("thr_original", "turn_2", "继续检查");
  await fixture.drain();

  assert.equal(fixture.discord.userMessages.length, 0);
  assert.ok(fixture.store.getWriteBackQueueItem(1)?.mirrorConsumedAt);
});
```

另写三项测试：桌面来源仍显示 `You`；slash 来源仍显示 `You`；两条相同普通消息只各消费一次且不影响第三条桌面消息。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build; node --test dist/test/bridge.mirroring.integration.test.js dist/test/store.test.js`

Expected: Discord 来源仍被发布为 `You`。

- [ ] **Step 3: 在发布边界消费来源标记**

`NotificationRouter` 提取完整用户文本后、调用 `MirrorPublisher` 前，调用 `claimSentPlainWriteBackForMirror`。命中时：

- 仍保存 canonical event 和线程状态。
- 不调用 Discord 用户消息发布。
- 不影响状态灯、agent 回复或队列排空。

不要在 `MirrorPublisher` 按文本做全局过滤；来源判断必须是线程级、一次性、持久化的明确决策。

- [ ] **Step 4: 运行去重测试**

Run: `npm run build; node --test dist/test/bridge.mirroring.integration.test.js dist/test/store.test.js`

Expected: 四种来源场景全部 PASS。

- [ ] **Step 5: 提交来源去重**

```powershell
git add src/bridge/events/NotificationRouter.ts src/bridge/mirror/MirrorPublisher.ts test/bridge.mirroring.integration.test.ts test/store.test.ts
git commit -m "fix: avoid echoing Discord user messages as You"
```

## Task 7: 动态模型选择和入队快照

**Files:**
- Modify: `src/codex/CodexAdapter.ts`
- Modify: `src/codex/CodexDesktopIpcClient.ts`
- Modify: `src/bridge/commands/DiscordPlainMessageCoordinator.ts`
- Modify: `src/bridge/commands/ProviderCommandCoordinator.ts`
- Modify: `src/providers/discord/DiscordProvider.ts`
- Modify: `src/bridge/BridgeService.ts`
- Test: `test/codexAdapter.test.ts`
- Test: `test/discordProvider.test.ts`
- Test: `test/discordPlainMessageCoordinator.test.ts`
- Test: `test/providerCommandCoordinator.test.ts`

- [ ] **Step 1: 编写动态模型列表失败测试**

```ts
test("model list is read from Codex instead of hard-coded", async () => {
  const adapter = createAdapterRespondingTo("model/list", {
    data: [
      { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
      { id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra" }
    ]
  });
  assert.deepEqual(await adapter.listModels(), [
    { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra" }
  ]);
});
```

- [ ] **Step 2: 编写模型菜单和偏好失败测试**

验证 `/codex model` 从当前频道解析 `threadId`，返回“跟随 Codex 默认模型”和动态模型；非控制者、未映射频道不能修改。选择后只写 `discord_thread_preferences`。

- [ ] **Step 3: 编写入队快照失败测试**

```ts
store.setDiscordThreadModelPreference("thr_original", "gpt-5.6-sol", "controller");
await coordinator.handlePlainMessage(plainInput("任务 A"));
store.setDiscordThreadModelPreference("thr_original", "gpt-5.6-terra", "controller");
assert.equal(store.getWriteBackQueueItem(1)?.requestedModel, "gpt-5.6-sol");
```

- [ ] **Step 4: 实现模型菜单和 turn 参数**

扩展 `CodexAdapter.startTurn`：

```ts
async startTurn(threadId: string, text: string, options: { model?: string | null } = {}): Promise<void>
```

只在 `options.model` 非空时发送 `model`。Desktop IPC 的 `turnStartParams` 同样只追加非空 `model`。插队路径不读取 `requestedModel`。

- [ ] **Step 5: 注册 `/codex model`**

增加 slash subcommand 和 `codex:model:*` 选择菜单路由。回复始终为 ephemeral，选择结果文案明确：

```text
已设置：GPT-5.6 Sol
只影响此频道以后由 Discord 发起的新一轮；插队沿用当前轮模型。
```

- [ ] **Step 6: 运行模型测试**

Run:

```powershell
npm run build
node --test dist/test/codexAdapter.test.js dist/test/discordProvider.test.js dist/test/discordPlainMessageCoordinator.test.js dist/test/providerCommandCoordinator.test.js
```

Expected: 动态列表、权限、偏好、快照、Desktop 参数和插队模型语义全部 PASS。

- [ ] **Step 7: 提交模型功能**

```powershell
git add src/codex/CodexAdapter.ts src/codex/CodexDesktopIpcClient.ts src/bridge/commands/DiscordPlainMessageCoordinator.ts src/bridge/commands/ProviderCommandCoordinator.ts src/providers/discord/DiscordProvider.ts src/bridge/BridgeService.ts test/codexAdapter.test.ts test/discordProvider.test.ts test/discordPlainMessageCoordinator.test.ts test/providerCommandCoordinator.test.ts
git commit -m "feat: select Discord write-back models per thread"
```

## Task 8: 端到端回归与受控实机试用

**Files:**
- Create: `test/bridge.writeback.integration.test.ts`
- Modify: `test/run.ts`
- Modify: `README.md`
- Modify after automated checks: `bridge.config.json`

- [ ] **Step 1: 编写完整失败集成测试**

覆盖一条完整生命周期：

```text
普通 ka 消息 -> 持久队列 -> 原 Desktop threadId -> Codex userMessage 不回显 You
-> agent 回复正常镜像 -> 状态灯正常完成
```

另覆盖：忙时两条 FIFO、第二条插队、插队竞态恢复、撤回、IPC 断开重启恢复、模型快照和配置关闭。

- [ ] **Step 2: 运行完整写回测试**

Run:

```powershell
npm run build
node --test dist/test/bridge.writeback.integration.test.js
```

Expected: 所有链路测试 PASS，fake Codex 中不存在 `thread/start` 调用。

- [ ] **Step 3: 运行静态检查和全量测试**

Run:

```powershell
npm run check
npm test
```

Expected: 全部通过；现有监控、状态、命名、审批和镜像用例无回归。

- [ ] **Step 4: 检查提交范围**

Run: `git status --short`

Expected: 本功能提交不包含实施前已经存在的 `package.json`、`package-lock.json` 与 `scripts/proxy-bootstrap.cjs` 改动。

- [ ] **Step 5: 配置 Discord Developer Portal**

在 Bot 设置中开启 Message Content Intent，并确认 Bot 在受控频道具有 `ViewChannel`、`ReadMessageHistory`、`SendMessages`。不扩大其他成员权限。

- [ ] **Step 6: 仅对本机显式开启试用**

在 `bridge.config.json` 添加：

```json
{
  "preset": "recommended",
  "messageWriteBacks": {
    "allowPlainMessages": true
  }
}
```

重启前记录一个试验用原对话 ID。不要在所有频道同时测试。

- [ ] **Step 7: 原对话可见性硬验收**

在该 Discord 频道发送唯一文本 `discord-desktop-link-<timestamp>`，必须同时满足：

1. 桌面 Codex 当前同一个对话出现该用户消息。
2. Codex 侧栏没有新增对话。
3. Discord 不出现机器人版重复 `You`。
4. 回复和状态灯继续在同一频道更新。
5. 运行日志记录同一 `threadId` 的 Desktop IPC start-turn，不含 `thread/start`。

任一条件失败，立即把 `allowPlainMessages` 改回 `false` 并停止试用，不删除队列数据库。

- [ ] **Step 8: 验证排队、插队和模型**

启动一个长任务后连续发送两条消息，确认两条显示队列顺序；对第二条点击“插队”，确认它进入当前轮且沿用当前模型。随后用 `/codex model` 选择另一个模型，再发送新消息，确认只有新一轮使用新模型，桌面输入框模型不被修改。

- [ ] **Step 9: 更新 README 并完成提交**

```powershell
git add test/bridge.writeback.integration.test.ts test/run.ts README.md bridge.config.json
git commit -m "feat: enable Discord original-thread write-back"
```

## Plan Self-Review

- 每项需求均有对应任务：普通消息入口（Task 3/4）、原桌面对话（Task 5）、排队插队撤回（Task 4/5）、`You` 去重（Task 6）、模型（Task 7）、回归与实机门槛（Task 8）。
- 功能默认关闭，只有自动测试完成后才修改真实配置。
- Desktop 对话没有独立 App Server 兜底；无法证明写入原对话时保留队列并报错。
- 模型只影响 Discord 发起的新轮，插队沿用当前模型，桌面输入框不变。
- 计划不包含 Telegram、代理守护、启动器或项目目录外文件。
- 计划中没有 `TBD`、`TODO` 或未定义的后续步骤。
