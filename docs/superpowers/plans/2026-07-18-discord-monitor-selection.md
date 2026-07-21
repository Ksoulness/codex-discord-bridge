# Discord Selective Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a private Discord `#监控管理` panel where the controller manually selects which Codex projects and conversations are mirrored, pauses unwanted mappings, and safely deletes only Discord copies.

**Architecture:** Persist discovered project/thread inventory and user selections separately from active `thread_bridges`. Discovery always refreshes inventory but hydrates only effectively selected threads. Pausing detaches the active mapping while retaining the Discord channel ID in monitor inventory; resuming reuses that channel after fast-forwarding the source frontier. A focused management coordinator returns provider-neutral button/select-menu views, while `DiscordProvider` owns channel creation and Discord component rendering.

**Tech Stack:** TypeScript 5.9, Node.js 24, discord.js 14, better-sqlite3, node:test, existing Bridge coordinator graph and provider abstractions.

---

## File Structure

**Create**

- `src/bridge/monitoring/MonitorSelectionService.ts`: project/thread inventory, effective-selection decisions, migration and pagination helpers.
- `src/bridge/monitoring/MonitorLifecycleCoordinator.ts`: serialized pause, resume and safe Discord-copy cleanup.
- `src/bridge/monitoring/MonitorManagementCoordinator.ts`: controller authorization, panel views, selection actions and confirmation tokens.
- `src/bridge/discovery/projectIdentity.ts`: shared deterministic project key/name calculation used before Discord hydration.
- `test/monitorSelection.test.ts`: pure selection and pagination tests.
- `test/monitorManagementCoordinator.test.ts`: management actions, authorization and cleanup-confirmation tests.
- `test/bridge.monitoring.integration.test.ts`: discovery gate, migration, pause/resume and restart integration tests.

**Modify**

- `src/domain.ts`: monitoring records and provider-neutral interactive component types.
- `src/store/StateStore.ts`: SQLite schema, migration, selection/control/cleanup-request/audit methods.
- `src/providers/types.ts`: management handlers and management-panel provider methods.
- `src/providers/discord/DiscordProvider.ts`: private channel, pinned panel, select menus, `/codex manage` and interaction routing.
- `src/providers/local/LocalStoreProvider.ts`: deterministic in-memory implementation for integration tests.
- `src/bridge/discovery/ThreadHydrator.ts`: use shared project identity and reuse paused Discord channel IDs.
- `src/bridge/discovery/DiscoveryCoordinator.ts`: refresh inventory for every candidate and gate automatic attach by effective selection.
- `src/bridge/artifacts/CleanupCoordinator.ts`: separate “detach without deleting” from “delete Discord copy after successful provider deletion.”
- `src/bridge/BridgeCoordinatorGraph.ts`: construct and expose the monitoring coordinators.
- `src/bridge/BridgeService.ts`: wire handlers, run one-time migration, reconcile the panel and refresh it after discovery.
- `src/bridge/commands/ProviderCommandCoordinator.ts`: route `/codex manage` through existing command authorization and update help text.
- `src/util/formatting.ts`: white paused channel-name formatter.
- `test/store.test.ts`, `test/discordProvider.test.ts`, `test/bridge.discovery.integration.test.ts`, `test/providerCommandCoordinator.test.ts`, `test/run.ts`: focused regression coverage and test registration.
- `README.md`: document selective monitoring, cleanup semantics and `/codex manage`.

## Task 1: Persist Monitoring Inventory and One-Time Migration

**Files:**
- Modify: `src/domain.ts`
- Modify: `src/store/StateStore.ts`
- Modify: `test/store.test.ts`

- [ ] **Step 1: Write failing store tests**

Add tests that assert new discoveries default off, existing mappings migrate once, and a cleaned mapping remains unselected:

