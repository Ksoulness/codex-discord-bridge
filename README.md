# Codex Discord Bridge

[中文文档](README.zh-CN.md) | English

Detailed documentation: [Capability archive](docs/codex-discord-capability-archive.md) · [AI implementation runbook](docs/ai-feature-implementation-runbook.md)

A local-first bridge that mirrors live Codex activity to Discord and routes supported approval and write-back actions back to the same locally running Codex task.

The upstream original established the Codex-to-Discord synchronization foundation. This independently maintained version adds guarded direct dialogue from Discord back to the same Codex task, so an authorized controller can continue the conversation and ask Codex to modify the project.

Codex stays on your computer. Discord is a deliberately constrained notification and control surface, not the source of truth.

## Features

For a practical explanation of model selection, Queue vs. Steer, retracting queued messages, and why status indicators can lag, see the [capability archive](docs/codex-discord-capability-archive.md).

- Mirror user messages, commentary, final answers, commands, file edits, and supported approval requests.
- Show live task status with channel indicators: 🟡 in progress/reconnecting, 🔴 approval required or error, 🟢 completed/stopped, and ⚪ monitoring paused.
- Mirror structured Codex plan progress into the task status, including the current step and total steps.
- Respond to exact supported approvals and proposed-plan requests from Discord.
- Continue the same mapped Codex task from Discord with `/codex send`; this is the direct dialogue path for asking Codex to modify the project.
- Queue a message while a task is busy; it is delivered as the next task turn in order. Use `/codex retract` to remove the newest still-pending queued message.
- Steer a confirmed active Codex turn to change its current direction without creating a separate task; ambiguous or stale active-turn state is rejected.
- Optionally allow plain messages from one configured Discord controller user.
- Select projects and conversations in a private management panel; pause, resume, or confirmation-clean their Discord mirrors, and view supported sub-agent activity in threads.
- Hand supported Discord image attachments to the same Codex task with a Discord-CDN allowlist, format/count/size limits, and a seven-day local image-cache rotation.
- Keep only necessary local SQLite state; bound retained turns, expire stale controls, redact common secret patterns, and fail closed when state is ambiguous.

## Limits and Safety

- Windows is the supported platform. macOS is best-effort; Linux is unsupported.
- The bridge works only while this computer, Codex, and the bridge process are running.
- Discord is the only supported provider.
- A Discord controller can act only in bridge-mapped locations, and only on exact surfaced approval or write-back actions.
- This project does not expose arbitrary command execution from Discord.
- Treat all content mirrored to Discord as leaving your machine. Use a private server you control and review the visibility settings before enabling richer output.

Read [SECURITY.md](SECURITY.md) before enabling remote approvals or write-back.

## Prerequisites

- Windows 10/11
- Node.js 24 or later
- Codex Desktop or Codex CLI already working on the same computer
- A Discord account and a Discord server you control
- Permission to create a Discord application and bot

## Quick Start

### AI-assisted setup

Open this repository in Codex and say: `Read AGENTS.md and guide me through setup.` Codex will ask for one step at a time, keep bot tokens out of chat, run diagnostics, and stop before starting the bridge.

1. Clone this repository on the computer running Codex.

   ```powershell
   git clone <your-repository-url>
   cd codex-discord-bridge
   ```

2. Install dependencies and start the setup wizard.

   ```powershell
   npm install
   npm run init
   ```

3. During setup, create or select a Discord server, create a Discord application and bot, invite the bot to the server, and provide the requested IDs and bot token.

4. Verify the configuration.

   ```powershell
   npm run doctor
   ```

5. Start the bridge.

   ```powershell
   npm start
   ```

Keep the bridge running while you use Codex. Stop it with `Ctrl+C` when you are finished.

## Manual Discord Setup

The wizard is recommended, but the required configuration is straightforward:

