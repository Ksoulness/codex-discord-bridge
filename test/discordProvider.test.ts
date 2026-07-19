import test from "node:test";
import assert from "node:assert/strict";
import {
  ChannelType,
  Collection,
  ComponentType,
  MessageFlags,
  OverwriteType,
  PermissionFlagsBits,
  MessageType
} from "discord.js";
import { DiscordProvider } from "../src/providers/discord/DiscordProvider.js";
import { createLogger } from "../src/logger.js";

test("non-MCP approval components place feedback before cancel and details last", () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );

  const rows = (provider as unknown as {
    buildApprovalComponents: (
      view: {
        token: string;
        threadId: string;
        shortThreadId: string;
        kind: "commandExecution";
        createdAt: Date;
        availableDecisions: string[];
        actionsEnabled: boolean;
        sanitizedPreview: string;
        cwd: string | null;
        reason: string | null;
        expiresAt: Date;
        details: string;
      },
      disabled: boolean
    ) => Array<{ components: Array<{ toJSON(): { label?: string } }> }>;
  }).buildApprovalComponents(
    {
      token: "token",
      threadId: "thread",
      shortThreadId: "thread",
      kind: "commandExecution",
      createdAt: new Date("2026-04-15T13:00:00.000Z"),
      availableDecisions: ["accept", "acceptWithExecpolicyAmendment", "cancel"],
      actionsEnabled: true,
      sanitizedPreview: "Start-Process https://example.com",
      cwd: "C:\\repo",
      reason: "Approval test",
      expiresAt: new Date("2026-04-15T13:10:00.000Z"),
      details: "{}"
    },
    false
  );

  const labels = rows.flatMap((row) => row.components.map((component) => component.toJSON().label ?? ""));
  assert.deepEqual(labels, [
    "Approve once",
    "Approve similar actions",
    "No, and tell Codex what to do differently",
    "Cancel",
    "Show details"
  ]);
});

test("MCP approval components omit feedback and keep details last", () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );

  const rows = (provider as unknown as {
    buildApprovalComponents: (
      view: {
        token: string;
        threadId: string;
        shortThreadId: string;
        kind: "mcpElicitation";
        createdAt: Date;
        availableDecisions: string[];
        actionsEnabled: boolean;
        sanitizedPreview: string;
        cwd: string | null;
        reason: string | null;
        expiresAt: Date;
        details: string;
      },
      disabled: boolean
    ) => Array<{ components: Array<{ toJSON(): { label?: string } }> }>;
  }).buildApprovalComponents(
    {
      token: "token",
      threadId: "thread",
      shortThreadId: "thread",
      kind: "mcpElicitation",
      createdAt: new Date("2026-04-15T13:00:00.000Z"),
      availableDecisions: ["accept", "acceptWithExecpolicyAmendment", "cancel"],
      actionsEnabled: true,
      sanitizedPreview: "Allow the playwright MCP server to run tool \"browser_navigate\"?",
      cwd: null,
      reason: "MCP approval test",
      expiresAt: new Date("2026-04-15T13:10:00.000Z"),
      details: "{}"
    },
    false
  );

  const labels = rows.flatMap((row) => row.components.map((component) => component.toJSON().label ?? ""));
  assert.deepEqual(labels, ["Approve once", "Approve similar actions", "Cancel", "Show details"]);
});

test("approval components fall back to details when decision labels exceed Discord limits", () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );

  const rows = (provider as unknown as {
    buildApprovalComponents: (
      view: {
        token: string;
        threadId: string;
        shortThreadId: string;
        kind: "toolUserInput";
        createdAt: Date;
        availableDecisions: string[];
        actionsEnabled: boolean;
        sanitizedPreview: string;
        cwd: string | null;
        reason: string | null;
        expiresAt: Date;
        details: string;
      },
      disabled: boolean
    ) => Array<{ components: Array<{ toJSON(): { label?: string } }> }>;
  }).buildApprovalComponents(
    {
      token: "token",
      threadId: "thread",
      shortThreadId: "thread",
      kind: "toolUserInput",
      createdAt: new Date("2026-04-15T13:00:00.000Z"),
      availableDecisions: ["x".repeat(120), "Decline"],
      actionsEnabled: true,
      sanitizedPreview: "Allow browser navigation?",
      cwd: null,
      reason: null,
      expiresAt: new Date("2026-04-15T13:10:00.000Z"),
      details: "{}"
    },
    false
  );

  const labels = rows.flatMap((row) => row.components.map((component) => component.toJSON().label ?? ""));
  assert.deepEqual(labels, ["Show details"]);
});

test("tool input components use opaque custom ids and truncate display labels", () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );

  const longLabel = `Keep this exact answer ${"x".repeat(120)}`;
  const rows = (provider as unknown as {
    buildApprovalComponents: (
      view: {
        token: string;
        threadId: string;
        shortThreadId: string;
        kind: "toolUserInput";
        createdAt: Date;
        availableDecisions: string[];
        actionsEnabled: boolean;
        sanitizedPreview: string;
        cwd: string | null;
        reason: string | null;
        expiresAt: Date;
        details: string;
        toolInput: {
          questions: Array<{
            id: string;
            question: string;
            options: Array<{ label: string; isOther?: boolean }>;
          }>;
          selectedAnswers: Record<string, string>;
        };
      },
      disabled: boolean
    ) => Array<{ components: Array<{ toJSON(): { custom_id?: string; label?: string } }> }>;
  }).buildApprovalComponents(
    {
      token: "opaque_token",
      threadId: "thread",
      shortThreadId: "thread",
      kind: "toolUserInput",
      createdAt: new Date("2026-04-15T13:00:00.000Z"),
      availableDecisions: [],
      actionsEnabled: true,
      sanitizedPreview: "Which approach?",
      cwd: null,
      reason: null,
      expiresAt: new Date("2026-04-15T13:10:00.000Z"),
      details: "{}",
      toolInput: {
        questions: [
          {
            id: "approach",
            question: "Which approach?",
            options: [{ label: longLabel }, { label: "Other", isOther: true }]
          }
        ],
        selectedAnswers: {}
      }
    },
    false
  );

  const components = rows.flatMap((row) => row.components.map((component) => component.toJSON()));
  assert.equal(components[0]?.custom_id, "codex:input:opaque_token:0:0");
  assert.equal(components[1]?.custom_id, "codex:input-other:opaque_token:0");
  assert.equal(components[0]?.label?.length, 80);
  assert.equal(components.at(-1)?.label, "Show details");
});