```ts
test("monitor inventory defaults off and migrates existing mappings once", () => {
  const store = createTestStore();
  store.upsertThreadBridge(createBridge("thr_existing", "discord_existing"));

  store.migrateExistingBridgeSelections("migration-v1");
  assert.equal(store.getMonitorProject("c:\\repo")?.enabled, true);
  assert.equal(store.getMonitorThread("thr_existing")?.selected, true);

  store.setMonitorThreadSelected("thr_existing", false, "user_1");
  store.migrateExistingBridgeSelections("migration-v1");
  assert.equal(store.getMonitorThread("thr_existing")?.selected, false);

  store.upsertDiscoveredMonitorThread({
    threadId: "thr_new",
    projectKey: "c:\\repo",
    projectName: "repo",
    threadName: "New task",
    lastSeenAt: "2026-07-18T00:00:00.000Z"
  });
  assert.equal(store.getMonitorThread("thr_new")?.selected, false);
  store.close();
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```powershell
npm run build
node --test dist/test/store.test.js
```

Expected: build fails because monitoring records and store methods do not exist.

- [ ] **Step 3: Add domain records and SQLite tables**

Define these stable shapes in `src/domain.ts`:

```ts
export interface MonitorProjectRecord {
  projectKey: string;
  projectToken: string;
  projectName: string;
  enabled: boolean;
  updatedBy: string | null;
  updatedAt: string;
}

export interface MonitorThreadRecord {
  threadId: string;
  projectKey: string;
  threadName: string | null;
  selected: boolean;
  pausedDiscordChannelId: string | null;
  lastSeenAt: string;
  updatedBy: string | null;
  updatedAt: string;
}

export interface MonitorControlRecord {
  guildId: string;
  channelId: string;
  messageId: string;
  updatedAt: string;
}

export interface MonitorCleanupRequestRecord {
  token: string;
  actorUserId: string;
  threadIds: string[];
  selectionVersion: string;
  expiresAt: string;
  consumedAt: string | null;
}
```

Create `monitor_projects`, `monitor_threads`, `monitor_control`, `monitor_cleanup_requests`, and `monitor_audit_log`. `monitor_projects.project_token` is a stable opaque value with a unique index. Use `ON CONFLICT` updates that never replace `enabled` or `selected` during ordinary discovery. Add explicit methods for list/get/upsert, project enablement, thread selection, paused channel IDs, cleanup tokens, audit rows, and migration marker `monitor-selection-migration-v1` in `schema_meta`.

- [ ] **Step 4: Run store tests**

Run:

```powershell
npm run build
node --test dist/test/store.test.js
```

Expected: all store tests pass.

- [ ] **Step 5: Commit persistence**

```powershell
git add src/domain.ts src/store/StateStore.ts test/store.test.ts
git commit -m "feat: persist Discord monitoring selections"
```

## Task 2: Add the Selection Policy and Shared Project Identity

**Files:**
- Create: `src/bridge/monitoring/MonitorSelectionService.ts`
- Create: `src/bridge/discovery/projectIdentity.ts`
- Modify: `src/bridge/discovery/ThreadHydrator.ts`
- Modify: `src/bridge/discovery/DiscoveryCoordinator.ts`
- Create: `test/monitorSelection.test.ts`
- Modify: `test/bridge.discovery.integration.test.ts`
- Modify: `test/run.ts`

- [ ] **Step 1: Write failing policy tests**

```ts
test("a project must be enabled and its thread selected", () => {
  const service = createMonitorSelectionService();
  service.recordDiscovery(candidate("thr_1", "c:\\repo", "repo"));
  assert.equal(service.isEffectivelySelected("thr_1"), false);

  service.setProjectEnabled("c:\\repo", true, "user_1");
  assert.equal(service.isEffectivelySelected("thr_1"), false);

  service.setThreadSelected("thr_1", true, "user_1");
  assert.equal(service.isEffectivelySelected("thr_1"), true);
});

