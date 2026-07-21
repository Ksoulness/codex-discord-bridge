import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MonitorManagementCoordinator } from "../src/bridge/monitoring/MonitorManagementCoordinator.js";
import { MonitorSelectionService } from "../src/bridge/monitoring/MonitorSelectionService.js";
import { Policy } from "../src/policy/Policy.js";
import { LocalStoreProvider } from "../src/providers/local/LocalStoreProvider.js";
import { StateStore } from "../src/store/StateStore.js";

const actor = { userId: "user_1", roleIds: [], username: "controller" };

function createFixture(
  onRefresh?: (store: StateStore) => void,
  refreshInventory?: () => Promise<number>,
  listModels?: () => Promise<Array<{
    id: string;
    displayName: string;
    defaultReasoningEffort: string | null;
    supportedReasoningEfforts: string[];
  }>>,
  refreshManagedState?: () => Promise<void>
) {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-monitor-management-"));
  const store = new StateStore(path.join(dir, "bridge.sqlite"));
  const provider = new LocalStoreProvider();
  const selection = new MonitorSelectionService(store);
  const resumed: string[] = [];
  const paused: string[] = [];
  const cleaned: string[][] = [];
  const refreshCalls: number[] = [];
  const managedRefreshCalls: number[] = [];
  const lifecycle = {
    async pauseThread(threadId: string, actorUserId: string, options: { preserveSelection?: boolean } = {}) {
      paused.push(threadId);
      if (!options.preserveSelection) store.setMonitorThreadSelected(threadId, false, actorUserId);
    },
    async resumeThread(threadId: string, actorUserId: string) {
      resumed.push(threadId);
      store.setMonitorThreadSelected(threadId, true, actorUserId);
    },
    async cleanPausedThreads(threadIds: string[]) {
      cleaned.push([...threadIds]);
      for (const threadId of threadIds) store.setMonitorThreadPausedDiscordChannelId(threadId, null);
      return threadIds.length;
    }
  };
  const policy = new Policy({
    allowFromDiscord: true,
    allowedUserIds: [actor.userId],
    mentionApprovers: false
  });
  const coordinator = new MonitorManagementCoordinator(
    store,
    policy,
    provider,
    selection,
    lifecycle as any,
    actor.userId,
    async () => {
      refreshCalls.push(Date.now());
      if (refreshInventory) return refreshInventory();
      onRefresh?.(store);
      return 37;
    },
    async () => listModels ? listModels() : [
      {
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: ["low", "medium", "high"]
      },
      {
        id: "gpt-5.6-terra",
        displayName: "GPT-5.6 Terra",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"]
      }
    ],
    null,
    async () => {
      managedRefreshCalls.push(Date.now());
      await refreshManagedState?.();
    }
  );
  const record = (threadId: string, projectKey = "c:\\repo", projectName = "repo") => {
    store.upsertDiscoveredMonitorThread({
      threadId,
      projectKey,
      projectName,
      threadName: `Task ${threadId}`,
      lastSeenAt: new Date().toISOString()
    });
  };
  return {
    store,
    provider,
    selection,
    coordinator,
    resumed,
    paused,
    cleaned,
    refreshCalls,
    managedRefreshCalls,
    record
  };
}

test("project and conversation pickers render from the current inventory while refresh runs in the background", async () => {
  const fixture = createFixture((store) => {
    store.deleteMonitorThreadIfUnselected("stale_prompt");
  });
  fixture.record("current_thread");
  fixture.record("stale_prompt");
  fixture.store.setMonitorProjectEnabled("c:\\repo", true, actor.userId);

  const projects = await fixture.coordinator.handleButton(actor, "codex:monitor:projects:0");
  assert.equal(fixture.refreshCalls.length, 1);
  assert.equal(fixture.store.getMonitorThread("stale_prompt"), undefined);
  assert.equal(projects.selectMenus?.[0]?.options[0]?.description, "1 个对话");

  fixture.record("stale_prompt");
  const conversations = await fixture.coordinator.handleButton(actor, "codex:monitor:thread-projects:0");
  assert.equal(fixture.refreshCalls.length, 2);
  assert.equal(fixture.store.getMonitorThread("stale_prompt"), undefined);
  assert.equal(conversations.selectMenus?.[0]?.options[0]?.description, "1 个对话");
  fixture.store.close();
});

