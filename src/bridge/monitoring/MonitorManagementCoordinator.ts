import { createHash } from "node:crypto";
import type {
  DiscordCommandButton,
  DiscordCommandResult,
  DiscordSelectOption,
  MonitorProjectRecord,
  MonitorThreadRecord
} from "../../domain.js";
import type { Policy } from "../../policy/Policy.js";
import type {
  BridgeProvider,
  ProviderActorContext
} from "../../providers/types.js";
import type { StateStore } from "../../store/StateStore.js";
import type { MonitorLifecycleCoordinator } from "./MonitorLifecycleCoordinator.js";
import {
  MONITOR_ACTIVE_WINDOW_HOURS,
  MONITOR_PICKER_PAGE_SIZE,
  type MonitorPage,
  type MonitorSelectionService
} from "./MonitorSelectionService.js";

const MONITOR_CONTROL_SCOPE = "discord";
const CLEANUP_REQUEST_TTL_MS = 10 * 60 * 1000;
const SCHEDULED_REFRESH_ACTOR = "scheduled-monitor-refresh";
const DEFAULT_NEW_THREAD_MODEL_META_KEY = "discord-new-thread-default-model";
const DEFAULT_NEW_THREAD_REASONING_META_KEY = "discord-new-thread-default-reasoning-effort";
const FALLBACK_NEW_THREAD_MODEL = "gpt-5.6-terra";
const FALLBACK_NEW_THREAD_REASONING = "medium";

type LifecycleActions = Pick<
  MonitorLifecycleCoordinator,
  "pauseThread" | "resumeThread" | "cleanPausedThreads"
>;

interface AutomaticMonitorActions {
  reconcile(force?: boolean): Promise<{
    enabled: boolean;
    changed: boolean;
    projectCount: number;
    threadCount: number;
    errors: string[];
  }>;
}

export class MonitorManagementCoordinator {
  private lastPanelSignature: string | null = null;
  private fullRefreshPromise: Promise<void> | null = null;

  constructor(
    private readonly store: StateStore,
    private readonly policy: Policy,
    private readonly provider: BridgeProvider,
    private readonly selection: MonitorSelectionService,
    private readonly lifecycle: LifecycleActions,
    private readonly controllerUserId: string | null,
    private readonly refreshInventory: (() => Promise<number>) | null = null,
    private readonly listModels: () => Promise<Array<{
      id: string;
      displayName: string;
      defaultReasoningEffort: string | null;
      supportedReasoningEfforts: string[];
    }>> = async () => [],
    private readonly automaticMonitor: AutomaticMonitorActions | null = null,
    private readonly refreshManagedState: (() => Promise<void>) | null = null
  ) {}