test("tool input components show one unanswered question at a time", () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );

  const buildRows = (selectedAnswers: Record<string, string>) =>
    (provider as unknown as {
      buildApprovalComponents: (
        view: {
          token: string;
          threadId: string;
          shortThreadId: string;
          kind: "toolUserInput";
          createdAt: Date;
          availableDecisions: string[];
          actionsEnabled: boolean;
          sanitizedPreview: string;
          cwd: string | null;
          reason: string | null;
          expiresAt: Date;
          details: string;
          toolInput: {
            questions: Array<{
              id: string;
              question: string;
              options: Array<{ label: string; isOther?: boolean }>;
            }>;
            selectedAnswers: Record<string, string>;
          };
        },
        disabled: boolean
      ) => Array<{ components: Array<{ toJSON(): { custom_id?: string; label?: string } }> }>;
    }).buildApprovalComponents(
      {
        token: "opaque_token",
        threadId: "thread",
        shortThreadId: "thread",
        kind: "toolUserInput",
        createdAt: new Date("2026-04-15T13:00:00.000Z"),
        availableDecisions: [],
        actionsEnabled: true,
        sanitizedPreview: "Tool input requested (2 questions)",
        cwd: null,
        reason: null,
        expiresAt: new Date("2026-04-15T13:10:00.000Z"),
        details: "{}",
        toolInput: {
          questions: [
            {
              id: "color",
              question: "What color?",
              options: [{ label: "Blue" }, { label: "Red" }]
            },
            {
              id: "food",
              question: "What food?",
              options: [{ label: "Pizza" }, { label: "Sushi" }]
            }
          ],
          selectedAnswers
        }
      },
      false
    );

  const firstLabels = buildRows({}).flatMap((row) =>
    row.components.map((component) => component.toJSON().label ?? "")
  );
  assert.deepEqual(firstLabels, ["Blue", "Red", "Show details"]);

  const secondComponents = buildRows({ color: "Blue" }).flatMap((row) =>
    row.components.map((component) => component.toJSON())
  );
  assert.deepEqual(
    secondComponents.map((component) => component.label ?? ""),
    ["Pizza", "Sushi", "Show details"]
  );
  assert.equal(secondComponents[0]?.custom_id, "codex:input:opaque_token:1:0");
});

test("project category creation does not adopt an existing same-name category", async () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );

  let createCalls = 0;
  let createPayload: Record<string, unknown> | null = null;
  (provider as unknown as {
    getGuild: () => Promise<{ channels: { create: (options: Record<string, unknown>) => Promise<{ id: string }> } }>;
    fetchExistingChannelOrNull: () => Promise<null>;
  }).getGuild = async () => ({
    channels: {
      create: async (options) => {
        createCalls += 1;
        createPayload = options;
        return { id: "bridge-category" };
      }
    }
  });
  (provider as unknown as {
    fetchExistingChannelOrNull: () => Promise<null>;
  }).fetchExistingChannelOrNull = async () => null;

  const result = await provider.ensureProjectCategory("c:\\repo", "Repo", null);

  assert.deepEqual(result, { id: "bridge-category", created: true });
  assert.equal(createCalls, 1);
  assert.equal(createPayload?.["name"], "Repo");
});

test("discovery does not sweep manual text channels under a seeded category", async () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );

  const channels = new Collection<string, unknown>([
    ["seed-category", { id: "seed-category", type: ChannelType.GuildCategory }],
    ["manual-channel", { id: "manual-channel", type: ChannelType.GuildText, parentId: "seed-category" }],
    ["managed-channel", { id: "managed-channel", type: ChannelType.GuildText, parentId: "seed-category" }]
  ]);
  (provider as unknown as {
    getGuild: () => Promise<{ channels: { fetch: () => Promise<Collection<string, unknown>> } }>;
    isBridgeManagedConversationChannel: (channel: { id: string }) => boolean;
    hasBridgeManagedMessages: (channel: { id: string }) => Promise<boolean>;
  }).getGuild = async () => ({
    channels: {
      fetch: async () => channels
    }
  });
  (provider as unknown as {
    isBridgeManagedConversationChannel: (channel: { id: string }) => boolean;
  }).isBridgeManagedConversationChannel = (channel) => channel.id === "managed-channel";
  (provider as unknown as {
    hasBridgeManagedMessages: (channel: { id: string }) => Promise<boolean>;
  }).hasBridgeManagedMessages = async () => false;

  const result = await provider.discoverBridgeManagedLocations(["seed-category"]);

  assert.deepEqual([...result.channelIds].sort(), ["managed-channel"]);
  assert.deepEqual(result.categoryIds, []);
});

test("scoped discovery only returns matching bridge scope inside seeded categories", async () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );

  const channels = new Collection<string, unknown>([
    ["seed-category", { id: "seed-category", type: ChannelType.GuildCategory }],
    [
      "scoped-channel",
      {
        id: "scoped-channel",
        type: ChannelType.GuildText,
        parentId: "seed-category",
        topic: "[codex-bridge] thread:thr_main scope:e2e-run"
      }
    ],
    [
      "unscoped-channel",
      {
        id: "unscoped-channel",
        type: ChannelType.GuildText,
        parentId: "seed-category",
        topic: "[codex-bridge] thread:thr_main"
      }
    ],
    [
      "other-category-channel",
      {
        id: "other-category-channel",
        type: ChannelType.GuildText,
        parentId: "other-category",
        topic: "[codex-bridge] thread:thr_main scope:e2e-run"
      }
    ]
  ]);
  (provider as unknown as {
    getGuild: () => Promise<{ channels: { fetch: () => Promise<Collection<string, unknown>> } }>;
    hasBridgeManagedMessages: (channel: { id: string }) => Promise<boolean>;
  }).getGuild = async () => ({
    channels: {
      fetch: async () => channels
    }
  });
  (provider as unknown as {
    hasBridgeManagedMessages: (channel: { id: string }) => Promise<boolean>;
  }).hasBridgeManagedMessages = async () => false;

  const result = await provider.discoverBridgeManagedLocations(["seed-category"], {
    restrictToSeedCategories: true,
    requiredScope: "e2e-run"
  });

  assert.deepEqual(result.channelIds, ["scoped-channel"]);
  assert.deepEqual(result.categoryIds, []);
});