test("new threads in an enabled project remain unselected", () => {
  const service = createMonitorSelectionService();
  service.recordDiscovery(candidate("thr_old", "c:\\repo", "repo"));
  service.setProjectEnabled("c:\\repo", true, "user_1");
  service.setThreadSelected("thr_old", true, "user_1");
  service.recordDiscovery(candidate("thr_new", "c:\\repo", "repo"));
  assert.equal(service.isEffectivelySelected("thr_new"), false);
});
```

- [ ] **Step 2: Verify failure**

Run `npm run build`.

Expected: missing `MonitorSelectionService` and project identity exports.

- [ ] **Step 3: Implement project identity and selection service**

Move the deterministic base project key/name calculation out of `ThreadHydrator` into:

```ts
export function resolveProjectIdentity(input: {
  cwd: string | null;
  repoName: string | null;
  projectNamePrefix: string | null;
}): { projectKey: string; projectName: string };
```

Implement `MonitorSelectionService.recordDiscovery`, `isEffectivelySelected`, list/pagination helpers and static `allowedThreadIds` intersection. Keep page size at 20.

- [ ] **Step 4: Gate discovery before hydration**

In `DiscoveryCoordinator.maybeAttachThread`, resolve metadata and project identity, record every ordinary conversation in monitor inventory, then use:

```ts
if (!forceAttach && !this.monitorSelection.isEffectivelySelected(thread.id)) {
  return;
}
```

Mapped sub-agents inherit the parent conversation selection and are not shown as independent management choices. Manual `/codex attach` marks the project enabled and the conversation selected before forcing hydration.

- [ ] **Step 5: Run selection and discovery tests**

Run:

```powershell
npm run build
node --test dist/test/monitorSelection.test.js dist/test/bridge.discovery.integration.test.js
```

Expected: both suites pass; an enabled project with an unselected new thread creates no Discord location.

- [ ] **Step 6: Commit discovery policy**

```powershell
git add src/bridge/monitoring/MonitorSelectionService.ts src/bridge/discovery/projectIdentity.ts src/bridge/discovery/ThreadHydrator.ts src/bridge/discovery/DiscoveryCoordinator.ts test/monitorSelection.test.ts test/bridge.discovery.integration.test.ts test/run.ts
git commit -m "feat: gate Discord discovery by selected conversations"
```

## Task 3: Implement Pause, Resume and Safe Discord-Only Cleanup

**Files:**
- Create: `src/bridge/monitoring/MonitorLifecycleCoordinator.ts`
- Modify: `src/bridge/artifacts/CleanupCoordinator.ts`
- Modify: `src/bridge/discovery/ThreadHydrator.ts`
- Modify: `src/util/formatting.ts`
- Create: `test/bridge.monitoring.integration.test.ts`
- Modify: `test/formatting.test.ts`
- Modify: `test/run.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Cover these exact outcomes:

```ts
test("pause keeps the Discord channel but removes the active mapping", async () => {
  const fixture = createMonitoringFixture();
  await fixture.lifecycle.pauseThread("thr_1", "user_1");
  assert.equal(fixture.store.getThreadBridge("thr_1"), undefined);
  assert.equal(fixture.store.getMonitorThread("thr_1")?.pausedDiscordChannelId, "discord_1");
  assert.deepEqual(fixture.provider.renames, [{ channelId: "discord_1", name: "⚪-task" }]);
  assert.equal(fixture.codexDeletes.length, 0);
});

test("resume reuses the paused channel and skips paused history", async () => {
  const fixture = createMonitoringFixture();
  await fixture.lifecycle.pauseThread("thr_1", "user_1");
  await fixture.lifecycle.resumeThread("thr_1", "user_1");
  assert.deepEqual(fixture.fastForwardCalls, ["thr_1", "thr_1"]);
  assert.equal(fixture.hydrateCalls[0]?.existingDiscordChannelId, "discord_1");
});

test("cleanup deletes only an unmonitored Discord copy", async () => {
  const fixture = createMonitoringFixture();
  await fixture.lifecycle.pauseThread("thr_1", "user_1");
  await fixture.lifecycle.cleanPausedThreads(["thr_1"], "user_1");
  assert.deepEqual(fixture.provider.deletedLocations, ["discord_1"]);
  assert.equal(fixture.store.getMonitorThread("thr_1")?.selected, false);
  assert.equal(fixture.store.getMonitorThread("thr_1")?.pausedDiscordChannelId, null);
  assert.equal(fixture.codexDeletes.length, 0);
});
```

- [ ] **Step 2: Verify failure**

Run `npm run build` and confirm missing lifecycle types.