test("management rejects users outside the controller allowlist", async () => {
  const fixture = createFixture();
  await assert.rejects(
    fixture.coordinator.handleManage({ userId: "other", roleIds: [], username: "other" }),
    /not allowed/i
  );
  fixture.store.close();
});

test("enabling a project does not implicitly select its conversations", async () => {
  const fixture = createFixture();
  fixture.record("thr_1");
  const project = fixture.store.getMonitorProject("c:\\repo");
  assert.ok(project);

  const result = await fixture.coordinator.handleSelect(
    actor,
    "codex:monitor:projects:0",
    [project.projectToken]
  );
  assert.match(result.content, /项目选择已保存/);
  assert.equal(fixture.store.getMonitorProject("c:\\repo")?.enabled, true);
  assert.equal(fixture.store.getMonitorThread("thr_1")?.selected, false);
  assert.deepEqual(fixture.resumed, []);
  fixture.store.close();
});

test("conversation selection starts only the checked conversation", async () => {
  const fixture = createFixture();
  fixture.record("thr_1");
  fixture.record("thr_2");
  fixture.store.setMonitorProjectEnabled("c:\\repo", true, actor.userId);
  const project = fixture.store.getMonitorProject("c:\\repo");
  assert.ok(project);

  await fixture.coordinator.handleSelect(
    actor,
    `codex:monitor:threads:${project.projectToken}:0`,
    ["thr_2"]
  );
  assert.equal(fixture.store.getMonitorThread("thr_1")?.selected, false);
  assert.equal(fixture.store.getMonitorThread("thr_2")?.selected, true);
  assert.deepEqual(fixture.resumed, ["thr_2"]);
  fixture.store.close();
});

test("cleanup confirmation rejects changed monitoring state", async () => {
  const fixture = createFixture();
  fixture.record("thr_1");
  fixture.store.setMonitorProjectEnabled("c:\\repo", true, actor.userId);
  fixture.store.setMonitorThreadPausedDiscordChannelId("thr_1", "discord_1");
  const project = fixture.store.getMonitorProject("c:\\repo");
  assert.ok(project);

  const request = await fixture.coordinator.handleSelect(
    actor,
    `codex:monitor:cleanup:${project.projectToken}:0`,
    ["thr_1"]
  );
  const confirmId = request.buttons?.find((button) => button.style === "danger")?.customId;
  assert.ok(confirmId);
  fixture.store.setMonitorThreadSelected("thr_1", true, actor.userId);
  const result = await fixture.coordinator.handleButton(actor, confirmId);

  assert.match(result.content, /状态已经变化/);
  assert.deepEqual(fixture.cleaned, []);
  assert.equal(fixture.store.getMonitorThread("thr_1")?.pausedDiscordChannelId, "discord_1");
  fixture.store.close();
});

test("cleanup confirmation is one-time and deletes only selected Discord copies", async () => {
  const fixture = createFixture();
  fixture.record("thr_1");
  fixture.store.setMonitorProjectEnabled("c:\\repo", true, actor.userId);
  fixture.store.setMonitorThreadPausedDiscordChannelId("thr_1", "discord_1");
  const project = fixture.store.getMonitorProject("c:\\repo");
  assert.ok(project);
  const request = await fixture.coordinator.handleSelect(
    actor,
    `codex:monitor:cleanup:${project.projectToken}:0`,
    ["thr_1"]
  );
  const confirmId = request.buttons?.find((button) => button.style === "danger")?.customId;
  assert.ok(confirmId);

  const first = await fixture.coordinator.handleButton(actor, confirmId);
  const second = await fixture.coordinator.handleButton(actor, confirmId);
  assert.match(first.content, /已删除 1 个 Discord 副本/);
  assert.match(second.content, /已失效/);
  assert.deepEqual(fixture.cleaned, [["thr_1"]]);
  fixture.store.close();
});

test("panel reconciliation persists one control message", async () => {
  const fixture = createFixture();
  fixture.record("thr_1");
  const first = await fixture.coordinator.reconcilePanel();
  const second = await fixture.coordinator.reconcilePanel();
  assert.deepEqual(first, second);
  assert.equal(fixture.provider.monitorPanelEnsureCalls, 1);
  assert.equal(fixture.store.getMonitorControl("discord")?.channelId, "local_monitor_control");
  assert.match(fixture.provider.monitorPanelView?.content ?? "", /Codex 监控管理/);

  fixture.record("thr_2");
  await fixture.coordinator.reconcilePanel();
  assert.equal(fixture.provider.monitorPanelEnsureCalls, 2);
  fixture.store.close();
});

