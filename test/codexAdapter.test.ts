import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexAdapter } from "../src/codex/CodexAdapter.js";

class FakeStream extends EventEmitter {}

class FakeChildProcess extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  stdin = {
    write: (_chunk: string) => true
  };
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function createLogger() {
  const warnings: Array<{ payload: unknown; message: string | undefined }> = [];
  return {
    warnings,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (payloadOrMessage: unknown, maybeMessage?: string) => {
        if (typeof payloadOrMessage === "string" && maybeMessage === undefined) {
          warnings.push({ payload: null, message: payloadOrMessage });
          return;
        }
        warnings.push({ payload: payloadOrMessage, message: maybeMessage });
      },
      error: () => undefined
    }
  };
}

test("CodexAdapter reads the model list dynamically from Codex", async () => {
  const { logger } = createLogger();
  const adapter = new CodexAdapter("codex", logger as never, process.cwd());
  (adapter as unknown as { request: (method: string) => Promise<unknown> }).request = async (method) => {
    assert.equal(method, "model/list");
    return {
      data: [
        {
          id: "gpt-5.6-sol",
          displayName: "GPT-5.6 Sol",
          supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
          defaultReasoningEffort: "low",
          isDefault: true
        },
        {
          model: "gpt-5.6-terra",
          display_name: "GPT-5.6 Terra",
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
          defaultReasoningEffort: "medium",
          isDefault: false
        },
        { id: "", displayName: "Ignored" }
      ]
    };
  };

  assert.deepEqual(await adapter.listModels(), [
    {
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      supportedReasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "low",
      isDefault: true
    },
    {
      id: "gpt-5.6-terra",
      displayName: "GPT-5.6 Terra",
      supportedReasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium",
      isDefault: false
    }
  ]);
});

test("CodexAdapter only adds a model to new turns when one is selected", async () => {
  const { logger } = createLogger();
  const adapter = new CodexAdapter("codex", logger as never, process.cwd());
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  (adapter as unknown as {
    request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  }).request = async (method, params) => {
    requests.push({ method, params });
    return {};
  };

  await adapter.startTurn("thread_model", "Use Terra.", {
    model: "gpt-5.6-terra",
    reasoningEffort: "medium"
  });
  await adapter.startTurn("thread_default", "Use default.");

  assert.equal(requests[0]?.params.model, "gpt-5.6-terra");
  assert.equal(requests[0]?.params.reasoningEffort, "medium");
  assert.equal("model" in (requests[1]?.params ?? {}), false);
});

test("CodexAdapter starts a thread with the selected model and reasoning effort", async () => {
  const { logger } = createLogger();
  const adapter = new CodexAdapter("codex", logger as never, process.cwd());
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  (adapter as unknown as {
    request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  }).request = async (method, params) => {
    requests.push({ method, params });
    return {
      thread: {
        id: "thread_new",
        name: null,
        preview: null,
        status: { type: "idle" }
      }
    };
  };

  const thread = await adapter.startThread({
    cwd: "E:\\Code\\codex手机端",
    model: "gpt-5.6-terra",
    reasoningEffort: "medium"
  });

  assert.equal(thread.id, "thread_new");
  assert.deepEqual(requests, [{
    method: "thread/start",
    params: {
      cwd: "E:\\Code\\codex手机端",
      model: "gpt-5.6-terra",
      reasoningEffort: "medium"
    }
  }]);
});

test("CodexAdapter exposes app-server subagent parent metadata", async () => {
  const { logger } = createLogger();
  const adapter = new CodexAdapter("codex", logger as never, process.cwd());
  (adapter as unknown as { request: () => Promise<unknown> }).request = async () => ({
    data: [{
      id: "child_thread",
      name: "Internal worker",
      source: {
        subAgent: {
          thread_spawn: {
            parent_thread_id: "parent_thread"
          },
          other: "worker"
        }
      },
      status: { type: "idle" }
    }]
  });

  const [thread] = await adapter.listThreads({ limit: 10, sortKey: "updated_at" });

  assert.equal(thread?.parentThreadId, "parent_thread");
  assert.equal(thread?.sourceSubagentOther, "worker");
});

test("CodexAdapter paginates the complete thread inventory in recency order", async () => {
  const { logger } = createLogger();
  const adapter = new CodexAdapter("codex", logger as never, process.cwd());
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  (adapter as unknown as {
    request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  }).request = async (method, params) => {
    requests.push({ method, params });
    if (!params.cursor) {
      return {
        data: [{ id: "thread_new", recencyAt: 22, status: { type: "idle" } }],
        nextCursor: "cursor_2"
      };
    }
    return {
      data: [{ id: "thread_old", recencyAt: 11, status: { type: "idle" } }],
      nextCursor: null
    };
  };

  const threads = await adapter.listAllThreads({
    sortKey: "recency_at",
    archived: false,
    pageSize: 1,
    maxItems: 10
  });

  assert.deepEqual(threads.map((thread) => [thread.id, thread.recencyAt]), [
    ["thread_new", 22],
    ["thread_old", 11]
  ]);
  assert.deepEqual(requests.map((request) => request.params), [
    { limit: 1, sortKey: "recency_at", archived: false },
    { limit: 1, sortKey: "recency_at", archived: false, cursor: "cursor_2" }
  ]);
});

test("CodexAdapter ignores websocket child exit when the transport stays connected", async () => {
  const child = new FakeChildProcess();
  const { logger, warnings } = createLogger();
  const adapter = new CodexAdapter("codex", logger as never, process.cwd(), "ws://127.0.0.1:8837");
  const exitedCodes: Array<number | null> = [];

  adapter.on("exited", (code) => {
    exitedCodes.push(code);
  });

  (adapter as any).spawnCodexProcess = () => child;
  (adapter as any).connectWebSocket = async () => {
    (adapter as any).websocket = {
      readyState: 1,
      send: () => undefined,
      close: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    };
  };
  (adapter as any).initialize = async () => undefined;
  (adapter as any).request = async (method: string) => {
    if (method === "account/read") {
      return { account: "ok" };
    }
    throw new Error(`Unexpected request: ${method}`);
  };

  await adapter.start();
  child.emit("exit", 1);

  assert.deepEqual(exitedCodes, []);
  assert.equal((adapter as any).childProcess, null);
  assert.match(
    warnings.map((entry) => entry.message ?? "").join("\n"),
    /websocket transport is still connected/i
  );

  await adapter.stop();
});

test("CodexAdapter metadata exposes guardian subagent source from session JSONL", async () => {
  const codexHome = mkdtempSync(path.join(tmpdir(), "codex-mobile-codex-adapter-"));
  const sessionsDir = path.join(codexHome, "sessions", "2026", "04", "25");
  mkdirSync(sessionsDir, { recursive: true });

  const threadId = "019dc305-f4d0-7dc3-a156-c1449a48a91e";
  writeFileSync(
    path.join(sessionsDir, `rollout-2026-04-25T07-04-00-${threadId}.jsonl`),
    `${JSON.stringify({
      timestamp: "2026-04-25T05:04:00.000Z",
      type: "session_meta",
      payload: {
        id: threadId,
        cwd: "C:\\Users\\Natale\\Desktop\\projects\\codex-mobile",
        originator: "Codex Desktop",
        source: {
          subagent: {
            other: "guardian"
          }
        }
      }
    })}\n`,
    "utf8"
  );

  const { logger } = createLogger();
  const adapter = new CodexAdapter("codex", logger as never, codexHome);
  const metadata = await adapter.resolveMetadata(threadId);

  assert.equal(metadata.sourceSubagentOther, "guardian");
});
