import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MONITOR_PICKER_PAGE_SIZE,
  MonitorSelectionService
} from "../src/bridge/monitoring/MonitorSelectionService.js";
import { resolveProjectIdentity } from "../src/bridge/discovery/projectIdentity.js";
import { StateStore } from "../src/store/StateStore.js";

function createFixture(allowedThreadIds?: string[], selectiveMonitoring = true) {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-monitor-selection-"));
  const store = new StateStore(path.join(dir, "bridge.sqlite"));
  return {
    store,
    service: new MonitorSelectionService(store, allowedThreadIds, selectiveMonitoring)
  };
}

function candidate(threadId: string) {
  return {
    threadId,
    projectKey: "c:\\repo",
    projectName: "repo",
    threadName: `Task ${threadId}`,
    threadStatus: "idle" as const,
    lastSeenAt: "2026-07-18T00:00:00.000Z"
  };
}

test("a project must be enabled and its conversation selected", () => {
  const fixture = createFixture();
  fixture.service.recordDiscovery(candidate("thr_1"));
  assert.equal(fixture.service.isEffectivelySelected("thr_1"), false);

  fixture.service.setProjectEnabled("c:\\repo", true, "user_1");
  assert.equal(fixture.service.isEffectivelySelected("thr_1"), false);

  fixture.service.setThreadSelected("thr_1", true, "user_1");
  assert.equal(fixture.service.isEffectivelySelected("thr_1"), true);
  fixture.store.close();
});

test("new conversations in an enabled project remain unselected", () => {
  const fixture = createFixture();
  fixture.service.recordDiscovery(candidate("thr_old"));
  fixture.service.setProjectEnabled("c:\\repo", true, "user_1");
  fixture.service.setThreadSelected("thr_old", true, "user_1");
  fixture.service.recordDiscovery(candidate("thr_new"));
  assert.equal(fixture.service.isEffectivelySelected("thr_new"), false);
  fixture.store.close();
});

test("configured thread scope remains a higher-priority boundary", () => {
  const fixture = createFixture(["thr_allowed"]);
  for (const threadId of ["thr_allowed", "thr_blocked"]) {
    fixture.service.recordDiscovery(candidate(threadId));
    fixture.service.setThreadSelected(threadId, true, "user_1");
  }
  fixture.service.setProjectEnabled("c:\\repo", true, "user_1");
  assert.equal(fixture.service.isEffectivelySelected("thr_allowed"), true);
  assert.equal(fixture.service.isEffectivelySelected("thr_blocked"), false);
  fixture.store.close();
});

test("legacy auto-discovery mode bypasses manual selection after scope checks", () => {
  const fixture = createFixture(["thr_allowed"], false);

  assert.equal(fixture.service.isEffectivelySelected("thr_allowed"), true);
  assert.equal(fixture.service.isEffectivelySelected("thr_blocked"), false);
  fixture.store.close();
});

test("monitor picker pages contain at most twenty items", () => {
  const fixture = createFixture();
  for (let index = 0; index < MONITOR_PICKER_PAGE_SIZE + 3; index += 1) {
    fixture.service.recordDiscovery(candidate(`thr_${String(index).padStart(2, "0")}`));
  }
  assert.equal(fixture.service.listThreads("c:\\repo", 0).items.length, 20);
  assert.equal(fixture.service.listThreads("c:\\repo", 1).items.length, 3);
  assert.equal(fixture.service.listThreads("c:\\repo", 9).page, 1);
  fixture.store.close();
});

test("active pickers default to running conversations and conversations completed within 24 hours", () => {
  const fixture = createFixture();
  fixture.service.recordDiscovery({
    ...candidate("thr_running"),
    threadStatus: "active",
    lastSeenAt: "2026-07-17T00:00:00.000Z"
  });
  fixture.service.recordDiscovery({
    ...candidate("thr_recent"),
    lastSeenAt: "2026-07-17T08:00:00.000Z"
  });
  fixture.service.recordDiscovery({
    ...candidate("thr_old"),
    lastSeenAt: "2026-07-17T06:59:59.000Z"
  });

  const now = Date.parse("2026-07-18T07:00:00.000Z");
  assert.deepEqual(
    fixture.service.listActiveThreads("c:\\repo", 0, now).items.map((thread) => thread.threadId),
    ["thr_recent", "thr_running"]
  );
  assert.equal(fixture.service.listActiveProjects(0, now).total, 1);
  fixture.store.close();
});

test("active picker window can be changed and survives a service restart", () => {
  const fixture = createFixture();
  fixture.service.recordDiscovery({
    ...candidate("thr_five_hours"),
    lastSeenAt: "2026-07-18T02:00:00.000Z"
  });
  fixture.service.recordDiscovery({
    ...candidate("thr_seven_hours"),
    lastSeenAt: "2026-07-18T00:00:00.000Z"
  });
  const now = Date.parse("2026-07-18T07:00:00.000Z");

  assert.equal(fixture.service.getActiveWindowHours(), 24);
  fixture.service.setActiveWindowHours(6);
  assert.deepEqual(
    fixture.service.listActiveThreads("c:\\repo", 0, now).items.map((thread) => thread.threadId),
    ["thr_five_hours"]
  );

  const restartedService = new MonitorSelectionService(fixture.store);
  assert.equal(restartedService.getActiveWindowHours(), 6);
  assert.throws(() => restartedService.setActiveWindowHours(8), /Unsupported monitor active window/);
  fixture.store.close();
});

test("project identity applies the configured prefix consistently", () => {
  assert.deepEqual(
    resolveProjectIdentity({
      cwd: "C:\\Repo",
      repoName: "Repo",
      projectNamePrefix: "E2E Run"
    }),
    {
      projectKey: "e2e run::c:\\repo",
      projectName: "E2E Run Repo"
    }
  );
});