test("scoped conversation channel creation ignores a stale existing channel outside the e2e scope", async () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );

  let editCalls = 0;
  let setTopicCalls = 0;
  let createPayload: Record<string, unknown> | null = null;
  const existingLiveChannel = {
    id: "live-channel",
    type: ChannelType.GuildText,
    name: "main",
    parentId: "live-category",
    topic: "[codex-bridge] thread:thr_main",
    createdTimestamp: 1,
    edit: async () => {
      editCalls += 1;
    },
    setTopic: async () => {
      setTopicCalls += 1;
    }
  };
  const channels = new Collection<string, unknown>([["live-channel", existingLiveChannel]]);
  (provider as unknown as {
    getGuild: () => Promise<{
      channels: {
        fetch: () => Promise<Collection<string, unknown>>;
        create: (payload: Record<string, unknown>) => Promise<{ id: string }>;
      };
    }>;
    fetchExistingChannelOrNull: () => Promise<typeof existingLiveChannel>;
  }).getGuild = async () => ({
    channels: {
      fetch: async () => channels,
      create: async (payload) => {
        createPayload = payload;
        return { id: "e2e-channel" };
      }
    }
  });
  (provider as unknown as {
    fetchExistingChannelOrNull: () => Promise<typeof existingLiveChannel>;
  }).fetchExistingChannelOrNull = async () => existingLiveChannel;

  const result = await provider.ensureConversationChannel(
    "thr_main",
    "Main",
    "e2e-category",
    "live-channel",
    {
      isolateProjectCategory: true,
      projectScope: "e2e-run"
    }
  );

  assert.deepEqual(result, { id: "e2e-channel", created: true });
  assert.equal(editCalls, 0);
  assert.equal(setTopicCalls, 0);
  assert.equal(createPayload?.["parent"], "e2e-category");
  assert.equal(createPayload?.["topic"], "[codex-bridge] thread:thr_main scope:e2e-run");
});

test("conversation metadata sync preserves the current task status light", async () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );
  const edits: Array<Record<string, unknown>> = [];
  const channel = {
    id: "channel-status-light",
    name: "🔴-旧标题",
    parentId: "category-1",
    topic: "[codex-bridge] thread:thr_status_light",
    edit: async (input: Record<string, unknown>) => {
      edits.push(input);
    },
    setTopic: async () => undefined
  };

  await (provider as unknown as {
    syncConversationChannel: (
      channel: Record<string, unknown>,
      desiredName: string,
      categoryId: string,
      topic: string,
      codexThreadId: string
    ) => Promise<void>;
  }).syncConversationChannel(
    channel,
    "新的标题",
    "category-1",
    "[codex-bridge] thread:thr_status_light",
    "thr_status_light"
  );

  assert.equal(edits[0]?.["name"], "🔴-新的标题");
});

test("conversation status updates rename an existing Discord text channel", async () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );
  const renamedTo: string[] = [];
  const channel = {
    id: "channel-status-rename",
    type: ChannelType.GuildText,
    name: "清理执行",
    setName: async (name: string) => {
      renamedTo.push(name);
      channel.name = name;
    }
  };
  (provider as unknown as {
    fetchExistingChannelOrNull: () => Promise<Record<string, unknown>>;
  }).fetchExistingChannelOrNull = async () => channel;

  const renamed = await provider.updateConversationChannelName(
    "channel-status-rename",
    "🟡-清理执行"
  );
  const unchanged = await provider.updateConversationChannelName(
    "channel-status-rename",
    "🟡-清理执行"
  );

  assert.equal(renamed, true);
  assert.equal(unchanged, true);
  assert.deepEqual(renamedTo, ["🟡-清理执行"]);
});

test("inspectBridgeManagedLocations includes bridge-owned child threads with ids", async () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );

  Object.defineProperty((provider as unknown as { client: { user?: { id: string } } }).client, "user", {
    value: { id: "bridge-bot" },
    configurable: true
  });

  const channelMessages = new Collection<string, unknown>([
    [
      "status",
      {
        createdTimestamp: 1_710_000_000_000,
        editedTimestamp: null,
        content: "Thread: `019parent`"
      }
    ]
  ]);
  const threadMessages = new Collection<string, unknown>([
    [
      "child-message",
      {
        createdTimestamp: 1_710_000_100_000,
        editedTimestamp: null,
        content: "Worker update"
      }
    ]
  ]);

  const activeThread = {
    id: "child-active",
    name: "Turing",
    parentId: "managed-channel",
    ownerId: "bridge-bot",
    archived: false,
    locked: false,
    messages: {
      fetch: async () => threadMessages
    }
  };
  const archivedThread = {
    id: "child-archived",
    name: "Lagrange",
    parentId: "managed-channel",
    ownerId: "bridge-bot",
    archived: true,
    locked: false,
    messages: {
      fetch: async () => threadMessages
    }
  };
  const managedChannel = {
    id: "managed-channel",
    type: ChannelType.GuildText,
    name: "test-bot",
    parentId: "seed-category",
    topic: "[codex-bridge] thread:019parent",
    messages: {
      fetch: async () => channelMessages
    },
    threads: {
      fetchActive: async () => ({
        threads: new Collection<string, unknown>([["child-active", activeThread]])
      }),
      fetchArchived: async () => ({
        threads: new Collection<string, unknown>([["child-archived", archivedThread]]),
        hasMore: false
      })
    }
  };

  const channels = new Collection<string, unknown>([
    ["seed-category", { id: "seed-category", name: "codex-mobile", type: ChannelType.GuildCategory }],
    ["managed-channel", managedChannel]
  ]);

  (provider as unknown as {
    getGuild: () => Promise<{ id: string; name: string; channels: { fetch: () => Promise<Collection<string, unknown>> } }>;
    isBridgeManagedConversationChannel: (channel: { id: string }) => boolean;
  }).getGuild = async () => ({
    id: "guild",
    name: "Guild",
    channels: {
      fetch: async () => channels
    }
  });
  (provider as unknown as {
    isBridgeManagedConversationChannel: (channel: { id: string }) => boolean;
  }).isBridgeManagedConversationChannel = (channel) => channel.id === "managed-channel";

  const snapshot = await provider.inspectBridgeManagedLocations(10);

  assert.equal(snapshot.channels.length, 1);
  assert.equal(snapshot.channels[0]?.channelId, "managed-channel");
  assert.equal(snapshot.threads.length, 2);
  assert.deepEqual(
    snapshot.threads.map((thread) => thread.threadId).sort(),
    ["child-active", "child-archived"]
  );
  assert.equal(snapshot.threads.find((thread) => thread.threadId === "child-active")?.parentChannelId, "managed-channel");
  assert.equal(snapshot.threads.find((thread) => thread.threadId === "child-archived")?.archived, true);
  assert.equal(snapshot.threads.find((thread) => thread.threadId === "child-active")?.lastMessagePreview, "Worker update");
});

