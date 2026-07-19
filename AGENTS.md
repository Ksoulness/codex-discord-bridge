# AI Setup Guide

When a user asks to set up, configure, or connect Codex Discord Bridge, guide them through the following workflow one step at a time. This file is an operational guide for AI assistants; the user-facing overview is in `README.md`.

## Goal

Help the user configure a local Codex-to-Discord bridge on the same Windows computer where Codex runs. The successful end state is a passing `npm run doctor` result and a user who knows to start the bridge themselves with `npm start`.

## Safety Rules

- Never ask the user to paste a Discord bot token, API key, password, cookie, or local database into chat.
- Tell the user to enter secrets directly into their local `.env` file. You may show placeholder variable names but never echo a supplied secret.
- Do not start the bridge automatically. After diagnostics pass, explain that the user should run `npm start` when ready.
- Do not run `npm run clean` unless the user explicitly asks. It deletes bridge-managed Discord structure and local bridge state.
- Treat Discord as semi-trusted. Explain the privacy implication before enabling remote approvals, full visibility, or plain-message write-back.

## Guided Setup Sequence

Before beginning, read the relevant sections of `README.md`, `.env.example`, and `bridge.config.example.jsonc`.

Ask for confirmation after every numbered step; do not ask for all IDs or settings at once.

1. Confirm that the user is on Windows, has Node.js 24+, and has Codex Desktop or Codex CLI working on this computer.
2. Ask the user to create or choose a private Discord server they control.
3. Ask the user to enable Discord Developer Mode and copy the server ID.
4. Ask the user to open the Discord Developer Portal, create or select an application, and create its bot.
5. Ask the user to configure server-install permissions and invite the bot to the selected server.
6. Ask the user to copy the application ID and their own Discord user ID.
7. Tell the user to copy `.env.example` to `.env`, then enter the bot token, application ID, server ID, and controller user ID locally. Do not request the token in chat.
8. Ask the user to choose a preset. Recommend `recommended`; explain that `basic` disables write-back and `full` sends richer command/file details to Discord.
9. Tell the user to create `bridge.config.json` with the selected preset.
10. Run `npm run doctor`. If it fails, diagnose only the reported prerequisite or configuration issue, then rerun the same command.
11. If diagnostics pass, explain that the user can start the bridge with `npm start`. Do not start it on their behalf.

## Required Configuration

The local `.env` file needs these values:

```env
DISCORD_BOT_TOKEN=<enter locally; never paste into chat>
DISCORD_APPLICATION_ID=<Discord application ID>
DISCORD_GUILD_ID=<Discord server ID>
DISCORD_CONTROLLER_USER_ID=<the one Discord user allowed to control the bridge>
```

For a first run, use this `bridge.config.json`:

```json
{ "preset": "recommended" }
```

## Verification and Handoff

After `npm run doctor` passes, summarize:

- which preset is enabled;
- that the bridge must run on the same computer as Codex;
- that the user should run `npm start` themselves;
- how to stop it with `Ctrl+C`;
- that `npm run clean` removes only bridge-managed Discord structure and local state.

If diagnostics cannot access Discord because of a restricted execution environment, report that result as inconclusive and ask the user to run the same `npm run doctor` command in their normal terminal.