- [ ] **Step 3: Implement paused channel naming**

Add:

```ts
export function formatPausedDiscordChannelName(title: string): string {
  const base = formatDiscordChannelName(
    title.replace(/^(🟡|🔴|🟢|⚪)-/u, ""),
    "codex-paused"
  );
  return Array.from(`⚪-${base}`).slice(0, 100).join("").replace(/-+$/g, "");
}
```

Extend the shared status-prefix expression to recognize `⚪-` so later title reconciliation preserves the paused prefix. Preserve existing yellow/red/green formatting for active mappings.

- [ ] **Step 4: Implement serialized lifecycle operations**

`pauseThread` must drain the thread queue, fast-forward the local source, detach runtime/mirror state without deleting Discord, persist the paused channel ID, and rename it white. `resumeThread` must select the thread, fast-forward again, and force hydration using the saved channel ID. `cleanPausedThreads` must revalidate effective selection immediately before deletion and clear local mapping state only after Discord reports success or not-found.

- [ ] **Step 5: Run lifecycle tests**

Run:

```powershell
npm run build
node --test dist/test/formatting.test.js dist/test/bridge.monitoring.integration.test.js
```

Expected: pause/resume/cleanup tests pass and no Codex delete/archive API is invoked.

- [ ] **Step 6: Commit lifecycle support**

```powershell
git add src/bridge/monitoring/MonitorLifecycleCoordinator.ts src/bridge/artifacts/CleanupCoordinator.ts src/bridge/discovery/ThreadHydrator.ts src/util/formatting.ts test/bridge.monitoring.integration.test.ts test/formatting.test.ts test/run.ts
git commit -m "feat: pause and clean Discord conversation mirrors"
```

## Task 4: Add Provider-Neutral Management Views

**Files:**
- Modify: `src/domain.ts`
- Modify: `src/providers/types.ts`
- Modify: `src/providers/local/LocalStoreProvider.ts`
- Modify: `test/discordProvider.test.ts`

- [ ] **Step 1: Write failing component-model tests**

Add tests for 20-item pages, selected defaults, 100-character Discord limits and danger confirmation buttons.

```ts
const result: DiscordCommandResult = {
  content: "选择需要监控的对话",
  selectMenus: [{
    customId: "codex:monitor:threads:project-token:0",
    placeholder: "选择对话",
    minValues: 0,
    maxValues: 2,
    options: [
      { label: "清理执行", value: "thr_1", description: "019f65ff · 1 分钟前", default: true },
      { label: "审计", value: "thr_2", description: "019f5c6c · 1 小时前", default: false }
    ]
  }]
};
assert.equal(result.selectMenus?.[0]?.options.length, 2);
```

- [ ] **Step 2: Verify failure**

Run `npm run build` and confirm `selectMenus` is not yet defined.

- [ ] **Step 3: Extend provider-neutral result types**

Add `DiscordSelectOption`, `DiscordSelectMenu`, and `selectMenus?: DiscordSelectMenu[]` to `DiscordCommandResult`. Add management handler methods for manage, buttons, select submissions and cleanup confirmation. Add provider methods:

```ts
ensureMonitorControlPanel(input: {
  controllerUserId: string;
  existingChannelId: string | null;
  existingMessageId: string | null;
  view: MonitorControlPanelView;
}): Promise<{ channelId: string; messageId: string }>;
```

Implement a no-network `LocalStoreProvider` equivalent for integration tests.

- [ ] **Step 4: Run provider type tests**

Run:

```powershell
npm run build
node --test dist/test/discordProvider.test.js
```

Expected: component model and existing provider tests pass.

- [ ] **Step 5: Commit provider abstractions**

```powershell
git add src/domain.ts src/providers/types.ts src/providers/local/LocalStoreProvider.ts test/discordProvider.test.ts
git commit -m "feat: add Discord monitoring management views"
```

## Task 5: Build the Management Coordinator

**Files:**
- Create: `src/bridge/monitoring/MonitorManagementCoordinator.ts`
- Create: `test/monitorManagementCoordinator.test.ts`
- Modify: `test/run.ts`

- [ ] **Step 1: Write failing coordinator tests**