test("inspectChannelMessages includes references, embeds, and components", async () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );

  const messages = new Collection<string, unknown>([
    [
      "message-1",
      {
        id: "message-1",
        createdTimestamp: 1_710_000_000_000,
        editedTimestamp: 1_710_000_060_000,
        author: { id: "bot", username: "Codex" },
        content: "Approval card content",
        pinned: true,
        type: MessageType.ThreadStarterMessage,
        flags: {
          toArray: () => ["SuppressEmbeds"]
        },
        reference: {
          messageId: "starter",
          channelId: "parent-channel",
          guildId: "guild",
          type: 0
        },
        embeds: [
          {
            toJSON: () => ({
              title: "Approval",
              description: "Review this request",
              author: { name: "Codex Mobile Bridge" },
              footer: { text: "Footer" },
              fields: [{ name: "A", value: "B" }]
            })
          }
        ],
        components: [
          {
            type: 1,
            components: [
              {
                toJSON: () => ({
                  type: 2,
                  style: 1,
                  custom_id: "approve-once",
                  label: "Approve once",
                  disabled: false
                })
              }
            ]
          }
        ]
      }
    ]
  ]);

  (provider as unknown as {
    fetchTargetChannel: () => Promise<{ messages: { fetch: () => Promise<Collection<string, unknown>> } }>;
  }).fetchTargetChannel = async () => ({
    messages: {
      fetch: async () => messages
    }
  });

  const snapshot = await provider.inspectChannelMessages("message-channel", 10);

  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0]?.messageId, "message-1");
  assert.equal(snapshot[0]?.type, "ThreadStarterMessage");
  assert.deepEqual(snapshot[0]?.flags, ["SuppressEmbeds"]);
  assert.deepEqual(snapshot[0]?.reference, {
    messageId: "starter",
    channelId: "parent-channel",
    guildId: "guild",
    type: 0
  });
  assert.equal(snapshot[0]?.embeds[0]?.title, "Approval");
  assert.equal(snapshot[0]?.embeds[0]?.fieldCount, 1);
  assert.equal(snapshot[0]?.components[0]?.type, "ActionRow");
  assert.equal(snapshot[0]?.components[0]?.components[0]?.customId, "approve-once");
  assert.equal(snapshot[0]?.components[0]?.components[0]?.label, "Approve once");
});

test("deleteParentThreadNotificationMessages paginates until it finds and deletes the matching starter notice", async () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );

  const deletedMessageIds: string[] = [];
  const fetchArgs: Array<Record<string, unknown>> = [];
  const firstPage = new Collection<string, unknown>([
    [
      "msg-1",
      {
        id: "msg-1",
        hasThread: true,
        thread: { id: "other-thread" }
      }
    ]
  ]);
  const secondPage = new Collection<string, unknown>([
    [
      "msg-2",
      {
        id: "msg-2",
        hasThread: true,
        thread: { id: "child-thread" },
        delete: async () => {
          deletedMessageIds.push("msg-2");
        }
      }
    ]
  ]);

  const parentChannel = {
    id: "parent-channel",
    type: ChannelType.GuildText,
    messages: {
      fetch: async (options: Record<string, unknown>) => {
        fetchArgs.push(options);
        return fetchArgs.length === 1 ? firstPage : secondPage;
      }
    }
  };

  await (provider as unknown as {
    deleteParentThreadNotificationMessages: (thread: {
      id: string;
      parentId: string;
      parent: typeof parentChannel;
    }) => Promise<void>;
  }).deleteParentThreadNotificationMessages({
    id: "child-thread",
    parentId: "parent-channel",
    parent: parentChannel
  });

  assert.deepEqual(fetchArgs, [{ limit: 100 }, { limit: 100, before: "msg-1" }]);
  assert.deepEqual(deletedMessageIds, ["msg-2"]);
});

test("ensureSubagentThread reuses archived child threads by reopening and renaming them", async () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );

  const operations: Array<[string, string | boolean, string]> = [];
  const existingThread = {
    id: "discord-child",
    archived: true,
    locked: false,
    name: "old-thread-name",
    isThread: () => true,
    setArchived: async (archived: boolean, reason: string) => {
      operations.push(["archived", archived, reason]);
    },
    setName: async (name: string, reason: string) => {
      operations.push(["name", name, reason]);
    }
  };

  (provider as unknown as {
    fetchTextChannel: () => Promise<{ threads: { create: () => Promise<never> } }>;
    fetchExistingChannelOrNull: () => Promise<typeof existingThread>;
  }).fetchTextChannel = async () => ({
    threads: {
      create: async () => {
        throw new Error("should not create a new thread");
      }
    }
  });
  (provider as unknown as {
    fetchExistingChannelOrNull: () => Promise<typeof existingThread>;
  }).fetchExistingChannelOrNull = async () => existingThread;

  const result = await provider.ensureSubagentThread(
    "019da4b7-60e4-7e11-aa4f-49a433595c1b",
    "New worker title",
    "parent-channel",
    "discord-child"
  );

  assert.deepEqual(result, { id: "discord-child", created: false });
  assert.deepEqual(operations, [
    ["archived", false, "Resume Codex bridge updates"],
    ["name", "New worker title", "Sync Codex sub-agent thread"]
  ]);
});

test("findExistingStatusCard prefers a matching pinned card before scanning recent messages", async () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );

  Object.defineProperty((provider as unknown as { client: { user?: { id: string } } }).client, "user", {
    value: { id: "bridge-bot" },
    configurable: true
  });

  let recentFetchCalled = false;
  const pinnedStatusCard = {
    id: "pinned-status",
    author: { id: "bridge-bot" },
    content: "Thread: `019abcde`\nProject: repo\nLast activity: moments ago",
    createdTimestamp: 20
  };

  const result = await (provider as unknown as {
    findExistingStatusCard: (
      target: {
        id: string;
        messages: {
          fetch: (arg: string | { limit: number }) => Promise<unknown>;
          fetchPins: () => Promise<{ items: Array<{ message: typeof pinnedStatusCard }> }>;
        };
      },
      view: { shortThreadId: string },
      preferredMessageId: string | null
    ) => Promise<{ id: string } | null>;
  }).findExistingStatusCard(
    {
      id: "target-channel",
      messages: {
        fetch: async (arg: string | { limit: number }) => {
          if (typeof arg === "string") {
            throw { code: 10008 };
          }
          recentFetchCalled = true;
          return new Collection();
        },
        fetchPins: async () => ({
          items: [{ message: pinnedStatusCard }]
        })
      }
    },
    {
      shortThreadId: "019abcde"
    },
    "missing-status-card"
  );

  assert.equal(result?.id, "pinned-status");
  assert.equal(recentFetchCalled, false);
});

test("inspection mode starts without subscribing to Discord interactions", async () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );

  const events: string[] = [];
  let loginCalls = 0;
  let registerCalls = 0;
  const client = (provider as unknown as {
    client: {
      on: (event: string, listener: unknown) => unknown;
      off: (event: string, listener: unknown) => unknown;
      login: (token: string) => Promise<void>;
    };
  }).client;

  client.on = ((event: string) => {
    events.push(event);
    return client;
  }) as typeof client.on;
  client.off = (() => client) as typeof client.off;
  client.login = (async () => {
    loginCalls += 1;
  }) as typeof client.login;
  (provider as unknown as { registerCommands: () => Promise<void> }).registerCommands = async () => {
    registerCalls += 1;
  };

  await provider.start(createNoopHandlers(), {
    registerCommands: false,
    listenForInteractions: false
  });

  assert.equal(loginCalls, 1);
  assert.equal(registerCalls, 0);
  assert.deepEqual(events, []);
});

