import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ProviderNotRegisteredError } from '../shared/index.js';
import type { ModelSpec, ProviderId } from './types.js';

export type ChatModelFactory = (spec: ModelSpec) => Promise<BaseChatModel>;

const registry = new Map<ProviderId, ChatModelFactory>();

function openAiFactory(spec: ModelSpec): Promise<BaseChatModel> {
  return Promise.resolve(
    new ChatOpenAI({
      model: spec.model,
      apiKey: spec.apiKey,
      temperature: spec.temperature ?? 0,
      ...(spec.baseURL ? { configuration: { baseURL: spec.baseURL } } : {}),
    }),
  );
}

export function registerProvider(id: ProviderId, factory: ChatModelFactory): void {
  registry.set(id, factory);
}

export async function createChatModel(spec: ModelSpec): Promise<BaseChatModel> {
  const factory = registry.get(spec.provider);
  if (!factory) {
    throw new ProviderNotRegisteredError(spec.provider);
  }
  return factory(spec);
}

registerProvider('openai', openAiFactory);
registerProvider('openai-compatible', openAiFactory);