Test unauthorized access, project enablement without implicit thread selection, thread selection, cleanup candidates and stale confirmation rejection:

```ts
test("enabling a project does not select its conversations", async () => {
  const fixture = createManagementFixture();
  await fixture.coordinator.setProjects(fixture.actor, ["project-token"]);
  assert.equal(fixture.store.getMonitorProject("c:\\repo")?.enabled, true);
  assert.equal(fixture.store.getMonitorThread("thr_1")?.selected, false);
});

test("cleanup confirmation revalidates the selection version", async () => {
  const fixture = createManagementFixture();
  const request = fixture.coordinator.createCleanupRequest(fixture.actor, ["thr_1"]);
  fixture.store.setMonitorThreadSelected("thr_1", true, fixture.actor.userId);
  const result = await fixture.coordinator.confirmCleanup(fixture.actor, request.token);
  assert.match(result.content, /状态已经变化/);
  assert.deepEqual(fixture.deletedThreadIds, []);
});
```

- [ ] **Step 2: Verify failure**

Run `npm run build` and confirm the coordinator is missing.

- [ ] **Step 3: Implement coordinator views and actions**

Use existing `Policy.ensureCommandAuthorized(actor)` for every entry point. Generate opaque cleanup tokens with `Policy.createOpaqueToken()`, expire them after ten minutes, bind them to actor ID and a deterministic selection version, and consume each token once. Return Chinese panel text and provider-neutral buttons/select menus. Never put raw project paths in custom IDs; use stable project tokens from persisted monitor records.

- [ ] **Step 4: Run coordinator tests**

Run:

```powershell
npm run build
node --test dist/test/monitorManagementCoordinator.test.js
```

Expected: all authorization, selection and cleanup-confirmation tests pass.

- [ ] **Step 5: Commit management logic**

```powershell
git add src/bridge/monitoring/MonitorManagementCoordinator.ts test/monitorManagementCoordinator.test.ts test/run.ts
git commit -m "feat: coordinate Discord monitoring controls"
```

## Task 6: Render the Private Discord Control Channel

**Files:**
- Modify: `src/providers/discord/DiscordProvider.ts`
- Modify: `test/discordProvider.test.ts`

- [ ] **Step 1: Write failing Discord rendering tests**

Assert that the provider renders string select menus, routes `codex:monitor:*` interactions, registers `/codex manage`, and creates a private channel permission set for the controller and Bot.

```ts
assert.deepEqual(permissionOverwrites, [
  { id: "guild", deny: ["ViewChannel"] },
  { id: "controller", allow: ["ViewChannel", "ReadMessageHistory", "SendMessages"] },
  { id: "bot", allow: ["ViewChannel", "ReadMessageHistory", "SendMessages", "ManageChannels"] }
]);
```

- [ ] **Step 2: Verify failure**

Run `npm run build` and confirm select-menu Discord imports and handlers are absent.

- [ ] **Step 3: Implement private panel and interaction routing**

Import `StringSelectMenuBuilder`, `StringSelectMenuInteraction`, `PermissionFlagsBits` and `ChannelType`. Create or reuse `#监控管理`, pin one Bot-owned panel message, edit it in place, and rebuild only missing resources. Route buttons, string selects and `/codex manage` to typed handlers. Reply ephemerally for all picker and confirmation screens.

- [ ] **Step 4: Run Discord provider tests**

Run:

```powershell
npm run build
node --test dist/test/discordProvider.test.js
```

Expected: new and existing provider tests pass.

- [ ] **Step 5: Commit Discord UI**

```powershell
git add src/providers/discord/DiscordProvider.ts test/discordProvider.test.ts
git commit -m "feat: add private Discord monitoring panel"
```

## Task 7: Wire Startup, Commands and Reconciliation

**Files:**
- Modify: `src/bridge/BridgeCoordinatorGraph.ts`
- Modify: `src/bridge/BridgeService.ts`
- Modify: `src/bridge/commands/ProviderCommandCoordinator.ts`
- Modify: `test/providerCommandCoordinator.test.ts`
- Modify: `test/bridge.startup.integration.test.ts`

