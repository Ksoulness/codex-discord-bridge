import type { DiscordCommandResult } from "../../domain.js";
import type { ProviderActorContext, ProviderInboundAttachment } from "../../providers/types.js";
import type { BridgeRuntimeContext } from "../runtime/BridgeRuntimeContext.js";
import type { ProviderCommandCoordinator } from "./ProviderCommandCoordinator.js";

export class DiscordPlainMessageCoordinator {
  constructor(
    private readonly context: BridgeRuntimeContext,
    private readonly providerCommands: ProviderCommandCoordinator
  ) {}

  async handleMessage(
    actor: ProviderActorContext,
    channelId: string,
    messageId: string,
    text: string,
    attachments: ProviderInboundAttachment[] = [],
    parentChannelId: string | null = null,
    channelName: string | null = null
  ): Promise<DiscordCommandResult | null> {
    if (!this.context.runtimeConfig.messageWriteBacks.allowPlainMessages) {
      return null;
    }
    return this.providerCommands.handlePlainMessage(
      actor,
      channelId,
      messageId,
      text,
      attachments,
      parentChannelId,
      channelName
    );
  }
}
