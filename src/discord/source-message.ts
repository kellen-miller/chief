import { createHash } from 'node:crypto';

import {
  qualifyTextMessage,
  type AllowedTextSurface,
} from './invocation-policy.js';

export interface DiscordAttachmentCandidate {
  readonly description: string | null;
  readonly name: string;
}

export interface DiscordSourceMessageCandidate {
  readonly attachments: readonly DiscordAttachmentCandidate[];
  readonly authorDisplayName: string;
  readonly authorId: string;
  readonly authorIsBot: boolean;
  readonly canModerateContext: boolean;
  readonly channelId: string;
  readonly content: string;
  readonly editedAt: number | null;
  readonly guildId: string | null;
  readonly id: string;
  readonly isThread: boolean;
  readonly occurredAt: number;
  readonly replyToMessageId: string | null;
  readonly webhookId: string | null;
}

export interface NormalizedDiscordSourceMessage {
  readonly attachmentMetadataJson: string;
  readonly authorKind: 'chief' | 'human';
  readonly canModerateContext: boolean;
  readonly content: string;
  readonly editedAt: number | null;
  readonly messageId: string;
  readonly occurredAt: number;
  readonly replyToMessageId: string | null;
  readonly requesterId: string;
  readonly speakerName: string;
}

const DESTRUCTIVE_ACTION_SOURCE = String.raw`(?:delete|forget|remove|erase|purge|scrub)`;
const OPTIONAL_COURTESY_SOURCE = String.raw`(?:(?:please|kindly)\s+)?`;
const OPTIONAL_MODAL_SOURCE = String.raw`(?:(?:can|could|would|will)\s+you\s+)?`;
const CONTEXT_ADDRESSEE_SOURCE = String.raw`(?:chief|<@!?\d{1,20}>)`;
const DESTRUCTIVE_CONTEXT_INTENT = new RegExp(
  String.raw`(?:${CONTEXT_ADDRESSEE_SOURCE}[\s,;:—-]*${OPTIONAL_COURTESY_SOURCE}${OPTIONAL_MODAL_SOURCE}${OPTIONAL_COURTESY_SOURCE}${DESTRUCTIVE_ACTION_SOURCE}\b|^\s*${OPTIONAL_COURTESY_SOURCE}${DESTRUCTIVE_ACTION_SOURCE}\b[\s\S]*${CONTEXT_ADDRESSEE_SOURCE})`,
  'iu',
);

export function contextPermissionSnapshot(
  content: string,
  currentAuthority: () => boolean | undefined,
): boolean {
  if (!DESTRUCTIVE_CONTEXT_INTENT.test(content)) return false;
  return currentAuthority() ?? false;
}

export function normalizeDiscordSourceMessage(
  allowed: AllowedTextSurface,
  message: DiscordSourceMessageCandidate,
): NormalizedDiscordSourceMessage | null {
  const authorKind = message.authorIsBot
    ? message.authorId === allowed.botUserId
      ? 'chief'
      : null
    : 'human';
  if (
    authorKind === null ||
    message.webhookId !== null ||
    message.isThread ||
    message.guildId !== allowed.guildId ||
    message.channelId !== allowed.channelId
  ) {
    return null;
  }

  return {
    attachmentMetadataJson: JSON.stringify(
      message.attachments.map(({ description, name }) => ({
        ...(description === null ? {} : { description }),
        name,
      })),
    ),
    authorKind,
    canModerateContext: message.canModerateContext,
    content: message.content,
    editedAt: message.editedAt,
    messageId: message.id,
    occurredAt: message.occurredAt,
    replyToMessageId: message.replyToMessageId,
    requesterId: message.authorId,
    speakerName: message.authorDisplayName,
  };
}

export function normalizeDiscordSourceForStorage(
  allowed: AllowedTextSurface,
  message: DiscordSourceMessageCandidate,
): NormalizedDiscordSourceMessage | null {
  const normalized = normalizeDiscordSourceMessage(allowed, message);
  if (normalized === null || normalized.authorKind === 'chief') {
    return normalized;
  }
  const qualification = qualifyTextMessage(allowed, message);
  return qualification.kind === 'ignore'
    ? null
    : { ...normalized, content: qualification.content };
}

export function discordSourceRevisionChecksum(
  source: Pick<
    NormalizedDiscordSourceMessage,
    | 'attachmentMetadataJson'
    | 'authorKind'
    | 'content'
    | 'editedAt'
    | 'messageId'
    | 'occurredAt'
    | 'replyToMessageId'
    | 'requesterId'
  >,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        attachmentMetadataJson: source.attachmentMetadataJson,
        authorKind: source.authorKind,
        content: source.content,
        editedAt: source.editedAt,
        messageId: source.messageId,
        occurredAt: source.occurredAt,
        replyToMessageId: source.replyToMessageId,
        requesterId: source.requesterId,
      }),
    )
    .digest('hex');
}
