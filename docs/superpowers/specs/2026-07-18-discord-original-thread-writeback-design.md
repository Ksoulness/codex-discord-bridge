# Discord 原对话双向写回设计

## 目标

让控制者 `ka` 在已监控的 Discord 对话频道中直接发送普通文字，并把该文字可靠地写入频道所绑定的 Codex Desktop 原对话。Codex Desktop 与 Discord 必须继续使用同一个 `threadId`，不得静默创建新对话。

同时提供：

- 忙时持久排队，任务结束后按顺序续发。
- 队列消息可选择“插队”到当前运行轮，也可撤回。
- 每个 Discord 对话频道可选择后续由 Discord 发起的新一轮所用模型。
- Discord 原始 `ka` 消息进入 Codex 后，不再由机器人重复镜像成一条 `You`。
- 桌面端直接发送的用户消息仍正常镜像为 `You`。

## 非目标

本阶段不实现：

- 改变 Codex Desktop 输入框当前显示的模型选择。
- 在任务执行途中切换当前轮模型。
- Discord 图片、附件、语音和引用消息写回。
- 多控制者协作或普通成员写回。
- 从 Discord 新建 Codex 对话。
- 替换现有监控管理、状态灯、频道命名、审批或镜像系统。

## 当前基础

Bridge 已经具备以下可复用能力：

- Discord 频道到原 `codexThreadId` 的持久映射。
- `/codex send` 的控制者鉴权、文本校验、持久队列与撤回。
- 空闲时通过 Desktop IPC 的 `thread-follower-start-turn` 启动原对话新一轮。
- 执行中通过 `turn/steer` 插入当前轮。
- 当前轮结束后自动排空下一条队列消息。
- Discord 按钮、选择菜单和 SQLite 重启恢复。

目前缺少的是普通 Discord 消息监听、普通消息来源标记、原消息镜像抑制和模型偏好。

## 推荐架构

### 1. 普通消息入口

`DiscordProvider` 增加 `GuildMessages` 与 `MessageContent` Gateway intent，并监听 `messageCreate`。消息只有同时满足以下条件才会进入 Bridge：

- 来自配置中的唯一控制者用户 ID。
- 位于一个有效的、已选择监控的普通 Codex 对话频道。
- 作者不是 Bot 或 Webhook。
- 不是 `#监控管理`、子代理线程或未映射频道。
- 内容为非空纯文字，长度不超过现有写回限制。
- `messageWriteBacks.allowPlainMessages` 已显式开启。

不满足条件的消息静默忽略；控制者在有效频道发送了不支持的附件或超长消息时，Bridge 才返回简短错误。

### 2. 统一持久队列

普通消息不直接绕过队列。每条消息先保存为 `write_back_queue` 记录，再根据原对话状态决定立即投递还是等待：

```text
ka 普通消息
  -> 保存队列记录（threadId、Discord messageId、文本、模型快照）
  -> 原对话空闲：立即 claim 并投递同一 threadId
  -> 原对话忙碌：保持 pending，显示“插队 / 撤回”控制条
  -> 当前轮完成：自动 claim 最早 pending 项并启动下一轮
```

所有队列操作仍按 `threadId` 串行。Bridge 重启后，未发送记录继续保留。

### 3. 原桌面对话硬保证

对 `sourceKind !== "cli-session"` 的 Desktop 对话，普通消息必须走 `CodexDesktopIpcClient.startTurn(conversationId, params)`，其中 `conversationId` 必须等于频道绑定的 `codexThreadId`。

新增 Desktop owner 检查：

- Desktop IPC 已连接且该 `threadId` 有 owner：允许投递。
- IPC 未连接、owner 不存在或请求失败：恢复队列为 `pending`，显示“桌面连接不可用，消息仍在队列”。
- Desktop 对话禁止回退到独立 `codex app-server` 启动新轮。
- CLI 会话仍可使用现有 `CodexAdapter` 路径。

任何写回路径都不得调用 `thread/start`。找不到原映射时直接拒绝。

### 4. 排队、插队和撤回

原对话忙碌时，Bridge 回复一条简短控制消息：

```text
已排队 · 第 2 条
[插队当前轮] [撤回]
```

