import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Policy } from "../src/policy/Policy.js";
import { ProviderCommandCoordinator } from "../src/bridge/commands/ProviderCommandCoordinator.js";
import { DesktopSteerPayloadBuilder } from "../src/bridge/commands/DesktopSteerPayloadBuilder.js";

function createPolicy(
  messageWriteBacks = {
    allowFromDiscord: true,
    allowPlainMessages: false,
    allowedUserIds: ["user_1"]
  },
  approvals = {
    allowFromDiscord: true,
    allowedUserIds: ["user_1"],
    mentionApprovers: false
  }
) {
  return new Policy(approvals, messageWriteBacks);
}

function createBridge(
  threadId: string,
  channelId: string,
  sourceKind: "app-server" | "cli-session" = "app-server"
) {
  return {
    codexThreadId: threadId,
    parentCodexThreadId: null,
    projectKey: "c:\\repo",
    projectName: "repo",
    discordChannelId: channelId,
    discordParentChannelId: null,
    statusMessageId: null,
    cwd: "C:\\repo",
    repoName: "repo",
    lastSeenAt: new Date().toISOString(),
    attachMode: "auto" as const,
    threadName: "Bridge thread",
    lastStatusType: "active",
    channelKind: "conversation" as const,
    sourceKind
  };
}

function createHarness(options: {
  messageWriteBacks?: Parameters<typeof createPolicy>[0];
  approvals?: Parameters<typeof createPolicy>[1];
  desktopIpcClient?: unknown;
  metadata?: Map<
    string,
    {
      cwd: string | null;
      repoName: string | null;
      threadName: string | null;
      actorName: string | null;
      parentThreadId: string | null;
      sourceSubagentOther: string | null;
      originator: string | null;
      source: string | null;
    }
  >;
  modelPreference?: string | null;
  models?: Array<{ id: string; displayName: string }>;
  resumeThreadError?: Error;
} = {}) {
  const bridges = new Map<string, ReturnType<typeof createBridge>>();
  const warnings: string[] = [];
  const readThreadCalls: string[] = [];
  const resumeThreadCalls: string[] = [];
  const steerTurnCalls: Array<{ threadId: string; turnId: string; text: string }> = [];
  const startTurnCalls: Array<{ threadId: string; text: string }> = [];
  const canonicalEvents: Array<{
    threadId: string;
    eventKind: string;
    itemKind?: string | null;
    turnId?: string | null;
    summary: string | null;
  }> = [];
  const writeBackQueue: Array<{
    id: number;
    threadId: string;
    discordChannelId: string;
    actorUserId: string;
    text: string;
    sourceKind: "slash" | "plain";
    discordMessageId: string | null;
    requestedModel: string | null;
    requestedReasoningEffort: string | null;
    localImagePaths: string[];
    mirrorConsumedAt: string | null;
    status: "pending" | "sending" | "sent" | "failed" | "retracted";
    createdAt: string;
    updatedAt: string;
    sentAt: string | null;
    error: string | null;
  }> = [];
  let nextWriteBackQueueId = 1;
  const queueCalls: string[] = [];
  const flushCalls: string[] = [];
  const clearQueuedCalls: string[] = [];
  const cleanupThreadCalls: string[] = [];
  const openCodexThreadCalls: string[] = [];
  const progressMessages: string[] = [];
  const turnStatusCalls: Array<{ threadId: string; turnId: string; statusKind: string }> = [];
  let resetCalled = false;
  let modelPreference = options.modelPreference ?? null;

  const context = {
    policy: createPolicy(options.messageWriteBacks, options.approvals),
    runtimeConfig: {
      configPath: path.join(tmpdir(), "codex-discord-bridge-test.json"),
      diagnostics: {
        desktopSteerDumpEnabled: false
      },
      messageWriteBacks:
        options.messageWriteBacks ?? {
          allowFromDiscord: true,
          allowPlainMessages: false,
          allowedUserIds: ["user_1"]
        }
    },
    stateStore: {
      getThreadBridge: (threadId: string) => bridges.get(threadId),
      findThreadBridgeByDiscordChannelId: (channelId: string) =>
        [...bridges.values()].find((bridge) => bridge.discordChannelId === channelId) ?? null,
      listThreadBridgesByKind: (kind: string) =>
        [...bridges.values()].filter((bridge) => bridge.channelKind === kind),
      upsertDiscoveredMonitorThread: () => undefined,
      setMonitorProjectEnabled: () => undefined,
      setMonitorThreadSelected: () => undefined,
      appendCanonicalThreadEvent: (record: {
        threadId: string;
        eventKind: string;
        itemKind?: string | null;
        turnId?: string | null;
        summary?: string | null;
      }) => {
        canonicalEvents.push({
          threadId: record.threadId,
          eventKind: record.eventKind,
          itemKind: record.itemKind ?? null,
          turnId: record.turnId ?? null,
          summary: record.summary ?? null
        });
      },
      listCanonicalThreadEvents: (threadId: string, limit: number) =>
        canonicalEvents.filter((event) => event.threadId === threadId).slice(-limit),
      createWriteBackQueueItem: (input: {
        threadId: string;
        discordChannelId: string;
        actorUserId: string;
        text: string;
        sourceKind?: "slash" | "plain";
        discordMessageId?: string | null;
        requestedModel?: string | null;
        requestedReasoningEffort?: string | null;
        localImagePaths?: string[];
      }) => {
        const now = new Date().toISOString();
        const record = {
          id: nextWriteBackQueueId++,
          status: "pending" as const,
          createdAt: now,
          updatedAt: now,
          sentAt: null,
          error: null,
          sourceKind: input.sourceKind ?? "slash",
          discordMessageId: input.discordMessageId ?? null,
          requestedModel: input.requestedModel ?? null,
          requestedReasoningEffort: input.requestedReasoningEffort ?? null,
          localImagePaths: input.localImagePaths ?? [],
          mirrorConsumedAt: null,
          ...input
        };
        writeBackQueue.push(record);
        return record;
      },
      getWriteBackQueueItem: (id: number) => writeBackQueue.find((record) => record.id === id),
      listWriteBackQueueItems: (threadId: string) =>
        writeBackQueue.filter((record) => record.threadId === threadId),
      countPendingWriteBackQueueItems: (threadId: string) =>
        writeBackQueue.filter((record) => record.threadId === threadId && record.status === "pending").length,
      claimNextPendingWriteBackQueueItem: (threadId: string) => {
        const record = writeBackQueue.find((entry) => entry.threadId === threadId && entry.status === "pending") ?? null;
        if (record) {
          record.status = "sending";
          record.updatedAt = new Date().toISOString();
          record.error = null;
        }
        return record;
      },
      claimWriteBackQueueItem: (id: number) => {
        const record = writeBackQueue.find((entry) => entry.id === id && entry.status === "pending") ?? null;
        if (record) {
          record.status = "sending";
          record.updatedAt = new Date().toISOString();
          record.error = null;
        }
        return record;
      },
      markWriteBackQueueItemSent: (id: number) => {
        const record = writeBackQueue.find((entry) => entry.id === id);
        if (record) {
          record.status = "sent";
          record.sentAt = new Date().toISOString();
          record.updatedAt = record.sentAt;
          record.error = null;
        }
      },
      markWriteBackQueueItemFailed: (id: number, error: string) => {
        const record = writeBackQueue.find((entry) => entry.id === id);
        if (record) {
          record.status = "failed";
          record.updatedAt = new Date().toISOString();
          record.error = error;
        }
      },
      markWriteBackQueueItemRetracted: (id: number) => {
        const record = writeBackQueue.find((entry) => entry.id === id && entry.status === "pending") ?? null;
        if (record) {
          record.status = "retracted";
          record.updatedAt = new Date().toISOString();
        }
        return record;
      },
      retractLatestPendingWriteBackQueueItem: (threadId: string) => {
        const record =
          writeBackQueue
            .filter((entry) => entry.threadId === threadId && entry.status === "pending")
            .sort((left, right) => right.id - left.id)[0] ?? null;
        if (record) {
          record.status = "retracted";
          record.updatedAt = new Date().toISOString();
        }
        return record;
      },
      restoreWriteBackQueueItemPending: (id: number, error: string | null) => {
        const record = writeBackQueue.find((entry) => entry.id === id && entry.status === "sending");
        if (record) {
          record.status = "pending";
          record.updatedAt = new Date().toISOString();
          record.error = error;
        }
      },
      getDiscordThreadModelPreference: () => modelPreference,
      getDiscordThreadReasoningEffortPreference: () => null,
      setDiscordThreadModelPreference: (_threadId: string, model: string | null) => {
        modelPreference = model;
      }
    },
    codexAdapter: {
      readThread: async (threadId: string) => {
        readThreadCalls.push(threadId);
        return {
          id: threadId,
          name: `Thread ${threadId}`,
          preview: "preview",
          modelProvider: null,
          createdAt: null,
          updatedAt: null,
          ephemeral: false,
          status: { type: "idle" as const }
        };
      },
      resumeThread: async (threadId: string) => {
        resumeThreadCalls.push(threadId);
        if (options.resumeThreadError) {
          throw options.resumeThreadError;
        }
      },
      steerTurn: async (threadId: string, turnId: string, text: string) => {
        steerTurnCalls.push({ threadId, turnId, text });
      },
      startTurn: async (threadId: string, text: string) => {
        startTurnCalls.push({ threadId, text });
      },
      listModels: async () =>
        options.models ?? [
          {
            id: "gpt-5.6-sol",
            displayName: "GPT-5.6 Sol",
            supportedReasoningEfforts: ["low", "medium", "high"],
            defaultReasoningEffort: "medium",
            isDefault: true
          },
          {
            id: "gpt-5.6-terra",
            displayName: "GPT-5.6 Terra",
            supportedReasoningEfforts: ["low", "medium", "high"],
            defaultReasoningEffort: "medium",
            isDefault: false
          }
        ],
      resolveMetadata: async (threadId: string) => {
        return (
          options.metadata?.get(threadId) ?? {
            cwd: null,
            repoName: null,
            threadName: null,
            actorName: null,
            parentThreadId: null,
            sourceSubagentOther: null,
            originator: null,
            source: null
          }
        );
      }
    },
    ...(options.desktopIpcClient ? { desktopIpcClient: options.desktopIpcClient } : {}),
    provider: {
      detachDiscordLocation: async () => undefined
    },
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (_payload: unknown, message: string) => {
        warnings.push(message);
      }
    }
  };

  const runtime = {
    threadEventChains: new Map<string, Promise<void>>(),
    threadState: new Map<string, { status: { type: "active" | "idle"; activeFlags?: string[] } }>()
  };

  const deps = {
    clearQueuedStatusUpdate: (threadId: string) => {
      clearQueuedCalls.push(threadId);
    },
    cleanupThread: async (threadId: string) => {
      cleanupThreadCalls.push(threadId);
      bridges.delete(threadId);
      return 2;
    },
    drainThreadEventQueue: async () => undefined,
    detachThread: (threadId: string) => {
      const existing = bridges.get(threadId) ?? null;
      bridges.delete(threadId);
      return existing;
    },
    pauseThread: async (threadId: string) => {
      clearQueuedCalls.push(threadId);
      bridges.delete(threadId);
    },
    flushStatusUpdate: async (threadId: string) => {
      flushCalls.push(threadId);
    },
    hydrateThread: async (threadId: string) => {
      if (!bridges.has(threadId)) {
        bridges.set(threadId, createBridge(threadId, `discord_${threadId}`));
      }
      return { bridge: bridges.get(threadId) } as never;
    },
    openCodexThreadInDesktop: (threadId: string) => {
      openCodexThreadCalls.push(threadId);
    },
    pollThreadSessionEvents: async () => undefined,
    persistThreadState: () => undefined,
    printProgress: (message: string) => {
      progressMessages.push(message);
    },
    readLatestTurnBackfillTurnId: async () => null,
    queueStatusUpdate: (threadId: string) => {
      queueCalls.push(threadId);
    },
    setTurnStatus: async (threadId: string, turnId: string, statusKind: string) => {
      turnStatusCalls.push({ threadId, turnId, statusKind });
    },
    resetBridge: async () => {
      resetCalled = true;
      bridges.clear();
      return { deletedCategories: 1, deletedLocations: 3 };
    }
  };

  return {
    bridges,
    warnings,
    readThreadCalls,
    resumeThreadCalls,
    steerTurnCalls,
    startTurnCalls,
    canonicalEvents,
    writeBackQueue,
    queueCalls,
    flushCalls,
    clearQueuedCalls,
    cleanupThreadCalls,
    openCodexThreadCalls,
    progressMessages,
    turnStatusCalls,
    runtime,
    get modelPreference() {
      return modelPreference;
    },
    get resetCalled() {
      return resetCalled;
    },
    coordinator: new ProviderCommandCoordinator(context as never, runtime as never, deps)
  };
}

