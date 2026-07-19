import type {
  ApprovalCardView,
  ApprovalDecision,
  DiscordCommandButton,
  DiscordCommandResult,
  StatusCardView
} from "../domain.js";
import type { ProviderOperationContext } from "../bridge/startupTransport.js";

export interface ProviderActorContext {
  userId: string;
  roleIds: string[];
  username: string | null;
}

export interface ProviderDetailButton {
  token: string;
  label: string;
}

export interface ProviderFileAttachment {
  path: string;
  name: string;
}

export interface ProviderInboundAttachment {
  url: string;
  name: string;
  contentType: string | null;
  size: number | null;
}

export interface ProviderMessageOptions {
  detailButtons?: ProviderDetailButton[];
  actionButtons?: DiscordCommandButton[];
  files?: ProviderFileAttachment[];
  operationContext?: ProviderOperationContext;
}

export interface BridgeProviderHandlers {
  onStatusCommand(actor: ProviderActorContext): Promise<DiscordCommandResult>;
  onSendCommand(
    actor: ProviderActorContext,
    channelId: string,
    text: string,
    mode: "queue" | "steer"
  ): Promise<DiscordCommandResult>;
  onPlainMessage?(
    actor: ProviderActorContext,
    channelId: string,
    messageId: string,
    text: string,
    attachments: ProviderInboundAttachment[],
    parentChannelId?: string | null,
    channelName?: string | null
  ): Promise<DiscordCommandResult | null>;
  onModelCommand?(
    actor: ProviderActorContext,
    channelId: string
  ): Promise<DiscordCommandResult>;
  onModelSelect?(
    actor: ProviderActorContext,
    channelId: string,
    model: string
  ): Promise<DiscordCommandResult>;
  onReasoningEffortSelect?(
    actor: ProviderActorContext,
    channelId: string,
    reasoningEffort: string
  ): Promise<DiscordCommandResult>;
  onRetractCommand(actor: ProviderActorContext, channelId: string): Promise<DiscordCommandResult>;
  onWriteBackButton(
    actor: ProviderActorContext,
    action: "retract" | "steer",
    queueItemId: number
  ): Promise<DiscordCommandResult>;
  onAttachCommand(actor: ProviderActorContext, threadId: string): Promise<DiscordCommandResult>;
  onDetachCommand(actor: ProviderActorContext, threadId: string): Promise<DiscordCommandResult>;
  onCleanIdCommand(actor: ProviderActorContext, threadId: string): Promise<DiscordCommandResult>;
  onCleanAllCommand(actor: ProviderActorContext): Promise<DiscordCommandResult>;
  onHelpCommand(actor: ProviderActorContext): Promise<DiscordCommandResult>;
  onManageCommand?(actor: ProviderActorContext): Promise<DiscordCommandResult>;
  onMonitorButton?(
    actor: ProviderActorContext,
    customId: string
  ): Promise<DiscordCommandResult>;
  onMonitorSelect?(
    actor: ProviderActorContext,
    customId: string,
    values: string[]
  ): Promise<DiscordCommandResult>;
  onApprovalDetails(actor: ProviderActorContext, token: string): Promise<DiscordCommandResult>;
  onApprovalAction(
    actor: ProviderActorContext,
    token: string,
    decision: ApprovalDecision
  ): Promise<DiscordCommandResult>;
  onToolInputOption(
    actor: ProviderActorContext,
    token: string,
    questionIndex: number,
    optionIndex: number
  ): Promise<DiscordCommandResult>;
  onToolInputOther(
    actor: ProviderActorContext,
    token: string,
    questionIndex: number,
    answer: string
  ): Promise<DiscordCommandResult>;
  onApprovalFeedback(actor: ProviderActorContext, token: string, feedback: string): Promise<DiscordCommandResult>;
  onMessageDetails(actor: ProviderActorContext, token: string): Promise<DiscordCommandResult>;
  onProposedPlanAction(
    actor: ProviderActorContext,
    token: string,
    action: "accept"
  ): Promise<DiscordCommandResult>;
  onProposedPlanFeedback(
    actor: ProviderActorContext,
    token: string,
    feedback: string
  ): Promise<DiscordCommandResult>;
}

export interface BridgeProviderStartOptions {
  registerCommands?: boolean;
  listenForInteractions?: boolean;
}

export interface BridgeProvider {
  start(
    handlers: BridgeProviderHandlers,
    options?: BridgeProviderStartOptions
  ): Promise<void>;
  stop(): Promise<void>;
  ensureProjectCategory(
    projectKey: string,
    projectName: string,
    existingCategoryId: string | null,
    operationContext?: ProviderOperationContext
  ): Promise<{ id: string; created: boolean }>;
  ensureConversationChannel(
    codexThreadId: string,
    title: string,
    categoryId: string,
    existingDiscordChannelId: string | null,
    operationContext?: ProviderOperationContext
  ): Promise<{ id: string; created: boolean }>;
  updateConversationChannelName(channelId: string, name: string): Promise<boolean>;
  ensureSubagentThread(
    codexThreadId: string,
    title: string,
    parentChannelId: string,
    existingDiscordChannelId: string | null,
    operationContext?: ProviderOperationContext
  ): Promise<{ id: string; created: boolean }>;
  countConversationChannelsInCategory(categoryId: string): Promise<number>;
  deleteDiscordLocation(channelId: string, reason: string): Promise<void>;
  discoverBridgeManagedLocations(seedCategoryIds: string[], options?: {
    restrictToSeedCategories?: boolean;
    requiredScope?: string | null;
  }): Promise<{
    categoryIds: string[];
    channelIds: string[];
  }>;
  upsertStatusCard(
    channelId: string,
    messageId: string | null,
    view: StatusCardView,
    operationContext?: ProviderOperationContext
  ): Promise<string>;
  postMilestone(channelId: string, content: string): Promise<void>;
  upsertLiveTextMessage(
    channelId: string,
    messageId: string | null,
    content: string,
    options?: ProviderMessageOptions
  ): Promise<string>;
  updateLiveTextMessageStatus(
    channelId: string,
    messageId: string,
    statusText: string | null
  ): Promise<boolean>;
  sendTextMessage(
    channelId: string,
    content: string,
    options?: ProviderMessageOptions
  ): Promise<string>;
  postApprovalCard(
    channelId: string,
    existingMessageId: string | null,
    view: ApprovalCardView
  ): Promise<string>;
  disableApprovalCard(
    channelId: string,
    messageId: string,
    resolutionText: string,
    view: ApprovalCardView
  ): Promise<void>;
  markApprovalCardStale(
    channelId: string,
    messageId: string,
    view: ApprovalCardView
  ): Promise<void>;
  updateMessageDetailsButtons(
    channelId: string,
    messageId: string,
    buttons: ProviderDetailButton[]
  ): Promise<void>;
  deleteMessages(channelId: string, messageIds: string[]): Promise<void>;
  detachDiscordLocation(channelId: string, codexThreadId: string): Promise<void>;
  ensureMonitorControlPanel?(input: {
    controllerUserId: string;
    existingChannelId: string | null;
    existingMessageId: string | null;
    view: DiscordCommandResult;
  }): Promise<{ channelId: string; messageId: string }>;
}