  buildPanelView(): DiscordCommandResult {
    const projects = this.store.listMonitorProjects();
    const threads = this.store.listMonitorThreads();
    const enabledProjects = projects.filter((project) => project.enabled).length;
    const selectedThreads = threads.filter((thread) => thread.selected).length;
    const activeThreads = threads.filter((thread) => this.store.getThreadBridge(thread.threadId)).length;
    const projectsByKey = new Map(projects.map((project) => [project.projectKey, project]));
    const pausedCopies = threads.filter((thread) => {
      const project = projectsByKey.get(thread.projectKey);
      return project ? this.isCleanableDiscordCopy(project, thread) : false;
    }).length;
    const activeWindowHours = this.selection.getActiveWindowHours();
    const defaultModel = this.store.getBridgeMetaValue(DEFAULT_NEW_THREAD_MODEL_META_KEY) ?? FALLBACK_NEW_THREAD_MODEL;
    const defaultReasoning = this.store.getBridgeMetaValue(DEFAULT_NEW_THREAD_REASONING_META_KEY) ?? FALLBACK_NEW_THREAD_REASONING;
    const settings = this.selection.getManagementSettings();
    const automatic = settings.mode === "automatic";
    return {
      content: [
        "# Codex 监控管理",
        automatic
          ? `当前模式：自动管理。保留最近 ${settings.projectLimit} 个项目，每个项目最近 ${settings.threadLimit} 个对话。`
          : "当前模式：手动管理。只同步你手动勾选的项目和对话。",
        automatic
          ? "按 Codex 最近回复时间自动新增、删除和排序，不设置过期时间。"
          : `候选范围：最近 ${activeWindowHours} 小时内完成的对话，以及所有正在进行的对话。`,
        "",
        `项目：${enabledProjects}/${projects.length} 已开启`,
        `对话：${selectedThreads}/${threads.length} 已勾选，${activeThreads} 个同步中`,
        `已停止且待完整刷新清理的 Discord 副本：${pausedCopies}`,
        `新对话默认模型：${defaultModel} · ${defaultReasoning}`,
        "",
        "完整刷新每 10 分钟自动执行，也可手动触发；手动刷新不影响定时。",
        automatic
          ? "自动淘汰只删除 Discord 副本和 Bridge 映射，不删除 Codex 对话、项目或文件。"
          : "停止监控会暂时保留历史并显示白灯；下次完整刷新会删除停用的 Discord 副本。"
      ].join("\n"),
      ephemeral: false,
      buttons: automatic
        ? [
            { customId: "codex:monitor:manual", label: "切换为手动管理", style: "secondary" },
            {
              customId: `codex:monitor:auto-settings:${settings.projectLimit}:${settings.threadLimit}`,
              label: "自动管理设置",
              style: "primary"
            },
            { customId: "codex:monitor:default-model", label: "默认模型", style: "secondary" },
            { customId: "codex:monitor:refresh", label: "刷新", style: "secondary" }
          ]
        : [
            {
              customId: `codex:monitor:auto-settings:${settings.projectLimit}:${settings.threadLimit}`,
              label: "启用自动管理",
              style: "primary"
            },
            { customId: "codex:monitor:projects:0", label: "选择项目", style: "primary" },
            { customId: "codex:monitor:thread-projects:0", label: "选择对话", style: "primary" },
            { customId: "codex:monitor:default-model", label: "默认模型", style: "secondary" },
            { customId: "codex:monitor:refresh", label: "刷新", style: "secondary" }
          ],
      selectMenus: automatic ? [] : [
        {
          customId: "codex:monitor:window",
          placeholder: `活跃范围：最近 ${activeWindowHours} 小时`,
          minValues: 1,
          maxValues: 1,
          options: MONITOR_ACTIVE_WINDOW_HOURS.map((hours) => ({
            label: `最近 ${hours} 小时`,
            value: String(hours),
            description: hours === 24 ? "推荐，覆盖最近一天的任务" : `仅显示最近 ${hours} 小时的任务`,
            default: hours === activeWindowHours
          }))
        }
      ]
    };
  }

  async reconcilePanel(force = false): Promise<{ channelId: string; messageId: string } | null> {
    if (!this.controllerUserId || !this.provider.ensureMonitorControlPanel) {
      return null;
    }
    const existing = this.store.getMonitorControl(MONITOR_CONTROL_SCOPE);
    const view = this.buildPanelView();
    const signature = createHash("sha256").update(JSON.stringify(view)).digest("hex");
    if (!force && existing && this.lastPanelSignature === signature) {
      return { channelId: existing.channelId, messageId: existing.messageId };
    }
    const result = await this.provider.ensureMonitorControlPanel({
      controllerUserId: this.controllerUserId,
      existingChannelId: existing?.channelId ?? null,
      existingMessageId: existing?.messageId ?? null,
      view
    });
    this.store.upsertMonitorControl({
      guildId: MONITOR_CONTROL_SCOPE,
      channelId: result.channelId,
      messageId: result.messageId,
      updatedAt: new Date().toISOString()
    });
    this.lastPanelSignature = signature;
    return result;
  }

  async handleManage(actor: ProviderActorContext): Promise<DiscordCommandResult> {
    this.authorize(actor);
    const panel = this.store.getMonitorControl(MONITOR_CONTROL_SCOPE);
    this.reconcilePanelInBackground();
    const view = this.buildPanelView();
    return {
      ...view,
      content: panel
        ? `${view.content}\n\n固定面板：<#${panel.channelId}>`
        : view.content,
      ephemeral: true
    };
  }