test("provider start subscribes to Discord interactions by default", async () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );

  const events: string[] = [];
  const client = (provider as unknown as {
    client: {
      on: (event: string, listener: unknown) => unknown;
      off: (event: string, listener: unknown) => unknown;
      login: (token: string) => Promise<void>;
    };
  }).client;

  client.on = ((event: string) => {
    events.push(event);
    return client;
  }) as typeof client.on;
  client.off = (() => client) as typeof client.off;
  client.login = (async () => undefined) as typeof client.login;
  (provider as unknown as { registerCommands: () => Promise<void> }).registerCommands = async () => undefined;

  await provider.start(createNoopHandlers(), { registerCommands: false });

  assert.deepEqual(events, ["interactionCreate"]);
});

test("command result components render string selects and buttons in valid action rows", () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );

  const rows = (provider as unknown as {
    buildCommandResultComponents: (
      buttons: Array<{ customId: string; label: string }>,
      selectMenus: Array<{
        customId: string;
        placeholder: string;
        minValues: number;
        maxValues: number;
        options: Array<{ label: string; value: string; default?: boolean }>;
      }>
    ) => Array<{ toJSON(): { components: Array<{ type: number; custom_id?: string }> } }>;
  }).buildCommandResultComponents(
    Array.from({ length: 6 }, (_, index) => ({
      customId: `codex:monitor:page:${index}`,
      label: `Button ${index + 1}`
    })),
    [
      {
        customId: "codex:monitor:projects:0",
        placeholder: "选择项目",
        minValues: 0,
        maxValues: 2,
        options: [
          { label: "sample-dashboard", value: "sample", default: true },
          { label: "example-mobile", value: "mobile" }
        ]
      }
    ]
  );

  const rendered = rows.map((row) => row.toJSON());
  assert.equal(rendered.length, 3);
  assert.equal(rendered[0]?.components.length, 1);
  assert.equal(rendered[0]?.components[0]?.type, ComponentType.StringSelect);
  assert.equal(rendered[0]?.components[0]?.custom_id, "codex:monitor:projects:0");
  assert.deepEqual(rendered.slice(1).map((row) => row.components.length), [5, 1]);
  assert.ok(rendered.every((row) => row.components.length <= 5));
});

test("monitor buttons dispatch to the monitor handler with an ephemeral result", async () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );

  let receivedCustomId = "";
  let deferredFlags: unknown = null;
  let editPayload: Record<string, unknown> | null = null;
  (provider as unknown as { handlers: unknown }).handlers = {
    ...createNoopHandlers(),
    onMonitorButton: async (_actor: unknown, customId: string) => {
      receivedCustomId = customId;
      return {
        content: "选择项目",
        ephemeral: false as const,
        selectMenus: [
          {
            customId: "codex:monitor:projects:0",
            placeholder: "选择项目",
            minValues: 0,
            maxValues: 1,
            options: [{ label: "sample-dashboard", value: "sample" }]
          }
        ]
      };
    }
  };

  const interaction = {
    customId: "codex:monitor:projects:0",
    user: { id: "controller", username: "tester" },
    member: null,
    isButton: () => true,
    deferReply: async (options: { flags: unknown }) => {
      deferredFlags = options.flags;
    },
    editReply: async (payload: Record<string, unknown>) => {
      editPayload = payload;
    }
  };

  await (provider as unknown as { handleButton: (interaction: unknown) => Promise<void> }).handleButton(interaction);

  assert.equal(receivedCustomId, "codex:monitor:projects:0");
  assert.equal(deferredFlags, MessageFlags.Ephemeral);
  assert.equal((editPayload as { content?: string } | null)?.content, "选择项目");
  assert.equal(((editPayload as { components?: unknown[] } | null)?.components ?? []).length, 1);
});

test("monitor string selects dispatch selected values with an ephemeral result", async () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );

  let received: { customId: string; values: string[] } | null = null;
  let deferredFlags: unknown = null;
  let editedContent = "";
  (provider as unknown as { handlers: unknown }).handlers = {
    ...createNoopHandlers(),
    onMonitorSelect: async (_actor: unknown, customId: string, values: string[]) => {
      received = { customId, values };
      return { content: "项目选择已保存", ephemeral: false as const };
    }
  };

  const interaction = {
    customId: "codex:monitor:projects:0",
    values: ["poly", "mobile"],
    user: { id: "controller", username: "tester" },
    member: null,
    isChatInputCommand: () => false,
    isButton: () => false,
    isStringSelectMenu: () => true,
    isModalSubmit: () => false,
    deferReply: async (options: { flags: unknown }) => {
      deferredFlags = options.flags;
    },
    editReply: async (payload: { content: string }) => {
      editedContent = payload.content;
    }
  };

  await (provider as unknown as { handleInteraction: (interaction: unknown) => Promise<void> }).handleInteraction(
    interaction
  );

  assert.deepEqual(received, {
    customId: "codex:monitor:projects:0",
    values: ["poly", "mobile"]
  });
  assert.equal(deferredFlags, MessageFlags.Ephemeral);
  assert.equal(editedContent, "项目选择已保存");
});

test("manage slash command dispatches the private monitor panel handler", async () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );

  let manageCalls = 0;
  let deferredFlags: unknown = null;
  let editedContent = "";
  (provider as unknown as { handlers: unknown }).handlers = {
    ...createNoopHandlers(),
    onManageCommand: async () => {
      manageCalls += 1;
      return { content: "监控管理面板已就绪", ephemeral: true as const };
    }
  };

  const interaction = {
    commandName: "codex",
    channelId: "discord_channel",
    user: { id: "controller", username: "tester" },
    member: null,
    options: {
      getSubcommand: () => "manage",
      getString: () => null
    },
    deferReply: async (options: { flags: unknown }) => {
      deferredFlags = options.flags;
    },
    editReply: async (payload: { content: string }) => {
      editedContent = payload.content;
    },
    reply: async () => {
      throw new Error("manage should use a deferred ephemeral reply");
    }
  };

  await (provider as unknown as { handleChatCommand: (interaction: unknown) => Promise<void> }).handleChatCommand(
    interaction
  );

  assert.equal(manageCalls, 1);
  assert.equal(deferredFlags, MessageFlags.Ephemeral);
  assert.equal(editedContent, "监控管理面板已就绪");
});

