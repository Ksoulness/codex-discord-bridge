import { createReadStream } from "node:fs";
import { access, readdir } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import Database from "better-sqlite3";
import type { Logger } from "../logger.js";
import { findNewestStateDatabasePath, pathExists } from "./codexFsHelpers.js";

const SESSION_LOG_PATH_MISS_TTL_MS = 5_000;

export interface ResolveSessionLogPathOptions {
  allowFilesystemScan?: boolean;
  validateSessionMeta?: boolean;
}

export interface StateDatabaseThreadRecord {
  threadId: string;
  name: string | null;
  cwd: string | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  status: "active" | "idle";
}

export class CodexSessionLogLocator {
  private readonly pathCache = new Map<string, string | null>();
  private readonly pathMissExpiresByThread = new Map<string, number>();
  private rolloutPathDatabase: InstanceType<typeof Database> | null = null;
  private rolloutPathDatabaseFilePath: string | null = null;

  constructor(
    private readonly codexHome: string,
    private readonly logger?: Logger
  ) {}

  remember(threadId: string, filePath: string): void {
    this.pathCache.set(threadId, filePath);
    this.pathMissExpiresByThread.delete(threadId);
  }

  rememberMissing(threadId: string): void {
    this.pathCache.set(threadId, null);
    this.pathMissExpiresByThread.set(threadId, Date.now() + SESSION_LOG_PATH_MISS_TTL_MS);
  }

  forget(threadId: string): void {
    this.pathCache.delete(threadId);
    this.pathMissExpiresByThread.delete(threadId);
  }

  async resolve(
    threadId: string,
    options: ResolveSessionLogPathOptions = {}
  ): Promise<string | null> {
    const cached = this.pathCache.get(threadId);
    if (typeof cached === "string" && (await pathExists(cached))) {
      return cached;
    }
    const missExpiresAt = this.pathMissExpiresByThread.get(threadId) ?? 0;
    if (cached === null && missExpiresAt > Date.now()) {
      return null;
    }

    const fromStateDatabase = this.resolveFromStateDatabase(threadId);
    if (fromStateDatabase && (await pathExists(fromStateDatabase))) {
      this.remember(threadId, fromStateDatabase);
      return fromStateDatabase;
    }

    if (options.allowFilesystemScan === false) {
      this.rememberMissing(threadId);
      return null;
    }

    const fromFilesystem = await this.searchSessionFile(threadId, Boolean(options.validateSessionMeta));
    this.pathCache.set(threadId, fromFilesystem);
    if (fromFilesystem) {
      this.pathMissExpiresByThread.delete(threadId);
    } else {
      this.pathMissExpiresByThread.set(threadId, Date.now() + SESSION_LOG_PATH_MISS_TTL_MS);
    }
    return fromFilesystem;
  }

  async listStateDatabaseRolloutPaths(maxPaths: number): Promise<string[]> {
    const database = this.getRolloutPathDatabase();
    if (!database) {
      return [];
    }

    try {
      const rows = database
        .prepare(
          "SELECT rollout_path FROM threads WHERE rollout_path IS NOT NULL AND trim(rollout_path) != '' ORDER BY rowid DESC LIMIT ?"
        )
        .all(Math.max(1, maxPaths)) as Array<{ rollout_path?: unknown }>;
      const paths = new Set<string>();
      for (const row of rows) {
        if (typeof row.rollout_path !== "string" || !row.rollout_path.trim()) {
          continue;
        }
        const rolloutPath = path.isAbsolute(row.rollout_path)
          ? row.rollout_path
          : path.resolve(this.codexHome, row.rollout_path);
        paths.add(rolloutPath);
      }
      return [...paths];
    } catch (error) {
      this.logger?.debug({ error }, "Failed to list rollout paths from Codex state database.");
      return [];
    }
  }