1. Create a private Discord server, or choose one you control.
2. Enable Discord Developer Mode and copy the server ID.
3. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application and add a bot.
4. Configure the bot for server installation, invite it to the server, and grant the permissions requested by `npm run init`.
5. Copy the bot token, application ID, and your Discord user ID.
6. Create `.env` from `.env.example` and set the values below. Never commit this file.

   ```env
   DISCORD_BOT_TOKEN=<bot-token>
   DISCORD_APPLICATION_ID=<application-id>
   DISCORD_GUILD_ID=<server-id>
   DISCORD_CONTROLLER_USER_ID=<your-discord-user-id>
   ```

7. Create `bridge.config.json` with a preset:

   ```json
   { "preset": "recommended" }
   ```

8. Run `npm run doctor`, then `npm start`.

See [bridge.config.example.jsonc](bridge.config.example.jsonc) for every available setting.

## Presets

| Preset | Behavior |
| --- | --- |
| `basic` | Mirrors conversation and grouped activity; Discord write-back is disabled. |
| `recommended` | Adds guarded `/codex send`, queue/retract, and steering controls. |
| `full` | Adds ungrouped command/file activity and detail buttons. |

The recommended preset is the safest starting point. Enable plain-message write-back only when you understand the privacy implications and have enabled Discord's Message Content Intent.

## Common Commands

| Command | Purpose |
| --- | --- |
| `npm run init` | Guided Discord and local configuration. |
| `npm run doctor` | Validate prerequisites, configuration, and permissions. |
| `npm start` | Start the bridge. |
| `npm run dev` | Start the bridge in development mode. |
| `npm run inspect` | Inspect local bridge state. |
| `npm run inspect:discord` | Inspect Discord mappings. |
| `npm run inspect:codex` | Inspect Codex discovery. |
| `npm run inspect:desktop` | Inspect recent Desktop approval and question events. |
| `npm run clean` | Delete bridge-managed Discord structure and local bridge state. |
| `npm run build` | Compile TypeScript. |
| `npm test` | Run the test suite. |

To use the project helper for Codex CLI:

```powershell
npm run cli -- -C C:\path\to\workspace
```

## How It Works

1. Codex Desktop or CLI is already authenticated locally.
2. This bridge connects only to local Codex surfaces on the same computer.
3. Selected Codex activity is mirrored into Discord.
4. Discord controls are validated locally against the exact active Codex request.
5. The bridge records only the state required to preserve mappings, deduplication, approvals, and queued write-backs.

Discord layout follows Codex work: projects become categories, top-level conversations become text channels, and supported sub-agent conversations become Discord threads.

## Troubleshooting

**The bot does not appear or the bridge cannot connect**

Run `npm run doctor`. Confirm the bot token, application ID, and server ID belong to the same Discord application and server.

**Approvals appear in Codex but not Discord**

Run `npm run inspect:desktop` and `npm run inspect:thread -- <thread-id> 20`. Confirm the bridge runs on the same computer as Codex.

**A sub-agent approval is read-only**

Open the sub-agent conversation in Codex Desktop. Some Desktop sub-agent requests are visible through local logs before Desktop exposes a routable native approval request.

**Discord history is too noisy**

Use the `basic` preset, or disable individual visibility settings in `bridge.config.json`.

## Development

```powershell
npm run build
npm run check
npm test
npm run coverage:gate
```

Please report bugs and feature requests through GitHub Issues. Do not post tokens, `.env` files, local databases, or unredacted logs in an issue. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Project Origin, Credits, and License

This project is an independently maintained derivative of [NathanZane/codex-mobile](https://github.com/NathanZane/codex-mobile), originally released by Natale and contributors. The upstream original established the activity-synchronization implementation. This repository adds guarded direct Discord-to-Codex conversation for the same mapped task, enabling authorized users to continue the dialogue and request project changes, alongside its own documentation and safeguards.

It remains available under the [MIT License](LICENSE). This derivative is maintained independently and is not affiliated with or endorsed by the upstream author.