test("manage returns a complete private control panel at the command location", async () => {
  const fixture = createFixture();
  fixture.record("thr_1");

  const result = await fixture.coordinator.handleManage(actor);

  assert.equal(result.ephemeral, true);
  assert.match(result.content, /Codex/);
  assert.equal(result.buttons?.length, 5);
  assert.ok(result.buttons?.some((button) => button.customId.startsWith("codex:monitor:auto-settings:")));
  assert.ok(result.buttons?.some((button) => button.customId === "codex:monitor:projects:0"));
  assert.ok(result.buttons?.some((button) => button.customId === "codex:monitor:thread-projects:0"));
  assert.equal(result.selectMenus?.[0]?.customId, "codex:monitor:window");
  assert.equal(result.selectMenus?.[0]?.options.find((option) => option.default)?.value, "24");
  assert.ok(!result.buttons?.some((button) => button.label === "删除停用频道"));
  assert.match(result.content, /每 10 分钟自动执行/);
  assert.ok(result.buttons?.some((button) => button.customId === "codex:monitor:default-model"));
  fixture.store.close();
});

test("cleanup picker includes stopped copies from disabled projects and stale active mappings", async () => {
  const fixture = createFixture();
  fixture.record("paused_thread", "c:\\disabled", "disabled");
  fixture.record("stale_mapping", "c:\\disabled", "disabled");
  fixture.store.setMonitorThreadSelected("paused_thread", true, actor.userId);
  fixture.store.setMonitorThreadPausedDiscordChannelId("paused_thread", "discord_paused");
  fixture.store.upsertThreadBridge({
    codexThreadId: "stale_mapping",
    parentCodexThreadId: null,
    projectKey: "c:\\disabled",
    projectName: "disabled",
    discordChannelId: "discord_stale",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\disabled",
    repoName: "disabled",
    lastSeenAt: new Date().toISOString(),
    attachMode: "manual",
    threadName: "stale_mapping",
    lastStatusType: "idle",
    channelKind: "conversation"
  });
  const project = fixture.store.getMonitorProject("c:\\disabled");
  assert.ok(project);

  const projects = await fixture.coordinator.handleButton(actor, "codex:monitor:cleanup-projects:0");
  assert.ok(projects.selectMenus?.[0]?.options.some((option) => option.value === project.projectToken));

  const threads = await fixture.coordinator.handleSelect(
    actor,
    "codex:monitor:cleanup-project:0",
    [project.projectToken]
  );
  assert.deepEqual(
    new Set(threads.selectMenus?.[0]?.options.map((option) => option.value)),
    new Set(["paused_thread", "stale_mapping"])
  );
  fixture.store.close();
});

test("management saves the default model used by future Discord-created threads", async () => {
  const fixture = createFixture();

  const picker = await fixture.coordinator.handleButton(actor, "codex:monitor:default-model");
  assert.equal(picker.selectMenus?.[0]?.customId, "codex:monitor:default-model");
  assert.equal(picker.selectMenus?.[1]?.customId, "codex:monitor:default-reasoning");

  const result = await fixture.coordinator.handleSelect(
    actor,
    "codex:monitor:default-model",
    ["gpt-5.6-terra"]
  );
  assert.equal(result.selectMenus?.[0]?.options.find((option) => option.default)?.value, "gpt-5.6-terra");
  assert.equal(fixture.store.getBridgeMetaValue("discord-new-thread-default-model"), "gpt-5.6-terra");
  assert.equal(fixture.store.getBridgeMetaValue("discord-new-thread-default-reasoning-effort"), "medium");
  assert.equal(fixture.store.listMonitorAudit(1)[0]?.action, "set_new_thread_default_model");

  await fixture.coordinator.handleSelect(actor, "codex:monitor:default-reasoning", ["xhigh"]);
  assert.equal(fixture.store.getBridgeMetaValue("discord-new-thread-default-reasoning-effort"), "xhigh");
  assert.equal(fixture.store.listMonitorAudit(1)[0]?.action, "set_new_thread_default_reasoning");
  fixture.store.close();
});

