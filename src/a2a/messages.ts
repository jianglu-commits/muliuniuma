import { randomUUID } from 'node:crypto';
import { Role } from '@a2a-js/sdk';
import type { Message, Part, SendMessageResult } from '@a2a-js/sdk';

export interface TextMessageParams {
  text: string;
  contextId?: string;
  taskId?: string;
  role?: Role;
}

export function buildTextMessage(params: TextMessageParams): Message {
  const part: Part = {
    content: { $case: 'text', value: params.text },
    metadata: undefined,
    filename: '',
    mediaType: 'text/plain',
  };

  return {
    messageId: randomUUID(),
    contextId: params.contextId ?? '',
    taskId: params.taskId ?? '',
    role: params.role ?? Role.ROLE_AGENT,
    parts: [part],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

function partText(part: Part): string {
  return part.content?.$case === 'text' ? part.content.value : '';
}

export function extractText(message: Message): string {
  return (message.parts ?? []).map(partText).join('');
}

function isMessage(result: SendMessageResult): result is Message {
  return 'messageId' in result && !('artifacts' in result);
}

export function extractResultText(result: SendMessageResult): string {
  if (isMessage(result)) {
    return extractText(result);
  }

  const statusText = result.status?.message
    ? extractText(result.status.message).trim()
    : '';
  if (statusText) {
    return statusText;
  }

  return (result.artifacts ?? [])
    .map((artifact) => (artifact.parts ?? []).map(partText).join(''))
    .join('\n')
    .trim();
}