const authorizedActor = { userId: "user_1", roleIds: [], username: "tester" };
const unauthorizedActor = { userId: "user_2", roleIds: [], username: "tester" };

function createDesktopSteerPayloadBuilder(options: { configPath?: string; dumpEnabled?: boolean } = {}) {
  const progressMessages: string[] = [];
  const runtimeConfig = {
    configPath: options.configPath ?? path.join(tmpdir(), "bridge.config.json"),
    diagnostics: {
      desktopSteerDumpEnabled: options.dumpEnabled ?? false
    }
  };
  const builder = new DesktopSteerPayloadBuilder({
    logger: {
      info: () => undefined,
      warn: () => undefined
    } as never,
    runtimeConfig: runtimeConfig as never,
    printProgress: (message) => {
      progressMessages.push(message);
    }
  });
  return { builder, progressMessages, runtimeConfig };
}

test("ProviderCommandCoordinator rejects unauthorized command actors", async () => {
  const harness = createHarness();
  const result = await harness.coordinator.handleStatusCommand(unauthorizedActor);

  assert.equal(result.ephemeral, true);
  assert.match(result.content, /not allowed to control the Codex bridge/i);
});

test("ProviderCommandCoordinator gates message write-backs separately from bridge commands", async () => {
  const harness = createHarness({
    messageWriteBacks: {
      allowFromDiscord: false,
      allowPlainMessages: false,
      allowedUserIds: ["user_1"]
    }
  });

  const status = await harness.coordinator.handleStatusCommand(authorizedActor);
  const send = await harness.coordinator.handleSendCommand(authorizedActor, "discord_missing", "Start work.", "queue");

  assert.equal(status.content, "No Codex conversations are mapped yet.");
  assert.equal(send.ephemeral, true);
  assert.match(send.content, /message write-backs are disabled/i);
});

test("ProviderCommandCoordinator gates proposed-plan actions with approval controls", async () => {
  const harness = createHarness({
    approvals: {
      allowFromDiscord: false,
      allowedUserIds: ["user_1"],
      mentionApprovers: false
    }
  });

  const result = await harness.coordinator.handleProposedPlanAction(authorizedActor, "plan_token", "accept");

  assert.equal(result.ephemeral, true);
  assert.match(result.content, /approvals are disabled/i);
});

test("ProviderCommandCoordinator reports mapped status rows with runtime labels", async () => {
  const harness = createHarness();
  harness.bridges.set("thread_12345678", createBridge("thread_12345678", "discord_thread"));
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_12345678",
    {
      status: { type: "active", activeFlags: ["waitingOnApproval"] }
    }
  );

  const result = await harness.coordinator.handleStatusCommand(authorizedActor);

  assert.match(result.content, /thread_1/);
  assert.match(result.content, /Waiting on approval/);
  assert.match(result.content, /<#discord_thread>/);
});

test("ProviderCommandCoordinator reports when no conversations are mapped", async () => {
  const harness = createHarness();
  const result = await harness.coordinator.handleStatusCommand(authorizedActor);

  assert.equal(result.content, "No Codex conversations are mapped yet.");
});

test("ProviderCommandCoordinator resolves mapped short thread ids shown by status", async () => {
  const harness = createHarness();
  harness.bridges.set(
    "019dcd46-3b51-7691-8d37-d501e704503b",
    createBridge("019dcd46-3b51-7691-8d37-d501e704503b", "discord_short_detach")
  );
  harness.bridges.set(
    "019dcd55-0000-7000-8000-000000000000",
    createBridge("019dcd55-0000-7000-8000-000000000000", "discord_short_clean")
  );

  const detach = await harness.coordinator.handleDetachCommand(authorizedActor, "019dcd46");
  const clean = await harness.coordinator.handleCleanIdCommand(authorizedActor, "019dcd55");

  assert.equal(
    detach.content,
    "Stopped monitoring Codex thread `019dcd46-3b51-7691-8d37-d501e704503b`. Discord history remains in <#discord_short_detach>."
  );
  assert.deepEqual(harness.clearQueuedCalls, ["019dcd46-3b51-7691-8d37-d501e704503b"]);
  assert.equal(harness.bridges.has("019dcd46-3b51-7691-8d37-d501e704503b"), false);
  assert.equal(
    clean.content,
    "Cleaned Codex thread `019dcd55-0000-7000-8000-000000000000`. Deleted 2 Discord location(s)."
  );
  assert.deepEqual(harness.cleanupThreadCalls, ["019dcd55-0000-7000-8000-000000000000"]);
});

test("ProviderCommandCoordinator rejects ambiguous short mapped thread ids", async () => {
  const harness = createHarness();
  harness.bridges.set(
    "019dcd46-0000-7000-8000-000000000001",
    createBridge("019dcd46-0000-7000-8000-000000000001", "discord_ambiguous_1")
  );
  harness.bridges.set(
    "019dcd46-0000-7000-8000-000000000002",
    createBridge("019dcd46-0000-7000-8000-000000000002", "discord_ambiguous_2")
  );

  const result = await harness.coordinator.handleDetachCommand(authorizedActor, "019dcd46");

  assert.equal(result.ephemeral, true);
  assert.match(result.content, /matches multiple mapped conversations/i);
  assert.match(result.content, /019dcd46-0000-7000-8000-000000000001/);
  assert.match(result.content, /019dcd46-0000-7000-8000-000000000002/);
  assert.equal(harness.bridges.size, 2);
});

test("ProviderCommandCoordinator attaches existing mappings by queueing a status update", async () => {
  const harness = createHarness();
  harness.bridges.set("thread_attach_existing", createBridge("thread_attach_existing", "discord_existing"));

  const result = await harness.coordinator.handleAttachCommand(authorizedActor, "thread_attach_existing");

  assert.equal(result.content, "Attached Codex thread `thread_attach_existing` to <#discord_existing>.");
  assert.deepEqual(harness.readThreadCalls, ["thread_attach_existing"]);
  assert.deepEqual(harness.resumeThreadCalls, ["thread_attach_existing"]);
  assert.deepEqual(harness.queueCalls, ["thread_attach_existing"]);
  assert.deepEqual(harness.flushCalls, []);
});

test("ProviderCommandCoordinator attaches new mappings by flushing the initial status", async () => {
  const harness = createHarness();

  const result = await harness.coordinator.handleAttachCommand(authorizedActor, "thread_attach_new");

  assert.equal(result.content, "Attached Codex thread `thread_attach_new` to <#discord_thread_attach_new>.");
  assert.deepEqual(harness.readThreadCalls, ["thread_attach_new"]);
  assert.deepEqual(harness.resumeThreadCalls, ["thread_attach_new"]);
  assert.deepEqual(harness.queueCalls, []);
  assert.deepEqual(harness.flushCalls, ["thread_attach_new"]);
});