test("model slash command opens the channel model menu ephemerally", async () => {
  const provider = new DiscordProvider(
    { token: "token", applicationId: "application", guildId: "guild" },
    createLogger("silent")
  );
  let receivedChannelId = "";
  let edited: Record<string, unknown> | null = null;
  (provider as unknown as { handlers: unknown }).handlers = {
    ...createNoopHandlers(),
    onModelCommand: async (_actor: unknown, channelId: string) => {
      receivedChannelId = channelId;
      return {
        content: "选择模型",
        ephemeral: true as const,
        selectMenus: [
          {
            customId: "codex:model:select",
            placeholder: "选择下一轮模型",
            minValues: 1,
            maxValues: 1,
            options: [{ label: "GPT-5.6 Sol", value: "gpt-5.6-sol" }]
          }
        ]
      };
    }
  };
  const interaction = {
    commandName: "codex",
    channelId: "discord_model_channel",
    user: { id: "controller", username: "tester" },
    member: null,
    options: { getSubcommand: () => "model", getString: () => null },
    deferReply: async () => undefined,
    editReply: async (payload: Record<string, unknown>) => {
      edited = payload;
    }
  };

  await (provider as unknown as { handleChatCommand: (value: unknown) => Promise<void> }).handleChatCommand(
    interaction
  );

  assert.equal(receivedChannelId, "discord_model_channel");
  assert.equal((edited as { content?: string } | null)?.content, "选择模型");
  assert.equal(((edited as { components?: unknown[] } | null)?.components ?? []).length, 1);
});

test("model select dispatches the chosen model for the current channel", async () => {
  const provider = new DiscordProvider(
    { token: "token", applicationId: "application", guildId: "guild" },
    createLogger("silent")
  );
  let received: Record<string, unknown> | null = null;
  let editedContent = "";
  (provider as unknown as { handlers: unknown }).handlers = {
    ...createNoopHandlers(),
    onModelSelect: async (actor: unknown, channelId: string, model: string) => {
      received = { actor, channelId, model };
      return { content: "已设置模型", ephemeral: true as const };
    }
  };
  const interaction = {
    customId: "codex:model:select",
    channelId: "discord_model_channel",
    values: ["gpt-5.6-terra"],
    user: { id: "controller", username: "tester" },
    member: null,
    isChatInputCommand: () => false,
    isButton: () => false,
    isStringSelectMenu: () => true,
    isModalSubmit: () => false,
    deferReply: async () => undefined,
    editReply: async (payload: { content: string }) => {
      editedContent = payload.content;
    }
  };

  await (provider as unknown as { handleInteraction: (value: unknown) => Promise<void> }).handleInteraction(
    interaction
  );

  assert.equal((received as { channelId?: string } | null)?.channelId, "discord_model_channel");
  assert.equal((received as { model?: string } | null)?.model, "gpt-5.6-terra");
  assert.equal(editedContent, "已设置模型");
});

test("monitor control panel creates a private channel and pins the coordinator view", async () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );

  const createdOptions: Array<Record<string, unknown>> = [];
  let sentPayload: Record<string, unknown> | null = null;
  let pinCalls = 0;
  const panelMessage = {
    id: "panel-message",
    author: { id: "bot-user" },
    edit: async () => panelMessage,
    pin: async () => {
      pinCalls += 1;
    }
  };
  const panelChannel = {
    id: "monitor-channel",
    type: ChannelType.GuildText,
    name: "监控管理",
    messages: {
      fetch: async () => {
        throw { code: 10008 };
      }
    },
    send: async (payload: Record<string, unknown>) => {
      sentPayload = payload;
      return panelMessage;
    },
    edit: async () => panelChannel
  };
  const guild = {
    roles: { everyone: { id: "everyone" } },
    channels: {
      fetch: async () => new Collection<string, unknown>(),
      create: async (options: Record<string, unknown>) => {
        createdOptions.push(options);
        return panelChannel;
      }
    }
  };
  (provider as unknown as { getGuild: () => Promise<unknown> }).getGuild = async () => guild;
  Object.defineProperty((provider as unknown as { client: object }).client, "user", {
    configurable: true,
    value: { id: "bot-user" }
  });

  const ensureMonitorControlPanel = (provider as unknown as {
    ensureMonitorControlPanel?: (input: {
      controllerUserId: string;
      existingChannelId: string | null;
      existingMessageId: string | null;
      view: {
        content: string;
        buttons: Array<{ customId: string; label: string }>;
      };
    }) => Promise<{ channelId: string; messageId: string }>;
  }).ensureMonitorControlPanel;
  assert.equal(typeof ensureMonitorControlPanel, "function");
  if (!ensureMonitorControlPanel) return;

  const result = await ensureMonitorControlPanel.call(provider, {
    controllerUserId: "controller",
    existingChannelId: null,
    existingMessageId: null,
    view: {
      content: "# Codex 监控管理\n只同步手动勾选的对话。",
      buttons: [{ customId: "codex:monitor:projects:0", label: "选择项目" }]
    }
  });

  assert.deepEqual(result, { channelId: "monitor-channel", messageId: "panel-message" });
  assert.equal(createdOptions.length, 1);
  assert.equal(createdOptions[0]?.name, "监控管理");
  assert.equal(createdOptions[0]?.type, ChannelType.GuildText);
  const overwrites = createdOptions[0]?.permissionOverwrites as Array<{
    id: string;
    type: OverwriteType;
    allow?: bigint[];
    deny?: bigint[];
  }>;
  assert.deepEqual(overwrites[0], {
    id: "everyone",
    type: OverwriteType.Role,
    deny: [PermissionFlagsBits.ViewChannel]
  });
  assert.deepEqual(overwrites[1], {
    id: "controller",
    type: OverwriteType.Member,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.SendMessages
    ]
  });
  assert.deepEqual(overwrites[2], {
    id: "bot-user",
    type: OverwriteType.Member,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ManageMessages
    ]
  });
  assert.equal((sentPayload as { content?: string } | null)?.content, "# Codex 监控管理\n只同步手动勾选的对话。");
  assert.equal(pinCalls, 1);
});

