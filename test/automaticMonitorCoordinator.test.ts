import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AutomaticMonitorCoordinator,
  buildAutomaticMonitorPlan
} from "../src/bridge/monitoring/AutomaticMonitorCoordinator.js";
import { MonitorSelectionService } from "../src/bridge/monitoring/MonitorSelectionService.js";
import type { MonitorProjectRecord, MonitorThreadRecord } from "../src/domain.js";
import { LocalStoreProvider } from "../src/providers/local/LocalStoreProvider.js";
import { StateStore } from "../src/store/StateStore.js";

function project(projectKey: string): MonitorProjectRecord {
  return {
    projectKey,
    projectToken: `token_${projectKey}`,
    projectName: projectKey,
    enabled: false,
    updatedBy: null,
    updatedAt: "2026-07-21T00:00:00.000Z"
  };
}

function thread(threadId: string, projectKey: string, recencyAt: string): MonitorThreadRecord {
  return {
    threadId,
    projectKey,
    threadName: threadId,
    threadStatus: "idle",
    available: true,
    selected: false,
    pausedDiscordChannelId: null,
    lastSeenAt: recencyAt,
    recencyAt,
    updatedBy: null,
    updatedAt: recencyAt
  };
}

test("automatic plan ranks projects and conversations by Codex recency", () => {
  const plan = buildAutomaticMonitorPlan(
    [project("p1"), project("p2"), project("p3")],
    [
      thread("p1_old", "p1", "2026-07-21T01:00:00.000Z"),
      thread("p1_new", "p1", "2026-07-21T02:00:00.000Z"),
      thread("p2_old", "p2", "2026-07-21T03:00:00.000Z"),
      thread("p2_new", "p2", "2026-07-21T04:00:00.000Z"),
      thread("p3_only", "p3", "2026-07-20T23:00:00.000Z")
    ],
    { projectLimit: 2, threadLimit: 1 }
  );

  assert.deepEqual(plan.projectKeys, ["p2", "p1"]);
  assert.deepEqual(plan.threadIdsByProject.get("p2"), ["p2_new"]);
  assert.deepEqual(plan.threadIdsByProject.get("p1"), ["p1_new"]);
  assert.deepEqual([...plan.desiredThreadIds], ["p2_new", "p1_new"]);
});

test("automatic reconciliation evicts old selections and activates the newest set", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-auto-monitor-"));
  const store = new StateStore(path.join(dir, "bridge.sqlite"));
  const provider = new LocalStoreProvider();
  const selection = new MonitorSelectionService(store);
  const paused: string[] = [];
  const resumed: string[] = [];
  const lifecycle = {
    async pauseThread(threadId: string, actorUserId: string) {
      paused.push(threadId);
      store.setMonitorThreadSelected(threadId, false, actorUserId);
    },
    async resumeThread(threadId: string, actorUserId: string) {
      resumed.push(threadId);
      store.setMonitorThreadSelected(threadId, true, actorUserId);
    },
    async cleanPausedThreads() {
      return 0;
    }
  };
  store.upsertDiscoveredMonitorThread({
    threadId: "old_thread",
    projectKey: "old_project",
    projectName: "old_project",
    threadName: "old",
    lastSeenAt: "2026-07-20T01:00:00.000Z",
    recencyAt: "2026-07-20T01:00:00.000Z"
  });
  store.upsertDiscoveredMonitorThread({
    threadId: "new_thread",
    projectKey: "new_project",
    projectName: "new_project",
    threadName: "new",
    lastSeenAt: "2026-07-21T01:00:00.000Z",
    recencyAt: "2026-07-21T01:00:00.000Z"
  });
  store.setMonitorProjectEnabled("old_project", true, "user");
  store.setMonitorThreadSelected("old_thread", true, "user");
  selection.setAutomaticSettings(1, 1);

  const coordinator = new AutomaticMonitorCoordinator(
    store,
    provider,
    selection,
    lifecycle
  );
  const result = await coordinator.reconcile();

  assert.equal(result.changed, true);
  assert.deepEqual(paused, ["old_thread"]);
  assert.deepEqual(resumed, []);
  assert.equal(store.getMonitorProject("old_project")?.enabled, false);
  assert.equal(store.getMonitorProject("new_project")?.enabled, true);
  assert.equal(store.getMonitorThread("old_thread")?.selected, false);
  assert.equal(store.getMonitorThread("new_thread")?.selected, true);
  store.close();
});

test("automatic reconciliation sends ranked bridge locations to the provider", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-auto-order-"));
  const store = new StateStore(path.join(dir, "bridge.sqlite"));
  const provider = new LocalStoreProvider();
  const selection = new MonitorSelectionService(store);
  let reordered: unknown = null;
  provider.reorderManagedLocations = async (input) => {
    reordered = input;
  };
  store.upsertDiscoveredMonitorThread({
    threadId: "thread_1",
    projectKey: "project_1",
    projectName: "project_1",
    threadName: "thread_1",
    lastSeenAt: "2026-07-21T01:00:00.000Z",
    recencyAt: "2026-07-21T01:00:00.000Z"
  });
  store.setMonitorProjectEnabled("project_1", true, "user");
  store.setMonitorThreadSelected("thread_1", true, "user");
  store.upsertProjectBridge({
    projectKey: "project_1",
    projectName: "project_1",
    discordCategoryId: "category_1",
    createdByBridge: true,
    updatedAt: new Date().toISOString()
  });
  store.upsertThreadBridge({
    codexThreadId: "thread_1",
    parentCodexThreadId: null,
    projectKey: "project_1",
    projectName: "project_1",
    discordChannelId: "channel_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\project_1",
    repoName: "project_1",
    lastSeenAt: new Date().toISOString(),
    attachMode: "manual",
    threadName: "thread_1",
    lastStatusType: "idle",
    channelKind: "conversation"
  });
  selection.setAutomaticSettings(1, 1);

  const coordinator = new AutomaticMonitorCoordinator(store, provider, selection, {
    async pauseThread() {},
    async resumeThread() {},
    async cleanPausedThreads() { return 0; }
  });
  await coordinator.reconcile();

  assert.deepEqual(reordered, {
    projectCategoryIds: ["category_1"],
    conversationChannelIdsByCategory: [{
      categoryId: "category_1",
      channelIds: ["channel_1"]
    }]
  });
  store.close();
});