test("ProviderCommandCoordinator pauses mappings without deleting Discord history", async () => {
  const harness = createHarness();
  harness.bridges.set("thread_detach", createBridge("thread_detach", "discord_detach"));
  (harness.coordinator as unknown as { context: { provider: { detachDiscordLocation: () => Promise<void> } } }).context.provider.detachDiscordLocation =
    async () => {
      throw new Error("discord detach failed");
    };

  const result = await harness.coordinator.handleDetachCommand(authorizedActor, "thread_detach");

  assert.equal(
    result.content,
    "Stopped monitoring Codex thread `thread_detach`. Discord history remains in <#discord_detach>."
  );
  assert.deepEqual(harness.clearQueuedCalls, ["thread_detach"]);
  assert.equal(harness.bridges.has("thread_detach"), false);
  assert.equal(harness.warnings.length, 0);
});

test("ProviderCommandCoordinator cleans one mapping or the whole bridge", async () => {
  const harness = createHarness();
  harness.bridges.set("thread_clean", createBridge("thread_clean", "discord_clean"));

  const cleanOne = await harness.coordinator.handleCleanIdCommand(authorizedActor, "thread_clean");
  const cleanAll = await harness.coordinator.handleCleanAllCommand(authorizedActor);

  assert.equal(
    cleanOne.content,
    "Cleaned Codex thread `thread_clean`. Deleted 2 Discord location(s)."
  );
  assert.equal(
    cleanAll.content,
    "Cleaned the bridge. Deleted 3 Discord location(s) and 1 category."
  );
  assert.deepEqual(harness.cleanupThreadCalls, ["thread_clean"]);
  assert.equal(harness.resetCalled, true);
});

test("ProviderCommandCoordinator returns help text", async () => {
  const harness = createHarness();
  const result = await harness.coordinator.handleHelpCommand(authorizedActor);

  assert.match(result.content, /\/codex help/);
  assert.match(result.content, /\/codex attach <thread_id>/);
});

test("ProviderCommandCoordinator internal steering steers an in-progress turn even if coarse status is idle", async () => {
  const harness = createHarness();
  harness.bridges.set("thread_steer", createBridge("thread_steer", "discord_steer"));
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_steer",
    {
      threadId: "thread_steer",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Bridge thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "idle" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_steer_1",
      lastTurnStatus: "in_progress"
    }
  );

  const result = await harness.coordinator.steerActiveTurnInternally("Do not run the command.", "thread_steer");

  assert.match(result.content, /Steered active turn/i);
  assert.deepEqual(harness.resumeThreadCalls, ["thread_steer"]);
  assert.deepEqual(harness.steerTurnCalls, [
    {
      threadId: "thread_steer",
      turnId: "turn_steer_1",
      text: "Do not run the command."
    }
  ]);
  assert.deepEqual(harness.startTurnCalls, []);
});

test("ProviderCommandCoordinator internal steering refuses when no active turn is tracked", async () => {
  const harness = createHarness();
  harness.bridges.set("thread_idle", createBridge("thread_idle", "discord_idle"));

  const result = await harness.coordinator.steerActiveTurnInternally("Please continue.", "thread_idle");

  assert.match(result.content, /There is no active Codex turn to steer/i);
  assert.equal(result.ephemeral, true);
  assert.deepEqual(harness.resumeThreadCalls, ["thread_idle"]);
  assert.deepEqual(harness.steerTurnCalls, []);
  assert.deepEqual(harness.startTurnCalls, []);
});

test("ProviderCommandCoordinator internal steering steers an active turn without Discord command routing", async () => {
  const harness = createHarness();
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_local_steer",
    {
      threadId: "thread_local_steer",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Bridge thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "active" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_local_steer_1",
      lastTurnStatus: "in_progress"
    }
  );

  const result = await harness.coordinator.steerActiveTurnInternally("Keep the same active turn.", "thread_local_steer");

  assert.match(result.content, /Steered active turn/i);
  assert.deepEqual(harness.resumeThreadCalls, ["thread_local_steer"]);
  assert.deepEqual(harness.steerTurnCalls, [
    {
      threadId: "thread_local_steer",
      turnId: "turn_local_steer_1",
      text: "Keep the same active turn."
    }
  ]);
});

test("ProviderCommandCoordinator send command starts a turn immediately when idle", async () => {
  const harness = createHarness();
  harness.bridges.set("thread_send_idle", createBridge("thread_send_idle", "discord_send_idle"));
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_send_idle",
    {
      threadId: "thread_send_idle",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Bridge thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "idle" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: null,
      lastTurnStatus: null
    }
  );

  const result = await harness.coordinator.handleSendCommand(
    authorizedActor,
    "discord_send_idle",
    "Start the next task.",
    "queue"
  );

  assert.match(result.content, /Started a new Codex turn/);
  assert.match(result.content, /> Start the next task\./);
  assert.deepEqual(harness.resumeThreadCalls, ["thread_send_idle"]);
  assert.deepEqual(harness.startTurnCalls, [
    {
      threadId: "thread_send_idle",
      text: "Start the next task."
    }
  ]);
  assert.equal(harness.writeBackQueue[0]?.status, "sent");
});

test("ProviderCommandCoordinator ignores plain messages while the feature flag is disabled", async () => {
  const harness = createHarness();
  harness.bridges.set("thread_plain_disabled", createBridge("thread_plain_disabled", "discord_plain_disabled"));

  const result = await harness.coordinator.handlePlainMessage(
    authorizedActor,
    "discord_plain_disabled",
    "message_disabled",
    "Do not deliver this."
  );

  assert.equal(result, null);
  assert.deepEqual(harness.writeBackQueue, []);
  assert.deepEqual(harness.startTurnCalls, []);
});

test("ProviderCommandCoordinator starts an idle plain message silently with its model snapshot", async () => {
  const desktopStarts: Array<{ threadId: string; params: Record<string, unknown> }> = [];
  const harness = createHarness({
    messageWriteBacks: {
      allowFromDiscord: true,
      allowPlainMessages: true,
      allowedUserIds: ["user_1"]
    },
    modelPreference: "gpt-5.6-sol",
    desktopIpcClient: {
      canStartTurnInDesktopThread: () => true,
      startTurn: async (threadId: string, params: Record<string, unknown>) => {
        desktopStarts.push({ threadId, params });
      }
    }
  });
  harness.bridges.set("thread_plain_idle", createBridge("thread_plain_idle", "discord_plain_idle"));
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_plain_idle",
    {
      threadId: "thread_plain_idle",
      sourceKind: "app-server",
      status: { type: "idle" },
      lastTurnId: null,
      lastTurnStatus: null
    }
  );

  const result = await harness.coordinator.handlePlainMessage(
    authorizedActor,
    "discord_plain_idle",
    "message_idle",
    "Continue from Discord."
  );

  assert.equal(result, null);
  assert.deepEqual(harness.startTurnCalls, []);
  assert.equal(desktopStarts.length, 1);
  assert.equal(desktopStarts[0]?.threadId, "thread_plain_idle");
  assert.equal(harness.writeBackQueue[0]?.status, "sent");
  assert.equal(harness.writeBackQueue[0]?.sourceKind, "plain");
  assert.equal(harness.writeBackQueue[0]?.discordMessageId, "message_idle");
  assert.equal(harness.writeBackQueue[0]?.requestedModel, "gpt-5.6-sol");
});

test("ProviderCommandCoordinator keeps a plain message queued when the original Desktop thread is unavailable", async () => {
  const harness = createHarness({
    messageWriteBacks: {
      allowFromDiscord: true,
      allowPlainMessages: true,
      allowedUserIds: ["user_1"]
    }
  });
  harness.bridges.set(
    "thread_plain_unavailable",
    createBridge("thread_plain_unavailable", "discord_plain_unavailable")
  );
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_plain_unavailable",
    {
      threadId: "thread_plain_unavailable",
      sourceKind: "app-server",
      status: { type: "idle" },
      lastTurnId: null,
      lastTurnStatus: null
    }
  );

  const result = await harness.coordinator.handlePlainMessage(
    authorizedActor,
    "discord_plain_unavailable",
    "message_unavailable",
    "Keep this for the original Desktop thread."
  );

  assert.match(result?.content ?? "", /原桌面对话暂时不可用/);
  assert.equal(harness.writeBackQueue[0]?.status, "pending");
  assert.deepEqual(harness.resumeThreadCalls, []);
  assert.deepEqual(harness.startTurnCalls, []);
});

test("ProviderCommandCoordinator opens an idle original Desktop thread and waits for its owner before sending", async () => {
  let ownerAvailable = false;
  const desktopStarts: Array<{ threadId: string; params: Record<string, unknown> }> = [];
  const harness = createHarness({
    messageWriteBacks: {
      allowFromDiscord: true,
      allowPlainMessages: true,
      allowedUserIds: ["user_1"]
    },
    desktopIpcClient: {
      isReady: () => true,
      canStartTurnInDesktopThread: () => ownerAvailable,
      getConversationState: () => ({ threadRuntimeStatus: { type: "idle" }, turns: [] }),
      waitForOwnerClientId: async () => {
        ownerAvailable = true;
        return "desktop-owner";
      },
      startTurn: async (threadId: string, params: Record<string, unknown>) => {
        desktopStarts.push({ threadId, params });
      }
    }
  });
  harness.bridges.set("thread_owner_recovery", createBridge("thread_owner_recovery", "discord_owner_recovery"));
  harness.runtime.threadState.set("thread_owner_recovery", {
    status: { type: "idle" },
    sourceKind: "app-server",
    lastTurnId: null,
    lastTurnStatus: null
  } as never);

  const result = await harness.coordinator.handlePlainMessage(
    authorizedActor,
    "discord_owner_recovery",
    "message_owner_recovery",
    "Resume the original Desktop conversation."
  );

  assert.equal(result, null);
  assert.deepEqual(harness.openCodexThreadCalls, ["thread_owner_recovery"]);
  assert.equal(harness.writeBackQueue[0]?.status, "sent");
  assert.equal(desktopStarts.length, 1);
});

