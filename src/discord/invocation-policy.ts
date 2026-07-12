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
  | { readonly content: string; readonly kind: 'observe' }
  | { readonly content: 'Chief'; readonly kind: 'greeting' }
  | {
      readonly content: string;
      readonly kind: 'request';
      readonly prompt: string;
    };

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

  const mentionSource = `<@!?${escapeRegex(allowed.botUserId)}>`;
  const mention = new RegExp(mentionSource, 'u');
  if (!mention.test(message.content)) {
    return { content: message.content, kind: 'observe' };
  }

  const withoutAddress = message.content.replace(
    new RegExp(`^\\s*${mentionSource}(?:\\s*[,;:—-]\\s*|\\s*)`, 'u'),
    '',
  );
  const prompt = withoutAddress
    .replace(new RegExp(mentionSource, 'gu'), 'Chief')
    .trim();
  if (prompt.length === 0) return { content: 'Chief', kind: 'greeting' };
  const leadingMention = new RegExp(`^\\s*${mentionSource}`, 'u').test(
    message.content,
  );
  return {
    content: leadingMention ? `Chief, ${prompt}` : prompt,
    kind: 'request',
    prompt,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
