import {
  test,
  assert,
  mkdtempSync,
  path,
  rmSync,
  tmpdir,
  createBridgeConfigFromPreset,
  createBridgeTestRig,
  FakeDesktopIpcClient,
  Policy
} from "./helpers/bridgeIntegration.js";
import { existsSync } from "node:fs";

test("plain Discord text reaches the original Desktop thread without a hidden thread or duplicate You", async () => {
  const runtimeConfig = createBridgeConfigFromPreset(
    "recommended",
    {
      allowFromDiscord: true,
      allowedUserIds: ["user_1"]
    },
    {
      messageWriteBacks: {
        allowPlainMessages: true
      }
    }
  );
  const desktop = new FakeDesktopIpcClient();
  desktop.ownerClientIdsByThread.set("thr_original_desktop", "desktop_owner_1");
  const { store, codex, discord, bridge } = createBridgeTestRig({
    runtimeConfig,
    policy: new Policy(runtimeConfig.approvals, runtimeConfig.messageWriteBacks),
    desktopIpcClient: desktop
  });
  store.upsertThreadBridge({
    codexThreadId: "thr_original_desktop",
    parentCodexThreadId: null,
    projectKey: "c:\\writeback",
    projectName: "writeback",
    discordChannelId: "discord_original_desktop",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\writeback",
    repoName: "writeback",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Original Desktop task",
    lastStatusType: "idle",
    channelKind: "conversation",
    sourceKind: "app-server"
  });
  discord.conversationChannelIds.add("discord_original_desktop");
  store.setDiscordThreadModelPreference("thr_original_desktop", "gpt-5.6-terra");

  try {
    await bridge.start({ skipDiscovery: true });
    const result = await discord.handlers?.onPlainMessage?.(
      { userId: "user_1", roleIds: [], username: "ka" },
      "discord_original_desktop",
      "discord_ka_message_1",
      "Continue in the original Desktop task.",
      []
    );

    assert.equal(result, null);
    assert.deepEqual(codex.startTurnRequests, []);
    assert.deepEqual(codex.resumedThreadIds, []);
    assert.equal(desktop.responses.length, 1);
    assert.equal(desktop.responses[0]?.method, "thread-follower-start-turn");
    assert.equal(desktop.responses[0]?.params.conversationId, "thr_original_desktop");
    assert.equal(
      (desktop.responses[0]?.params.turnStartParams as Record<string, unknown>).model,
      "gpt-5.6-terra"
    );
    assert.equal(store.listWriteBackQueueItems("thr_original_desktop")[0]?.status, "sent");

    const nowSeconds = Math.floor(Date.now() / 1000);
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_original_desktop",
        turnId: "turn_original_desktop",
        item: {
          type: "userMessage",
          id: "desktop_user_item_1",
          createdAt: nowSeconds,
          content: [{ type: "text", text: "Continue in the original Desktop task." }]
        }
      }
    });
    codex.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thr_original_desktop",
        turnId: "turn_original_desktop",
        item: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          id: "desktop_assistant_item_2",
          createdAt: nowSeconds + 1,
          content: [{ type: "output_text", text: "Original Desktop continuation completed." }]
        }
      }
    });
    await (bridge as unknown as {
      drainThreadEventQueue: (threadIds: Set<string>) => Promise<void>;
    }).drainThreadEventQueue(new Set(["thr_original_desktop"]));

    const mirrored = [
      ...discord.sentTextMessages.map((entry) => entry.content),
      ...discord.liveTextMessages.map((entry) => entry.content)
    ].join("\n");
    assert.doesNotMatch(mirrored, /\*\*You\*\*/);
    assert.match(mirrored, /Original Desktop continuation completed\./);
    assert.ok(store.listWriteBackQueueItems("thr_original_desktop")[0]?.mirrorConsumedAt);
  } finally {
    await bridge.stop();
  }
});

test("plain Discord image attachments reach the original Desktop thread as local images", async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "codex-discord-image-writeback-"));
  const runtimeConfig = createBridgeConfigFromPreset(
    "recommended",
    { allowFromDiscord: true, allowedUserIds: ["user_1"] },
    { messageWriteBacks: { allowPlainMessages: true } },
    path.join(tempRoot, "bridge.config.json")
  );
  const desktop = new FakeDesktopIpcClient();
  desktop.ownerClientIdsByThread.set("thr_image_writeback", "desktop_owner_1");
  const { store, discord, bridge } = createBridgeTestRig({
    runtimeConfig,
    policy: new Policy(runtimeConfig.approvals, runtimeConfig.messageWriteBacks),
    desktopIpcClient: desktop
  });
  store.upsertThreadBridge({
    codexThreadId: "thr_image_writeback",
    parentCodexThreadId: null,
    projectKey: "c:\\writeback",
    projectName: "writeback",
    discordChannelId: "discord_image_writeback",
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\writeback",
    repoName: "writeback",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto",
    threadName: "Image writeback",
    lastStatusType: "idle",
    channelKind: "conversation",
    sourceKind: "app-server"
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), {
      status: 200,
      headers: { "content-type": "image/png" }
    });

  try {
    await bridge.start({ skipDiscovery: true });
    const result = await discord.handlers?.onPlainMessage?.(
      { userId: "user_1", roleIds: [], username: "ka" },
      "discord_image_writeback",
      "discord_image_message_1",
      "看看这张图",
      [
        {
          url: "https://cdn.discordapp.com/attachments/channel/image.png",
          name: "image.png",
          contentType: "image/png",
          size: 4
        }
      ]
    );

    assert.equal(result, null);
    const turnStartParams = desktop.responses[0]?.params.turnStartParams as {
      input?: Array<Record<string, unknown>>;
    };
    assert.equal(turnStartParams.input?.[0]?.type, "text");
    assert.equal(turnStartParams.input?.[1]?.type, "localImage");
    const imagePath = String(turnStartParams.input?.[1]?.path ?? "");
    assert.equal(existsSync(imagePath), true);
    assert.deepEqual(store.listWriteBackQueueItems("thr_image_writeback")[0]?.localImagePaths, [imagePath]);
  } finally {
    globalThis.fetch = originalFetch;
    await bridge.stop();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