test("ProviderCommandCoordinator reopens an original Desktop thread after a stale owner rejects start-turn", async () => {
  let ownerAvailable = true;
  let startAttempts = 0;
  const harness = createHarness({
    messageWriteBacks: {
      allowFromDiscord: true,
      allowPlainMessages: true,
      allowedUserIds: ["user_1"]
    },
    desktopIpcClient: {
      isReady: () => true,
      canStartTurnInDesktopThread: () => ownerAvailable,
      getConversationState: () => ({ threadRuntimeStatus: { type: "idle" }, turns: [] }),
      waitForOwnerClientId: async () => {
        ownerAvailable = true;
        return "replacement-owner";
      },
      startTurn: async () => {
        startAttempts += 1;
        if (startAttempts === 1) {
          ownerAvailable = false;
          throw new Error("no-client-found");
        }
      }
    }
  });
  harness.bridges.set("thread_stale_owner", createBridge("thread_stale_owner", "discord_stale_owner"));
  harness.runtime.threadState.set("thread_stale_owner", {
    status: { type: "idle" },
    sourceKind: "app-server",
    lastTurnId: null,
    lastTurnStatus: null
  } as never);

  const result = await harness.coordinator.handlePlainMessage(
    authorizedActor,
    "discord_stale_owner",
    "message_stale_owner",
    "Retry through the replacement Desktop owner."
  );

  assert.equal(result, null);
  assert.deepEqual(harness.openCodexThreadCalls, ["thread_stale_owner"]);
  assert.equal(startAttempts, 2);
  assert.equal(harness.writeBackQueue[0]?.status, "sent");
});

test("ProviderCommandCoordinator queues a busy plain message with steer and retract controls", async () => {
  const harness = createHarness({
    messageWriteBacks: {
      allowFromDiscord: true,
      allowPlainMessages: true,
      allowedUserIds: ["user_1"]
    }
  });
  harness.bridges.set("thread_plain_busy", createBridge("thread_plain_busy", "discord_plain_busy"));
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_plain_busy",
    {
      threadId: "thread_plain_busy",
      sourceKind: "app-server",
      status: { type: "active" },
      lastTurnId: "turn_busy",
      lastTurnStatus: "in_progress"
    }
  );

  const result = await harness.coordinator.handlePlainMessage(
    authorizedActor,
    "discord_plain_busy",
    "message_busy",
    "Queue this message."
  );

  assert.match(result?.content ?? "", /已排队/);
  assert.deepEqual(result?.buttons?.map((button) => button.label), ["立即发送", "删除"]);
  assert.equal(harness.writeBackQueue[0]?.status, "pending");
  assert.deepEqual(harness.startTurnCalls, []);

  const deleted = await harness.coordinator.handleWriteBackButton(authorizedActor, "retract", 1);
  assert.match(deleted.content, /已删除排队消息/);
  assert.equal(harness.writeBackQueue[0]?.status, "retracted");
  assert.deepEqual(deleted.buttons, undefined);
});

test("stale unloaded Desktop turns are marked stopped after the grace period", async () => {
  const desktopIpcClient = {
    isReady: () => true,
    getConversationState: () => null
  };
  const harness = createHarness({ desktopIpcClient });
  const bridge = createBridge("thread_stopped_desktop", "discord_stopped_desktop");
  bridge.lastSeenAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  Object.assign(bridge, {
    lastTurnId: "turn_stopped_desktop",
    lastTurnStatus: "in_progress"
  });
  harness.bridges.set(bridge.codexThreadId, bridge);
  harness.runtime.threadState.set(bridge.codexThreadId, {
    threadId: bridge.codexThreadId,
    status: { type: "active" },
    lastTurnId: "turn_stopped_desktop",
    lastTurnStatus: "in_progress"
  } as never);

  await harness.coordinator.reconcileStaleDesktopStatuses();

  assert.equal(
    (harness.runtime.threadState.get(bridge.codexThreadId) as { lastTurnStatus?: string })?.lastTurnStatus,
    "stopped"
  );
  assert.deepEqual(harness.turnStatusCalls, [
    {
      threadId: bridge.codexThreadId,
      turnId: "turn_stopped_desktop",
      statusKind: "stopped"
    }
  ]);
});

test("stale unloaded Desktop turns with a canonical final answer remain completed", async () => {
  const desktopIpcClient = {
    isReady: () => true,
    getConversationState: () => null
  };
  const harness = createHarness({ desktopIpcClient });
  const bridge = createBridge("thread_completed_desktop", "discord_completed_desktop");
  bridge.lastSeenAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  Object.assign(bridge, {
    lastTurnId: "turn_completed_desktop",
    lastTurnStatus: "in_progress"
  });
  harness.bridges.set(bridge.codexThreadId, bridge);
  harness.runtime.threadState.set(bridge.codexThreadId, {
    threadId: bridge.codexThreadId,
    status: { type: "active" },
    lastTurnId: "turn_completed_desktop",
    lastTurnStatus: "in_progress"
  } as never);
  (harness.coordinator as unknown as {
    context: {
      stateStore: {
        appendCanonicalThreadEvent(record: {
          threadId: string;
          eventKind: string;
          itemKind: string;
          turnId: string;
          summary: string;
        }): void;
      };
    };
  }).context.stateStore.appendCanonicalThreadEvent({
    threadId: bridge.codexThreadId,
    eventKind: "content",
    itemKind: "agentAnswer",
    turnId: "turn_completed_desktop",
    summary: "Finished."
  });

  await harness.coordinator.reconcileStaleDesktopStatuses();

  assert.equal(
    (harness.runtime.threadState.get(bridge.codexThreadId) as { lastTurnStatus?: string })?.lastTurnStatus,
    "completed"
  );
  assert.deepEqual(harness.turnStatusCalls, [
    {
      threadId: bridge.codexThreadId,
      turnId: "turn_completed_desktop",
      statusKind: "completed"
    }
  ]);
});

test("ProviderCommandCoordinator offers and delivers Desktop guidance before the cached turn id arrives", async () => {
  const desktopSteerTurnCalls: Array<{ threadId: string; turnId: string; input: unknown }> = [];
  const harness = createHarness({
    messageWriteBacks: {
      allowFromDiscord: true,
      allowPlainMessages: true,
      allowedUserIds: ["user_1"]
    },
    resumeThreadError: new Error("failed to parse thread ID from rollout file"),
    desktopIpcClient: {
      isReady: () => true,
      canStartTurnInDesktopThread: (threadId: string) => threadId === "thread_plain_desktop_active",
      getConversationState: () => ({
        turns: [{ turnId: "turn_desktop_active", status: "inProgress" }]
      }),
      waitForConversationState: async () => null,
      steerTurn: async (threadId: string, turnId: string, input: unknown) => {
        desktopSteerTurnCalls.push({ threadId, turnId, input });
      }
    }
  });
  harness.bridges.set(
    "thread_plain_desktop_active",
    createBridge("thread_plain_desktop_active", "discord_plain_desktop_active")
  );
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_plain_desktop_active",
    {
      threadId: "thread_plain_desktop_active",
      sourceKind: "app-server",
      status: { type: "active" },
      lastTurnId: null,
      lastTurnStatus: "in_progress"
    }
  );

  const queued = await harness.coordinator.handlePlainMessage(
    authorizedActor,
    "discord_plain_desktop_active",
    "message_desktop_active",
    "Guide the active Desktop turn."
  );

  assert.deepEqual(queued?.buttons?.map((button) => button.label), ["立即发送", "删除"]);
  const guided = await harness.coordinator.handleWriteBackButton(authorizedActor, "steer", 1);
  assert.match(guided.content, /Sent queued message to the active turn\./);
  assert.deepEqual(harness.resumeThreadCalls, []);
  assert.deepEqual(desktopSteerTurnCalls, [
    {
      threadId: "thread_plain_desktop_active",
      turnId: "turn_desktop_active",
      input: [{ type: "text", text: "Guide the active Desktop turn." }]
    }
  ]);
});

test("ProviderCommandCoordinator restores canonical Desktop turn history before steering", async () => {
  const desktopSteerTurnCalls: Array<{
    threadId: string;
    turnId: string;
    input: unknown;
    options: { restoreMessage?: unknown };
  }> = [];
  const desktopConversationState = {
    turns: [],
    threadRuntimeStatus: { type: "active", activeFlags: [] },
    turnHistory: {
      kind: "canonical",
      history: {
        entitiesByKey: {
          "tail:1:local:active": {
            turnId: "turn_desktop_canonical_active",
            status: "inProgress",
            items: []
          }
        }
      }
    }
  };
  const harness = createHarness({
    messageWriteBacks: {
      allowFromDiscord: true,
      allowPlainMessages: true,
      allowedUserIds: ["user_1"]
    },
    desktopIpcClient: {
      isReady: () => true,
      canStartTurnInDesktopThread: (threadId: string) => threadId === "thread_desktop_canonical",
      getConversationState: () => desktopConversationState,
      waitForConversationState: async () => desktopConversationState,
      steerTurn: async (
        threadId: string,
        turnId: string,
        input: unknown,
        options: { restoreMessage?: unknown }
      ) => {
        desktopSteerTurnCalls.push({ threadId, turnId, input, options });
      }
    }
  });
  harness.bridges.set(
    "thread_desktop_canonical",
    createBridge("thread_desktop_canonical", "discord_desktop_canonical")
  );
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_desktop_canonical",
    {
      threadId: "thread_desktop_canonical",
      sourceKind: "app-server",
      status: { type: "idle" },
      lastTurnId: null,
      lastTurnStatus: "completed"
    }
  );

  const queued = await harness.coordinator.handlePlainMessage(
    authorizedActor,
    "discord_desktop_canonical",
    "message_desktop_canonical",
    "Guide the active canonical Desktop turn."
  );

  assert.match(queued?.content ?? "", /已排队/);
  assert.deepEqual(queued?.buttons?.map((button) => button.label), ["立即发送", "删除"]);
  assert.equal(harness.writeBackQueue[0]?.status, "pending");
  assert.deepEqual(harness.startTurnCalls, []);

  const guided = await harness.coordinator.handleWriteBackButton(authorizedActor, "steer", 1);
  assert.match(guided.content, /Sent queued message to the active turn\./);
  assert.equal(harness.writeBackQueue[0]?.status, "sent");
  assert.equal(desktopSteerTurnCalls.length, 1);
  assert.equal(desktopSteerTurnCalls[0]?.threadId, "thread_desktop_canonical");
  assert.equal(desktopSteerTurnCalls[0]?.turnId, "turn_desktop_canonical_active");
  assert.deepEqual(desktopSteerTurnCalls[0]?.input, [
    { type: "text", text: "Guide the active canonical Desktop turn." }
  ]);
  const restoreMessage = desktopSteerTurnCalls[0]?.options.restoreMessage as Record<string, unknown>;
  assert.equal(restoreMessage.id, "restore:turn_desktop_canonical_active");
  assert.equal(restoreMessage.cwd, "C:\\repo");
  assert.deepEqual((restoreMessage.thread as Record<string, unknown>).turns, [
    {
      id: "turn_desktop_canonical_active",
      status: "inProgress",
      error: null,
      items: []
    }
  ]);
  assert.deepEqual(harness.steerTurnCalls, []);
});