test("refresh button starts a complete monitor refresh in the background", async () => {
  const order: string[] = [];
  const fixture = createFixture(
    undefined,
    async () => {
      order.push("inventory");
      return 37;
    },
    undefined,
    async () => {
      order.push("managed-state");
    }
  );

  const result = await fixture.coordinator.handleButton(actor, "codex:monitor:refresh");
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(fixture.refreshCalls.length, 1);
  assert.equal(fixture.managedRefreshCalls.length, 1);
  assert.deepEqual(order, ["inventory", "managed-state"]);
  assert.match(result.content, /分类、频道、对话和状态灯/);
  fixture.store.close();
});

test("complete refresh deletes stopped Discord copies without a separate cleanup action", async () => {
  const fixture = createFixture();
  fixture.record("thr_stopped");
  fixture.store.setMonitorThreadPausedDiscordChannelId("thr_stopped", "discord_stopped");

  await fixture.coordinator.handleButton(actor, "codex:monitor:refresh");
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(fixture.cleaned, [["thr_stopped"]]);
  fixture.store.close();
});

test("monitor buttons respond even when the inventory refresh never returns", async () => {
  const fixture = createFixture(undefined, async () => new Promise<number>(() => undefined));
  fixture.record("thr_1");

  const result = await Promise.race([
    fixture.coordinator.handleButton(actor, "codex:monitor:projects:0"),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("monitor button did not respond")), 100))
  ]);

  assert.equal(result.selectMenus?.[0]?.customId, "codex:monitor:projects:0");

  const refresh = await Promise.race([
    fixture.coordinator.handleButton(actor, "codex:monitor:refresh"),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("refresh button did not respond")), 100))
  ]);
  assert.match(refresh.content, /后台.*刷新/);
  fixture.store.close();
});

test("default model picker returns an error instead of leaving Discord responding", async () => {
  const fixture = createFixture(
    undefined,
    undefined,
    async () => new Promise(() => undefined)
  );

  const result = await Promise.race([
    fixture.coordinator.handleButton(actor, "codex:monitor:default-model"),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("model button did not respond")), 2_000))
  ]);

  assert.match(result.content, /模型列表/);
  fixture.store.close();
});

test("management active-window selection persists and refreshes the panel", async () => {
  const fixture = createFixture();
  fixture.record("thr_1");

  const result = await fixture.coordinator.handleSelect(
    actor,
    "codex:monitor:window",
    ["12"]
  );

  assert.match(result.content, /最近 12 小时/);
  assert.equal(fixture.selection.getActiveWindowHours(), 12);
  assert.equal(fixture.coordinator.buildPanelView().selectMenus?.[0]?.options.find((option) => option.default)?.value, "12");
  assert.equal(fixture.store.listMonitorAudit(1)[0]?.action, "set_active_window");
  fixture.store.close();
});

test("automatic settings switch the panel to automatic mode and manual switch freezes selection", async () => {
  const fixture = createFixture();
  fixture.record("thr_1");

  const enabled = await fixture.coordinator.handleAutomaticSettings(actor, 5, 4);
  assert.match(enabled.content, /最近 5 个项目，每个项目最近 4 个对话/);
  assert.deepEqual(fixture.selection.getManagementSettings(), {
    mode: "automatic",
    projectLimit: 5,
    threadLimit: 4
  });
  const automaticPanel = fixture.coordinator.buildPanelView();
  assert.match(automaticPanel.content, /当前模式：自动管理/);
  assert.equal(automaticPanel.selectMenus?.length, 0);
  assert.ok(automaticPanel.buttons?.some((button) => button.customId === "codex:monitor:manual"));
  assert.ok(!automaticPanel.buttons?.some((button) => button.customId === "codex:monitor:projects:0"));

  const blocked = await fixture.coordinator.handleButton(actor, "codex:monitor:projects:0");
  assert.match(blocked.content, /当前是自动管理模式/);

  const manual = await fixture.coordinator.handleButton(actor, "codex:monitor:manual");
  assert.match(manual.content, /当前项目和对话保持原样/);
  assert.equal(fixture.selection.getManagementSettings().mode, "manual");
  fixture.store.close();
});