  async handleButton(
    actor: ProviderActorContext,
    customId: string
  ): Promise<DiscordCommandResult> {
    this.authorize(actor);
    const parts = this.parseCustomId(customId);
    const action = parts[0];
    if (action === "manual") {
      const settings = this.selection.setManualMode();
      this.store.appendMonitorAudit({
        timestamp: new Date().toISOString(),
        actorUserId: actor.userId,
        action: "set_monitor_management_mode",
        projectKey: null,
        threadId: null,
        detail: settings.mode
      });
      await this.reconcilePanel(true);
      return {
        content: "已切换为手动管理。当前项目和对话保持原样，不会自动删除。",
        ephemeral: true
      };
    }
    if (action === "refresh") {
      this.requestFullRefresh(actor.userId);
      return {
        content: "已在后台完整刷新分类、频道、对话和状态灯，并清理停用的 Discord 副本。",
        ephemeral: true
      };
    }
    if (action === "default-model") {
      return this.buildDefaultModelPicker();
    }
    if (this.selection.getManagementSettings().mode === "automatic") {
      return {
        content: "当前是自动管理模式。请使用“自动管理设置”调整数量，或先切换为手动管理。",
        ephemeral: true
      };
    }
    if (action === "projects") {
      this.refreshInventoryInBackground(true);
      return this.buildProjectPicker(this.readPage(parts[1]));
    }
    if (action === "thread-projects") {
      this.refreshInventoryInBackground(true);
      return this.buildProjectRoutePicker("thread-project", this.readPage(parts[1]));
    }
    if (action === "cleanup-projects") {
      return this.buildProjectRoutePicker("cleanup-project", this.readPage(parts[1]), true);
    }
    if (action === "threads" && parts[1]) {
      return this.buildThreadPicker(parts[1], this.readPage(parts[2]));
    }
    if (action === "cleanup" && parts[1]) {
      return this.buildCleanupPicker(parts[1], this.readPage(parts[2]));
    }
    if (action === "cleanup-confirm" && parts[1]) {
      return this.confirmCleanup(actor, parts[1]);
    }
    if (action === "cleanup-cancel" && parts[1]) {
      this.store.consumeMonitorCleanupRequest(parts[1]);
      return { content: "已取消清理。", ephemeral: true };
    }
    return { content: "这个监控操作已失效，请重新打开管理面板。", ephemeral: true };
  }

  async handleAutomaticSettings(
    actor: ProviderActorContext,
    projectLimit: number,
    threadLimit: number
  ): Promise<DiscordCommandResult> {
    this.authorize(actor);
    try {
      const settings = this.selection.setAutomaticSettings(projectLimit, threadLimit);
      this.store.appendMonitorAudit({
        timestamp: new Date().toISOString(),
        actorUserId: actor.userId,
        action: "set_monitor_management_mode",
        projectKey: null,
        threadId: null,
        detail: `${settings.mode}:${settings.projectLimit}x${settings.threadLimit}`
      });
      this.requestFullRefresh(actor.userId);
      await this.reconcilePanel(true);
      return {
        content: `已启用自动管理：最近 ${settings.projectLimit} 个项目，每个项目最近 ${settings.threadLimit} 个对话。正在后台刷新并自动同步。`,
        ephemeral: true
      };
    } catch (error) {
      return {
        content: `自动管理设置无效：${this.errorMessage(error)}。请输入 1 到 20 的整数。`,
        ephemeral: true
      };
    }
  }

  async handleSelect(
    actor: ProviderActorContext,
    customId: string,
    values: string[]
  ): Promise<DiscordCommandResult> {
    this.authorize(actor);
    const parts = this.parseCustomId(customId);
    const action = parts[0];
    if (
      this.selection.getManagementSettings().mode === "automatic" &&
      action !== "default-model" &&
      action !== "default-reasoning"
    ) {
      return {
        content: "当前是自动管理模式。请使用“自动管理设置”调整数量，或先切换为手动管理。",
        ephemeral: true
      };
    }
    if (action === "window") {
      const hours = this.selection.setActiveWindowHours(Number(values[0]));
      this.store.appendMonitorAudit({
        timestamp: new Date().toISOString(),
        actorUserId: actor.userId,
        action: "set_active_window",
        projectKey: null,
        threadId: null,
        detail: `${hours}h`
      });
      this.reconcilePanelInBackground();
      return {
        content: `候选范围已改为最近 ${hours} 小时。已勾选的监控频道不受影响。`,
        ephemeral: true
      };
    }
    if (action === "default-model") {
      return this.applyDefaultModel(actor, values[0] ?? "");
    }
    if (action === "default-reasoning") {
      return this.applyDefaultReasoning(actor, values[0] ?? "");
    }
    if (action === "projects") {
      return this.applyProjectSelection(actor, this.readPage(parts[1]), values);
    }
    if (action === "thread-project") {
      const token = values[0];
      return token
        ? this.buildThreadPicker(token, 0)
        : { content: "请选择一个项目。", ephemeral: true };
    }
    if (action === "cleanup-project") {
      const token = values[0];
      return token
        ? this.buildCleanupPicker(token, 0)
        : { content: "请选择一个项目。", ephemeral: true };
    }
    if (action === "threads" && parts[1]) {
      return this.applyThreadSelection(actor, parts[1], this.readPage(parts[2]), values);
    }
    if (action === "cleanup" && parts[1]) {
      return this.createCleanupRequest(actor, parts[1], this.readPage(parts[2]), values);
    }
    return { content: "这个选择器已失效，请重新打开管理面板。", ephemeral: true };
  }