test("ProviderCommandCoordinator uses Desktop idle state instead of a stale busy cache", async () => {
  const desktopStartTurnCalls: Array<{ threadId: string; params: Record<string, unknown> }> = [];
  const harness = createHarness({
    messageWriteBacks: {
      allowFromDiscord: true,
      allowPlainMessages: true,
      allowedUserIds: ["user_1"]
    },
    desktopIpcClient: {
      isReady: () => true,
      canStartTurnInDesktopThread: (threadId: string) => threadId === "thread_desktop_idle",
      getConversationState: () => ({
        turns: [],
        threadRuntimeStatus: { type: "idle" },
        turnHistory: {
          kind: "canonical",
          history: { entitiesByKey: {} }
        }
      }),
      startTurn: async (threadId: string, params: Record<string, unknown>) => {
        desktopStartTurnCalls.push({ threadId, params });
      }
    }
  });
  harness.bridges.set("thread_desktop_idle", createBridge("thread_desktop_idle", "discord_desktop_idle"));
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_desktop_idle",
    {
      threadId: "thread_desktop_idle",
      sourceKind: "app-server",
      status: { type: "active" },
      lastTurnId: "stale_turn",
      lastTurnStatus: "in_progress"
    }
  );

  const result = await harness.coordinator.handlePlainMessage(
    authorizedActor,
    "discord_desktop_idle",
    "message_desktop_idle",
    "Start after Desktop becomes idle."
  );

  assert.equal(result, null);
  assert.equal(harness.writeBackQueue[0]?.status, "sent");
  assert.equal(desktopStartTurnCalls.length, 1);
  assert.equal(desktopStartTurnCalls[0]?.threadId, "thread_desktop_idle");
});

test("ProviderCommandCoordinator sends a queued Discord message as a new turn when the active turn has ended", async () => {
  const desktopStartTurnCalls: Array<{ threadId: string; params: Record<string, unknown> }> = [];
  let phase: "active" | "idle" = "active";
  const harness = createHarness({
    messageWriteBacks: {
      allowFromDiscord: true,
      allowPlainMessages: true,
      allowedUserIds: ["user_1"]
    },
    desktopIpcClient: {
      isReady: () => true,
      canStartTurnInDesktopThread: (threadId: string) => threadId === "thread_direct_send",
      getConversationState: () => ({
        threadRuntimeStatus: { type: phase },
        turns: phase === "active" ? [{ turnId: "turn_finished", status: "inProgress" }] : []
      }),
      startTurn: async (threadId: string, params: Record<string, unknown>) => {
        desktopStartTurnCalls.push({ threadId, params });
      }
    }
  });
  harness.bridges.set("thread_direct_send", createBridge("thread_direct_send", "discord_direct_send"));
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_direct_send",
    {
      threadId: "thread_direct_send",
      sourceKind: "app-server",
      status: { type: "active" },
      lastTurnId: "turn_finished",
      lastTurnStatus: "in_progress"
    }
  );

  const queued = await harness.coordinator.handlePlainMessage(
    authorizedActor,
    "discord_direct_send",
    "message_direct_send",
    "Start this immediately after the earlier turn ends."
  );
  assert.equal(harness.writeBackQueue[0]?.status, "pending");
  assert.deepEqual(queued?.buttons?.map((button) => button.label), ["立即发送", "删除"]);

  phase = "idle";
  const sent = await harness.coordinator.handleWriteBackButton(authorizedActor, "steer", 1);

  assert.match(sent.content, /Started a new Codex turn\./);
  assert.equal(harness.writeBackQueue[0]?.status, "sent");
  assert.deepEqual(desktopStartTurnCalls, [
    {
      threadId: "thread_direct_send",
      params: {
        input: [{ type: "text", text: "Start this immediately after the earlier turn ends." }],
        attachments: []
      }
    }
  ]);
});

test("ProviderCommandCoordinator builds a dynamic per-channel model menu", async () => {
  const harness = createHarness({ modelPreference: "gpt-5.6-sol" });
  harness.bridges.set("thread_model", createBridge("thread_model", "discord_model"));
  harness.writeBackQueue.push({
    id: 99,
    threadId: "thread_model",
    discordChannelId: "discord_model",
    actorUserId: "user_1",
    text: "Use the selected model.",
    sourceKind: "plain",
    discordMessageId: "message_model",
    requestedModel: "gpt-5.6-sol",
    requestedReasoningEffort: "high",
    localImagePaths: [],
    mirrorConsumedAt: null,
    status: "sent",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sentAt: new Date().toISOString(),
    error: null
  });

  const result = await harness.coordinator.handleModelCommand(authorizedActor, "discord_model");

  assert.equal(result.ephemeral, true);
  assert.match(result.content, /只影响此频道以后由 Discord 发起的新一轮/);
  assert.match(result.content, /当前频道设置：\*\*GPT-5\.6 Sol · medium\*\*/);
  assert.match(result.content, /最近一次 Discord 发送：\*\*GPT-5\.6 Sol · high\*\*/);
  assert.deepEqual(result.selectMenus?.[0]?.options, [
    { label: "跟随 Codex 默认模型", value: "__codex_default__", default: false },
    { label: "GPT-5.6 Sol", value: "gpt-5.6-sol", default: true },
    { label: "GPT-5.6 Terra", value: "gpt-5.6-terra", default: false }
  ]);
  assert.deepEqual(result.selectMenus?.[1], {
    customId: "codex:reasoning-effort:select",
    placeholder: "选择推理强度",
    minValues: 1,
    maxValues: 1,
    options: [
      { label: "low", value: "low", default: false },
      { label: "medium", value: "medium", default: true },
      { label: "high", value: "high", default: false }
    ]
  });
});

test("ProviderCommandCoordinator validates and saves model selection for future Discord turns", async () => {
  const harness = createHarness({ modelPreference: "gpt-5.6-sol" });
  harness.bridges.set("thread_model_select", createBridge("thread_model_select", "discord_model_select"));

  const selected = await harness.coordinator.handleModelSelect(
    authorizedActor,
    "discord_model_select",
    "gpt-5.6-terra"
  );
  assert.equal(selected.selectMenus?.[1]?.customId, "codex:reasoning-effort:select");
  assert.equal(harness.modelPreference, "gpt-5.6-terra");

  const rejected = await harness.coordinator.handleModelSelect(
    authorizedActor,
    "discord_model_select",
    "invented-model"
  );
  assert.match(rejected.content, /模型不可用/);
  assert.equal(harness.modelPreference, "gpt-5.6-terra");

  const reset = await harness.coordinator.handleModelSelect(
    authorizedActor,
    "discord_model_select",
    "__codex_default__"
  );
  assert.match(reset.content, /跟随 Codex 默认模型/);
  assert.equal(harness.modelPreference, null);
});

test("a queued plain message keeps the model selected when it entered the queue", async () => {
  const harness = createHarness({
    messageWriteBacks: {
      allowFromDiscord: true,
      allowPlainMessages: true,
      allowedUserIds: ["user_1"]
    },
    modelPreference: "gpt-5.6-sol"
  });
  harness.bridges.set("thread_model_snapshot", createBridge("thread_model_snapshot", "discord_model_snapshot"));
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_model_snapshot",
    {
      threadId: "thread_model_snapshot",
      sourceKind: "app-server",
      status: { type: "active" },
      lastTurnId: "turn_busy",
      lastTurnStatus: "in_progress"
    }
  );

  await harness.coordinator.handlePlainMessage(
    authorizedActor,
    "discord_model_snapshot",
    "message_model_snapshot",
    "Queue with Sol."
  );
  await harness.coordinator.handleModelSelect(
    authorizedActor,
    "discord_model_snapshot",
    "gpt-5.6-terra"
  );

  assert.equal(harness.writeBackQueue[0]?.requestedModel, "gpt-5.6-sol");
  assert.equal(harness.modelPreference, "gpt-5.6-terra");
});

test("ProviderCommandCoordinator send command starts an idle CLI session without resuming", async () => {
  const harness = createHarness();
  harness.bridges.set(
    "thread_cli_send_idle",
    createBridge("thread_cli_send_idle", "discord_cli_send_idle", "cli-session")
  );
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_cli_send_idle",
    {
      threadId: "thread_cli_send_idle",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "cli-session",
      name: "CLI bridge thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "idle" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: null,
      lastTurnStatus: null
    }
  );

  const result = await harness.coordinator.handleSendCommand(
    authorizedActor,
    "discord_cli_send_idle",
    "Start from Discord in the live CLI.",
    "queue"
  );

  assert.match(result.content, /Started a new Codex turn/);
  assert.match(result.content, /> Start from Discord in the live CLI\./);
  assert.deepEqual(harness.resumeThreadCalls, []);
  assert.deepEqual(harness.startTurnCalls, [
    {
      threadId: "thread_cli_send_idle",
      text: "Start from Discord in the live CLI."
    }
  ]);
  assert.equal(harness.writeBackQueue[0]?.status, "sent");
});

