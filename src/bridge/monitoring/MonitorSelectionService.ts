import type {
  MonitorProjectRecord,
  MonitorThreadRecord
} from "../../domain.js";
import type { StateStore } from "../../store/StateStore.js";

export const MONITOR_PICKER_PAGE_SIZE = 20;
export const MONITOR_ACTIVE_WINDOW_HOURS = [6, 12, 24] as const;
export const DEFAULT_MONITOR_ACTIVE_WINDOW_HOURS = 24;
export const DEFAULT_AUTOMATIC_PROJECT_LIMIT = 5;
export const DEFAULT_AUTOMATIC_THREAD_LIMIT = 5;
export const MAX_AUTOMATIC_PROJECT_LIMIT = 20;
export const MAX_AUTOMATIC_THREAD_LIMIT = 20;

type MonitorActiveWindowHours = (typeof MONITOR_ACTIVE_WINDOW_HOURS)[number];
export type MonitorManagementMode = "manual" | "automatic";

export interface MonitorManagementSettings {
  mode: MonitorManagementMode;
  projectLimit: number;
  threadLimit: number;
}

const MONITOR_ACTIVE_WINDOW_META_KEY = "monitor-active-window-hours";
const MONITOR_MANAGEMENT_MODE_META_KEY = "monitor-management-mode";
const MONITOR_AUTOMATIC_PROJECT_LIMIT_META_KEY = "monitor-automatic-project-limit";
const MONITOR_AUTOMATIC_THREAD_LIMIT_META_KEY = "monitor-automatic-thread-limit";

export interface MonitorDiscoveryRecord {
  threadId: string;
  projectKey: string;
  projectName: string;
  threadName: string | null;
  threadStatus?: "active" | "idle" | "notLoaded" | "systemError";
  lastSeenAt: string;
  recencyAt?: string;
}

export interface MonitorPage<T> {
  items: T[];
  page: number;
  pageCount: number;
  total: number;
}

export class MonitorSelectionService {
  private readonly allowedThreadIds: ReadonlySet<string> | null;

  constructor(
    private readonly store: StateStore,
    allowedThreadIds?: readonly string[] | null,
    private readonly selectiveMonitoring = true
  ) {
    this.allowedThreadIds = allowedThreadIds?.length ? new Set(allowedThreadIds) : null;
  }

  recordDiscovery(record: MonitorDiscoveryRecord): void {
    this.store.upsertDiscoveredMonitorThread(record);
  }

  isEffectivelySelected(threadId: string): boolean {
    if (!this.isWithinConfiguredScope(threadId)) {
      return false;
    }
    if (!this.selectiveMonitoring) {
      return true;
    }
    const thread = this.store.getMonitorThread(threadId);
    if (!thread?.selected) {
      return false;
    }
    return this.store.getMonitorProject(thread.projectKey)?.enabled === true;
  }

  isExplicitlySelected(threadId: string): boolean {
    return this.selectiveMonitoring && this.isEffectivelySelected(threadId);
  }

  isWithinConfiguredScope(threadId: string): boolean {
    return !this.allowedThreadIds || this.allowedThreadIds.has(threadId);
  }

  setProjectEnabled(projectKey: string, enabled: boolean, actorUserId: string): void {
    this.store.setMonitorProjectEnabled(projectKey, enabled, actorUserId);
  }

  setThreadSelected(threadId: string, selected: boolean, actorUserId: string): void {
    this.store.setMonitorThreadSelected(threadId, selected, actorUserId);
  }

  getActiveWindowHours(): MonitorActiveWindowHours {
    const stored = Number(this.store.getBridgeMetaValue(MONITOR_ACTIVE_WINDOW_META_KEY));
    return MONITOR_ACTIVE_WINDOW_HOURS.includes(stored as MonitorActiveWindowHours)
      ? (stored as MonitorActiveWindowHours)
      : DEFAULT_MONITOR_ACTIVE_WINDOW_HOURS;
  }

  setActiveWindowHours(hours: number): MonitorActiveWindowHours {
    if (!MONITOR_ACTIVE_WINDOW_HOURS.includes(hours as MonitorActiveWindowHours)) {
      throw new Error(`Unsupported monitor active window: ${hours}`);
    }
    const selected = hours as MonitorActiveWindowHours;
    this.store.setBridgeMetaValue(MONITOR_ACTIVE_WINDOW_META_KEY, String(selected));
    return selected;
  }

