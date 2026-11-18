import { describe, expect, it } from 'vitest';
import { ChatOpenAI } from '@langchain/openai';
import type { CreateAgentParams } from 'langchain';
import { createChatModel, registerProvider } from '../src/llm/index.js';
import { ProviderNotRegisteredError } from '../src/shared/index.js';

/** langchain 的 createAgent({ model }) 接受除字符串外的模型类型。 */
type AgentLanguageModelLike = Exclude<CreateAgentParams['model'], string>;

describe('createChatModel', () => {
  it('openai-compatible 返回可用的 chat model', async () => {
    const model = await createChatModel({
      provider: 'openai-compatible',
      model: 'gpt-4o-mini',
      baseURL: 'https://example.com/v1',
      apiKey: 'sk-test',
      temperature: 0.5,
    });
    expect(model).toBeInstanceOf(ChatOpenAI);
    expect(typeof model.invoke).toBe('function');

    const openAi = model as ChatOpenAI;
    expect(openAi.model).toBe('gpt-4o-mini');
    expect(openAi.temperature).toBe(0.5);
    expect(openAi.apiKey).toBe('sk-test');
    expect(openAi.clientConfig.baseURL).toBe('https://example.com/v1');
  });

  it('openai provider 走同一个实现', async () => {
    const model = await createChatModel({
      provider: 'openai',
      model: 'gpt-4o-mini',
      baseURL: 'https://gateway.example.com/v1',
      apiKey: 'sk-test',
      temperature: 0.7,
    });
    expect(model).toBeInstanceOf(ChatOpenAI);

    const openAi = model as ChatOpenAI;
    expect(openAi.model).toBe('gpt-4o-mini');
    expect(openAi.temperature).toBe(0.7);
    expect(openAi.apiKey).toBe('sk-test');
    expect(openAi.clientConfig.baseURL).toBe('https://gateway.example.com/v1');
  });

  it('自定义 provider 可通过注册表注入', async () => {
    registerProvider('fake-provider', async () => {
      return { invoke: async () => 'fake' } as never;
    });
    const model = await createChatModel({
      provider: 'fake-provider',
      model: 'x',
      apiKey: 'k',
    });
    expect(model).toBeDefined();
    expect(model).not.toBeInstanceOf(ChatOpenAI);

    const result: unknown = await model.invoke('x');
    expect(result).toBe('fake');
  });

  it('未注册的 provider 抛出 ProviderNotRegisteredError', async () => {
    const promise = createChatModel({ provider: 'nope', model: 'x' });
    await expect(promise).rejects.toBeInstanceOf(ProviderNotRegisteredError);
    await expect(promise).rejects.toThrow(/nope/);
    await expect(promise).rejects.toThrow(/registerProvider/);
  });

  it('返回的模型可以直接作为 createAgent 的 model 使用', async () => {
    const model = await createChatModel({
      provider: 'openai-compatible',
      model: 'gpt-4o-mini',
      baseURL: 'https://example.com/v1',
      apiKey: 'sk-test',
    });

    const asAgentModel: AgentLanguageModelLike = model;
    expect(asAgentModel).toBeInstanceOf(ChatOpenAI);
  });
});