test("ProviderCommandCoordinator send command routes bridge remote CLI threads through app-server", async () => {
  const desktopStartTurnCalls: Array<{ conversationId: string; turnStartParams: Record<string, unknown> }> = [];
  const harness = createHarness({
    desktopIpcClient: {
      startTurn: async (conversationId: string, turnStartParams: Record<string, unknown>) => {
        desktopStartTurnCalls.push({ conversationId, turnStartParams });
      }
    },
    metadata: new Map([
      [
        "thread_remote_cli_send_idle",
        {
          cwd: "C:\\repo",
          repoName: "repo",
          threadName: "Remote CLI thread",
          actorName: null,
          parentThreadId: null,
          sourceSubagentOther: null,
          originator: "codex-mobile",
          source: "vscode"
        }
      ]
    ])
  });
  harness.bridges.set(
    "thread_remote_cli_send_idle",
    createBridge("thread_remote_cli_send_idle", "discord_remote_cli_send_idle", "app-server")
  );
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_remote_cli_send_idle",
    {
      threadId: "thread_remote_cli_send_idle",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Remote CLI bridge thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "idle" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: null,
      lastTurnStatus: null
    }
  );

  const result = await harness.coordinator.handleSendCommand(
    authorizedActor,
    "discord_remote_cli_send_idle",
    "Start from Discord in the remote CLI.",
    "queue"
  );

  assert.match(result.content, /Started a new Codex turn/);
  assert.match(result.content, /> Start from Discord in the remote CLI\./);
  assert.deepEqual(harness.resumeThreadCalls, []);
  assert.deepEqual(harness.startTurnCalls, [
    {
      threadId: "thread_remote_cli_send_idle",
      text: "Start from Discord in the remote CLI."
    }
  ]);
  assert.deepEqual(desktopStartTurnCalls, []);
  assert.equal(harness.writeBackQueue[0]?.status, "sent");
});

test("ProviderCommandCoordinator send command queues while active and exposes write-back buttons", async () => {
  const harness = createHarness();
  harness.bridges.set("thread_send_active", createBridge("thread_send_active", "discord_send_active"));
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_send_active",
    {
      threadId: "thread_send_active",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Bridge thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "active" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_active",
      lastTurnStatus: "in_progress"
    }
  );

  const result = await harness.coordinator.handleSendCommand(
    authorizedActor,
    "discord_send_active",
    "Queue this after the active turn.",
    "queue"
  );

  assert.match(result.content, /Queued for the next turn\. Position 1\./);
  assert.match(result.content, /> Queue this after the active turn\./);
  assert.equal(harness.writeBackQueue[0]?.status, "pending");
  assert.deepEqual(harness.startTurnCalls, []);
  assert.deepEqual(result.buttons?.map((button) => button.label), ["Send now", "Retract"]);
});

test("ProviderCommandCoordinator send command reconciles stale active state from canonical final answer", async () => {
  const harness = createHarness();
  harness.bridges.set("thread_send_stale_final", createBridge("thread_send_stale_final", "discord_send_stale_final"));
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_send_stale_final",
    {
      threadId: "thread_send_stale_final",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Bridge thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "active" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_stale_final",
      lastTurnStatus: "in_progress"
    }
  );
  (harness.coordinator as unknown as {
    context: {
      stateStore: {
        appendCanonicalThreadEvent(record: {
          threadId: string;
          eventKind: string;
          itemKind: string;
          turnId: string;
          summary: string;
        }): void;
      };
    };
  }).context.stateStore.appendCanonicalThreadEvent({
    threadId: "thread_send_stale_final",
    eventKind: "content",
    itemKind: "agentAnswer",
    turnId: "turn_stale_final",
    summary: "Finished."
  });

  const result = await harness.coordinator.handleSendCommand(
    authorizedActor,
    "discord_send_stale_final",
    "Start from stale completed state.",
    "queue"
  );

  assert.match(result.content, /Started a new Codex turn/);
  assert.match(result.content, /> Start from stale completed state\./);
  assert.deepEqual(harness.startTurnCalls, [
    {
      threadId: "thread_send_stale_final",
      text: "Start from stale completed state."
    }
  ]);
  assert.equal(harness.writeBackQueue[0]?.status, "sent");
  const runtimeState = (harness.coordinator as unknown as {
    runtime: { threadState: Map<string, { lastTurnId: string | null; lastTurnStatus: string | null }> };
  }).runtime.threadState.get("thread_send_stale_final");
  assert.equal(runtimeState?.lastTurnId, null);
  assert.equal(runtimeState?.lastTurnStatus, "in_progress");
});

test("ProviderCommandCoordinator send command steers only active turns", async () => {
  const harness = createHarness();
  harness.bridges.set("thread_send_steer", createBridge("thread_send_steer", "discord_send_steer"));
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_send_steer",
    {
      threadId: "thread_send_steer",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Bridge thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "active" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_send_steer",
      lastTurnStatus: "in_progress"
    }
  );

  const result = await harness.coordinator.handleSendCommand(
    authorizedActor,
    "discord_send_steer",
    "Adjust the active turn.",
    "steer"
  );

  assert.match(result.content, /Sent to the active turn\./);
  assert.match(result.content, /> Adjust the active turn\./);
  assert.deepEqual(harness.steerTurnCalls, [
    {
      threadId: "thread_send_steer",
      turnId: "turn_send_steer",
      text: "Adjust the active turn."
    }
  ]);

  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_send_steer",
    {
      threadId: "thread_send_steer",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Bridge thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "idle" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: null,
      lastTurnStatus: null
    }
  );

  const idle = await harness.coordinator.handleSendCommand(
    authorizedActor,
    "discord_send_steer",
    "This should start a new turn instead.",
    "steer"
  );
  assert.equal(idle.ephemeral, true);
  assert.match(idle.content, /thread is idle/i);
});

test("ProviderCommandCoordinator send command steers bridge remote CLI through app-server when Desktop IPC is ready", async () => {
  const desktopSteerTurnCalls: Array<{ threadId: string; turnId: string; input: unknown }> = [];
  const desktopIpcClient = {
    isReady: () => true,
    getConversationState: () => null,
    waitForConversationState: async () => null,
    steerTurn: async (threadId: string, turnId: string, input: unknown) => {
      desktopSteerTurnCalls.push({ threadId, turnId, input });
    }
  };
  const harness = createHarness({
    desktopIpcClient,
    metadata: new Map([
      [
        "thread_remote_cli_steer",
        {
          cwd: "C:\\repo",
          repoName: "repo",
          threadName: "Remote CLI bridge thread",
          actorName: null,
          parentThreadId: null,
          sourceSubagentOther: null,
          originator: "codex-mobile",
          source: "vscode"
        }
      ]
    ])
  });
  harness.bridges.set(
    "thread_remote_cli_steer",
    createBridge("thread_remote_cli_steer", "discord_remote_cli_steer", "app-server")
  );
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_remote_cli_steer",
    {
      threadId: "thread_remote_cli_steer",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Remote CLI bridge thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "active" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_remote_cli_steer",
      lastTurnStatus: "in_progress"
    }
  );

  const result = await harness.coordinator.handleSendCommand(
    authorizedActor,
    "discord_remote_cli_steer",
    "Adjust the active remote CLI turn.",
    "steer"
  );

  assert.match(result.content, /Sent to the active turn\./);
  assert.match(result.content, /> Adjust the active remote CLI turn\./);
  assert.deepEqual(harness.steerTurnCalls, [
    {
      threadId: "thread_remote_cli_steer",
      turnId: "turn_remote_cli_steer",
      text: "Adjust the active remote CLI turn."
    }
  ]);
  assert.deepEqual(desktopSteerTurnCalls, []);
});

test("ProviderCommandCoordinator retracts the latest pending queued write-back", async () => {
  const harness = createHarness();
  harness.bridges.set("thread_retract", createBridge("thread_retract", "discord_retract"));
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_retract",
    {
      status: { type: "active" },
      lastTurnId: "turn_retract",
      lastTurnStatus: "in_progress"
    }
  );

  await harness.coordinator.handleSendCommand(authorizedActor, "discord_retract", "First", "queue");
  await harness.coordinator.handleSendCommand(authorizedActor, "discord_retract", "Second", "queue");
  const result = await harness.coordinator.handleRetractCommand(authorizedActor, "discord_retract");

  assert.match(result.content, /Retracted the latest pending queued message\./);
  assert.match(result.content, /> Second/);
  assert.equal(harness.writeBackQueue[0]?.status, "pending");
  assert.equal(harness.writeBackQueue[1]?.status, "retracted");
});

test("ProviderCommandCoordinator drains only one queued write-back per idle transition", async () => {
  const harness = createHarness();
  harness.bridges.set("thread_drain", createBridge("thread_drain", "discord_drain"));
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_drain",
    {
      threadId: "thread_drain",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Bridge thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "active" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_drain_old",
      lastTurnStatus: "in_progress"
    }
  );
  await harness.coordinator.handleSendCommand(authorizedActor, "discord_drain", "First", "queue");
  await harness.coordinator.handleSendCommand(authorizedActor, "discord_drain", "Second", "queue");
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_drain",
    {
      threadId: "thread_drain",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Bridge thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "idle" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_drain_old",
      lastTurnStatus: "completed"
    }
  );

  await harness.coordinator.drainNextQueuedWriteBackMessage("thread_drain");
  await harness.coordinator.drainNextQueuedWriteBackMessage("thread_drain");

  assert.deepEqual(harness.startTurnCalls, [
    {
      threadId: "thread_drain",
      text: "First"
    }
  ]);
  assert.equal(harness.writeBackQueue[0]?.status, "sent");
  assert.equal(harness.writeBackQueue[1]?.status, "pending");
});

