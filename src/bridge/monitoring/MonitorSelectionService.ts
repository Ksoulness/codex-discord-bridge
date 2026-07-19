import type {
  MonitorProjectRecord,
  MonitorThreadRecord
} from "../../domain.js";
import type { StateStore } from "../../store/StateStore.js";

export const MONITOR_PICKER_PAGE_SIZE = 20;
export const MONITOR_ACTIVE_WINDOW_HOURS = [6, 12, 24] as const;
export const DEFAULT_MONITOR_ACTIVE_WINDOW_HOURS = 24;

type MonitorActiveWindowHours = (typeof MONITOR_ACTIVE_WINDOW_HOURS)[number];

const MONITOR_ACTIVE_WINDOW_META_KEY = "monitor-active-window-hours";

export interface MonitorDiscoveryRecord {
  threadId: string;
  projectKey: string;
  projectName: string;
  threadName: string | null;
  threadStatus?: "active" | "idle" | "notLoaded" | "systemError";
  lastSeenAt: string;
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
    if (this.allowedThreadIds && !this.allowedThreadIds.has(threadId)) {
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
