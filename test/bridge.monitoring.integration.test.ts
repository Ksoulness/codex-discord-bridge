import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CodexThreadSummary, ThreadBridgeRecord } from "../src/domain.js";
import { MonitorLifecycleCoordinator } from "../src/bridge/monitoring/MonitorLifecycleCoordinator.js";
import { MonitorSelectionService } from "../src/bridge/monitoring/MonitorSelectionService.js";
import { StateStore } from "../src/store/StateStore.js";
import { FakeDiscordAdapter } from "./helpers/bridgeIntegration.js";

function createFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-monitor-lifecycle-"));
  const store = new StateStore(path.join(dir, "bridge.sqlite"));
  const provider = new FakeDiscordAdapter();
  const selection = new MonitorSelectionService(store);
  const fastForwardCalls: string[] = [];
  const hydrateCalls: Array<{ threadId: string; existingDiscordChannelId: string | null | undefined }> = [];
  const summary: CodexThreadSummary = {
    id: "thr_1",
    name: "Important task",
    preview: "Important task",
    modelProvider: null,
    createdAt: 1,
    updatedAt: 2,
    ephemeral: false,
    status: { type: "idle" }
  };
  const bridge: ThreadBridgeRecord = {
    codexThreadId: "thr_1",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord_1",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: "2026-07-18T00:00:00.000Z",
    attachMode: "auto",
    threadName: "Important task",
    lastStatusType: "idle",
    channelKind: "conversation"
  };
  store.upsertDiscoveredMonitorThread({
    threadId: "thr_1",
    projectKey: "c:\\repo",
    projectName: "repo",
    threadName: "Important task",
    lastSeenAt: bridge.lastSeenAt
  });
  store.setMonitorProjectEnabled("c:\\repo", true, "test");
  store.setMonitorThreadSelected("thr_1", true, "test");
  store.upsertThreadBridge(bridge);
  provider.conversationChannelIds.add("discord_1");

  const lifecycle = new MonitorLifecycleCoordinator(store, provider as any, selection, {
    detachMappedThread(threadId) {
      const record = store.getThreadBridge(threadId) ?? null;
      if (record) store.deleteThreadBridge(threadId);
      return record;
    },
    async drainThreadEventQueue() {},
    async fastForwardThread(threadId) {
      fastForwardCalls.push(threadId);
      return true;
    },
    async hydrateThread(threadId, _summary, _attachMode, options) {
      hydrateCalls.push({ threadId, existingDiscordChannelId: options.existingDiscordChannelId });
      store.upsertThreadBridge({ ...bridge, attachMode: "manual" });
      return {} as any;
    },
    queueStatusUpdate() {},
    async tryReadThread() {
      return summary;
    }
  });
  return { store, provider, lifecycle, fastForwardCalls, hydrateCalls };
}

test("pause preserves and marks the Discord channel while removing active mirror state", async () => {
  const fixture = createFixture();
  await fixture.lifecycle.pauseThread("thr_1", "user_1");

  assert.equal(fixture.store.getThreadBridge("thr_1"), undefined);
  assert.equal(fixture.store.getMonitorThread("thr_1")?.selected, false);
  assert.equal(fixture.store.getMonitorThread("thr_1")?.pausedDiscordChannelId, "discord_1");
  assert.deepEqual(fixture.provider.conversationChannelNameUpdates, [{
    channelId: "discord_1",
    name: "⚪-important-task"
  }]);
  assert.deepEqual(fixture.provider.deletedLocationIds, []);
  fixture.store.close();
});

test("resume reuses the paused channel and fast-forwards past paused history", async () => {
  const fixture = createFixture();
  await fixture.lifecycle.pauseThread("thr_1", "user_1");
  await fixture.lifecycle.resumeThread("thr_1", "user_1");

  assert.deepEqual(fixture.fastForwardCalls, ["thr_1", "thr_1"]);
  assert.deepEqual(fixture.hydrateCalls, [{
    threadId: "thr_1",
    existingDiscordChannelId: "discord_1"
  }]);
  assert.equal(fixture.store.getMonitorThread("thr_1")?.selected, true);
  assert.equal(fixture.store.getMonitorThread("thr_1")?.pausedDiscordChannelId, null);
  fixture.store.close();
});

test("cleanup deletes only a stopped Discord copy", async () => {
  const fixture = createFixture();
  await fixture.lifecycle.pauseThread("thr_1", "user_1");
  const deleted = await fixture.lifecycle.cleanPausedThreads(["thr_1"], "user_1");

  assert.equal(deleted, 1);
  assert.deepEqual(fixture.provider.deletedLocationIds, ["discord_1"]);
  assert.equal(fixture.store.getMonitorThread("thr_1")?.pausedDiscordChannelId, null);
  assert.equal(fixture.store.getMonitorThread("thr_1")?.selected, false);
  fixture.store.close();
});

test("cleanup refuses active or selected conversations", async () => {
  const fixture = createFixture();
  const deleted = await fixture.lifecycle.cleanPausedThreads(["thr_1"], "user_1");
  assert.equal(deleted, 0);
  assert.deepEqual(fixture.provider.deletedLocationIds, []);
  assert.ok(fixture.store.getThreadBridge("thr_1"));
  fixture.store.close();
});