test("ProviderCommandCoordinator drains queued bridge remote CLI write-back through app-server", async () => {
  const desktopStartTurnCalls: Array<{ conversationId: string; turnStartParams: Record<string, unknown> }> = [];
  const harness = createHarness({
    desktopIpcClient: {
      startTurn: async (conversationId: string, turnStartParams: Record<string, unknown>) => {
        desktopStartTurnCalls.push({ conversationId, turnStartParams });
      }
    },
    metadata: new Map([
      [
        "thread_remote_cli_drain",
        {
          cwd: "C:\\repo",
          repoName: "repo",
          threadName: "Remote CLI bridge thread",
          actorName: null,
          parentThreadId: null,
          sourceSubagentOther: null,
          originator: "codex-mobile",
          source: "vscode"
        }
      ]
    ])
  });
  harness.bridges.set(
    "thread_remote_cli_drain",
    createBridge("thread_remote_cli_drain", "discord_remote_cli_drain", "app-server")
  );
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_remote_cli_drain",
    {
      threadId: "thread_remote_cli_drain",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Remote CLI bridge thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "active" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_remote_cli_drain_old",
      lastTurnStatus: "in_progress"
    }
  );
  await harness.coordinator.handleSendCommand(
    authorizedActor,
    "discord_remote_cli_drain",
    "Run after the active remote CLI turn.",
    "queue"
  );
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_remote_cli_drain",
    {
      threadId: "thread_remote_cli_drain",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Remote CLI bridge thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "idle" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_remote_cli_drain_old",
      lastTurnStatus: "completed"
    }
  );

  await harness.coordinator.drainNextQueuedWriteBackMessage("thread_remote_cli_drain");

  assert.deepEqual(harness.startTurnCalls, [
    {
      threadId: "thread_remote_cli_drain",
      text: "Run after the active remote CLI turn."
    }
  ]);
  assert.deepEqual(desktopStartTurnCalls, []);
  assert.equal(harness.writeBackQueue[0]?.status, "sent");
});

test("ProviderCommandCoordinator routes a Discord-created thread through Desktop after Desktop owns it", async () => {
  const desktopStartTurnCalls: Array<{ conversationId: string; turnStartParams: Record<string, unknown> }> = [];
  const harness = createHarness({
    desktopIpcClient: {
      canStartTurnInDesktopThread: (threadId: string) => threadId === "thread_discord_created_owned",
      startTurn: async (conversationId: string, turnStartParams: Record<string, unknown>) => {
        desktopStartTurnCalls.push({ conversationId, turnStartParams });
      }
    },
    metadata: new Map([
      [
        "thread_discord_created_owned",
        {
          cwd: "C:\\repo",
          repoName: "repo",
          threadName: "Discord-created Desktop thread",
          actorName: null,
          parentThreadId: null,
          sourceSubagentOther: null,
          originator: "codex-mobile",
          source: "vscode"
        }
      ]
    ])
  });
  harness.bridges.set(
    "thread_discord_created_owned",
    createBridge("thread_discord_created_owned", "discord_created_owned", "app-server")
  );
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_discord_created_owned",
    {
      threadId: "thread_discord_created_owned",
      sourceKind: "app-server",
      status: { type: "active" },
      lastTurnId: "turn_discord_created_old",
      lastTurnStatus: "in_progress"
    }
  );
  await harness.coordinator.handleSendCommand(
    authorizedActor,
    "discord_created_owned",
    "Continue in the visible Desktop thread.",
    "queue"
  );
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_discord_created_owned",
    {
      threadId: "thread_discord_created_owned",
      sourceKind: "app-server",
      status: { type: "idle" },
      lastTurnId: "turn_discord_created_old",
      lastTurnStatus: "completed"
    }
  );

  await harness.coordinator.drainNextQueuedWriteBackMessage("thread_discord_created_owned");

  assert.equal(harness.startTurnCalls.length, 0);
  assert.deepEqual(desktopStartTurnCalls, [
    {
      conversationId: "thread_discord_created_owned",
      turnStartParams: {
        input: [{ type: "text", text: "Continue in the visible Desktop thread." }],
        attachments: []
      }
    }
  ]);
  assert.equal(harness.writeBackQueue[0]?.status, "sent");
});

test("ProviderCommandCoordinator opens and waits for a Discord-created thread before Desktop routing", async () => {
  let desktopOwnsThread = false;
  const desktopStartTurnCalls: Array<{ conversationId: string; turnStartParams: Record<string, unknown> }> = [];
  const harness = createHarness({
    messageWriteBacks: {
      allowFromDiscord: true,
      allowPlainMessages: true,
      allowedUserIds: ["user_1"]
    },
    desktopIpcClient: {
      isReady: () => true,
      canStartTurnInDesktopThread: () => desktopOwnsThread,
      waitForOwnerClientId: async () => {
        desktopOwnsThread = true;
        return "desktop-owner";
      },
      startTurn: async (conversationId: string, turnStartParams: Record<string, unknown>) => {
        desktopStartTurnCalls.push({ conversationId, turnStartParams });
      }
    },
    metadata: new Map([
      [
        "thread_discord_created_unclaimed",
        {
          cwd: "C:\\repo",
          repoName: "repo",
          threadName: "Discord-created unclaimed thread",
          actorName: null,
          parentThreadId: null,
          sourceSubagentOther: null,
          originator: "codex-mobile",
          source: "vscode"
        }
      ]
    ])
  });
  harness.bridges.set(
    "thread_discord_created_unclaimed",
    createBridge("thread_discord_created_unclaimed", "discord_created_unclaimed", "app-server")
  );
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_discord_created_unclaimed",
    {
      threadId: "thread_discord_created_unclaimed",
      sourceKind: "app-server",
      status: { type: "idle" },
      lastTurnId: "turn_discord_created_old",
      lastTurnStatus: "completed"
    }
  );

  await harness.coordinator.handlePlainMessage(
    authorizedActor,
    "discord_created_unclaimed",
    "message_created_unclaimed",
    "Show this turn in Codex Desktop."
  );

  assert.deepEqual(harness.openCodexThreadCalls, ["thread_discord_created_unclaimed"]);
  assert.deepEqual(desktopStartTurnCalls, [
    {
      conversationId: "thread_discord_created_unclaimed",
      turnStartParams: {
        input: [{ type: "text", text: "Show this turn in Codex Desktop." }],
        attachments: []
      }
    }
  ]);
  assert.equal(harness.writeBackQueue[0]?.status, "sent");
});

test("ProviderCommandCoordinator steer-instead button sends without starting a duplicate turn", async () => {
  const harness = createHarness();
  harness.bridges.set("thread_button", createBridge("thread_button", "discord_button"));
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_button",
    {
      threadId: "thread_button",
      parentThreadId: null,
      projectKey: "c:\\repo",
      projectName: "repo",
      channelKind: "conversation",
      sourceKind: "app-server",
      name: "Bridge thread",
      actorName: null,
      preview: null,
      cwd: "C:\\repo",
      repoName: "repo",
      status: { type: "active" },
      lastActivityAt: Date.now(),
      latestCommandPreview: null,
      latestAgentMessage: null,
      lastTurnId: "turn_button",
      lastTurnStatus: "in_progress"
    }
  );

  await harness.coordinator.handleSendCommand(authorizedActor, "discord_button", "Steer this instead.", "queue");
  const result = await harness.coordinator.handleWriteBackButton(authorizedActor, "steer", 1);

  assert.match(result.content, /Sent queued message to the active turn\./);
  assert.match(result.content, /> Steer this instead\./);
  assert.equal(harness.writeBackQueue[0]?.status, "sent");
  assert.deepEqual(harness.steerTurnCalls, [
    {
      threadId: "thread_button",
      turnId: "turn_button",
      text: "Steer this instead."
    }
  ]);
  assert.deepEqual(harness.startTurnCalls, []);
});

test("ProviderCommandCoordinator steers an owned Desktop thread without parsing its live rollout", async () => {
  const desktopSteerTurnCalls: Array<{ threadId: string; turnId: string; input: unknown }> = [];
  const harness = createHarness({
    resumeThreadError: new Error("failed to parse thread ID from rollout file"),
    desktopIpcClient: {
      isReady: () => true,
      canStartTurnInDesktopThread: (threadId: string) => threadId === "thread_desktop_button",
      getConversationState: () => ({
        turns: [{ turnId: "turn_desktop_button", status: "inProgress" }]
      }),
      waitForConversationState: async () => null,
      steerTurn: async (threadId: string, turnId: string, input: unknown) => {
        desktopSteerTurnCalls.push({ threadId, turnId, input });
      }
    }
  });
  harness.bridges.set(
    "thread_desktop_button",
    createBridge("thread_desktop_button", "discord_desktop_button")
  );
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_desktop_button",
    {
      threadId: "thread_desktop_button",
      sourceKind: "app-server",
      status: { type: "active" },
      lastTurnId: "turn_desktop_button",
      lastTurnStatus: "in_progress"
    }
  );

  await harness.coordinator.handleSendCommand(
    authorizedActor,
    "discord_desktop_button",
    "Steer without reading the live rollout.",
    "queue"
  );
  const result = await harness.coordinator.handleWriteBackButton(authorizedActor, "steer", 1);

  assert.match(result.content, /Sent queued message to the active turn\./);
  assert.deepEqual(harness.resumeThreadCalls, []);
  assert.equal(harness.writeBackQueue[0]?.status, "sent");
  assert.deepEqual(desktopSteerTurnCalls, [
    {
      threadId: "thread_desktop_button",
      turnId: "turn_desktop_button",
      input: [{ type: "text", text: "Steer without reading the live rollout." }]
    }
  ]);
});