test("monitor control panel reuses its channel and rebuilds a missing panel message", async () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );

  let channelEditOptions: Record<string, unknown> | null = null;
  let sendCalls = 0;
  const replacementMessage = {
    id: "replacement-message",
    author: { id: "bot-user" },
    pin: async () => undefined
  };
  const panelChannel = {
    id: "monitor-channel",
    type: ChannelType.GuildText,
    name: "old-name",
    edit: async (options: Record<string, unknown>) => {
      channelEditOptions = options;
      return panelChannel;
    },
    messages: {
      fetch: async () => {
        throw { code: 10008 };
      }
    },
    send: async () => {
      sendCalls += 1;
      return replacementMessage;
    }
  };
  const guild = {
    roles: { everyone: { id: "everyone" } },
    channels: {
      fetch: async (channelId?: string) => {
        if (channelId === "monitor-channel") return panelChannel;
        return new Collection<string, unknown>([["monitor-channel", panelChannel]]);
      },
      create: async () => {
        throw new Error("existing channel should be reused");
      }
    }
  };
  (provider as unknown as { getGuild: () => Promise<unknown> }).getGuild = async () => guild;
  Object.defineProperty((provider as unknown as { client: object }).client, "user", {
    configurable: true,
    value: { id: "bot-user" }
  });

  const ensureMonitorControlPanel = (provider as unknown as {
    ensureMonitorControlPanel?: (input: {
      controllerUserId: string;
      existingChannelId: string | null;
      existingMessageId: string | null;
      view: { content: string };
    }) => Promise<{ channelId: string; messageId: string }>;
  }).ensureMonitorControlPanel;
  assert.equal(typeof ensureMonitorControlPanel, "function");
  if (!ensureMonitorControlPanel) return;

  const result = await ensureMonitorControlPanel.call(provider, {
    controllerUserId: "controller",
    existingChannelId: "monitor-channel",
    existingMessageId: "missing-message",
    view: { content: "更新后的中文面板" }
  });

  assert.deepEqual(result, { channelId: "monitor-channel", messageId: "replacement-message" });
  assert.equal((channelEditOptions as { name?: string } | null)?.name, "监控管理");
  assert.equal(
    (channelEditOptions as { permissionOverwrites?: unknown } | null)?.permissionOverwrites,
    undefined
  );
  assert.equal(sendCalls, 1);
});

test("send slash command dispatches inferred channel, text, and mode", async () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );

  let received: Record<string, unknown> | null = null;
  let editPayload: Record<string, unknown> | null = null;
  (provider as unknown as { handlers: unknown }).handlers = {
    ...createNoopHandlers(),
    onSendCommand: async (actor: unknown, channelId: string, text: string, mode: string) => {
      received = { actor, channelId, text, mode };
      return {
        content: "queued",
        ephemeral: true as const,
        buttons: [
          {
            customId: "codex:writeback:retract:1",
            label: "Retract",
            style: "danger" as const
          }
        ]
      };
    }
  };

  const interaction = {
    commandName: "codex",
    channelId: "discord_channel",
    user: { id: "user_1", username: "tester" },
    member: null,
    options: {
      getSubcommand: () => "send",
      getString: (name: string) =>
        name === "text" ? "Message from Discord" : name === "mode" ? "steer" : null
    },
    deferReply: async () => undefined,
    editReply: async (payload: Record<string, unknown>) => {
      editPayload = payload;
    }
  };

  await (provider as unknown as { handleChatCommand: (interaction: unknown) => Promise<void> }).handleChatCommand(
    interaction
  );

  const receivedRecord = received as unknown as Record<string, unknown>;
  const editRecord = editPayload as unknown as Record<string, unknown>;
  assert.equal(receivedRecord.channelId, "discord_channel");
  assert.equal(receivedRecord.text, "Message from Discord");
  assert.equal(receivedRecord.mode, "steer");
  assert.ok(Array.isArray(editRecord.components));
});

test("plain controller messages dispatch channel, message id, and text", async () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild",
      allowPlainMessages: true
    },
    createLogger("silent")
  );
  let received: Record<string, unknown> | null = null;
  let replyPayload: Record<string, unknown> | null = null;
  (provider as unknown as { handlers: unknown }).handlers = {
    ...createNoopHandlers(),
    onPlainMessage: async (
      actor: unknown,
      channelId: string,
      messageId: string,
      text: string,
      attachments: unknown[]
    ) => {
      received = { actor, channelId, messageId, text, attachments };
      return { content: "queued", ephemeral: false as const };
    }
  };

  await (provider as unknown as { handlePlainMessage: (message: unknown) => Promise<void> }).handlePlainMessage({
    id: "message_1",
    channelId: "channel_1",
    guildId: "guild",
    content: "  Continue from Discord  ",
    channel: { parentId: "category_1", name: "conversation" },
    attachments: new Collection([
      [
        "attachment_1",
        {
          url: "https://cdn.discordapp.com/attachments/channel/image.png",
          name: "image.png",
          contentType: "image/png",
          size: 1234
        }
      ]
    ]),
    webhookId: null,
    author: { id: "user_1", username: "controller", bot: false },
    member: { roles: { cache: new Map([["role_1", true]]) } },
    reply: async (payload: Record<string, unknown>) => {
      replyPayload = payload;
    }
  });

  const record = received as unknown as Record<string, unknown>;
  assert.equal(record.channelId, "channel_1");
  assert.equal(record.messageId, "message_1");
  assert.equal(record.text, "Continue from Discord");
  assert.deepEqual(record.attachments, [
    {
      url: "https://cdn.discordapp.com/attachments/channel/image.png",
      name: "image.png",
      contentType: "image/png",
      size: 1234
    }
  ]);
  assert.equal((record.actor as { userId: string }).userId, "user_1");
  assert.equal((replyPayload as unknown as { content: string }).content, "queued");
});

test("plain message listener ignores bot, webhook, DM, and empty messages", async () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild",
      allowPlainMessages: true
    },
    createLogger("silent")
  );
  let calls = 0;
  (provider as unknown as { handlers: unknown }).handlers = {
    ...createNoopHandlers(),
    onPlainMessage: async () => {
      calls += 1;
      return null;
    }
  };
  const handle = (message: Record<string, unknown>) =>
    (provider as unknown as { handlePlainMessage: (value: unknown) => Promise<void> }).handlePlainMessage({
      id: "message",
      channelId: "channel",
      guildId: "guild",
      content: "hello",
      webhookId: null,
      author: { id: "user", username: "user", bot: false },
      member: null,
      reply: async () => undefined,
      ...message
    });

  await handle({ author: { id: "bot", username: "bot", bot: true } });
  await handle({ webhookId: "webhook" });
  await handle({ guildId: null });
  await handle({ content: "   " });
  assert.equal(calls, 0);
});

test("write-back buttons dispatch queue item actions", async () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );

  let received: Record<string, unknown> | null = null;
  let editedContent = "";
  (provider as unknown as { handlers: unknown }).handlers = {
    ...createNoopHandlers(),
    onWriteBackButton: async (actor: unknown, action: string, queueItemId: number) => {
      received = { actor, action, queueItemId };
      return { content: "retracted", ephemeral: true as const };
    }
  };

  const interaction = {
    customId: "codex:writeback:retract:42",
    user: { id: "user_1", username: "tester" },
    member: null,
    isButton: () => true,
    deferUpdate: async () => undefined,
    editReply: async (payload: { content: string }) => {
      editedContent = payload.content;
    }
  };

  await (provider as unknown as { handleButton: (interaction: unknown) => Promise<void> }).handleButton(interaction);

  const receivedRecord = received as unknown as Record<string, unknown>;
  assert.equal(receivedRecord.action, "retract");
  assert.equal(receivedRecord.queueItemId, 42);
  assert.equal(editedContent, "retracted");
});