  listStateDatabaseThreads(maxThreads: number): StateDatabaseThreadRecord[] {
    const database = this.getRolloutPathDatabase();
    if (!database) {
      return [];
    }

    try {
      const columns = database.prepare("PRAGMA table_info(threads)").all() as Array<{ name?: unknown }>;
      const names = new Map(
        columns
          .filter((column): column is { name: string } => typeof column.name === "string")
          .map((column) => [column.name.toLowerCase(), column.name])
      );
      const idColumn = names.get("id") ?? names.get("thread_id");
      if (!idColumn) {
        return [];
      }
      const updatedColumn = names.get("updated_at") ?? names.get("updatedat") ?? names.get("last_updated_at");
      const orderBy = updatedColumn ? this.quoteIdentifier(updatedColumn) : "rowid";
      const rows = database
        .prepare(`SELECT * FROM threads ORDER BY ${orderBy} DESC LIMIT ?`)
        .all(Math.max(1, maxThreads)) as Array<Record<string, unknown>>;

      return rows.flatMap((row) => {
        const threadId = this.readString(row, idColumn);
        if (!threadId) {
          return [];
        }
        const statusValue = this.readString(row, names.get("status"))?.toLowerCase() ?? "";
        return [{
          threadId,
          name: this.readString(row, names.get("title")) ?? this.readString(row, names.get("name")),
          cwd: this.readString(row, names.get("cwd")) ?? this.readString(row, names.get("working_directory")),
          createdAtMs: this.readTimestamp(row, names.get("created_at") ?? names.get("createdat")),
          updatedAtMs: this.readTimestamp(row, updatedColumn),
          status: /active|running|in[_ -]?progress/.test(statusValue) ? "active" : "idle"
        }];
      });
    } catch (error) {
      this.logger?.debug({ error }, "Failed to list thread records from Codex state database.");
      return [];
    }
  }

  private resolveFromStateDatabase(threadId: string): string | null {
    const database = this.getRolloutPathDatabase();
    if (!database) {
      return null;
    }

    try {
      const row = database
        .prepare("SELECT rollout_path FROM threads WHERE id = ? LIMIT 1")
        .get(threadId) as { rollout_path?: unknown } | undefined;
      if (!row?.rollout_path || typeof row.rollout_path !== "string") {
        return null;
      }
      return path.isAbsolute(row.rollout_path)
        ? row.rollout_path
        : path.resolve(this.codexHome, row.rollout_path);
    } catch (error) {
      this.logger?.debug({ error, threadId }, "Failed to resolve rollout path from Codex state database.");
      return null;
    }
  }

  private quoteIdentifier(identifier: string): string {
    return `"${identifier.replaceAll('"', '""')}"`;
  }

  private readString(row: Record<string, unknown>, column: string | undefined): string | null {
    const value = column ? row[column] : null;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private readTimestamp(row: Record<string, unknown>, column: string | undefined): number | null {
    const value = column ? row[column] : null;
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 10_000_000_000 ? value : value * 1_000;
    }
    if (typeof value === "string" && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        return numeric > 10_000_000_000 ? numeric : numeric * 1_000;
      }
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private getRolloutPathDatabase(): InstanceType<typeof Database> | null {
    const databasePath = findNewestStateDatabasePath(this.codexHome);
    if (!databasePath) {
      return null;
    }

    if (this.rolloutPathDatabase && this.rolloutPathDatabaseFilePath === databasePath) {
      return this.rolloutPathDatabase;
    }

    this.rolloutPathDatabase?.close();
    this.rolloutPathDatabase = null;
    this.rolloutPathDatabaseFilePath = null;

    try {
      this.rolloutPathDatabase = new Database(databasePath, { readonly: true });
      this.rolloutPathDatabaseFilePath = databasePath;
      return this.rolloutPathDatabase;
    } catch (error) {
      this.logger?.debug({ error, databasePath }, "Failed to open Codex state database for rollout paths.");
      return null;
    }
  }

  private async searchSessionFile(threadId: string, validateSessionMeta: boolean): Promise<string | null> {
    const searchRoots = [
      path.join(this.codexHome, "sessions"),
      path.join(this.codexHome, "archived_sessions")
    ];

    for (const root of searchRoots) {
      const match = await this.searchSessionDirectory(root, threadId, validateSessionMeta);
      if (match) {
        return match;
      }
    }

    return null;
  }

  private async searchSessionDirectory(
    directory: string,
    threadId: string,
    validateSessionMeta: boolean
  ): Promise<string | null> {
    try {
      await access(directory);
    } catch {
      return null;
    }

    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const nested = await this.searchSessionDirectory(fullPath, threadId, validateSessionMeta);
        if (nested) {
          return nested;
        }
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      if (entry.name.includes(threadId)) {
        return fullPath;
      }

      if (validateSessionMeta && (await this.fileContainsSessionMeta(fullPath, threadId))) {
        return fullPath;
      }
    }

    return null;
  }

  private async fileContainsSessionMeta(filePath: string, threadId: string): Promise<boolean> {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        const parsed = JSON.parse(line) as { type?: unknown; payload?: { id?: unknown } };
        if (parsed.type === "session_meta" && parsed.payload?.id === threadId) {
          return true;
        }
      }
    } catch {
      return false;
    } finally {
      lines.close();
      stream.close();
    }

    return false;
  }
}