- `插队当前轮`：复用现有 `turn/steer`；成功后队列项转为 `sent`。
- 插队时当前轮已经结束：队列项恢复为 `pending`，等待下一轮自动发送。
- `撤回`：仅允许撤回仍为 `pending` 的记录。
- 重复点击：返回“该消息已处理”，不得重复发送。
- 插队沿用当前运行轮的模型，忽略该排队项的模型快照。

空闲时立即投递成功不额外发送 `You` 或控制回复；Codex 后续回复就是成功反馈。投递失败才回复错误。

### 5. Discord 来源的 `You` 去重

普通 `ka` 消息本身已经存在于 Discord。其内容进入 Codex 后，Codex 会产生一个 `userMessage` 事件；Bridge 必须只抑制这一条回流镜像。

队列记录新增：

- `source_kind`: `slash` 或 `plain`。
- `discord_message_id`: 普通消息的 Discord ID。
- `requested_model`: 入队时的模型快照，可为空。
- `mirror_consumed_at`: 对应 Codex `userMessage` 已识别并跳过的时间。

收到 `userMessage` 时，按 `threadId + 完整规范化文本 + 最近 sent_at + source_kind=plain` 原子匹配一条未消费记录，标记 `mirror_consumed_at` 并跳过 Discord 发布。匹配必须一次性消费，不能影响同一线程后续相同文本。

以下消息仍显示 `You`：

- 用户直接在 Codex Desktop 输入的内容。
- `/codex send` 的斜杠命令内容，因为斜杠命令回复是临时消息，频道中没有可替代的 `ka` 正文。
- 无法可靠匹配来源的历史或启动回填内容。

### 6. 模型选择

新增 `/codex model`：

- 动态调用本机 Codex `model/list`，不硬编码模型名称。
- 使用仅控制者可见的 Discord 下拉菜单。
- 第一项为“跟随 Codex 默认模型”。
- 选择按 `codexThreadId` 保存到独立的 `discord_thread_preferences` 表。
- 普通消息入队时把当前偏好复制到 `requested_model`，因此后续改变偏好不会改写已排队消息。
- 启动新一轮时把非空 `requested_model` 放入 `turn/start` / Desktop IPC 参数。
- 插队属于当前轮，沿用当前轮模型。
- 选择仅影响以后从 Discord 发起的新一轮，不修改 Desktop 输入框，也不影响桌面直接发出的消息。

若模型列表暂时读取失败，保留原偏好并提示失败；不发送空模型或猜测模型名称。

### 7. 功能开关与回退

新增配置：

```json
{
  "messageWriteBacks": {
    "allowFromDiscord": true,
    "allowPlainMessages": false
  }
}
```

实现与自动测试完成前保持 `false`。实机验证时只在本机 `bridge.config.json` 显式开启。关闭后：

- 普通 `ka` 消息不再写回。
- `/codex send`、审批、监控、状态和镜像保持原行为。
- 已存在队列不删除，仍按原队列规则处理。

## 故障处理

- Discord Message Content Intent 未开启：启动诊断明确提示，不进入重启循环。
- Desktop IPC 断开：消息留在队列，不调用隐藏 App Server 兜底。
- 线程映射失效：拒绝写回，并指向 `/codex manage` 重新选择。
- 当前轮状态不确定：默认排队，不猜测为可插队。
- steer 返回“当前轮已结束”：恢复排队，避免消息丢失。
- 模型已下线：发送失败后保留队列并提示重新选择模型。
- Bridge 重启：恢复队列、模型偏好和未消费来源标记。
- Discord 消息被用户删除：已经发送到 Codex 的内容不撤销；仍 pending 的消息允许通过控制按钮撤回。

## 验收标准

1. `ka` 在已监控频道发出的普通文字出现在桌面端同一个 Codex 原对话。
2. Codex 侧栏不新增隐藏对话，写回过程从不调用 `thread/start`。
3. Discord 原始 `ka` 消息不再重复显示为机器人版 `You`。
4. 桌面端输入仍正常镜像为 `You`。
5. 空闲消息立即发送；忙时按 FIFO 排队；插队和撤回均可重复安全操作。
6. Desktop IPC 不可用时消息不丢失、不偷偷运行，并明确显示等待原因。
7. `/codex model` 只影响该频道以后由 Discord 发起的新一轮；排队项保留入队时模型。
8. 插队沿用当前轮模型。
9. 关闭 `allowPlainMessages` 后完全恢复当前普通消息只读行为。
10. 现有监控选择、状态灯、频道命名、审批、镜像、启动和代理功能回归测试全部通过。