test("proposed plan accept button dispatches plan action", async () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );

  let received: Record<string, unknown> | null = null;
  let editedContent = "";
  (provider as unknown as { handlers: unknown }).handlers = {
    ...createNoopHandlers(),
    onProposedPlanAction: async (actor: unknown, token: string, action: string) => {
      received = { actor, token, action };
      return { content: "accepted", ephemeral: true as const };
    }
  };

  const interaction = {
    customId: "codex:plan:plan_token:accept",
    user: { id: "user_1", username: "tester" },
    member: null,
    isButton: () => true,
    deferReply: async () => undefined,
    editReply: async (payload: { content: string }) => {
      editedContent = payload.content;
    }
  };

  await (provider as unknown as { handleButton: (interaction: unknown) => Promise<void> }).handleButton(interaction);

  const receivedRecord = received as unknown as Record<string, unknown>;
  assert.equal(receivedRecord.token, "plan_token");
  assert.equal(receivedRecord.action, "accept");
  assert.equal(editedContent, "accepted");
});

test("proposed plan feedback button opens a feedback modal", async () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );
  (provider as unknown as { handlers: unknown }).handlers = createNoopHandlers();

  let modal: { custom_id?: string; title?: string } | null = null;
  const interaction = {
    customId: "codex:plan:plan_token:feedback",
    user: { id: "user_1", username: "tester" },
    member: null,
    isButton: () => true,
    showModal: async (value: { toJSON(): { custom_id?: string; title?: string } }) => {
      modal = value.toJSON();
    }
  };

  await (provider as unknown as { handleButton: (interaction: unknown) => Promise<void> }).handleButton(interaction);

  const modalRecord = modal as unknown as Record<string, unknown>;
  assert.equal(modalRecord.custom_id, "codex:plan-feedback-submit:plan_token");
  assert.equal(modalRecord.title, "Tell Codex what to do differently");
});

test("proposed plan feedback modal dispatches typed feedback", async () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );

  let received: Record<string, unknown> | null = null;
  let editedContent = "";
  (provider as unknown as { handlers: unknown }).handlers = {
    ...createNoopHandlers(),
    onProposedPlanFeedback: async (actor: unknown, token: string, feedback: string) => {
      received = { actor, token, feedback };
      return { content: "feedback sent", ephemeral: true as const };
    }
  };

  const interaction = {
    customId: "codex:plan-feedback-submit:plan_token",
    user: { id: "user_1", username: "tester" },
    member: null,
    isModalSubmit: () => true,
    fields: {
      getTextInputValue: () => "Make the plan smaller."
    },
    deferReply: async () => undefined,
    editReply: async (payload: { content: string }) => {
      editedContent = payload.content;
    }
  };

  await (provider as unknown as { handleModalSubmit: (interaction: unknown) => Promise<void> }).handleModalSubmit(
    interaction
  );

  const receivedRecord = received as unknown as Record<string, unknown>;
  assert.equal(receivedRecord.token, "plan_token");
  assert.equal(receivedRecord.feedback, "Make the plan smaller.");
  assert.equal(editedContent, "feedback sent");
});

test("interaction state errors do not trigger a second error response", async () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );

  let respondCalls = 0;
  (provider as unknown as { handleButton: (interaction: unknown) => Promise<void> }).handleButton = async () => {
    throw { code: 10062, message: "Unknown interaction" };
  };
  (provider as unknown as { respondToInteractionError: (interaction: unknown, message: string) => Promise<void> }).respondToInteractionError =
    async () => {
      respondCalls += 1;
    };

  const interaction = {
    isChatInputCommand: () => false,
    isButton: () => true,
    isModalSubmit: () => false
  };

  await assert.doesNotReject(async () => {
    await (provider as unknown as { handleInteraction: (interaction: unknown) => Promise<void> }).handleInteraction(
      interaction
    );
  });
  assert.equal(respondCalls, 0);
});

test("already acknowledged Discord interaction errors do not crash the provider", async () => {
  const provider = new DiscordProvider(
    {
      token: "token",
      applicationId: "application",
      guildId: "guild"
    },
    createLogger("silent")
  );

  let replyCalls = 0;
  (provider as unknown as { handleButton: (interaction: unknown) => Promise<void> }).handleButton = async () => {
    throw new Error("boom");
  };

  const interaction = {
    isChatInputCommand: () => false,
    isButton: () => true,
    isModalSubmit: () => false,
    deferred: false,
    replied: false,
    reply: async () => {
      replyCalls += 1;
      throw { code: 40060, message: "Interaction has already been acknowledged." };
    }
  };

  await assert.doesNotReject(async () => {
    await (provider as unknown as { handleInteraction: (interaction: unknown) => Promise<void> }).handleInteraction(
      interaction
    );
  });
  assert.equal(replyCalls, 1);
});

function createNoopHandlers() {
  return {
    onStatusCommand: async () => ({ content: "", ephemeral: true as const }),
    onSendCommand: async () => ({ content: "", ephemeral: true as const }),
    onPlainMessage: async () => null,
    onModelCommand: async () => ({ content: "", ephemeral: true as const }),
    onModelSelect: async () => ({ content: "", ephemeral: true as const }),
    onRetractCommand: async () => ({ content: "", ephemeral: true as const }),
    onWriteBackButton: async () => ({ content: "", ephemeral: true as const }),
    onAttachCommand: async () => ({ content: "", ephemeral: true as const }),
    onDetachCommand: async () => ({ content: "", ephemeral: true as const }),
    onCleanIdCommand: async () => ({ content: "", ephemeral: true as const }),
    onCleanAllCommand: async () => ({ content: "", ephemeral: true as const }),
    onHelpCommand: async () => ({ content: "", ephemeral: true as const }),
    onApprovalDetails: async () => ({ content: "", ephemeral: true as const }),
    onApprovalAction: async () => ({ content: "", ephemeral: true as const }),
    onToolInputOption: async () => ({ content: "", ephemeral: true as const }),
    onToolInputOther: async () => ({ content: "", ephemeral: true as const }),
    onApprovalFeedback: async () => ({ content: "", ephemeral: true as const }),
    onMessageDetails: async () => ({ content: "", ephemeral: true as const }),
    onProposedPlanAction: async () => ({ content: "", ephemeral: true as const }),
    onProposedPlanFeedback: async () => ({ content: "", ephemeral: true as const })
  };
}
