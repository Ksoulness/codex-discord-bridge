import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  AuditLogRecord,
  CanonicalThreadEventRecord,
  ChildThreadAnchorRecord,
  DesktopLogCursorRecord,
  MessageDetailRecord,
  MirroredItemRecord,
  MonitorAuditRecord,
  MonitorCleanupRequestRecord,
  MonitorControlRecord,
  MonitorProjectRecord,
  MonitorThreadRecord,
  PendingApprovalRecord,
  ProposedPlanActionRecord,
  ProposedPlanActionStatus,
  ProjectBridgeRecord,
  RetainedTurnRecord,
  SessionLogCursorRecord,
  ThreadBridgeRecord,
  TurnStatusMessageRecord,
  WriteBackQueueRecord,
  WriteBackQueueStatus
} from "../domain.js";

type ApprovalRow = Record<string, unknown>;

export class StateStore {
  private readonly database: any;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS project_bridges (
        project_key TEXT PRIMARY KEY,
        project_name TEXT NOT NULL,
        discord_category_id TEXT NOT NULL UNIQUE,
        created_by_bridge INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS thread_bridges (
        codex_thread_id TEXT PRIMARY KEY,
        discord_channel_id TEXT,
        status_message_id TEXT,
        cwd TEXT,
        repo_name TEXT,
        last_seen_at TEXT NOT NULL,
        attach_mode TEXT NOT NULL,
        thread_name TEXT,
        actor_name TEXT,
        last_status_type TEXT,
        last_turn_id TEXT,
        last_turn_status TEXT,
        parent_codex_thread_id TEXT,
        parent_anchor_turn_id TEXT,
        parent_anchor_turn_cursor TEXT,
        project_key TEXT,
        project_name TEXT,
        discord_parent_channel_id TEXT,
        channel_kind TEXT,
        source_kind TEXT,
        latest_mirrored_timestamp_ms INTEGER,
        latest_mirrored_cursor TEXT,
        latest_mirrored_turn_cursor TEXT,
        latest_mirrored_source_file_path TEXT,
        latest_mirrored_source_offset INTEGER,
        latest_mirrored_source_event_key TEXT
      );

      CREATE TABLE IF NOT EXISTS pending_approvals (
        token TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        feedback_turn_id TEXT,
        item_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        sanitized_preview TEXT NOT NULL,
        cwd TEXT,
        reason TEXT,
        available_decisions TEXT NOT NULL,
        decision_payloads TEXT NOT NULL DEFAULT '{}',
        expires_at TEXT NOT NULL,
        discord_message_id TEXT,
        status TEXT NOT NULL,
        details TEXT NOT NULL,
        created_at TEXT NOT NULL,
        restart_disabled_at TEXT,
        tool_input TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        sanitized_preview TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mirrored_items (
        thread_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        turn_id TEXT,
        kind TEXT NOT NULL,
        discord_message_id TEXT NOT NULL,
        group_key TEXT,
        content_signature TEXT NOT NULL,
        rendered_content TEXT NOT NULL,
        timestamp_ms INTEGER,
        cursor TEXT,
        turn_cursor TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, item_id)
      );

      CREATE TABLE IF NOT EXISTS mirrored_item_messages (
        thread_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        discord_message_id TEXT NOT NULL,
        message_order INTEGER NOT NULL,
        PRIMARY KEY (thread_id, item_id, discord_message_id),
        FOREIGN KEY (thread_id, item_id) REFERENCES mirrored_items(thread_id, item_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS session_log_cursors (
        thread_id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        byte_offset INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS desktop_log_cursors (
        file_path TEXT PRIMARY KEY,
        byte_offset INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS message_details (
        token TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        button_label TEXT NOT NULL,
        detail TEXT NOT NULL,
        discord_message_id TEXT,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS retained_turns (
        thread_id TEXT NOT NULL,
        turn_key TEXT NOT NULL,
        turn_id TEXT,
        turn_cursor TEXT,
        anchor_item_id TEXT,
        anchor_text TEXT,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, turn_key)
      );

      CREATE TABLE IF NOT EXISTS child_thread_anchors (
        child_thread_id TEXT PRIMARY KEY,
        parent_thread_id TEXT NOT NULL,
        parent_turn_id TEXT,
        parent_turn_cursor TEXT,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS canonical_thread_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        source TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        item_kind TEXT,
        turn_id TEXT,
        turn_cursor TEXT,
        item_id TEXT,
        request_id TEXT,
        summary TEXT,
        detail TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS write_back_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        codex_thread_id TEXT NOT NULL,
        discord_channel_id TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        text TEXT NOT NULL,
        source_kind TEXT NOT NULL DEFAULT 'slash',
        discord_message_id TEXT,
        requested_model TEXT,
        requested_reasoning_effort TEXT,
        local_image_paths_json TEXT,
        mirror_consumed_at TEXT,
        mirror_item_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS discord_thread_preferences (
        codex_thread_id TEXT PRIMARY KEY,
        requested_model TEXT,
        requested_reasoning_effort TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS monitor_projects (
        project_key TEXT PRIMARY KEY,
        project_token TEXT NOT NULL UNIQUE,
        project_name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        updated_by TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS monitor_threads (
        thread_id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        thread_name TEXT,
        thread_status TEXT NOT NULL DEFAULT 'idle',
        selected INTEGER NOT NULL DEFAULT 0,
        paused_discord_channel_id TEXT,
        last_seen_at TEXT NOT NULL,
        updated_by TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_key) REFERENCES monitor_projects(project_key) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS monitor_control (
        guild_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS monitor_cleanup_requests (
        token TEXT PRIMARY KEY,
        actor_user_id TEXT NOT NULL,
        thread_ids TEXT NOT NULL,
        selection_version TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS monitor_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        project_key TEXT,
        thread_id TEXT,
        detail TEXT
      );

      CREATE TABLE IF NOT EXISTS proposed_plan_actions (
        token TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        item_id TEXT NOT NULL,
        plan_text TEXT NOT NULL,
        status TEXT NOT NULL,
        discord_message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        expires_at TEXT NOT NULL,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS turn_status_messages (
        thread_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        discord_message_id TEXT NOT NULL,
        target_kind TEXT NOT NULL DEFAULT 'fallback',
        status_kind TEXT NOT NULL,
        error_reason TEXT,
        plan_current_step INTEGER,
        plan_total_steps INTEGER,
        plan_current_step_text TEXT,
        plan_all_steps_completed INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `);

    const turnStatusColumns = this.database
      .prepare(`PRAGMA table_info(turn_status_messages)`)
      .all() as Array<{ name?: unknown }>;
    if (!turnStatusColumns.some((column) => String(column.name) === "target_kind")) {
      this.database.exec(
        `ALTER TABLE turn_status_messages ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'fallback'`
      );
    }
    if (!turnStatusColumns.some((column) => String(column.name) === "error_reason")) {
      this.database.exec(
        `ALTER TABLE turn_status_messages ADD COLUMN error_reason TEXT`
      );
    }
    if (!turnStatusColumns.some((column) => String(column.name) === "plan_current_step")) {
      this.database.exec(`ALTER TABLE turn_status_messages ADD COLUMN plan_current_step INTEGER`);
    }
    if (!turnStatusColumns.some((column) => String(column.name) === "plan_total_steps")) {
      this.database.exec(`ALTER TABLE turn_status_messages ADD COLUMN plan_total_steps INTEGER`);
    }
    if (!turnStatusColumns.some((column) => String(column.name) === "plan_current_step_text")) {
      this.database.exec(`ALTER TABLE turn_status_messages ADD COLUMN plan_current_step_text TEXT`);
    }
    if (!turnStatusColumns.some((column) => String(column.name) === "plan_all_steps_completed")) {
      this.database.exec(
        `ALTER TABLE turn_status_messages ADD COLUMN plan_all_steps_completed INTEGER NOT NULL DEFAULT 0`
      );
    }

    const monitorThreadColumns = this.database
      .prepare(`PRAGMA table_info(monitor_threads)`)
      .all() as Array<{ name?: unknown }>;
    if (!monitorThreadColumns.some((column) => String(column.name) === "thread_status")) {
      this.database.exec(
        `ALTER TABLE monitor_threads ADD COLUMN thread_status TEXT NOT NULL DEFAULT 'idle'`
      );
    }

    const writeBackQueueColumns = this.database
      .prepare(`PRAGMA table_info(write_back_queue)`)
      .all() as Array<{ name?: unknown }>;
    if (!writeBackQueueColumns.some((column) => String(column.name) === "source_kind")) {
      this.database.exec(`ALTER TABLE write_back_queue ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'slash'`);
    }
    if (!writeBackQueueColumns.some((column) => String(column.name) === "discord_message_id")) {
      this.database.exec(`ALTER TABLE write_back_queue ADD COLUMN discord_message_id TEXT`);
    }
    if (!writeBackQueueColumns.some((column) => String(column.name) === "requested_model")) {
      this.database.exec(`ALTER TABLE write_back_queue ADD COLUMN requested_model TEXT`);
    }
    if (!writeBackQueueColumns.some((column) => String(column.name) === "requested_reasoning_effort")) {
      this.database.exec(`ALTER TABLE write_back_queue ADD COLUMN requested_reasoning_effort TEXT`);
    }
    const preferenceColumns = this.database
      .prepare(`PRAGMA table_info(discord_thread_preferences)`)
      .all() as Array<{ name?: unknown }>;
    if (!preferenceColumns.some((column) => String(column.name) === "requested_reasoning_effort")) {
      this.database.exec(`ALTER TABLE discord_thread_preferences ADD COLUMN requested_reasoning_effort TEXT`);
    }
    if (!writeBackQueueColumns.some((column) => String(column.name) === "local_image_paths_json")) {
      this.database.exec(`ALTER TABLE write_back_queue ADD COLUMN local_image_paths_json TEXT`);
    }
    if (!writeBackQueueColumns.some((column) => String(column.name) === "mirror_consumed_at")) {
      this.database.exec(`ALTER TABLE write_back_queue ADD COLUMN mirror_consumed_at TEXT`);
    }
    if (!writeBackQueueColumns.some((column) => String(column.name) === "mirror_item_id")) {
      this.database.exec(`ALTER TABLE write_back_queue ADD COLUMN mirror_item_id TEXT`);
    }

    this.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_project_bridges_category_id ON project_bridges(discord_category_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_bridges_discord_channel_id ON thread_bridges(discord_channel_id);
      CREATE INDEX IF NOT EXISTS idx_thread_bridges_parent_thread_id ON thread_bridges(parent_codex_thread_id);
      CREATE INDEX IF NOT EXISTS idx_thread_bridges_project_key ON thread_bridges(project_key);
      CREATE INDEX IF NOT EXISTS idx_pending_approvals_request_id ON pending_approvals(request_id);
      CREATE INDEX IF NOT EXISTS idx_pending_approvals_item ON pending_approvals(thread_id, item_id, kind);
      CREATE INDEX IF NOT EXISTS idx_mirrored_items_thread_id ON mirrored_items(thread_id);
      CREATE INDEX IF NOT EXISTS idx_mirrored_items_cursor ON mirrored_items(thread_id, cursor);
      CREATE INDEX IF NOT EXISTS idx_mirrored_items_turn_id ON mirrored_items(thread_id, turn_id);
      CREATE INDEX IF NOT EXISTS idx_mirrored_items_turn_cursor ON mirrored_items(thread_id, turn_cursor);
      CREATE INDEX IF NOT EXISTS idx_mirrored_item_messages_message_id ON mirrored_item_messages(discord_message_id);
      CREATE INDEX IF NOT EXISTS idx_session_log_cursors_updated_at ON session_log_cursors(updated_at);
      CREATE INDEX IF NOT EXISTS idx_desktop_log_cursors_updated_at ON desktop_log_cursors(updated_at);
      CREATE INDEX IF NOT EXISTS idx_message_details_thread_id ON message_details(thread_id);
      CREATE INDEX IF NOT EXISTS idx_message_details_expires_at ON message_details(expires_at);
      CREATE INDEX IF NOT EXISTS idx_proposed_plan_actions_thread_id ON proposed_plan_actions(thread_id);
      CREATE INDEX IF NOT EXISTS idx_proposed_plan_actions_message_id ON proposed_plan_actions(discord_message_id);
      CREATE INDEX IF NOT EXISTS idx_proposed_plan_actions_expires_at ON proposed_plan_actions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_retained_turns_thread_id ON retained_turns(thread_id);
      CREATE INDEX IF NOT EXISTS idx_retained_turns_turn_cursor ON retained_turns(thread_id, turn_cursor);
      CREATE INDEX IF NOT EXISTS idx_child_thread_anchors_parent_thread_id ON child_thread_anchors(parent_thread_id);
      CREATE INDEX IF NOT EXISTS idx_canonical_thread_events_thread_id ON canonical_thread_events(thread_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_write_back_queue_thread_status ON write_back_queue(codex_thread_id, status, id);
      CREATE INDEX IF NOT EXISTS idx_write_back_queue_status ON write_back_queue(status, id);
      CREATE INDEX IF NOT EXISTS idx_turn_status_messages_turn_id ON turn_status_messages(turn_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_monitor_projects_token ON monitor_projects(project_token);
      CREATE INDEX IF NOT EXISTS idx_monitor_projects_enabled ON monitor_projects(enabled, project_name);
      CREATE INDEX IF NOT EXISTS idx_monitor_threads_project ON monitor_threads(project_key, selected, last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_monitor_threads_paused_channel ON monitor_threads(paused_discord_channel_id);
      CREATE INDEX IF NOT EXISTS idx_monitor_cleanup_requests_expires ON monitor_cleanup_requests(expires_at);
      CREATE INDEX IF NOT EXISTS idx_monitor_audit_timestamp ON monitor_audit_log(timestamp DESC);
    `);
  }

  private setSchemaMetaValue(key: string, value: string): void {
    this.database
      .prepare(`
        INSERT INTO schema_meta (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `)
      .run(key, value, new Date().toISOString());
  }

  private getSchemaMetaValue(key: string): string | undefined {
    const row = this.database
      .prepare(`SELECT value FROM schema_meta WHERE key = ?`)
      .get(key) as { value?: unknown } | undefined;
    return row?.value === undefined ? undefined : String(row.value);
  }

  setBridgeMetaValue(key: string, value: string): void {
    this.setSchemaMetaValue(key, value);
  }

  getBridgeMetaValue(key: string): string | undefined {
    return this.getSchemaMetaValue(key);
  }

  upsertProjectBridge(record: ProjectBridgeRecord): void {
    this.database
      .prepare(`
        INSERT INTO project_bridges (
          project_key,
          project_name,
          discord_category_id,
          created_by_bridge,
          updated_at
        ) VALUES (
          @projectKey,
          @projectName,
          @discordCategoryId,
          @createdByBridge,
          @updatedAt
        )
        ON CONFLICT(project_key) DO UPDATE SET
          project_name = excluded.project_name,
          discord_category_id = excluded.discord_category_id,
          created_by_bridge = excluded.created_by_bridge,
          updated_at = excluded.updated_at
      `)
      .run({
        ...record,
        createdByBridge: record.createdByBridge ? 1 : 0
      });
  }

  getProjectBridge(projectKey: string): ProjectBridgeRecord | undefined {
    return this.selectOne(
      `SELECT * FROM project_bridges WHERE project_key = ?`,
      [projectKey],
      (row) => this.mapProjectBridge(row)
    );
  }

  listProjectBridges(): ProjectBridgeRecord[] {
    return this.selectMany(
      `SELECT * FROM project_bridges ORDER BY project_name ASC`,
      [],
      (row) => this.mapProjectBridge(row)
    );
  }

  deleteProjectBridge(projectKey: string): void {
    this.database
      .prepare(`DELETE FROM project_bridges WHERE project_key = ?`)
      .run(projectKey);
  }

  upsertThreadBridge(record: ThreadBridgeRecord): void {
    this.database
      .prepare(`
        INSERT INTO thread_bridges (
          codex_thread_id,
          parent_codex_thread_id,
          parent_anchor_turn_id,
          parent_anchor_turn_cursor,
          project_key,
          project_name,
          discord_channel_id,
          discord_parent_channel_id,
          status_message_id,
          cwd,
          repo_name,
          last_seen_at,
          attach_mode,
          thread_name,
          actor_name,
          last_status_type,
          last_turn_id,
          last_turn_status,
          channel_kind,
          source_kind,
          latest_mirrored_timestamp_ms,
          latest_mirrored_cursor,
          latest_mirrored_turn_cursor,
          latest_mirrored_source_file_path,
          latest_mirrored_source_offset,
          latest_mirrored_source_event_key
        ) VALUES (
          @codexThreadId,
          @parentCodexThreadId,
          @parentAnchorTurnId,
          @parentAnchorTurnCursor,
          @projectKey,
          @projectName,
          @discordChannelId,
          @discordParentChannelId,
          @statusMessageId,
          @cwd,
          @repoName,
          @lastSeenAt,
          @attachMode,
          @threadName,
          @actorName,
          @lastStatusType,
          @lastTurnId,
          @lastTurnStatus,
          @channelKind,
          @sourceKind,
          @latestMirroredTimestampMs,
          @latestMirroredCursor,
          @latestMirroredTurnCursor,
          @latestMirroredSourceFilePath,
          @latestMirroredSourceOffset,
          @latestMirroredSourceEventKey
        )
        ON CONFLICT(codex_thread_id) DO UPDATE SET
          parent_codex_thread_id = excluded.parent_codex_thread_id,
          parent_anchor_turn_id = excluded.parent_anchor_turn_id,
          parent_anchor_turn_cursor = excluded.parent_anchor_turn_cursor,
          project_key = excluded.project_key,
          project_name = excluded.project_name,
          discord_channel_id = excluded.discord_channel_id,
          discord_parent_channel_id = excluded.discord_parent_channel_id,
          status_message_id = excluded.status_message_id,
          cwd = excluded.cwd,
          repo_name = excluded.repo_name,
          last_seen_at = excluded.last_seen_at,
          attach_mode = excluded.attach_mode,
          thread_name = excluded.thread_name,
          actor_name = excluded.actor_name,
          last_status_type = excluded.last_status_type,
          last_turn_id = excluded.last_turn_id,
          last_turn_status = excluded.last_turn_status,
          channel_kind = excluded.channel_kind,
          source_kind = excluded.source_kind,
          latest_mirrored_timestamp_ms = excluded.latest_mirrored_timestamp_ms,
          latest_mirrored_cursor = excluded.latest_mirrored_cursor,
          latest_mirrored_turn_cursor = excluded.latest_mirrored_turn_cursor,
          latest_mirrored_source_file_path = excluded.latest_mirrored_source_file_path,
          latest_mirrored_source_offset = excluded.latest_mirrored_source_offset,
          latest_mirrored_source_event_key = excluded.latest_mirrored_source_event_key
      `)
      .run({
        actorName: null,
        lastTurnId: null,
        lastTurnStatus: null,
        parentAnchorTurnId: null,
        parentAnchorTurnCursor: null,
        sourceKind: "app-server",
        latestMirroredTimestampMs: null,
        latestMirroredCursor: null,
        latestMirroredTurnCursor: null,
        latestMirroredSourceFilePath: null,
        latestMirroredSourceOffset: null,
        latestMirroredSourceEventKey: null,
        ...record
      });
  }

  getThreadBridge(codexThreadId: string): ThreadBridgeRecord | undefined {
    return this.selectOne(
      `SELECT * FROM thread_bridges WHERE codex_thread_id = ?`,
      [codexThreadId],
      (row) => this.mapThreadBridge(row)
    );
  }

  findThreadBridgeByDiscordChannelId(discordChannelId: string): ThreadBridgeRecord | undefined {
    return this.selectOne(
      `SELECT * FROM thread_bridges WHERE discord_channel_id = ? LIMIT 1`,
      [discordChannelId],
      (row) => this.mapThreadBridge(row)
    );
  }

  listThreadBridges(): ThreadBridgeRecord[] {
    return this.selectMany(
      `SELECT * FROM thread_bridges ORDER BY last_seen_at DESC`,
      [],
      (row) => this.mapThreadBridge(row)
    );
  }

  listThreadBridgesByKind(channelKind: ThreadBridgeRecord["channelKind"]): ThreadBridgeRecord[] {
    return this.selectMany(
      `SELECT * FROM thread_bridges WHERE channel_kind = ? ORDER BY last_seen_at DESC`,
      [channelKind],
      (row) => this.mapThreadBridge(row)
    );
  }

  deleteThreadBridge(codexThreadId: string): void {
    this.database
      .prepare(`DELETE FROM thread_bridges WHERE codex_thread_id = ?`)
      .run(codexThreadId);
    this.database
      .prepare(`DELETE FROM session_log_cursors WHERE thread_id = ?`)
      .run(codexThreadId);
    this.database
      .prepare(`DELETE FROM message_details WHERE thread_id = ?`)
      .run(codexThreadId);
    this.database
      .prepare(`DELETE FROM proposed_plan_actions WHERE thread_id = ?`)
      .run(codexThreadId);
    this.database
      .prepare(`DELETE FROM discord_thread_preferences WHERE codex_thread_id = ?`)
      .run(codexThreadId);
    this.deleteTurnStatusMessage(codexThreadId);
  }

  upsertDiscoveredMonitorThread(input: {
    threadId: string;
    projectKey: string;
    projectName: string;
    threadName: string | null;
    threadStatus?: "active" | "idle" | "notLoaded" | "systemError";
    lastSeenAt: string;
  }): void {
    const now = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      this.database
        .prepare(`
          INSERT INTO monitor_projects (
            project_key, project_token, project_name, enabled, updated_by, updated_at
          ) VALUES (?, ?, ?, 0, NULL, ?)
          ON CONFLICT(project_key) DO UPDATE SET
            project_name = excluded.project_name,
            updated_at = excluded.updated_at
        `)
        .run(
          input.projectKey,
          this.createMonitorProjectToken(input.projectKey),
          input.projectName,
          now
        );
      this.database
        .prepare(`
          INSERT INTO monitor_threads (
            thread_id, project_key, thread_name, thread_status, selected,
            paused_discord_channel_id, last_seen_at, updated_by, updated_at
          ) VALUES (?, ?, ?, ?, 0, NULL, ?, NULL, ?)
          ON CONFLICT(thread_id) DO UPDATE SET
            project_key = excluded.project_key,
            thread_name = COALESCE(excluded.thread_name, monitor_threads.thread_name),
            thread_status = excluded.thread_status,
            last_seen_at = excluded.last_seen_at,
            updated_at = excluded.updated_at
        `)
        .run(
          input.threadId,
          input.projectKey,
          input.threadName,
          input.threadStatus ?? "idle",
          input.lastSeenAt,
          now
        );
    });
    transaction();
  }

  getMonitorProject(projectKey: string): MonitorProjectRecord | undefined {
    return this.selectOne(
      `SELECT * FROM monitor_projects WHERE project_key = ?`,
      [projectKey],
      (row) => this.mapMonitorProject(row)
    );
  }

  getMonitorProjectByToken(projectToken: string): MonitorProjectRecord | undefined {
    return this.selectOne(
      `SELECT * FROM monitor_projects WHERE project_token = ?`,
      [projectToken],
      (row) => this.mapMonitorProject(row)
    );
  }

  listMonitorProjects(): MonitorProjectRecord[] {
    return this.selectMany(
      `SELECT * FROM monitor_projects ORDER BY project_name COLLATE NOCASE, project_key`,
      [],
      (row) => this.mapMonitorProject(row)
    );
  }

  setMonitorProjectEnabled(projectKey: string, enabled: boolean, actorUserId: string): void {
    this.database
      .prepare(`
        UPDATE monitor_projects
        SET enabled = ?, updated_by = ?, updated_at = ?
        WHERE project_key = ?
      `)
      .run(enabled ? 1 : 0, actorUserId, new Date().toISOString(), projectKey);
  }

  getMonitorThread(threadId: string): MonitorThreadRecord | undefined {
    return this.selectOne(
      `SELECT * FROM monitor_threads WHERE thread_id = ?`,
      [threadId],
      (row) => this.mapMonitorThread(row)
    );
  }

  listMonitorThreads(projectKey?: string): MonitorThreadRecord[] {
    if (projectKey) {
      return this.selectMany(
        `
          SELECT * FROM monitor_threads
          WHERE project_key = ?
          ORDER BY last_seen_at DESC, thread_id
        `,
        [projectKey],
        (row) => this.mapMonitorThread(row)
      );
    }
    return this.selectMany(
      `SELECT * FROM monitor_threads ORDER BY last_seen_at DESC, thread_id`,
      [],
      (row) => this.mapMonitorThread(row)
    );
  }

  deleteMonitorThreadIfUnselected(threadId: string): boolean {
    const result = this.database
      .prepare(
        `DELETE FROM monitor_threads
         WHERE thread_id = ?
           AND selected = 0
           AND paused_discord_channel_id IS NULL`
      )
      .run(threadId);
    return result.changes > 0;
  }

  setMonitorThreadSelected(threadId: string, selected: boolean, actorUserId: string): void {
    this.database
      .prepare(`
        UPDATE monitor_threads
        SET selected = ?, updated_by = ?, updated_at = ?
        WHERE thread_id = ?
      `)
      .run(selected ? 1 : 0, actorUserId, new Date().toISOString(), threadId);
  }

  setMonitorThreadPausedDiscordChannelId(threadId: string, channelId: string | null): void {
    this.database
      .prepare(`
        UPDATE monitor_threads
        SET paused_discord_channel_id = ?, updated_at = ?
        WHERE thread_id = ?
      `)
      .run(channelId, new Date().toISOString(), threadId);
  }

  getMonitorControl(guildId: string): MonitorControlRecord | undefined {
    return this.selectOne(
      `SELECT * FROM monitor_control WHERE guild_id = ?`,
      [guildId],
      (row) => this.mapMonitorControl(row)
    );
  }

  upsertMonitorControl(record: MonitorControlRecord): void {
    this.database
      .prepare(`
        INSERT INTO monitor_control (guild_id, channel_id, message_id, updated_at)
        VALUES (@guildId, @channelId, @messageId, @updatedAt)
        ON CONFLICT(guild_id) DO UPDATE SET
          channel_id = excluded.channel_id,
          message_id = excluded.message_id,
          updated_at = excluded.updated_at
      `)
      .run(record);
  }

  createMonitorCleanupRequest(record: MonitorCleanupRequestRecord): void {
    this.database
      .prepare(`
        INSERT INTO monitor_cleanup_requests (
          token, actor_user_id, thread_ids, selection_version, expires_at, consumed_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.token,
        record.actorUserId,
        JSON.stringify(record.threadIds),
        record.selectionVersion,
        record.expiresAt,
        record.consumedAt
      );
  }

  getMonitorCleanupRequest(token: string): MonitorCleanupRequestRecord | undefined {
    return this.selectOne(
      `SELECT * FROM monitor_cleanup_requests WHERE token = ?`,
      [token],
      (row) => this.mapMonitorCleanupRequest(row)
    );
  }

  consumeMonitorCleanupRequest(token: string, consumedAt = new Date().toISOString()): boolean {
    const result = this.database
      .prepare(`
        UPDATE monitor_cleanup_requests
        SET consumed_at = ?
        WHERE token = ? AND consumed_at IS NULL
      `)
      .run(consumedAt, token);
    return Number(result.changes ?? 0) === 1;
  }

  deleteExpiredMonitorCleanupRequests(nowIso = new Date().toISOString()): number {
    const result = this.database
      .prepare(`DELETE FROM monitor_cleanup_requests WHERE expires_at < ?`)
      .run(nowIso);
    return Number(result.changes ?? 0);
  }

  appendMonitorAudit(record: MonitorAuditRecord): void {
    this.database
      .prepare(`
        INSERT INTO monitor_audit_log (
          timestamp, actor_user_id, action, project_key, thread_id, detail
        ) VALUES (@timestamp, @actorUserId, @action, @projectKey, @threadId, @detail)
      `)
      .run(record);
  }

  listMonitorAudit(limit = 100): MonitorAuditRecord[] {
    return this.selectMany(
      `SELECT * FROM monitor_audit_log ORDER BY id DESC LIMIT ?`,
      [Math.max(1, Math.floor(limit))],
      (row) => this.mapMonitorAudit(row)
    );
  }

  migrateExistingBridgeSelections(marker = "monitor-selection-migration-v1"): boolean {
    if (this.getSchemaMetaValue(marker)) {
      return false;
    }
    const transaction = this.database.transaction(() => {
      for (const bridge of this.listThreadBridgesByKind("conversation")) {
        this.upsertDiscoveredMonitorThread({
          threadId: bridge.codexThreadId,
          projectKey: bridge.projectKey,
          projectName: bridge.projectName,
          threadName: bridge.threadName,
          lastSeenAt: bridge.lastSeenAt
        });
        this.setMonitorProjectEnabled(bridge.projectKey, true, "migration");
        this.setMonitorThreadSelected(bridge.codexThreadId, true, "migration");
      }
      this.setSchemaMetaValue(marker, new Date().toISOString());
    });
    transaction();
    return true;
  }

  upsertTurnStatusMessage(record: TurnStatusMessageRecord): void {
    this.database
      .prepare(`
        INSERT INTO turn_status_messages (
          thread_id,
          turn_id,
          discord_message_id,
          target_kind,
          status_kind,
          error_reason,
          plan_current_step,
          plan_total_steps,
          plan_current_step_text,
          plan_all_steps_completed,
          updated_at
        ) VALUES (
          @threadId,
          @turnId,
          @discordMessageId,
          @targetKind,
          @statusKind,
          @errorReason,
          @planCurrentStep,
          @planTotalSteps,
          @planCurrentStepText,
          @planAllStepsCompleted,
          @updatedAt
        )
        ON CONFLICT(thread_id) DO UPDATE SET
          turn_id = excluded.turn_id,
          discord_message_id = excluded.discord_message_id,
          target_kind = excluded.target_kind,
          status_kind = excluded.status_kind,
          error_reason = excluded.error_reason,
          plan_current_step = excluded.plan_current_step,
          plan_total_steps = excluded.plan_total_steps,
          plan_current_step_text = excluded.plan_current_step_text,
          plan_all_steps_completed = excluded.plan_all_steps_completed,
          updated_at = excluded.updated_at
      `)
      .run({
        ...record,
        planAllStepsCompleted: record.planAllStepsCompleted ? 1 : 0
      });
  }

  getTurnStatusMessage(threadId: string): TurnStatusMessageRecord | undefined {
    return this.selectOne(
      `SELECT * FROM turn_status_messages WHERE thread_id = ? LIMIT 1`,
      [threadId],
      (row) => this.mapTurnStatusMessage(row)
    );
  }

  listTurnStatusMessages(): TurnStatusMessageRecord[] {
    return this.selectMany(
      `SELECT * FROM turn_status_messages ORDER BY updated_at ASC`,
      [],
      (row) => this.mapTurnStatusMessage(row)
    );
  }

  deleteTurnStatusMessage(threadId: string): void {
    this.database
      .prepare(`DELETE FROM turn_status_messages WHERE thread_id = ?`)
      .run(threadId);
  }

  updateThreadMirrorCursor(
    codexThreadId: string,
    latestMirroredTimestampMs: number | null,
    latestMirroredCursor: string | null,
    latestMirroredTurnCursor: string | null,
    latestMirroredSourceFrontier?: {
      filePath: string | null;
      offset: number | null;
      eventKey: string | null;
    }
  ): void {
    this.database
      .prepare(`
        UPDATE thread_bridges
        SET
          latest_mirrored_timestamp_ms = ?,
          latest_mirrored_cursor = ?,
          latest_mirrored_turn_cursor = ?,
          latest_mirrored_source_file_path = ?,
          latest_mirrored_source_offset = ?,
          latest_mirrored_source_event_key = ?
        WHERE codex_thread_id = ?
      `)
      .run(
        latestMirroredTimestampMs,
        latestMirroredCursor,
        latestMirroredTurnCursor,
        latestMirroredSourceFrontier?.filePath ?? null,
        latestMirroredSourceFrontier?.offset ?? null,
        latestMirroredSourceFrontier?.eventKey ?? null,
        codexThreadId
      );
  }

  deletePendingApprovalsByThread(threadId: string): void {
    this.database
      .prepare(`DELETE FROM pending_approvals WHERE thread_id = ?`)
      .run(threadId);
  }

  upsertMirroredItem(record: MirroredItemRecord): void {
    this.database
      .prepare(`
        INSERT INTO mirrored_items (
          thread_id,
          item_id,
          turn_id,
          kind,
          discord_message_id,
          group_key,
          content_signature,
          rendered_content,
          timestamp_ms,
          cursor,
          turn_cursor,
          updated_at
        ) VALUES (
          @threadId,
          @itemId,
          @turnId,
          @kind,
          @discordMessageId,
          @groupKey,
          @contentSignature,
          @renderedContent,
          @timestampMs,
          @cursor,
          @turnCursor,
          @updatedAt
        )
        ON CONFLICT(thread_id, item_id) DO UPDATE SET
          turn_id = excluded.turn_id,
          kind = excluded.kind,
          discord_message_id = excluded.discord_message_id,
          group_key = excluded.group_key,
          content_signature = excluded.content_signature,
          rendered_content = excluded.rendered_content,
          timestamp_ms = excluded.timestamp_ms,
          cursor = excluded.cursor,
          turn_cursor = excluded.turn_cursor,
          updated_at = excluded.updated_at
      `)
      .run(record);
    this.replaceMirroredItemMessageIds(
      record.threadId,
      record.itemId,
      this.normalizeMirroredItemMessageIds(record.discordMessageIds, record.discordMessageId)
    );
  }

  getMirroredItem(threadId: string, itemId: string): MirroredItemRecord | undefined {
    return this.selectOne(
      `SELECT * FROM mirrored_items WHERE thread_id = ? AND item_id = ?`,
      [threadId, itemId],
      (row) => this.mapMirroredItem(row)
    );
  }

  listMirroredItems(threadId: string): MirroredItemRecord[] {
    return this.selectMany(
      `SELECT * FROM mirrored_items WHERE thread_id = ? ORDER BY timestamp_ms ASC, cursor ASC, item_id ASC`,
      [threadId],
      (row) => this.mapMirroredItem(row)
    );
  }

  deleteMirroredItem(threadId: string, itemId: string): void {
    this.database
      .prepare(`DELETE FROM mirrored_item_messages WHERE thread_id = ? AND item_id = ?`)
      .run(threadId, itemId);
    this.database
      .prepare(`DELETE FROM mirrored_items WHERE thread_id = ? AND item_id = ?`)
      .run(threadId, itemId);
  }

  deleteMirroredItemsByThread(threadId: string): void {
    this.database
      .prepare(`DELETE FROM mirrored_item_messages WHERE thread_id = ?`)
      .run(threadId);
    this.database
      .prepare(`DELETE FROM mirrored_items WHERE thread_id = ?`)
      .run(threadId);
  }

  replaceMirroredItemMessageIds(threadId: string, itemId: string, discordMessageIds: string[]): void {
    const normalizedIds = this.normalizeMirroredItemMessageIds(discordMessageIds, null);
    const transaction = this.database.transaction((ids: string[]) => {
      this.database
        .prepare(`DELETE FROM mirrored_item_messages WHERE thread_id = ? AND item_id = ?`)
        .run(threadId, itemId);
      const insert = this.database.prepare(`
          INSERT INTO mirrored_item_messages (
            thread_id,
            item_id,
            discord_message_id,
            message_order
          ) VALUES (?, ?, ?, ?)
        `);
      ids.forEach((messageId, index) => {
        insert.run(threadId, itemId, messageId, index);
      });
    });
    transaction(normalizedIds);
  }

  listMirroredItemMessageIds(threadId: string, itemId: string): string[] {
    return this.selectMany(
      `
        SELECT discord_message_id
        FROM mirrored_item_messages
        WHERE thread_id = ? AND item_id = ?
        ORDER BY message_order ASC, discord_message_id ASC
      `,
      [threadId, itemId],
      (row) => String(row.discord_message_id)
    );
  }

  deleteMessageDetailsByThread(threadId: string): void {
    this.database
      .prepare(`DELETE FROM message_details WHERE thread_id = ?`)
      .run(threadId);
  }

  deleteProposedPlanActionsByThread(threadId: string): void {
    this.database
      .prepare(`DELETE FROM proposed_plan_actions WHERE thread_id = ?`)
      .run(threadId);
  }

  upsertMessageDetail(record: MessageDetailRecord): void {
    this.database
      .prepare(`
        INSERT INTO message_details (
          token,
          thread_id,
          kind,
          title,
          button_label,
          detail,
          discord_message_id,
          expires_at,
          updated_at
        ) VALUES (
          @token,
          @threadId,
          @kind,
          @title,
          @buttonLabel,
          @detail,
          @discordMessageId,
          @expiresAt,
          @updatedAt
        )
        ON CONFLICT(token) DO UPDATE SET
          thread_id = excluded.thread_id,
          kind = excluded.kind,
          title = excluded.title,
          button_label = excluded.button_label,
          detail = excluded.detail,
          discord_message_id = excluded.discord_message_id,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `)
      .run(record);
  }

  findMessageDetailByToken(token: string): MessageDetailRecord | undefined {
    return this.selectOne(
      `SELECT * FROM message_details WHERE token = ?`,
      [token],
      (row) => this.mapMessageDetail(row)
    );
  }

  listMessageDetailsByDiscordMessageId(discordMessageId: string): MessageDetailRecord[] {
    return this.selectMany(
      `SELECT * FROM message_details WHERE discord_message_id = ? ORDER BY updated_at ASC, token ASC`,
      [discordMessageId],
      (row) => this.mapMessageDetail(row)
    );
  }

  listExpiredMessageDetails(beforeIso: string): MessageDetailRecord[] {
    return this.selectMany(
      `SELECT * FROM message_details WHERE expires_at <= ? ORDER BY expires_at ASC`,
      [beforeIso],
      (row) => this.mapMessageDetail(row)
    );
  }

  deleteMessageDetail(token: string): void {
    this.database
      .prepare(`DELETE FROM message_details WHERE token = ?`)
      .run(token);
  }

  upsertProposedPlanAction(record: ProposedPlanActionRecord): void {
    this.database
      .prepare(`
        INSERT INTO proposed_plan_actions (
          token,
          thread_id,
          turn_id,
          item_id,
          plan_text,
          status,
          discord_message_id,
          created_at,
          updated_at,
          completed_at,
          expires_at,
          error
        ) VALUES (
          @token,
          @threadId,
          @turnId,
          @itemId,
          @planText,
          @status,
          @discordMessageId,
          @createdAt,
          @updatedAt,
          @completedAt,
          @expiresAt,
          @error
        )
        ON CONFLICT(token) DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          item_id = excluded.item_id,
          plan_text = excluded.plan_text,
          status = excluded.status,
          discord_message_id = excluded.discord_message_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          completed_at = excluded.completed_at,
          expires_at = excluded.expires_at,
          error = excluded.error
      `)
      .run(record);
  }

  findProposedPlanActionByToken(token: string): ProposedPlanActionRecord | undefined {
    return this.selectOne(
      `SELECT * FROM proposed_plan_actions WHERE token = ?`,
      [token],
      (row) => this.mapProposedPlanActionRecord(row)
    );
  }

  listProposedPlanActions(threadId?: string): ProposedPlanActionRecord[] {
    return this.selectMany(
      threadId
        ? `SELECT * FROM proposed_plan_actions WHERE thread_id = ? ORDER BY created_at ASC, token ASC`
        : `SELECT * FROM proposed_plan_actions ORDER BY created_at ASC, token ASC`,
      threadId ? [threadId] : [],
      (row) => this.mapProposedPlanActionRecord(row)
    );
  }

  claimPendingProposedPlanAction(token: string): ProposedPlanActionRecord | null {
    const claim = this.database.transaction(() => {
      const now = new Date().toISOString();
      const result = this.database
        .prepare(`
          UPDATE proposed_plan_actions
          SET status = 'sending',
              updated_at = ?,
              error = NULL
          WHERE token = ?
            AND status = 'pending'
            AND expires_at > ?
        `)
        .run(now, token, now);
      if (Number(result.changes ?? 0) === 0) {
        return null;
      }
      return this.findProposedPlanActionByToken(token) ?? null;
    });
    return claim();
  }

  completeProposedPlanAction(
    token: string,
    status: Extract<ProposedPlanActionStatus, "accepted" | "feedbackSent">
  ): ProposedPlanActionRecord | null {
    const now = new Date().toISOString();
    const result = this.database
      .prepare(`
        UPDATE proposed_plan_actions
        SET status = ?,
            updated_at = ?,
            completed_at = ?,
            error = NULL
        WHERE token = ? AND status = 'sending'
      `)
      .run(status, now, now, token);
    if (Number(result.changes ?? 0) === 0) {
      return null;
    }
    return this.findProposedPlanActionByToken(token) ?? null;
  }

  restoreProposedPlanActionPending(token: string, error: string | null = null): void {
    this.database
      .prepare(`
        UPDATE proposed_plan_actions
        SET status = 'pending',
            updated_at = ?,
            error = ?
        WHERE token = ? AND status = 'sending'
      `)
      .run(new Date().toISOString(), error, token);
  }

  upsertSessionLogCursor(record: SessionLogCursorRecord): void {
    this.database
      .prepare(`
        INSERT INTO session_log_cursors (
          thread_id,
          file_path,
          byte_offset,
          updated_at
        ) VALUES (
          @threadId,
          @filePath,
          @byteOffset,
          @updatedAt
        )
        ON CONFLICT(thread_id) DO UPDATE SET
          file_path = excluded.file_path,
          byte_offset = excluded.byte_offset,
          updated_at = excluded.updated_at
      `)
      .run(record);
  }

  getSessionLogCursor(threadId: string): SessionLogCursorRecord | undefined {
    return this.selectOne(
      `SELECT * FROM session_log_cursors WHERE thread_id = ?`,
      [threadId],
      (row) => this.mapSessionLogCursor(row)
    );
  }

  deleteSessionLogCursor(threadId: string): void {
    this.database
      .prepare(`DELETE FROM session_log_cursors WHERE thread_id = ?`)
      .run(threadId);
  }

  upsertDesktopLogCursor(record: DesktopLogCursorRecord): void {
    this.database
      .prepare(`
        INSERT INTO desktop_log_cursors (
          file_path,
          byte_offset,
          updated_at
        ) VALUES (
          @filePath,
          @byteOffset,
          @updatedAt
        )
        ON CONFLICT(file_path) DO UPDATE SET
          byte_offset = excluded.byte_offset,
          updated_at = excluded.updated_at
      `)
      .run(record);
  }

  getDesktopLogCursor(filePath: string): DesktopLogCursorRecord | undefined {
    return this.selectOne(
      `SELECT * FROM desktop_log_cursors WHERE file_path = ?`,
      [filePath],
      (row) => this.mapDesktopLogCursor(row)
    );
  }

  deleteDesktopLogCursor(filePath: string): void {
    this.database
      .prepare(`DELETE FROM desktop_log_cursors WHERE file_path = ?`)
      .run(filePath);
  }

  upsertRetainedTurn(record: RetainedTurnRecord): void {
    this.database
      .prepare(`
        INSERT INTO retained_turns (
          thread_id,
          turn_key,
          turn_id,
          turn_cursor,
          anchor_item_id,
          anchor_text,
          source,
          updated_at
        ) VALUES (
          @threadId,
          @turnKey,
          @turnId,
          @turnCursor,
          @anchorItemId,
          @anchorText,
          @source,
          @updatedAt
        )
        ON CONFLICT(thread_id, turn_key) DO UPDATE SET
          turn_id = excluded.turn_id,
          turn_cursor = excluded.turn_cursor,
          anchor_item_id = excluded.anchor_item_id,
          anchor_text = excluded.anchor_text,
          source = excluded.source,
          updated_at = excluded.updated_at
      `)
      .run(record);
  }

  listRetainedTurns(threadId: string): RetainedTurnRecord[] {
    return this.selectMany(
      `
        SELECT * FROM retained_turns
        WHERE thread_id = ?
        ORDER BY COALESCE(turn_cursor, turn_key) ASC, updated_at ASC
      `,
      [threadId],
      (row) => this.mapRetainedTurn(row)
    );
  }

  deleteRetainedTurn(threadId: string, turnKey: string): void {
    this.database
      .prepare(`DELETE FROM retained_turns WHERE thread_id = ? AND turn_key = ?`)
      .run(threadId, turnKey);
  }

  deleteRetainedTurnsByThread(threadId: string): void {
    this.database
      .prepare(`DELETE FROM retained_turns WHERE thread_id = ?`)
      .run(threadId);
  }

  upsertChildThreadAnchor(record: ChildThreadAnchorRecord): void {
    this.database
      .prepare(`
        INSERT INTO child_thread_anchors (
          child_thread_id,
          parent_thread_id,
          parent_turn_id,
          parent_turn_cursor,
          source,
          updated_at
        ) VALUES (
          @childThreadId,
          @parentThreadId,
          @parentTurnId,
          @parentTurnCursor,
          @source,
          @updatedAt
        )
        ON CONFLICT(child_thread_id) DO UPDATE SET
          parent_thread_id = excluded.parent_thread_id,
          parent_turn_id = excluded.parent_turn_id,
          parent_turn_cursor = excluded.parent_turn_cursor,
          source = excluded.source,
          updated_at = excluded.updated_at
      `)
      .run(record);
  }

  getChildThreadAnchor(childThreadId: string): ChildThreadAnchorRecord | null {
    return (
      this.selectOne(
      `SELECT * FROM child_thread_anchors WHERE child_thread_id = ? LIMIT 1`,
      [childThreadId],
      (row) => this.mapChildThreadAnchor(row)
      ) ?? null
    );
  }

  listChildThreadAnchorsForParent(parentThreadId: string): ChildThreadAnchorRecord[] {
    return this.selectMany(
      `
        SELECT * FROM child_thread_anchors
        WHERE parent_thread_id = ?
        ORDER BY updated_at ASC, child_thread_id ASC
      `,
      [parentThreadId],
      (row) => this.mapChildThreadAnchor(row)
    );
  }

  deleteChildThreadAnchor(childThreadId: string): void {
    this.database
      .prepare(`DELETE FROM child_thread_anchors WHERE child_thread_id = ?`)
      .run(childThreadId);
  }

  appendCanonicalThreadEvent(
    record: Omit<CanonicalThreadEventRecord, "id">
  ): void {
    this.database
      .prepare(`
        INSERT INTO canonical_thread_events (
          thread_id,
          source,
          event_kind,
          item_kind,
          turn_id,
          turn_cursor,
          item_id,
          request_id,
          summary,
          detail,
          created_at
        ) VALUES (
          @threadId,
          @source,
          @eventKind,
          @itemKind,
          @turnId,
          @turnCursor,
          @itemId,
          @requestId,
          @summary,
          @detail,
          @createdAt
        )
      `)
      .run(record);
  }

  appendCanonicalThreadEventIfNew(
    record: Omit<CanonicalThreadEventRecord, "id">
  ): boolean {
    const result = this.database
      .prepare(`
        INSERT INTO canonical_thread_events (
          thread_id,
          source,
          event_kind,
          item_kind,
          turn_id,
          turn_cursor,
          item_id,
          request_id,
          summary,
          detail,
          created_at
        )
        SELECT
          @threadId,
          @source,
          @eventKind,
          @itemKind,
          @turnId,
          @turnCursor,
          @itemId,
          @requestId,
          @summary,
          @detail,
          @createdAt
        WHERE NOT EXISTS (
          SELECT 1
          FROM canonical_thread_events
          WHERE
            thread_id = @threadId AND
            source = @source AND
            event_kind = @eventKind AND
            COALESCE(item_kind, '') = COALESCE(@itemKind, '') AND
            COALESCE(turn_id, '') = COALESCE(@turnId, '') AND
            COALESCE(turn_cursor, '') = COALESCE(@turnCursor, '') AND
            COALESCE(item_id, '') = COALESCE(@itemId, '') AND
            COALESCE(request_id, '') = COALESCE(@requestId, '')
          LIMIT 1
        )
      `)
      .run(record);
    return Number(result.changes ?? 0) > 0;
  }

  listCanonicalThreadEvents(threadId: string, limit: number): CanonicalThreadEventRecord[] {
    return this.selectMany(
      `
        SELECT * FROM canonical_thread_events
        WHERE thread_id = ?
        ORDER BY id DESC
        LIMIT ?
      `,
      [threadId, Math.max(1, Math.floor(limit))],
      (row) => this.mapCanonicalThreadEvent(row)
    ).reverse();
  }

  deleteCanonicalThreadEventsByThread(threadId: string): void {
    this.database
      .prepare(`DELETE FROM canonical_thread_events WHERE thread_id = ?`)
      .run(threadId);
  }

  clearBridgeState(): void {
    this.database.pragma("foreign_keys = OFF");
    try {
      this.database.exec(`
        DROP TABLE IF EXISTS monitor_audit_log;
        DROP TABLE IF EXISTS monitor_cleanup_requests;
        DROP TABLE IF EXISTS monitor_control;
        DROP TABLE IF EXISTS monitor_threads;
        DROP TABLE IF EXISTS monitor_projects;
        DROP TABLE IF EXISTS turn_status_messages;
        DROP TABLE IF EXISTS discord_thread_preferences;
        DROP TABLE IF EXISTS write_back_queue;
        DROP TABLE IF EXISTS canonical_thread_events;
        DROP TABLE IF EXISTS child_thread_anchors;
        DROP TABLE IF EXISTS retained_turns;
        DROP TABLE IF EXISTS proposed_plan_actions;
        DROP TABLE IF EXISTS desktop_log_cursors;
        DROP TABLE IF EXISTS session_log_cursors;
        DROP TABLE IF EXISTS mirrored_item_messages;
        DROP TABLE IF EXISTS mirrored_items;
        DROP TABLE IF EXISTS message_details;
        DROP TABLE IF EXISTS pending_approvals;
        DROP TABLE IF EXISTS audit_log;
        DROP TABLE IF EXISTS thread_bridges;
        DROP TABLE IF EXISTS project_bridges;
        DROP TABLE IF EXISTS schema_meta;
      `);
    } finally {
      this.database.pragma("foreign_keys = ON");
    }
    this.initializeSchema();
  }

  updateStatusMessageId(codexThreadId: string, statusMessageId: string): void {
    this.database
      .prepare(`UPDATE thread_bridges SET status_message_id = ? WHERE codex_thread_id = ?`)
      .run(statusMessageId, codexThreadId);
  }

  createWriteBackQueueItem(input: {
    threadId: string;
    discordChannelId: string;
    actorUserId: string;
    text: string;
    sourceKind?: "slash" | "plain";
    discordMessageId?: string | null;
    requestedModel?: string | null;
    requestedReasoningEffort?: string | null;
    localImagePaths?: string[];
  }): WriteBackQueueRecord {
    const now = new Date().toISOString();
    const result = this.database
      .prepare(`
        INSERT INTO write_back_queue (
          codex_thread_id,
          discord_channel_id,
          actor_user_id,
          text,
          source_kind,
          discord_message_id,
          requested_model,
          requested_reasoning_effort,
          local_image_paths_json,
          mirror_consumed_at,
          status,
          created_at,
          updated_at,
          sent_at,
          error
        ) VALUES (
          @threadId,
          @discordChannelId,
          @actorUserId,
          @text,
          @sourceKind,
          @discordMessageId,
          @requestedModel,
          @requestedReasoningEffort,
          @localImagePathsJson,
          NULL,
          'pending',
          @now,
          @now,
          NULL,
          NULL
        )
      `)
      .run({
        ...input,
        sourceKind: input.sourceKind ?? "slash",
        discordMessageId: input.discordMessageId ?? null,
        requestedModel: input.requestedModel ?? null,
        requestedReasoningEffort: input.requestedReasoningEffort ?? null,
        localImagePathsJson: JSON.stringify(input.localImagePaths ?? []),
        now
      });
    const id = Number(result.lastInsertRowid);
    const record = this.getWriteBackQueueItem(id);
    if (!record) {
      throw new Error(`Failed to create write-back queue item ${id}.`);
    }
    return record;
  }

  setDiscordThreadModelPreference(
    threadId: string,
    requestedModel: string | null,
    requestedReasoningEffort: string | null = null
  ): void {
    const normalized = requestedModel?.trim() || null;
    this.database
      .prepare(`
        INSERT INTO discord_thread_preferences (codex_thread_id, requested_model, requested_reasoning_effort, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(codex_thread_id) DO UPDATE SET
          requested_model = excluded.requested_model,
          requested_reasoning_effort = excluded.requested_reasoning_effort,
          updated_at = excluded.updated_at
      `)
      .run(threadId, normalized, requestedReasoningEffort?.trim() || null, new Date().toISOString());
  }

  getDiscordThreadModelPreference(threadId: string): string | null {
    const row = this.database
      .prepare(`SELECT requested_model FROM discord_thread_preferences WHERE codex_thread_id = ? LIMIT 1`)
      .get(threadId) as { requested_model?: unknown } | undefined;
    return row?.requested_model ? String(row.requested_model) : null;
  }

  claimSentPlainWriteBackForMirror(
    threadId: string,
    itemId: string,
    text: string
  ): WriteBackQueueRecord | null {
    const normalizedText = this.normalizeWriteBackMirrorText(text);
    if (!normalizedText) {
      return null;
    }
    const claim = this.database.transaction(() => {
      const replay = this.database
        .prepare(`
          SELECT * FROM write_back_queue
          WHERE codex_thread_id = ?
            AND source_kind = 'plain'
            AND status = 'sent'
            AND mirror_item_id = ?
          LIMIT 1
        `)
        .get(threadId, itemId) as Record<string, unknown> | undefined;
      if (replay) {
        return this.mapWriteBackQueueRecord(replay);
      }

      const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const candidates = this.database
        .prepare(`
          SELECT * FROM write_back_queue
          WHERE codex_thread_id = ?
            AND source_kind = 'plain'
            AND status = 'sent'
            AND mirror_consumed_at IS NULL
            AND sent_at >= ?
          ORDER BY id ASC
          LIMIT 20
        `)
        .all(threadId, cutoff) as Array<Record<string, unknown>>;
      const textWithoutImageReferences = this.normalizeWriteBackMirrorText(
        text.replace(/<image\b[^>]*>/gi, " ").replace(/<\/image>/gi, " ")
      );
      const candidate = candidates.find((row) => {
        const queuedText = this.normalizeWriteBackMirrorText(String(row.text ?? ""));
        if (queuedText === normalizedText) {
          return true;
        }
        const localImagePaths = this.readStringArrayJson(row.local_image_paths_json);
        return localImagePaths.length > 0 && queuedText === textWithoutImageReferences;
      });
      if (!candidate) {
        return null;
      }
      const now = new Date().toISOString();
      const result = this.database
        .prepare(`
          UPDATE write_back_queue
          SET mirror_consumed_at = ?, mirror_item_id = ?, updated_at = ?
          WHERE id = ? AND mirror_consumed_at IS NULL
        `)
        .run(now, itemId, now, Number(candidate.id));
      if (Number(result.changes ?? 0) === 0) {
        return null;
      }
      return this.getWriteBackQueueItem(Number(candidate.id)) ?? null;
    });
    return claim();
  }

  private normalizeWriteBackMirrorText(text: string): string {
    return text.trim().replace(/\s+/g, " ");
  }

  getWriteBackQueueItem(id: number): WriteBackQueueRecord | undefined {
    return this.selectOne(
      `SELECT * FROM write_back_queue WHERE id = ? LIMIT 1`,
      [id],
      (row) => this.mapWriteBackQueueRecord(row)
    );
  }

  listWriteBackQueueItems(threadId?: string): WriteBackQueueRecord[] {
    return this.selectMany(
      threadId
        ? `SELECT * FROM write_back_queue WHERE codex_thread_id = ? ORDER BY id ASC`
        : `SELECT * FROM write_back_queue ORDER BY id ASC`,
      threadId ? [threadId] : [],
      (row) => this.mapWriteBackQueueRecord(row)
    );
  }

  countPendingWriteBackQueueItems(threadId: string): number {
    const row = this.database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM write_back_queue
        WHERE codex_thread_id = ? AND status = 'pending'
      `)
      .get(threadId) as { count?: unknown } | undefined;
    return Number(row?.count ?? 0);
  }

  claimNextPendingWriteBackQueueItem(threadId: string): WriteBackQueueRecord | null {
    const claim = this.database.transaction(() => {
      const row = this.database
        .prepare(`
          SELECT * FROM write_back_queue
          WHERE codex_thread_id = ? AND status = 'pending'
          ORDER BY id ASC
          LIMIT 1
        `)
        .get(threadId) as Record<string, unknown> | undefined;
      if (!row) {
        return null;
      }
      const id = Number(row.id);
      const now = new Date().toISOString();
      const result = this.database
        .prepare(`
          UPDATE write_back_queue
          SET status = 'sending',
              updated_at = ?,
              error = NULL
          WHERE id = ? AND status = 'pending'
        `)
        .run(now, id);
      if (Number(result.changes ?? 0) === 0) {
        return null;
      }
      return this.getWriteBackQueueItem(id) ?? null;
    });
    return claim();
  }

  claimWriteBackQueueItem(id: number): WriteBackQueueRecord | null {
    const claim = this.database.transaction(() => {
      const now = new Date().toISOString();
      const result = this.database
        .prepare(`
          UPDATE write_back_queue
          SET status = 'sending',
              updated_at = ?,
              error = NULL
          WHERE id = ? AND status = 'pending'
        `)
        .run(now, id);
      if (Number(result.changes ?? 0) === 0) {
        return null;
      }
      return this.getWriteBackQueueItem(id) ?? null;
    });
    return claim();
  }

  markWriteBackQueueItemSent(id: number): void {
    const now = new Date().toISOString();
    this.database
      .prepare(`
        UPDATE write_back_queue
        SET status = 'sent',
            updated_at = ?,
            sent_at = ?,
            error = NULL
        WHERE id = ?
      `)
      .run(now, now, id);
  }

  markWriteBackQueueItemFailed(id: number, error: string): void {
    this.setWriteBackQueueItemTerminalStatus(id, "failed", error);
  }

  markWriteBackQueueItemRetracted(id: number): WriteBackQueueRecord | null {
    return this.transitionPendingWriteBackQueueItem(id, "retracted");
  }

  retractLatestPendingWriteBackQueueItem(threadId: string): WriteBackQueueRecord | null {
    const retract = this.database.transaction(() => {
      const row = this.database
        .prepare(`
          SELECT * FROM write_back_queue
          WHERE codex_thread_id = ? AND status = 'pending'
          ORDER BY id DESC
          LIMIT 1
        `)
        .get(threadId) as Record<string, unknown> | undefined;
      if (!row) {
        return null;
      }
      return this.transitionPendingWriteBackQueueItem(Number(row.id), "retracted");
    });
    return retract();
  }

  restoreWriteBackQueueItemPending(id: number, error: string | null = null): void {
    this.database
      .prepare(`
        UPDATE write_back_queue
        SET status = 'pending',
            updated_at = ?,
            error = ?
        WHERE id = ? AND status = 'sending'
      `)
      .run(new Date().toISOString(), error, id);
  }

  private transitionPendingWriteBackQueueItem(
    id: number,
    status: Extract<WriteBackQueueStatus, "retracted">
  ): WriteBackQueueRecord | null {
    const now = new Date().toISOString();
    const result = this.database
      .prepare(`
        UPDATE write_back_queue
        SET status = ?,
            updated_at = ?,
            error = NULL
        WHERE id = ? AND status = 'pending'
      `)
      .run(status, now, id);
    if (Number(result.changes ?? 0) === 0) {
      return null;
    }
    return this.getWriteBackQueueItem(id) ?? null;
  }

  private setWriteBackQueueItemTerminalStatus(
    id: number,
    status: Extract<WriteBackQueueStatus, "failed">,
    error: string | null
  ): void {
    this.database
      .prepare(`
        UPDATE write_back_queue
        SET status = ?,
            updated_at = ?,
            error = ?
        WHERE id = ?
      `)
      .run(status, new Date().toISOString(), error, id);
  }

  upsertPendingApproval(record: PendingApprovalRecord): void {
    this.database
      .prepare(`
        INSERT INTO pending_approvals (
          token,
          request_id,
          thread_id,
          turn_id,
          feedback_turn_id,
          item_id,
          kind,
          sanitized_preview,
          cwd,
          reason,
          available_decisions,
          decision_payloads,
          expires_at,
          discord_message_id,
          status,
          details,
          created_at,
          restart_disabled_at,
          tool_input
        ) VALUES (
          @token,
          @requestId,
          @threadId,
          @turnId,
          @feedbackTurnId,
          @itemId,
          @kind,
          @sanitizedPreview,
          @cwd,
          @reason,
          @availableDecisions,
          @decisionPayloads,
          @expiresAt,
          @discordMessageId,
          @status,
          @details,
          @createdAt,
          @restartDisabledAt,
          @toolInput
        )
        ON CONFLICT(token) DO UPDATE SET
          request_id = excluded.request_id,
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          feedback_turn_id = excluded.feedback_turn_id,
          item_id = excluded.item_id,
          kind = excluded.kind,
          sanitized_preview = excluded.sanitized_preview,
          cwd = excluded.cwd,
          reason = excluded.reason,
          available_decisions = excluded.available_decisions,
          decision_payloads = excluded.decision_payloads,
          expires_at = excluded.expires_at,
          discord_message_id = excluded.discord_message_id,
          status = excluded.status,
          details = excluded.details,
          created_at = excluded.created_at,
          restart_disabled_at = excluded.restart_disabled_at,
          tool_input = excluded.tool_input
      `)
      .run({
        ...record,
        feedbackTurnId: record.feedbackTurnId ?? null,
        availableDecisions: JSON.stringify(record.availableDecisions),
        decisionPayloads: JSON.stringify(record.decisionPayloads),
        restartDisabledAt: record.restartDisabledAt ?? null,
        toolInput: record.toolInput ? JSON.stringify(record.toolInput) : null
      });
  }

  findPendingApprovalByToken(token: string): PendingApprovalRecord | undefined {
    return this.selectOne(
      `SELECT * FROM pending_approvals WHERE token = ?`,
      [token],
      (row) => this.mapPendingApproval(row)
    );
  }

  findPendingApprovalByRequestId(requestId: string): PendingApprovalRecord | undefined {
    return this.selectOne(
      `SELECT * FROM pending_approvals WHERE request_id = ? ORDER BY created_at DESC LIMIT 1`,
      [requestId],
      (row) => this.mapPendingApproval(row)
    );
  }

  findPendingApprovalByItem(threadId: string, itemId: string, kind: string): PendingApprovalRecord | undefined {
    return this.selectOne(
      `
        SELECT * FROM pending_approvals
        WHERE thread_id = ? AND item_id = ? AND kind = ?
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [threadId, itemId, kind],
      (row) => this.mapPendingApproval(row)
    );
  }

  listPendingApprovals(): PendingApprovalRecord[] {
    return this.selectMany(
      `SELECT * FROM pending_approvals ORDER BY created_at DESC`,
      [],
      (row) => this.mapPendingApproval(row)
    );
  }

  listActionableApprovals(): PendingApprovalRecord[] {
    return this.selectMany(
      `
        SELECT * FROM pending_approvals
        WHERE status IN ('pending', 'decisionSent') AND restart_disabled_at IS NULL
        ORDER BY created_at DESC
      `,
      [],
      (row) => this.mapPendingApproval(row)
    );
  }

  refreshPendingApprovalRecord(previousToken: string, record: PendingApprovalRecord): void {
    this.database
      .prepare(`
        UPDATE pending_approvals
        SET
          token = @token,
          request_id = @requestId,
          thread_id = @threadId,
          turn_id = @turnId,
          feedback_turn_id = @feedbackTurnId,
          item_id = @itemId,
          kind = @kind,
          sanitized_preview = @sanitizedPreview,
          cwd = @cwd,
          reason = @reason,
          available_decisions = @availableDecisions,
          decision_payloads = @decisionPayloads,
          expires_at = @expiresAt,
          discord_message_id = @discordMessageId,
          status = @status,
          details = @details,
          created_at = @createdAt,
          restart_disabled_at = @restartDisabledAt,
          tool_input = @toolInput
        WHERE token = @previousToken
      `)
      .run({
        previousToken,
        ...record,
        feedbackTurnId: record.feedbackTurnId ?? null,
        availableDecisions: JSON.stringify(record.availableDecisions),
        decisionPayloads: JSON.stringify(record.decisionPayloads),
        restartDisabledAt: record.restartDisabledAt ?? null,
        toolInput: record.toolInput ? JSON.stringify(record.toolInput) : null
      });
  }

  setPendingApprovalToolInputSelection(
    token: string,
    questionId: string,
    answer: string
  ): PendingApprovalRecord | undefined {
    const record = this.findPendingApprovalByToken(token);
    if (!record?.toolInput) {
      return record;
    }
    const toolInput = {
      ...record.toolInput,
      selectedAnswers: {
        ...record.toolInput.selectedAnswers,
        [questionId]: answer
      }
    };
    this.database
      .prepare(`UPDATE pending_approvals SET tool_input = ? WHERE token = ?`)
      .run(JSON.stringify(toolInput), token);
    return {
      ...record,
      toolInput
    };
  }

  setPendingApprovalStatus(token: string, status: PendingApprovalRecord["status"]): void {
    this.database
      .prepare(`
        UPDATE pending_approvals
        SET
          status = @status,
          restart_disabled_at = CASE WHEN @status = 'pending' THEN restart_disabled_at ELSE NULL END
        WHERE token = @token
      `)
      .run({ token, status });
  }

  setPendingApprovalStatusByRequestId(requestId: string, status: PendingApprovalRecord["status"]): void {
    this.database
      .prepare(`
        UPDATE pending_approvals
        SET
          status = @status,
          restart_disabled_at = CASE WHEN @status = 'pending' THEN restart_disabled_at ELSE NULL END
        WHERE request_id = @requestId
      `)
      .run({ requestId, status });
  }

  setPendingApprovalMessageId(token: string, discordMessageId: string): void {
    this.database
      .prepare(`UPDATE pending_approvals SET discord_message_id = ? WHERE token = ?`)
      .run(discordMessageId, token);
  }

  setPendingApprovalRestartDisabled(token: string, restartDisabledAt: string | null): void {
    this.database
      .prepare(`UPDATE pending_approvals SET restart_disabled_at = ? WHERE token = ?`)
      .run(restartDisabledAt, token);
  }

  clearPendingApprovalMessageIdsByThread(threadId: string): void {
    this.database
      .prepare(`UPDATE pending_approvals SET discord_message_id = NULL WHERE thread_id = ?`)
      .run(threadId);
  }

  deletePendingApproval(token: string): void {
    this.database
      .prepare(`DELETE FROM pending_approvals WHERE token = ?`)
      .run(token);
  }

  appendAuditLog(record: AuditLogRecord): void {
    this.database
      .prepare(`
        INSERT INTO audit_log (
          timestamp,
          discord_user_id,
          thread_id,
          turn_id,
          request_id,
          decision,
          sanitized_preview
        ) VALUES (
          @timestamp,
          @discordUserId,
          @threadId,
          @turnId,
          @requestId,
          @decision,
          @sanitizedPreview
        )
      `)
      .run(record);
  }

  deleteAuditLogOlderThan(cutoffIso: string): number {
    const result = this.database
      .prepare(`DELETE FROM audit_log WHERE timestamp < ?`)
      .run(cutoffIso);
    return Number(result.changes ?? 0);
  }

  deleteInactiveApprovalsOlderThan(cutoffIso: string): number {
    const result = this.database
      .prepare(`
        DELETE FROM pending_approvals
        WHERE status IN ('approved', 'rejected', 'expired', 'stale') AND created_at < ?
      `)
      .run(cutoffIso);
    return Number(result.changes ?? 0);
  }

  close(): void {
    this.database.close();
  }

  private selectOne<Row extends Record<string, unknown>, Value>(
    sql: string,
    params: unknown[],
    mapRow: (row: Row) => Value
  ): Value | undefined {
    const row = this.database.prepare(sql).get(...params) as Row | undefined;
    return row ? mapRow(row) : undefined;
  }

  private selectMany<Row extends Record<string, unknown>, Value>(
    sql: string,
    params: unknown[],
    mapRow: (row: Row) => Value
  ): Value[] {
    return (this.database.prepare(sql).all(...params) as Row[]).map((row) => mapRow(row));
  }

  private readNullableNumber(value: unknown): number | null {
    if (typeof value === "number") {
      return value;
    }
    if (value === null || value === undefined) {
      return null;
    }
    return Number(value);
  }

  private readNumber(value: unknown): number {
    return typeof value === "number" ? value : Number(value);
  }

  getDiscordThreadReasoningEffortPreference(threadId: string): string | null {
    const row = this.database
      .prepare(`SELECT requested_reasoning_effort FROM discord_thread_preferences WHERE codex_thread_id = ? LIMIT 1`)
      .get(threadId) as { requested_reasoning_effort?: unknown } | undefined;
    return row?.requested_reasoning_effort ? String(row.requested_reasoning_effort) : null;
  }

  private readStringArrayJson(value: unknown): string[] {
    if (typeof value !== "string" || !value.trim()) {
      return [];
    }
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        : [];
    } catch {
      return [];
    }
  }

  private createMonitorProjectToken(projectKey: string): string {
    return `prj_${createHash("sha256").update(projectKey).digest("hex").slice(0, 20)}`;
  }

  private mapMonitorProject(row: Record<string, unknown>): MonitorProjectRecord {
    return {
      projectKey: String(row.project_key),
      projectToken: String(row.project_token),
      projectName: String(row.project_name),
      enabled: Number(row.enabled) === 1,
      updatedBy: row.updated_by ? String(row.updated_by) : null,
      updatedAt: String(row.updated_at)
    };
  }

  private mapMonitorThread(row: Record<string, unknown>): MonitorThreadRecord {
    return {
      threadId: String(row.thread_id),
      projectKey: String(row.project_key),
      threadName: row.thread_name ? String(row.thread_name) : null,
      threadStatus:
        row.thread_status === "active" || row.thread_status === "notLoaded" || row.thread_status === "systemError"
          ? row.thread_status
          : "idle",
      selected: Number(row.selected) === 1,
      pausedDiscordChannelId: row.paused_discord_channel_id
        ? String(row.paused_discord_channel_id)
        : null,
      lastSeenAt: String(row.last_seen_at),
      updatedBy: row.updated_by ? String(row.updated_by) : null,
      updatedAt: String(row.updated_at)
    };
  }

  private mapMonitorControl(row: Record<string, unknown>): MonitorControlRecord {
    return {
      guildId: String(row.guild_id),
      channelId: String(row.channel_id),
      messageId: String(row.message_id),
      updatedAt: String(row.updated_at)
    };
  }

  private mapMonitorCleanupRequest(
    row: Record<string, unknown>
  ): MonitorCleanupRequestRecord {
    return {
      token: String(row.token),
      actorUserId: String(row.actor_user_id),
      threadIds: JSON.parse(String(row.thread_ids)) as string[],
      selectionVersion: String(row.selection_version),
      expiresAt: String(row.expires_at),
      consumedAt: row.consumed_at ? String(row.consumed_at) : null
    };
  }

  private mapMonitorAudit(row: Record<string, unknown>): MonitorAuditRecord {
    return {
      id: Number(row.id),
      timestamp: String(row.timestamp),
      actorUserId: String(row.actor_user_id),
      action: String(row.action),
      projectKey: row.project_key ? String(row.project_key) : null,
      threadId: row.thread_id ? String(row.thread_id) : null,
      detail: row.detail ? String(row.detail) : null
    };
  }

  private mapProjectBridge(row: Record<string, unknown>): ProjectBridgeRecord {
    return {
      projectKey: String(row.project_key),
      projectName: String(row.project_name),
      discordCategoryId: String(row.discord_category_id),
      createdByBridge: Number(row.created_by_bridge) === 1,
      updatedAt: String(row.updated_at)
    };
  }

  private mapPendingApproval(row: ApprovalRow): PendingApprovalRecord {
    return {
      token: String(row.token),
      requestId: String(row.request_id),
      threadId: String(row.thread_id),
      turnId: String(row.turn_id),
      feedbackTurnId: row.feedback_turn_id ? String(row.feedback_turn_id) : null,
      itemId: String(row.item_id),
      kind: String(row.kind) as PendingApprovalRecord["kind"],
      sanitizedPreview: String(row.sanitized_preview),
      cwd: row.cwd ? String(row.cwd) : null,
      reason: row.reason ? String(row.reason) : null,
      availableDecisions: JSON.parse(String(row.available_decisions)) as string[],
      decisionPayloads: row.decision_payloads
        ? (JSON.parse(String(row.decision_payloads)) as Record<string, unknown>)
        : {},
      expiresAt: String(row.expires_at),
      discordMessageId: row.discord_message_id ? String(row.discord_message_id) : null,
      status: String(row.status) as PendingApprovalRecord["status"],
      details: String(row.details),
      createdAt: String(row.created_at),
      restartDisabledAt: row.restart_disabled_at ? String(row.restart_disabled_at) : null,
      toolInput: row.tool_input
        ? (JSON.parse(String(row.tool_input)) as NonNullable<PendingApprovalRecord["toolInput"]>)
        : null
    };
  }

  private mapThreadBridge(row: Record<string, unknown>): ThreadBridgeRecord {
    return {
      codexThreadId: String(row.codex_thread_id),
      parentCodexThreadId: row.parent_codex_thread_id ? String(row.parent_codex_thread_id) : null,
      parentAnchorTurnId: row.parent_anchor_turn_id ? String(row.parent_anchor_turn_id) : null,
      parentAnchorTurnCursor: row.parent_anchor_turn_cursor ? String(row.parent_anchor_turn_cursor) : null,
      projectKey: row.project_key ? String(row.project_key) : "no-workspace",
      projectName: row.project_name ? String(row.project_name) : "No Workspace",
      discordChannelId: String(row.discord_channel_id),
      discordParentChannelId: row.discord_parent_channel_id ? String(row.discord_parent_channel_id) : null,
      statusMessageId: row.status_message_id ? String(row.status_message_id) : null,
      cwd: row.cwd ? String(row.cwd) : null,
      repoName: row.repo_name ? String(row.repo_name) : null,
      lastSeenAt: String(row.last_seen_at),
      attachMode: row.attach_mode === "manual" ? "manual" : "auto",
      threadName: row.thread_name ? String(row.thread_name) : null,
      actorName: row.actor_name ? String(row.actor_name) : null,
      lastStatusType: row.last_status_type ? String(row.last_status_type) : null,
      lastTurnId: row.last_turn_id ? String(row.last_turn_id) : null,
      lastTurnStatus: row.last_turn_status ? String(row.last_turn_status) : null,
      channelKind: row.channel_kind === "subagent" ? "subagent" : "conversation",
      sourceKind: row.source_kind === "cli-session" ? "cli-session" : "app-server",
      latestMirroredTimestampMs: this.readNullableNumber(row.latest_mirrored_timestamp_ms),
      latestMirroredCursor: row.latest_mirrored_cursor ? String(row.latest_mirrored_cursor) : null,
      latestMirroredTurnCursor: row.latest_mirrored_turn_cursor ? String(row.latest_mirrored_turn_cursor) : null,
      latestMirroredSourceFilePath: row.latest_mirrored_source_file_path
        ? String(row.latest_mirrored_source_file_path)
        : null,
      latestMirroredSourceOffset: this.readNullableNumber(row.latest_mirrored_source_offset),
      latestMirroredSourceEventKey: row.latest_mirrored_source_event_key
        ? String(row.latest_mirrored_source_event_key)
        : null
    };
  }

  private mapTurnStatusMessage(row: Record<string, unknown>): TurnStatusMessageRecord {
    return {
      threadId: String(row.thread_id),
      turnId: String(row.turn_id),
      discordMessageId: String(row.discord_message_id),
      targetKind:
        row.target_kind === "commentary" || row.target_kind === "answer"
          ? row.target_kind
          : "fallback",
      statusKind: String(row.status_kind) as TurnStatusMessageRecord["statusKind"],
      errorReason: row.error_reason ? String(row.error_reason) : null,
      planCurrentStep: this.readNullableNumber(row.plan_current_step),
      planTotalSteps: this.readNullableNumber(row.plan_total_steps),
      planCurrentStepText: row.plan_current_step_text ? String(row.plan_current_step_text) : null,
      planAllStepsCompleted: Number(row.plan_all_steps_completed) === 1,
      updatedAt: String(row.updated_at)
    };
  }

  private mapMirroredItem(row: Record<string, unknown>): MirroredItemRecord {
    const threadId = String(row.thread_id);
    const itemId = String(row.item_id);
    const discordMessageId = String(row.discord_message_id);
    const discordMessageIds = this.listMirroredItemMessageIds(threadId, itemId);
    return {
      threadId,
      itemId,
      turnId: row.turn_id ? String(row.turn_id) : null,
      kind: String(row.kind) as MirroredItemRecord["kind"],
      discordMessageId,
      discordMessageIds: discordMessageIds.length > 0 ? discordMessageIds : [discordMessageId],
      groupKey: row.group_key ? String(row.group_key) : null,
      contentSignature: String(row.content_signature),
      renderedContent: String(row.rendered_content),
      timestampMs: this.readNullableNumber(row.timestamp_ms),
      cursor: row.cursor ? String(row.cursor) : null,
      turnCursor: row.turn_cursor ? String(row.turn_cursor) : null,
      updatedAt: String(row.updated_at)
    };
  }

  private normalizeMirroredItemMessageIds(
    rawMessageIds: string[] | undefined,
    fallbackMessageId: string | null
  ): string[] {
    const candidates = [
      ...(Array.isArray(rawMessageIds) ? rawMessageIds : []),
      ...(fallbackMessageId ? [fallbackMessageId] : [])
    ];
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (typeof candidate !== "string") {
        continue;
      }
      const trimmed = candidate.trim();
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      normalized.push(trimmed);
    }
    return normalized;
  }

  private mapMessageDetail(row: Record<string, unknown>): MessageDetailRecord {
    return {
      token: String(row.token),
      threadId: String(row.thread_id),
      kind: String(row.kind) as MessageDetailRecord["kind"],
      title: String(row.title),
      buttonLabel: String(row.button_label ?? "Show details"),
      detail: String(row.detail),
      discordMessageId: row.discord_message_id ? String(row.discord_message_id) : null,
      expiresAt: String(row.expires_at),
      updatedAt: String(row.updated_at)
    };
  }

  private mapProposedPlanActionRecord(row: Record<string, unknown>): ProposedPlanActionRecord {
    const status = String(row.status ?? "");
    return {
      token: String(row.token),
      threadId: String(row.thread_id),
      turnId: row.turn_id ? String(row.turn_id) : null,
      itemId: String(row.item_id),
      planText: String(row.plan_text),
      status:
        status === "pending" ||
        status === "sending" ||
        status === "accepted" ||
        status === "feedbackSent" ||
        status === "failed"
          ? status
          : "failed",
      discordMessageId: row.discord_message_id ? String(row.discord_message_id) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      completedAt: row.completed_at ? String(row.completed_at) : null,
      expiresAt: String(row.expires_at),
      error: row.error ? String(row.error) : null
    };
  }

  private mapSessionLogCursor(row: Record<string, unknown>): SessionLogCursorRecord {
    return {
      threadId: String(row.thread_id),
      filePath: String(row.file_path),
      byteOffset: this.readNumber(row.byte_offset),
      updatedAt: String(row.updated_at)
    };
  }

  private mapDesktopLogCursor(row: Record<string, unknown>): DesktopLogCursorRecord {
    return {
      filePath: String(row.file_path),
      byteOffset: this.readNumber(row.byte_offset),
      updatedAt: String(row.updated_at)
    };
  }

  private mapRetainedTurn(row: Record<string, unknown>): RetainedTurnRecord {
    const source = String(row.source ?? "");
    return {
      threadId: String(row.thread_id),
      turnKey: String(row.turn_key),
      turnId: row.turn_id ? String(row.turn_id) : null,
      turnCursor: row.turn_cursor ? String(row.turn_cursor) : null,
      anchorItemId: row.anchor_item_id ? String(row.anchor_item_id) : null,
      anchorText: row.anchor_text ? String(row.anchor_text) : null,
      source: source === "session" || source === "codex-read" ? source : "codex-read",
      updatedAt: String(row.updated_at)
    };
  }

  private mapChildThreadAnchor(row: Record<string, unknown>): ChildThreadAnchorRecord {
    const source = String(row.source ?? "");
    return {
      childThreadId: String(row.child_thread_id),
      parentThreadId: String(row.parent_thread_id),
      parentTurnId: row.parent_turn_id ? String(row.parent_turn_id) : null,
      parentTurnCursor: row.parent_turn_cursor ? String(row.parent_turn_cursor) : null,
      source: source === "session" || source === "codex-read" ? source : "codex-read",
      updatedAt: String(row.updated_at)
    };
  }

  private mapCanonicalThreadEvent(row: Record<string, unknown>): CanonicalThreadEventRecord {
    const source = String(row.source ?? "");
    const eventKind = String(row.event_kind ?? "");
    return {
      id: this.readNumber(row.id),
      threadId: String(row.thread_id),
      source:
        source === "session" ||
        source === "desktop-ipc" ||
        source === "app-server" ||
        source === "discord" ||
        source === "codex-read"
          ? source
          : "app-server",
      eventKind:
        eventKind === "content" ||
        eventKind === "childAnchor" ||
        eventKind === "approvalUpsert" ||
        eventKind === "approvalResolved" ||
        eventKind === "status" ||
        eventKind === "ignoredHint" ||
        eventKind === "approvalHold" ||
        eventKind === "approvalRelease" ||
        eventKind === "writeBackQueued" ||
        eventKind === "writeBackSent" ||
        eventKind === "writeBackFailed" ||
        eventKind === "writeBackRetracted"
          ? eventKind
          : "content",
      itemKind: row.item_kind ? String(row.item_kind) : null,
      turnId: row.turn_id ? String(row.turn_id) : null,
      turnCursor: row.turn_cursor ? String(row.turn_cursor) : null,
      itemId: row.item_id ? String(row.item_id) : null,
      requestId: row.request_id ? String(row.request_id) : null,
      summary: row.summary ? String(row.summary) : null,
      detail: row.detail ? String(row.detail) : null,
      createdAt: String(row.created_at)
    };
  }

  private mapWriteBackQueueRecord(row: Record<string, unknown>): WriteBackQueueRecord {
    const status = String(row.status ?? "");
    return {
      id: this.readNumber(row.id),
      threadId: String(row.codex_thread_id),
      discordChannelId: String(row.discord_channel_id),
      actorUserId: String(row.actor_user_id),
      text: String(row.text),
      sourceKind: String(row.source_kind) === "plain" ? "plain" : "slash",
      discordMessageId: row.discord_message_id ? String(row.discord_message_id) : null,
      requestedModel: row.requested_model ? String(row.requested_model) : null,
      requestedReasoningEffort: row.requested_reasoning_effort ? String(row.requested_reasoning_effort) : null,
      localImagePaths: this.readStringArrayJson(row.local_image_paths_json),
      mirrorConsumedAt: row.mirror_consumed_at ? String(row.mirror_consumed_at) : null,
      status:
        status === "pending" ||
        status === "sending" ||
        status === "sent" ||
        status === "failed" ||
        status === "retracted"
          ? status
          : "failed",
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      sentAt: row.sent_at ? String(row.sent_at) : null,
      error: row.error ? String(row.error) : null
    };
  }
}
