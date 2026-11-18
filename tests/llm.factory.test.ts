import { describe, expect, it } from 'vitest';
import type { CreateAgentParams } from 'langchain';
import { createChatModel, registerProvider } from '../src/llm/index.js';

/** langchain 的 createAgent({ model }) 接受除字符串外的模型类型。 */
type AgentLanguageModelLike = Exclude<CreateAgentParams['model'], string>;

describe('createChatModel', () => {
  it('openai-compatible 返回可用的 chat model', async () => {
    const model = await createChatModel({
      provider: 'openai-compatible',
      model: 'gpt-4o-mini',
      baseURL: 'https://example.com/v1',
      apiKey: 'sk-test',
      temperature: 0,
    });
    expect(model).toBeDefined();
    expect(typeof model.invoke).toBe('function');
  });

  it('openai provider 走同一个实现', async () => {
    const model = await createChatModel({
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
    });
    expect(model).toBeDefined();
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
  });

  it('返回的模型可以直接作为 createAgent 的 model 使用', async () => {
    const model = await createChatModel({
      provider: 'openai-compatible',
      model: 'gpt-4o-mini',
      baseURL: 'https://example.com/v1',
      apiKey: 'sk-test',
    });

    const asAgentModel: AgentLanguageModelLike = model;
    expect(asAgentModel).toBe(model);
  });
});