  requestFullRefresh(actorUserId = SCHEDULED_REFRESH_ACTOR): void {
    if (this.fullRefreshPromise) {
      return;
    }
    const refresh = this.runFullRefresh(actorUserId).finally(() => {
      if (this.fullRefreshPromise === refresh) {
        this.fullRefreshPromise = null;
      }
    });
    this.fullRefreshPromise = refresh;
    void refresh.catch(() => undefined);
  }

  private async runFullRefresh(actorUserId: string): Promise<void> {
    const errors: string[] = [];
    const attempt = async (label: string, operation: (() => Promise<unknown>) | null): Promise<void> => {
      if (!operation) {
        return;
      }
      try {
        await operation();
      } catch (error) {
        errors.push(`${label}: ${this.errorMessage(error)}`);
      }
    };
    await attempt("inventory", this.refreshInventory);
    if (this.selection.getManagementSettings().mode === "automatic") {
      await attempt(
        "automatic-selection",
        this.automaticMonitor ? () => this.automaticMonitor!.reconcile(true) : null
      );
    }
    await attempt("cleanup-before-refresh", () => this.cleanStoppedDiscordCopies(actorUserId));
    await attempt("managed-state", this.refreshManagedState);
    if (this.selection.getManagementSettings().mode === "automatic") {
      await attempt(
        "automatic-ordering",
        this.automaticMonitor ? () => this.automaticMonitor!.reconcile(true) : null
      );
    }
    await attempt("cleanup-after-refresh", () => this.cleanStoppedDiscordCopies(actorUserId));
    await attempt("panel", () => this.reconcilePanel());
    this.store.appendMonitorAudit({
      timestamp: new Date().toISOString(),
      actorUserId,
      action: "full-refresh",
      projectKey: null,
      threadId: null,
      detail: JSON.stringify({
        steps: "inventory,locations,messages,statuses,cleanup",
        errors
      })
    });
  }

  private async cleanStoppedDiscordCopies(actorUserId: string): Promise<void> {
    const projectsByKey = new Map(
      this.store.listMonitorProjects().map((project) => [project.projectKey, project])
    );
    const threadIds = this.store.listMonitorThreads()
      .filter((thread) => {
        const project = projectsByKey.get(thread.projectKey);
        return project ? this.isCleanableDiscordCopy(project, thread) : false;
      })
      .map((thread) => thread.threadId);
    if (threadIds.length > 0) {
      await this.lifecycle.cleanPausedThreads(threadIds, actorUserId);
    }
  }

  private refreshInventoryInBackground(refreshPanel: boolean): void {
    if (!this.refreshInventory) return;
    void this.refreshInventory()
      .then(async () => {
        if (refreshPanel) await this.reconcilePanel();
      })
      .catch(async () => {
        if (refreshPanel) await this.reconcilePanel().catch(() => undefined);
      })
      .catch(() => undefined);
  }

  private reconcilePanelInBackground(): void {
    void this.reconcilePanel().catch(() => undefined);
  }

