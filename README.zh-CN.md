# Codex Discord Bridge

中文 | [English](README.md)

详细文档：[功能档案](docs/codex-discord-capability-archive.zh-CN.md) · [AI 实施与验收手册](docs/ai-feature-implementation-runbook.zh-CN.md)

这是一个本地优先的桥接程序：它将 Codex 的实时活动同步到 Discord，并把受支持的审批和写回操作路由回同一台电脑上正在运行的 Codex 任务。

上游原版建立了 Codex 到 Discord 的活动同步基础。本独立维护版本在此基础上增加了受控的 Discord → Codex 直接对话：经授权的控制者可继续同一任务的对话，并要求 Codex 修改项目。

Codex 始终运行在你的电脑上。Discord 只是受到严格限制的通知与控制界面，不是事实来源。

## 功能

- 同步用户消息、过程说明、最终回答、命令、文件编辑和受支持的审批请求。
- 在 Discord 中响应精确匹配的受支持审批和计划反馈请求。
- 使用 `/codex` 命令向已映射的 Codex 对话发送消息、排队、撤回或引导当前任务。
- 可选地允许一名已配置的 Discord 控制者发送普通文本消息。
- 按项目和对话选择监控范围；在 Discord 线程中查看受支持的子代理活动。
- 使用 SQLite 保存必要的本地状态；对常见密钥模式脱敏、使过期控件失效，并在状态不明确时拒绝操作。

## 限制与安全边界

- Windows 是受支持平台；macOS 仅尽力支持，Linux 暂不支持。
- 只有电脑、Codex 和桥接进程都运行时，本桥接才会工作。
- 当前只支持 Discord。
- Discord 控制者只能在桥接已映射的位置，对精确出现的审批或写回操作执行控制。
- 本项目不提供从 Discord 任意执行命令的能力。
- 同步到 Discord 的内容会离开本机。请使用自己控制的私有 Discord 服务器，并在启用更丰富的同步内容前检查可见性配置。

启用远程审批或写回前，请先阅读 [SECURITY.md](SECURITY.md)。

## 前置条件

- Windows 10/11
- Node.js 24 或更高版本
- 已在同一台电脑上正常运行的 Codex Desktop 或 Codex CLI
- Discord 账户和由你控制的 Discord 服务器
- 创建 Discord 应用和机器人的权限

## 快速开始

1. 在运行 Codex 的电脑上克隆本仓库。

   ```powershell
   git clone <your-repository-url>
   cd codex-discord-bridge
   ```

2. 安装依赖并启动配置向导。

   ```powershell
   npm install
   npm run init
   ```

3. 按向导提示创建或选择 Discord 服务器，创建 Discord 应用和机器人，邀请机器人进入服务器，并填写所需的 ID 与机器人令牌。

4. 验证配置。

   ```powershell
   npm run doctor
   ```

5. 启动桥接。

   ```powershell
   npm start
   ```

使用 Codex 期间保持桥接运行；结束时按 `Ctrl+C` 停止。

## 手动配置 Discord

推荐使用向导；若手动配置，请按以下步骤操作：

1. 创建或选择一个你控制的私有 Discord 服务器。
2. 启用 Discord 开发者模式并复制服务器 ID。
3. 打开 [Discord Developer Portal](https://discord.com/developers/applications)，创建应用并添加机器人。
4. 配置机器人服务器安装权限，邀请机器人进入服务器，并授予 `npm run init` 所提示的权限。
5. 复制机器人令牌、应用 ID 和你的 Discord 用户 ID。
6. 基于 `.env.example` 创建 `.env`，填入下列值。绝不要提交此文件。

   ```env
   DISCORD_BOT_TOKEN=<机器人令牌>
   DISCORD_APPLICATION_ID=<应用 ID>
   DISCORD_GUILD_ID=<服务器 ID>
   DISCORD_CONTROLLER_USER_ID=<你的 Discord 用户 ID>
   ```

7. 创建 `bridge.config.json` 并选择预设：

   ```json
   { "preset": "recommended" }
   ```

8. 运行 `npm run doctor`，然后运行 `npm start`。

完整配置说明见 [bridge.config.example.jsonc](bridge.config.example.jsonc)。

## 预设

| 预设 | 行为 |
| --- | --- |
| `basic` | 同步对话和汇总活动，不启用 Discord 写回。 |
| `recommended` | 增加受保护的 `/codex send`、排队/撤回和引导控制。 |
| `full` | 增加未汇总的命令/文件活动和详情按钮。 |

建议从 `recommended` 开始。只有充分理解隐私影响并已启用 Discord Message Content Intent 时，才启用普通消息写回。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run init` | 引导式 Discord 与本地配置。 |
| `npm run doctor` | 检查前置条件、配置和权限。 |
| `npm start` | 启动桥接。 |
| `npm run dev` | 以开发模式启动桥接。 |
| `npm run inspect` | 检查本地桥接状态。 |
| `npm run inspect:discord` | 检查 Discord 映射。 |
| `npm run inspect:codex` | 检查 Codex 发现状态。 |
| `npm run inspect:desktop` | 检查近期 Desktop 审批和问题事件。 |
| `npm run clean` | 删除桥接创建的 Discord 结构和本地状态。 |
| `npm run build` | 编译 TypeScript。 |
| `npm test` | 运行测试。 |

使用项目辅助命令启动 Codex CLI：

```powershell
npm run cli -- -C C:\path\to\workspace
```

## 工作方式

1. Codex Desktop 或 CLI 已在本机完成登录。
2. 桥接仅连接同一台电脑上的本地 Codex 接口。
3. 选定的 Codex 活动被同步到 Discord。
4. Discord 控件在本地针对精确的活跃 Codex 请求进行验证。
5. 桥接只保存映射、去重、审批和待发送写回消息所需的状态。

Discord 的层级对应 Codex 工作：项目对应分类，对话对应文本频道，受支持的子代理对话对应 Discord 线程。

## 故障排查

**机器人没有出现或桥接无法连接**

运行 `npm run doctor`。确认机器人令牌、应用 ID 和服务器 ID 属于同一个 Discord 应用和服务器。

**Codex 出现审批，但 Discord 未显示**

运行 `npm run inspect:desktop` 和 `npm run inspect:thread -- <thread-id> 20`，并确认桥接与 Codex 在同一台电脑上运行。

**子代理审批显示为只读**

在 Codex Desktop 中打开该子代理对话。某些 Desktop 子代理请求会先通过本地日志可见，之后 Desktop 才会暴露可路由的原生审批请求。

**Discord 历史过于嘈杂**

使用 `basic` 预设，或在 `bridge.config.json` 中关闭相应可见性设置。

## 开发

```powershell
npm run build
npm run check
npm test
npm run coverage:gate
```

请通过 GitHub Issues 提交问题和建议。不要在 issue 中发布令牌、`.env`、本地数据库或未脱敏日志。详见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [SECURITY.md](SECURITY.md)。

## 项目来源、致谢与许可证

本项目是对上游 [NathanZane/codex-mobile](https://github.com/NathanZane/codex-mobile) 的独立维护二次开发版本。原版由 Natale 及贡献者发布，并建立了活动同步实现；本仓库在此基础上增加了受控的 Discord → Codex 同任务直接对话，使经授权用户能够继续对话并请求修改项目，同时加入自己的文档与安全限制。

项目继续采用 [MIT License](LICENSE)。本衍生版本由本仓库独立维护，不代表获得上游作者的认可或背书。