test("ProviderCommandCoordinator retries a temporarily incomplete Desktop active state before steering", async () => {
  const desktopSteerTurnCalls: Array<{ threadId: string; turnId: string; input: unknown }> = [];
  let desktopTurnIsVisible = false;
  const harness = createHarness({
    desktopIpcClient: {
      isReady: () => true,
      canStartTurnInDesktopThread: (threadId: string) => threadId === "thread_delayed_desktop_turn",
      getConversationState: () => ({
        threadRuntimeStatus: { type: "active" },
        turns: desktopTurnIsVisible ? [{ turnId: "turn_delayed_desktop", status: "inProgress" }] : []
      }),
      waitForConversationState: async () => null,
      steerTurn: async (threadId: string, turnId: string, input: unknown) => {
        desktopSteerTurnCalls.push({ threadId, turnId, input });
      }
    }
  });
  harness.bridges.set(
    "thread_delayed_desktop_turn",
    createBridge("thread_delayed_desktop_turn", "discord_delayed_desktop_turn")
  );
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_delayed_desktop_turn",
    {
      threadId: "thread_delayed_desktop_turn",
      sourceKind: "app-server",
      status: { type: "active" },
      lastTurnId: null,
      lastTurnStatus: null
    }
  );

  await harness.coordinator.handleSendCommand(
    authorizedActor,
    "discord_delayed_desktop_turn",
    "Wait for the Desktop turn id, then guide it.",
    "queue"
  );
  setTimeout(() => {
    desktopTurnIsVisible = true;
  }, 25);

  const result = await harness.coordinator.handleWriteBackButton(authorizedActor, "steer", 1);

  assert.match(result.content, /Sent queued message to the active turn\./);
  assert.equal(harness.writeBackQueue[0]?.status, "sent");
  assert.deepEqual(desktopSteerTurnCalls, [
    {
      threadId: "thread_delayed_desktop_turn",
      turnId: "turn_delayed_desktop",
      input: [{ type: "text", text: "Wait for the Desktop turn id, then guide it." }]
    }
  ]);
});

test("ProviderCommandCoordinator starts a new turn when Desktop reports the queued turn has ended", async () => {
  const desktopSteerTurnCalls: Array<{ threadId: string; turnId: string; input: unknown }> = [];
  const desktopStartTurnCalls: Array<{ threadId: string; params: Record<string, unknown> }> = [];
  let phase: "queued" | "waiting" | "active" = "queued";
  const harness = createHarness({
    desktopIpcClient: {
      isReady: () => true,
      canStartTurnInDesktopThread: (threadId: string) => threadId === "thread_stale_busy",
      getConversationState: () => {
        if (phase === "active") {
          return {
            threadRuntimeStatus: { type: "active" },
            turns: [{ turnId: "turn_after_stale_busy", status: "inProgress" }]
          };
        }
        return {
          threadRuntimeStatus: { type: phase === "queued" ? "active" : "idle" },
          turns: []
        };
      },
      waitForConversationState: async () => null,
      steerTurn: async (threadId: string, turnId: string, input: unknown) => {
        desktopSteerTurnCalls.push({ threadId, turnId, input });
      },
      startTurn: async (threadId: string, params: Record<string, unknown>) => {
        desktopStartTurnCalls.push({ threadId, params });
      }
    }
  });
  harness.bridges.set("thread_stale_busy", createBridge("thread_stale_busy", "discord_stale_busy"));
  (harness.coordinator as unknown as { runtime: { threadState: Map<string, unknown> } }).runtime.threadState.set(
    "thread_stale_busy",
    {
      threadId: "thread_stale_busy",
      sourceKind: "app-server",
      status: { type: "active" },
      lastTurnId: null,
      lastTurnStatus: null
    }
  );

  await harness.coordinator.handleSendCommand(
    authorizedActor,
    "discord_stale_busy",
    "Guide the turn that is about to appear.",
    "queue"
  );
  phase = "waiting";
  const result = await harness.coordinator.handleWriteBackButton(authorizedActor, "steer", 1);

  assert.match(result.content, /Started a new Codex turn\./);
  assert.equal(harness.writeBackQueue[0]?.status, "sent");
  assert.deepEqual(desktopSteerTurnCalls, []);
  assert.deepEqual(desktopStartTurnCalls, [
    {
      threadId: "thread_stale_busy",
      params: {
        input: [{ type: "text", text: "Guide the turn that is about to appear." }],
        attachments: []
      }
    }
  ]);
});

test("DesktopSteerPayloadBuilder restore summary does not count duplicated rollback thread bytes", () => {
  const { builder } = createDesktopSteerPayloadBuilder();
  const desktopConversationState = {
    id: "thread_desktop_summary",
    cwd: "C:\\repo",
    updatedAt: 1_777_000_000_000,
    latestModel: "gpt-5.4",
    latestReasoningEffort: "high",
    turns: [
      {
        turnId: "turn_desktop_summary_live",
        status: "inProgress",
        params: {
          threadId: "thread_desktop_summary",
          input: [
            {
              type: "text",
              text: "Keep the restore payload compact."
            }
          ],
          cwd: "C:\\repo",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: ["C:\\repo"]
          },
          attachments: [],
          commentAttachments: []
        }
      }
    ],
    requests: []
  };

  const restoreMessage = builder.buildDesktopRestoreMessage(
    "thread_desktop_summary",
    desktopConversationState,
    "turn_desktop_summary_live"
  );
  const summary = builder.summarizeDesktopSteerPayload(desktopConversationState, restoreMessage);

  assert.ok(restoreMessage);
  assert.equal("rollbackResponse" in restoreMessage, false);
  assert.equal(summary.restoreThreadBytes ? summary.restoreThreadBytes > 0 : false, true);
  assert.equal(summary.restoreRollbackResponseBytes, null);
  assert.equal(summary.restoreRollbackResponseThreadBytes, null);
  assert.equal(summary.estimatedDuplicatedThreadBytes, null);
});

test("DesktopSteerPayloadBuilder sanitizes historical rollback items but keeps live rollback input", () => {
  const { builder } = createDesktopSteerPayloadBuilder();
  const historicalSteeringItem = {
    id: "turn_desktop_sanitize_old:steer",
    type: "steeringUserMessage",
    targetTurnId: "turn_desktop_sanitize_old",
    status: "delivered",
    input: [
      {
        type: "text",
        text: "Older feedback."
      }
    ],
    restoreMessage: {
      id: "restore:old",
      text: "Nested restore prompt.",
      thread: {
        id: "thread_desktop_sanitize",
        turns: []
      }
    }
  };
  const historicalCommandItem = {
    id: "cmd_desktop_sanitize_old",
    type: "commandExecution",
    command: "npm run test",
    status: "completed",
    aggregatedOutput: "very long historical output",
    exitCode: 0
  };
  const desktopConversationState = {
    id: "thread_desktop_sanitize",
    cwd: "C:\\repo",
    updatedAt: 1_779_100_000_000,
    latestModel: "gpt-5.4",
    latestReasoningEffort: "high",
    turns: [
      {
        turnId: "turn_desktop_sanitize_old",
        status: "complete",
        items: [historicalSteeringItem, historicalCommandItem]
      },
      {
        turnId: "turn_desktop_sanitize_live",
        status: "inProgress",
        params: {
          threadId: "thread_desktop_sanitize",
          input: [
            {
              type: "text",
              text: "Current live prompt."
            }
          ],
          cwd: "C:\\repo",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: ["C:\\repo"]
          },
          attachments: [],
          commentAttachments: []
        },
        items: []
      }
    ],
    requests: []
  };

  const restoreMessage = builder.buildDesktopRestoreMessage(
    "thread_desktop_sanitize",
    desktopConversationState,
    "turn_desktop_sanitize_live"
  );
  assert.ok(restoreMessage);

  const rollbackTurns =
    (((restoreMessage.thread as Record<string, unknown>)?.turns as Record<string, unknown>[]) ?? []);
  const historicalTurn = rollbackTurns.find((turn) => turn.id === "turn_desktop_sanitize_old");
  assert.ok(historicalTurn);
  const historicalItems = (historicalTurn.items as Record<string, unknown>[]) ?? [];
  const sanitizedSteeringItem = historicalItems.find((item) => item.type === "steeringUserMessage");
  const sanitizedCommandItem = historicalItems.find((item) => item.type === "commandExecution");
  assert.ok(sanitizedSteeringItem);
  assert.ok(sanitizedCommandItem);
  assert.equal("restoreMessage" in sanitizedSteeringItem, false);
  assert.equal("aggregatedOutput" in sanitizedCommandItem, false);
  assert.equal(sanitizedCommandItem.command, "npm run test");

  const liveTurn = rollbackTurns.find((turn) => turn.id === "turn_desktop_sanitize_live");
  assert.ok(liveTurn);
  assert.deepEqual((liveTurn.items as unknown[])[0], {
    id: "turn_desktop_sanitize_live:user-message",
    type: "userMessage",
    content: [
      {
        type: "text",
        text: "Current live prompt."
      }
    ]
  });
  assert.equal("restoreMessage" in historicalSteeringItem, true);
  assert.equal("aggregatedOutput" in historicalCommandItem, true);
});

test("DesktopSteerPayloadBuilder only dumps oversized Desktop steer payloads behind the dev guardrail", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mobile-steer-dump-"));
  const configPath = path.join(dir, "bridge.config.json");
  const { builder, runtimeConfig } = createDesktopSteerPayloadBuilder({ configPath, dumpEnabled: false });

  const dumpArgs = {
    targetThreadId: "thread_dump_guard",
    runtimeTurnId: "turn_runtime",
    preferredTurnId: "turn_preferred",
    desktopTurnId: "turn_desktop",
    restoreStateSource: "desktop-ipc" as const,
    waitedForConversationState: false,
    waitForConversationStateDurationMs: 0,
    desktopConversationState: {
      id: "thread_dump_guard",
      turns: []
    },
    restoreMessage: {
      id: "restore:turn_desktop"
    },
    steerPayloadSummary: {
      conversationTurnCount: 0,
      rollbackTurnCount: 0,
      rollbackItemCount: 0,
      conversationStateBytes: null,
      restoreContextBytes: null,
      restoreThreadBytes: null,
      restoreRollbackResponseBytes: null,
      restoreRollbackResponseThreadBytes: null,
      estimatedDuplicatedThreadBytes: null,
      restoreMessageBytes: 30 * 1024 * 1024
    }
  };

  await builder.dumpOversizedDesktopSteerPayload(dumpArgs);
  const dumpDir = path.join(dir, "tmp", "desktop-steer-dumps");
  assert.equal(existsSync(dumpDir), false);

  runtimeConfig.diagnostics.desktopSteerDumpEnabled = true;
  await builder.dumpOversizedDesktopSteerPayload(dumpArgs);
  assert.equal(existsSync(dumpDir), true);
  assert.equal(readdirSync(dumpDir).length > 0, true);
});