  getManagementSettings(): MonitorManagementSettings {
    return {
      mode: this.store.getBridgeMetaValue(MONITOR_MANAGEMENT_MODE_META_KEY) === "automatic"
        ? "automatic"
        : "manual",
      projectLimit: this.readAutomaticLimit(
        MONITOR_AUTOMATIC_PROJECT_LIMIT_META_KEY,
        DEFAULT_AUTOMATIC_PROJECT_LIMIT,
        MAX_AUTOMATIC_PROJECT_LIMIT
      ),
      threadLimit: this.readAutomaticLimit(
        MONITOR_AUTOMATIC_THREAD_LIMIT_META_KEY,
        DEFAULT_AUTOMATIC_THREAD_LIMIT,
        MAX_AUTOMATIC_THREAD_LIMIT
      )
    };
  }

  setAutomaticSettings(projectLimit: number, threadLimit: number): MonitorManagementSettings {
    const normalizedProjectLimit = this.normalizeAutomaticLimit(
      projectLimit,
      MAX_AUTOMATIC_PROJECT_LIMIT,
      "project"
    );
    const normalizedThreadLimit = this.normalizeAutomaticLimit(
      threadLimit,
      MAX_AUTOMATIC_THREAD_LIMIT,
      "conversation"
    );
    this.store.setBridgeMetaValue(MONITOR_MANAGEMENT_MODE_META_KEY, "automatic");
    this.store.setBridgeMetaValue(
      MONITOR_AUTOMATIC_PROJECT_LIMIT_META_KEY,
      String(normalizedProjectLimit)
    );
    this.store.setBridgeMetaValue(
      MONITOR_AUTOMATIC_THREAD_LIMIT_META_KEY,
      String(normalizedThreadLimit)
    );
    return this.getManagementSettings();
  }

  setManualMode(): MonitorManagementSettings {
    this.store.setBridgeMetaValue(MONITOR_MANAGEMENT_MODE_META_KEY, "manual");
    return this.getManagementSettings();
  }

  listProjects(page = 0): MonitorPage<MonitorProjectRecord> {
    return this.paginate(this.store.listMonitorProjects(), page);
  }

  listActiveProjects(page = 0, nowMs = Date.now()): MonitorPage<MonitorProjectRecord> {
    const activeProjectKeys = new Set(
      this.store
        .listMonitorThreads()
        .filter((thread) => this.isActiveThread(thread, nowMs))
        .map((thread) => thread.projectKey)
    );
    return this.paginate(
      this.store.listMonitorProjects().filter((project) => activeProjectKeys.has(project.projectKey)),
      page
    );
  }

  listThreads(projectKey: string, page = 0): MonitorPage<MonitorThreadRecord> {
    return this.paginate(this.store.listMonitorThreads(projectKey), page);
  }

  listActiveThreads(projectKey: string, page = 0, nowMs = Date.now()): MonitorPage<MonitorThreadRecord> {
    return this.paginate(
      this.store
        .listMonitorThreads(projectKey)
        .filter((thread) => this.isActiveThread(thread, nowMs)),
      page
    );
  }

  private isActiveThread(thread: MonitorThreadRecord, nowMs: number): boolean {
    if (thread.threadStatus === "active") {
      return true;
    }
    const lastSeenMs = Date.parse(thread.lastSeenAt);
    return (
      Number.isFinite(lastSeenMs) &&
      lastSeenMs >= nowMs - this.getActiveWindowHours() * 60 * 60 * 1000
    );
  }

  private readAutomaticLimit(key: string, fallback: number, maximum: number): number {
    const stored = Number(this.store.getBridgeMetaValue(key));
    return Number.isSafeInteger(stored) && stored >= 1 && stored <= maximum
      ? stored
      : fallback;
  }

  private normalizeAutomaticLimit(value: number, maximum: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`${label} limit must be an integer from 1 to ${maximum}`);
    }
    return value;
  }

  private paginate<T>(items: T[], requestedPage: number): MonitorPage<T> {
    const pageCount = Math.max(1, Math.ceil(items.length / MONITOR_PICKER_PAGE_SIZE));
    const page = Math.max(0, Math.min(Math.floor(requestedPage), pageCount - 1));
    const start = page * MONITOR_PICKER_PAGE_SIZE;
    return {
      items: items.slice(start, start + MONITOR_PICKER_PAGE_SIZE),
      page,
      pageCount,
      total: items.length
    };
  }
}
