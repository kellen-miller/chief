export interface AllowedTextSurface {
  readonly botUserId: string;
  readonly channelId: string;
  readonly guildId: string;
}

export interface TextMessageCandidate {
  readonly authorIsBot: boolean;
  readonly channelId: string;
  readonly content: string;
  readonly guildId: string | null;
  readonly isThread: boolean;
  readonly webhookId: string | null;
}

export type TextQualification =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'observe' }
  | { readonly kind: 'greeting' }
  | { readonly kind: 'request'; readonly prompt: string };

export function qualifyTextMessage(
  allowed: AllowedTextSurface,
  message: TextMessageCandidate,
): TextQualification {
  if (
    message.authorIsBot ||
    message.webhookId !== null ||
    message.isThread ||
    message.guildId !== allowed.guildId ||
    message.channelId !== allowed.channelId
  ) {
    return { kind: 'ignore' };
  }

  const mention = new RegExp(`<@!?${escapeRegex(allowed.botUserId)}>`, 'u');
  if (!mention.test(message.content)) return { kind: 'observe' };

  const prompt = message.content.replace(mention, '').trim();
  return prompt.length === 0
    ? { kind: 'greeting' }
    : { kind: 'request', prompt };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
