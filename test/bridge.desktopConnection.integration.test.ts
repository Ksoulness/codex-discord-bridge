import assert from "node:assert/strict";
import test from "node:test";
import { CodexDesktopIpcClient } from "../src/codex/CodexDesktopIpcClient.js";
import { createLogger } from "../src/logger.js";
import {
  createBridgeTestRig,
  FakeDesktopIpcClient
} from "./helpers/bridgeIntegration.js";

async function waitForCondition(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for Desktop connection status update.");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test("Desktop owner disconnect clears stale ownership while the IPC router stays connected", () => {
  const client = new CodexDesktopIpcClient(
    createLogger("silent"),
    "\\\\.\\pipe\\codex-mobile-desktop-disconnect-test"
  );
  const availabilityChanges: boolean[] = [];
  const internalClient = client as unknown as {
    socket: { destroyed: boolean };
    clientId: string;
    ownerClientIdsByThread: Map<string, string>;
    conversationStatesByThread: Map<string, Record<string, unknown>>;
    handleFrame(frame: Record<string, unknown>): void;
    isDesktopAvailable(): boolean;
    on(event: string, listener: (available: boolean) => void): void;
  };
  internalClient.socket = { destroyed: false };
  internalClient.clientId = "bridge-client";
  internalClient.ownerClientIdsByThread.set("thread-desktop-owner", "desktop-owner-client");
  internalClient.conversationStatesByThread.set("thread-desktop-owner", { id: "thread-desktop-owner" });
  internalClient.on("availabilityChanged", (available) => availabilityChanges.push(available));

  internalClient.handleFrame({
    type: "broadcast",
    method: "client-status-changed",
    sourceClientId: "router-client",
    params: {
      clientId: "desktop-owner-client",
      clientType: "codex-desktop",
      status: "disconnected"
    }
  });

  assert.equal(client.isReady(), true);
  assert.equal(client.getOwnerClientId("thread-desktop-owner"), null);
  assert.equal(client.getConversationState("thread-desktop-owner"), null);
  assert.equal(internalClient.isDesktopAvailable(), false);
  assert.deepEqual(availabilityChanges, [false]);
});

test("Desktop owner exit shows double-red disconnected state and scheduled refresh restores status", async () => {
  const desktopIpcClient = new FakeDesktopIpcClient();
  let desktopAvailable = true;
  (
    desktopIpcClient as unknown as { isDesktopAvailable(): boolean }
  ).isDesktopAvailable = () => desktopIpcClient.started && desktopAvailable;
  const { store, discord, bridge } = createBridgeTestRig({
    desktopIpcClient
  });
  store.upsertThreadBridge({
    codexThreadId: "thread-desktop-connection",
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: "discord-desktop-connection",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: "2026-07-21T10:00:00.000Z",
    attachMode: "auto",
    threadName: "Desktop connection",
    lastStatusType: "idle",
    lastTurnId: "turn-desktop-connection",
    lastTurnStatus: "completed",
    channelKind: "conversation",
    sourceKind: "app-server"
  });
  discord.conversationChannelIds.add("discord-desktop-connection");

  const internalBridge = bridge as unknown as {
    coordinators: {
      monitorManagementCoordinator: { fullRefreshPromise: Promise<void> | null };
    };
    refreshDesktopConnectionStatus(reconnect: boolean): Promise<void>;
    runScheduledMonitorRefresh(): Promise<void>;
  };

  await internalBridge.refreshDesktopConnectionStatus(true);
  assert.match(discord.conversationChannelNameUpdates.at(-1)?.name ?? "", /^🟢-/u);

  desktopAvailable = false;
  desktopIpcClient.emit("availabilityChanged", false);
  await waitForCondition(
    () => discord.conversationChannelNameUpdates.at(-1)?.name.startsWith("🔴🔴-") === true
  );
  assert.match(discord.liveTextMessages.at(-1)?.content ?? "", /状态：已断线/u);
  assert.equal(
    store.getTurnStatusMessage("thread-desktop-connection")?.statusKind,
    "completed"
  );

  desktopAvailable = true;
  desktopIpcClient.emit("availabilityChanged", true);
  await internalBridge.runScheduledMonitorRefresh();
  await internalBridge.coordinators.monitorManagementCoordinator.fullRefreshPromise;

  assert.equal(desktopIpcClient.started, true);
  assert.match(discord.conversationChannelNameUpdates.at(-1)?.name ?? "", /^🟢-/u);
  const restoredContent = discord.liveTextMessages.at(-1)?.content ?? "";
  assert.match(restoredContent, /状态：已完成/u);
  assert.doesNotMatch(restoredContent, /状态：已断线/u);
  assert.equal((restoredContent.match(/状态：/gu) ?? []).length, 1);
  await bridge.stop();
});