  private async listModelsPromptly(): Promise<Array<{
    id: string;
    displayName: string;
    defaultReasoningEffort: string | null;
    supportedReasoningEfforts: string[];
  }>> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Codex model list timed out")), 1_500);
      void this.listModels().then(
        (models) => {
          clearTimeout(timeout);
          resolve(models);
        },
        (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      );
    });
  }

  private async buildDefaultModelPicker(): Promise<DiscordCommandResult> {
    try {
      const models = await this.listModelsPromptly();
      if (models.length === 0) {
        return { content: "暂时无法读取 Codex 模型列表，请稍后重试。", ephemeral: true };
      }
      const selected = this.store.getBridgeMetaValue(DEFAULT_NEW_THREAD_MODEL_META_KEY) ?? FALLBACK_NEW_THREAD_MODEL;
      const selectedModel = models.find((model) => model.id === selected) ?? models[0] ?? null;
      const selectedEffort = this.store.getBridgeMetaValue(DEFAULT_NEW_THREAD_REASONING_META_KEY) ??
        selectedModel?.defaultReasoningEffort ??
        FALLBACK_NEW_THREAD_REASONING;
      return {
        content: "选择新 Discord 频道创建 Codex 对话时使用的默认模型。已有对话不受影响。",
        ephemeral: true,
        selectMenus: [{
          customId: "codex:monitor:default-model",
          placeholder: "选择新对话默认模型",
          minValues: 1,
          maxValues: 1,
          options: models.slice(0, 25).map((model) => ({
            label: model.displayName.slice(0, 100),
            value: model.id,
            default: model.id === selected
          }))
        }, ...(selectedModel && selectedModel.supportedReasoningEfforts.length > 0 ? [{
          customId: "codex:monitor:default-reasoning",
          placeholder: "选择新对话默认推理强度",
          minValues: 1,
          maxValues: 1,
          options: selectedModel.supportedReasoningEfforts.slice(0, 25).map((effort) => ({
            label: effort,
            value: effort,
            default: effort === selectedEffort
          }))
        }] : [])]
      };
    } catch (error) {
      return { content: `无法读取 Codex 模型列表：${this.errorMessage(error)}`, ephemeral: true };
    }
  }

  private async applyDefaultModel(actor: ProviderActorContext, modelId: string): Promise<DiscordCommandResult> {
    const normalized = modelId.trim();
    try {
      const models = await this.listModelsPromptly();
      const selected = models.find((model) => model.id === normalized);
      if (!selected) {
        return { content: "所选模型当前不可用，请重新打开默认模型选择器。", ephemeral: true };
      }
      const effort = selected.defaultReasoningEffort ?? FALLBACK_NEW_THREAD_REASONING;
      this.store.setBridgeMetaValue(DEFAULT_NEW_THREAD_MODEL_META_KEY, selected.id);
      this.store.setBridgeMetaValue(DEFAULT_NEW_THREAD_REASONING_META_KEY, effort);
      this.store.appendMonitorAudit({
        timestamp: new Date().toISOString(),
        actorUserId: actor.userId,
        action: "set_new_thread_default_model",
        projectKey: null,
        threadId: null,
        detail: `${selected.id}:${effort}`
      });
      this.reconcilePanelInBackground();
      return this.buildDefaultModelPicker();
    } catch (error) {
      return { content: `无法保存默认模型：${this.errorMessage(error)}`, ephemeral: true };
    }
  }

  private async applyDefaultReasoning(actor: ProviderActorContext, reasoningEffort: string): Promise<DiscordCommandResult> {
    const selectedEffort = reasoningEffort.trim();
    try {
      const models = await this.listModelsPromptly();
      const modelId = this.store.getBridgeMetaValue(DEFAULT_NEW_THREAD_MODEL_META_KEY) ?? FALLBACK_NEW_THREAD_MODEL;
      const model = models.find((entry) => entry.id === modelId);
      if (!model || !model.supportedReasoningEfforts.includes(selectedEffort)) {
        return { content: "该推理强度不适用于当前默认模型，请重新打开默认模型设置。", ephemeral: true };
      }
      this.store.setBridgeMetaValue(DEFAULT_NEW_THREAD_REASONING_META_KEY, selectedEffort);
      this.store.appendMonitorAudit({
        timestamp: new Date().toISOString(),
        actorUserId: actor.userId,
        action: "set_new_thread_default_reasoning",
        projectKey: null,
        threadId: null,
        detail: `${model.id}:${selectedEffort}`
      });
      this.reconcilePanelInBackground();
      return this.buildDefaultModelPicker();
    } catch (error) {
      return { content: `无法保存默认推理强度：${this.errorMessage(error)}`, ephemeral: true };
    }
  }

  private buildProjectPicker(page: number): DiscordCommandResult {
    const projects = this.selection.listActiveProjects(page);
    return this.buildPickerResult(
      `选择需要监控的项目（第 ${projects.page + 1}/${projects.pageCount} 页）`,
      `codex:monitor:projects:${projects.page}`,
      "勾选项目",
      projects.items.map((project) => this.projectOption(project)),
      this.pageButtons("projects", projects)
    );
  }

  private buildProjectRoutePicker(
    action: "thread-project" | "cleanup-project",
    page: number,
    cleanupOnly = false
  ): DiscordCommandResult {
    const all = (cleanupOnly
      ? this.store.listMonitorProjects()
      : this.selection.listActiveProjects().items
    ).filter((project) => {
      if (!cleanupOnly) return project.enabled;
      return this.store.listMonitorThreads(project.projectKey).some(
        (thread) => this.isCleanableDiscordCopy(project, thread)
      );
    });
    const result = this.paginate(all, page);
    const label = cleanupOnly ? "选择要清理副本的项目" : "选择要管理对话的项目";
    return this.buildPickerResult(
      `${label}（第 ${result.page + 1}/${result.pageCount} 页）`,
      `codex:monitor:${action}:${result.page}`,
      label,
      result.items.map((project) => ({
        label: this.limit(project.projectName, 100),
        value: project.projectToken,
        description: this.limit(`${this.selection.listActiveThreads(project.projectKey).total} 个对话`, 100)
      })),
      this.pageButtons(action === "thread-project" ? "thread-projects" : "cleanup-projects", result),
      1
    );
  }

  private buildThreadPicker(projectToken: string, page: number): DiscordCommandResult {
    const project = this.store.getMonitorProjectByToken(projectToken);
    if (!project?.enabled) {
      return { content: "项目未开启监控，请先在项目选择中勾选。", ephemeral: true };
    }
    const threads = this.selection.listActiveThreads(project.projectKey, page);
    return this.buildPickerResult(
      `${project.projectName}：选择需要同步的对话（第 ${threads.page + 1}/${threads.pageCount} 页）`,
      `codex:monitor:threads:${projectToken}:${threads.page}`,
      "勾选对话",
      threads.items.map((thread) => this.threadOption(thread)),
      this.pageButtons(`threads:${projectToken}`, threads)
    );
  }

  private buildCleanupPicker(projectToken: string, page: number): DiscordCommandResult {
    const project = this.store.getMonitorProjectByToken(projectToken);
    if (!project) {
      return { content: "项目不存在，请刷新管理面板。", ephemeral: true };
    }
    const candidates = this.store.listMonitorThreads(project.projectKey).filter(
      (thread) => this.isCleanableDiscordCopy(project, thread)
    );
    const result = this.paginate(candidates, page);
    return this.buildPickerResult(
      `${project.projectName}：选择要删除的 Discord 副本（第 ${result.page + 1}/${result.pageCount} 页）`,
      `codex:monitor:cleanup:${projectToken}:${result.page}`,
      "选择副本",
      result.items.map((thread) => ({
        ...this.threadOption(thread),
        default: false
      })),
      this.pageButtons(`cleanup:${projectToken}`, result)
    );
  }

  private async applyProjectSelection(
    actor: ProviderActorContext,
    page: number,
    selectedTokens: string[]
  ): Promise<DiscordCommandResult> {
    const currentPage = this.selection.listActiveProjects(page);
    const selected = new Set(selectedTokens);
    const errors: string[] = [];
    for (const project of currentPage.items) {
      const enabled = selected.has(project.projectToken);
      if (project.enabled === enabled) continue;
      this.selection.setProjectEnabled(project.projectKey, enabled, actor.userId);
      const threads = this.store.listMonitorThreads(project.projectKey).filter((thread) => thread.selected);
      for (const thread of threads) {
        try {
          if (enabled) {
            if (!this.store.getThreadBridge(thread.threadId)) {
              await this.lifecycle.resumeThread(thread.threadId, actor.userId);
            }
          } else {
            await this.lifecycle.pauseThread(thread.threadId, actor.userId, { preserveSelection: true });
            await this.lifecycle.cleanPausedThreads([thread.threadId], actor.userId);
          }
        } catch (error) {
          errors.push(`${thread.threadName ?? thread.threadId}: ${this.errorMessage(error)}`);
        }
      }
    }
    await this.reconcilePanel();
    return {
      content: errors.length
        ? `项目选择已保存，但有 ${errors.length} 个对话未能切换：\n${errors.slice(0, 5).join("\n")}`
        : "项目选择已保存。项目开启后仍只同步手动勾选的对话。",
      ephemeral: true
    };
  }

  private async applyThreadSelection(
    actor: ProviderActorContext,
    projectToken: string,
    page: number,
    selectedThreadIds: string[]
  ): Promise<DiscordCommandResult> {
    const project = this.store.getMonitorProjectByToken(projectToken);
    if (!project?.enabled) {
      return { content: "项目未开启监控。", ephemeral: true };
    }
    const currentPage = this.selection.listActiveThreads(project.projectKey, page);
    const selected = new Set(selectedThreadIds);
    const errors: string[] = [];
    for (const thread of currentPage.items) {
      const shouldSelect = selected.has(thread.threadId);
      if (thread.selected === shouldSelect) continue;
      try {
        if (shouldSelect) {
          await this.lifecycle.resumeThread(thread.threadId, actor.userId);
        } else {
          await this.lifecycle.pauseThread(thread.threadId, actor.userId);
          await this.lifecycle.cleanPausedThreads([thread.threadId], actor.userId);
        }
      } catch (error) {
        errors.push(`${thread.threadName ?? thread.threadId}: ${this.errorMessage(error)}`);
      }
    }
    await this.reconcilePanel();
    return {
      content: errors.length
        ? `对话选择已保存，但有 ${errors.length} 个对话未能切换：\n${errors.slice(0, 5).join("\n")}`
        : "对话选择已保存。",
      ephemeral: true
    };
  }

  private createCleanupRequest(
    actor: ProviderActorContext,
    projectToken: string,
    page: number,
    selectedThreadIds: string[]
  ): DiscordCommandResult {
    const project = this.store.getMonitorProjectByToken(projectToken);
    if (!project) {
      return { content: "项目不存在。", ephemeral: true };
    }
    const candidates = this.paginate(
      this.store.listMonitorThreads(project.projectKey).filter(
        (thread) => this.isCleanableDiscordCopy(project, thread)
      ),
      page
    ).items;
    const allowedIds = new Set(candidates.map((thread) => thread.threadId));
    const threadIds = [...new Set(selectedThreadIds)].filter((threadId) => allowedIds.has(threadId));
    if (threadIds.length === 0) {
      return { content: "没有选择可清理的 Discord 副本。", ephemeral: true };
    }
    const token = this.policy.createOpaqueToken();
    const selectionVersion = this.cleanupSelectionVersion(threadIds);
    this.store.createMonitorCleanupRequest({
      token,
      actorUserId: actor.userId,
      threadIds,
      selectionVersion,
      expiresAt: new Date(Date.now() + CLEANUP_REQUEST_TTL_MS).toISOString(),
      consumedAt: null
    });
    return {
      content: [
        `确认删除 ${threadIds.length} 个 Discord 对话副本？`,
        "只删除 Discord 频道和 Bridge 映射，不会删除 Codex 对话、项目或文件。"
      ].join("\n"),
      ephemeral: true,
      buttons: [
        { customId: `codex:monitor:cleanup-confirm:${token}`, label: "确认删除", style: "danger" },
        { customId: `codex:monitor:cleanup-cancel:${token}`, label: "取消", style: "secondary" }
      ]
    };
  }

  private async confirmCleanup(
    actor: ProviderActorContext,
    token: string
  ): Promise<DiscordCommandResult> {
    const request = this.store.getMonitorCleanupRequest(token);
    if (!request || request.actorUserId !== actor.userId || request.consumedAt) {
      return { content: "这次清理确认已失效。", ephemeral: true };
    }
    if (Date.parse(request.expiresAt) <= Date.now()) {
      this.store.consumeMonitorCleanupRequest(token);
      return { content: "清理确认已过期，请重新选择。", ephemeral: true };
    }
    if (request.selectionVersion !== this.cleanupSelectionVersion(request.threadIds)) {
      this.store.consumeMonitorCleanupRequest(token);
      return { content: "监控状态已经变化，未执行清理，请重新选择。", ephemeral: true };
    }
    if (!this.store.consumeMonitorCleanupRequest(token)) {
      return { content: "这次清理确认已使用。", ephemeral: true };
    }
    const deleted = await this.lifecycle.cleanPausedThreads(request.threadIds, actor.userId);
    await this.reconcilePanel();
    return { content: `已删除 ${deleted} 个 Discord 副本，Codex 原对话未受影响。`, ephemeral: true };
  }

  private projectOption(project: MonitorProjectRecord): DiscordSelectOption {
    const threadCount = this.store.listMonitorThreads(project.projectKey).length;
    return {
      label: this.limit(project.projectName, 100),
      value: project.projectToken,
      description: this.limit(`${threadCount} 个对话`, 100),
      default: project.enabled
    };
  }

  private threadOption(thread: MonitorThreadRecord): DiscordSelectOption {
    return {
      label: this.limit(thread.threadName?.trim() || thread.threadId.slice(0, 12), 100),
      value: thread.threadId,
      description: this.limit(`${thread.threadId.slice(0, 8)} · ${this.formatAge(thread.lastSeenAt)}`, 100),
      default: thread.selected
    };
  }

  private buildPickerResult(
    content: string,
    customId: string,
    placeholder: string,
    options: DiscordSelectOption[],
    buttons: DiscordCommandButton[],
    maxValues = options.length
  ): DiscordCommandResult {
    if (options.length === 0) {
      return { content: `${content}\n\n当前没有可选择的项目或对话。`, ephemeral: true, buttons };
    }
    return {
      content,
      ephemeral: true,
      selectMenus: [{
        customId,
        placeholder,
        minValues: 0,
        maxValues: Math.max(1, Math.min(maxValues, options.length)),
        options
      }],
      buttons
    };
  }

  private pageButtons<T>(prefix: string, result: MonitorPage<T>): DiscordCommandButton[] {
    const buttons: DiscordCommandButton[] = [];
    if (result.page > 0) {
      buttons.push({ customId: `codex:monitor:${prefix}:${result.page - 1}`, label: "上一页" });
    }
    if (result.page + 1 < result.pageCount) {
      buttons.push({ customId: `codex:monitor:${prefix}:${result.page + 1}`, label: "下一页" });
    }
    return buttons;
  }

  private paginate<T>(items: T[], requestedPage: number): MonitorPage<T> {
    const pageCount = Math.max(1, Math.ceil(items.length / MONITOR_PICKER_PAGE_SIZE));
    const page = Math.max(0, Math.min(Math.floor(requestedPage), pageCount - 1));
    const start = page * MONITOR_PICKER_PAGE_SIZE;
    return { items: items.slice(start, start + MONITOR_PICKER_PAGE_SIZE), page, pageCount, total: items.length };
  }

  private cleanupSelectionVersion(threadIds: string[]): string {
    const state = [...threadIds].sort().map((threadId) => {
      const thread = this.store.getMonitorThread(threadId);
      const active = Boolean(this.store.getThreadBridge(threadId));
      return [threadId, thread?.selected, thread?.pausedDiscordChannelId, thread?.updatedAt, active];
    });
    return createHash("sha256").update(JSON.stringify(state)).digest("hex");
  }

  private isCleanableDiscordCopy(
    project: MonitorProjectRecord,
    thread: MonitorThreadRecord
  ): boolean {
    if (project.enabled && thread.selected) {
      return false;
    }
    return Boolean(
      thread.pausedDiscordChannelId ||
      this.store.getThreadBridge(thread.threadId)
    );
  }

  private parseCustomId(customId: string): string[] {
    const parts = customId.split(":");
    return parts[0] === "codex" && parts[1] === "monitor" ? parts.slice(2) : [];
  }

  private readPage(value: string | undefined): number {
    const page = Number(value ?? "0");
    return Number.isSafeInteger(page) && page >= 0 ? page : 0;
  }

  private authorize(actor: ProviderActorContext): void {
    this.policy.ensureCommandAuthorized(actor);
  }

  private limit(value: string, max: number): string {
    return Array.from(value).slice(0, max).join("");
  }

  private formatAge(iso: string): string {
    const ageMs = Math.max(0, Date.now() - Date.parse(iso));
    if (!Number.isFinite(ageMs) || ageMs < 60_000) return "刚刚";
    if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)} 分钟前`;
    if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)} 小时前`;
    return `${Math.floor(ageMs / 86_400_000)} 天前`;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