- [ ] **Step 1: Write failing wiring tests**

Cover one-time migration before startup refresh, management handler registration, panel reconciliation after discovery, `/codex manage`, and restart persistence.

```ts
test("startup migrates existing mappings before applying the selection gate", async () => {
  const fixture = createStartupFixture({ existingBridge: createBridge("thr_1", "discord_1") });
  await fixture.service.start();
  assert.equal(fixture.store.getMonitorThread("thr_1")?.selected, true);
  assert.equal(fixture.provider.createdConversationChannels.length, 0);
  assert.equal(fixture.provider.monitorPanels.length, 1);
});
```

- [ ] **Step 2: Verify failure**

Run `npm run build` and confirm coordinator graph/service methods are missing.

- [ ] **Step 3: Wire coordinators and startup order**

Use this startup order:

```text
provider start
Codex app-server start
existing mapping migration
rehydrate selected mappings
discovery inventory refresh and selected attach
monitor control panel reconcile
status reconcile and polling
```

Refresh the panel after project/thread selection changes and after each successful discovery cycle. `/codex attach` explicitly enables/selects its target; `/codex detach` becomes the same safe pause behavior used by the panel. Keep `/codex cleanall` as the explicit global destructive Bridge cleanup command.

- [ ] **Step 4: Run wiring and startup tests**

Run:

```powershell
npm run build
node --test dist/test/providerCommandCoordinator.test.js dist/test/bridge.startup.integration.test.js dist/test/bridge.monitoring.integration.test.js
```

Expected: all focused integration tests pass.

- [ ] **Step 5: Commit wiring**

```powershell
git add src/bridge/BridgeCoordinatorGraph.ts src/bridge/BridgeService.ts src/bridge/commands/ProviderCommandCoordinator.ts test/providerCommandCoordinator.test.ts test/bridge.startup.integration.test.ts
git commit -m "feat: wire selective Discord monitoring"
```

## Task 8: Documentation, Full Verification and Live Rollout

**Files:**
- Modify: `README.md`
- Verify only: `.env`, `bridge.config.json`, startup scripts outside this repository

- [ ] **Step 1: Update operator documentation**

Document:

```text
/codex manage opens or repairs #监控管理.
New projects and conversations default to not monitored.
Stopping monitoring preserves Discord history and never stops Codex.
Cleaning deletes only the Discord copy and Bridge mapping.
```

- [ ] **Step 2: Run static and full automated verification**

Run:

```powershell
npm run check
npm test
npm run coverage:gate
```

Expected: TypeScript check passes, the full test suite passes, and coverage remains above the configured 80% line gate.

- [ ] **Step 3: Inspect the final diff for unrelated changes**

Run:

```powershell
git status --short
git diff --check
git diff --stat HEAD~7..HEAD
```

Expected: only selective-monitoring code, tests and docs are included; pre-existing `package.json`, `package-lock.json`, and `scripts/proxy-bootstrap.cjs` changes remain untouched.

- [ ] **Step 4: Commit documentation**

```powershell
git add README.md
git commit -m "docs: explain selective Discord monitoring"
```

- [ ] **Step 5: Restart the existing hidden Bridge launcher**

Use the repository's existing startup integration rather than launching a second visible process. Confirm there is exactly one Bridge process and that the SQLite lock belongs to it.

- [ ] **Step 6: Perform live Discord acceptance**

Verify in the real server:

1. `#监控管理` is visible to the controller and hidden from an ordinary member.
2. Existing mapped conversations remain selected after migration.
3. A newly discovered conversation appears unselected and creates no channel.
4. Selecting it creates one channel and starts current-state mirroring.
5. Stopping it preserves the channel, turns the prefix white and stops updates.
6. Re-selecting it reuses the same channel and does not replay paused history.
7. Cleaning a stopped channel asks for confirmation, deletes only Discord state and does not affect Codex Desktop.
8. Restarting the Bridge preserves every selection.

- [ ] **Step 7: Record final runtime evidence**

Capture the Bridge PID, startup time, SQLite selected-thread count, management channel/message IDs, and one successful select/pause/resume/clean audit row in the final report.
