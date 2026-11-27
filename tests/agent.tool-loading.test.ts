import { describe, expect, it } from 'vitest';
import { createAgent, tool } from 'langchain';
import { MemorySaver, REMOVE_ALL_MESSAGES } from '@langchain/langgraph';
import { AIMessage, RemoveMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import type { FakeChatInput, ToolSpec } from '@langchain/core/utils/testing';
import type { StructuredTool, StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { createToolLoadingMiddleware } from '../src/agent/tool-loading.js';
import type { ToolLoadingPolicy } from '../src/agent/tool-catalog.js';
import { createLogger } from '../src/shared/index.js';

const silentLogger = createLogger('silent', 'test');

const POLICY: ToolLoadingPolicy = {
  enabled: true,
  eagerMaxTools: 12,
  eagerMaxTokens: 1500,
  catalogMaxTools: 40,
  catalogMaxTokens: 4000,
  searchTopK: 8,
  maxActiveTools: 3,
};

function dummy(name: string, description = '描述'): StructuredToolInterface {
  return tool(async () => 'ok', { name, description, schema: z.object({}) });
}

/** 记录每次模型调用真实绑定的工具名，并可选地在首个回合发一次 tool_call。 */
class RecordingModel extends FakeListChatModel {
  readonly boundNames: string[][] = [];
  readonly systemTexts: string[] = [];
  private firstCallTool: { name: string; args: Record<string, unknown> } | undefined;
  private calls = 0;

  constructor(firstCallTool?: { name: string; args: Record<string, unknown> }) {
    super({ responses: [] } as FakeChatInput);
    this.firstCallTool = firstCallTool;
  }

  override async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls += 1;
    const system = messages.find((m) => m.getType() === 'system');
    this.systemTexts.push(system === undefined ? '' : String(system.content));
    if (this.calls === 1 && this.firstCallTool !== undefined) {
      const message = new AIMessage({
        content: '',
        tool_calls: [{ ...this.firstCallTool, id: 'call_1' }],
      });
      return { generations: [{ text: '', message }], llmOutput: {} };
    }
    return {
      generations: [{ text: '完成', message: new AIMessage('完成') }],
      llmOutput: {},
    };
  }

  override bindTools(tools: (StructuredTool | ToolSpec)[]): ReturnType<FakeListChatModel['bindTools']> {
    this.boundNames.push(tools.map((t) => ('name' in t ? String(t.name) : '?')));
    return this.withConfig({});
  }
}

function build(model: RecordingModel, deferrable: StructuredToolInterface[]) {
  const middleware = createToolLoadingMiddleware({
    tier: 'catalog',
    deferrable,
    alwaysOn: ['always_on'],
    policy: POLICY,
    logger: silentLogger,
  });
  return createAgent({
    model,
    tools: [dummy('always_on'), ...deferrable],
    checkpointer: new MemorySaver(),
    middleware: [middleware],
  });
}

describe('catalog 档加载中间件', () => {
  it('首次调用只绑常驻工具与 activate_tools', async () => {
    const model = new RecordingModel();
    const agent = build(model, [dummy('t1'), dummy('t2')]);
    await agent.invoke({ messages: [{ role: 'human', content: '你好' }] }, { configurable: { thread_id: 'a' } });
    expect(model.boundNames[0]).toEqual(['always_on', 'activate_tools']);
  });

  it('系统提示里列出可激活工具目录', async () => {
    const model = new RecordingModel();
    const agent = build(model, [dummy('t1', '读取文件')]);
    await agent.invoke({ messages: [{ role: 'human', content: '你好' }] }, { configurable: { thread_id: 'b' } });
    expect(model.systemTexts[0]).toContain('t1: 读取文件');
  });

  it('activate_tools 之后该工具的完整 schema 被绑定', async () => {
    const model = new RecordingModel({ name: 'activate_tools', args: { names: ['t1'] } });
    const agent = build(model, [dummy('t1'), dummy('t2')]);
    await agent.invoke({ messages: [{ role: 'human', content: '你好' }] }, { configurable: { thread_id: 'c' } });
    expect(model.boundNames.at(-1)).toContain('t1');
    expect(model.boundNames.at(-1)).not.toContain('t2');
  });

  it('激活状态跨 invoke 持久', async () => {
    const first = new RecordingModel({ name: 'activate_tools', args: { names: ['t1'] } });
    const agent = build(first, [dummy('t1'), dummy('t2')]);
    const config = { configurable: { thread_id: 'd' } };
    await agent.invoke({ messages: [{ role: 'human', content: '第一轮' }] }, config);
    await agent.invoke({ messages: [{ role: 'human', content: '第二轮' }] }, config);
    expect(first.boundNames.at(-1)).toContain('t1');
  });

  it('摘要式清空 messages 后激活不丢', async () => {
    const model = new RecordingModel({ name: 'activate_tools', args: { names: ['t1'] } });
    const agent = build(model, [dummy('t1'), dummy('t2')]);
    const config = { configurable: { thread_id: 'e' } };
    await agent.invoke({ messages: [{ role: 'human', content: '第一轮' }] }, config);
    await agent.updateState(config, { messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES })] }, '__start__');
    await agent.invoke({ messages: [{ role: 'human', content: '清空后' }] }, config);
    expect(model.boundNames.at(-1)).toContain('t1');
  });

  it('超上限按 FIFO 淘汰，且生效清单对模型可见', async () => {
    const model = new RecordingModel({ name: 'activate_tools', args: { names: ['t1', 't2'] } });
    const agent = build(model, [dummy('t1'), dummy('t2'), dummy('t3'), dummy('t4')]);
    const config = { configurable: { thread_id: 'f' } };
    await agent.invoke({ messages: [{ role: 'human', content: '第一批' }] }, config);
    await agent.updateState(config, { activatedTools: ['t3', 't4'] }, '__start__');
    await agent.invoke({ messages: [{ role: 'human', content: '第二批' }] }, config);
    const bound = model.boundNames.at(-1) ?? [];
    expect(bound).not.toContain('t1');
    expect(bound).toContain('t2');
    expect(bound).toContain('t3');
    expect(bound).toContain('t4');
    expect(model.systemTexts.at(-1)).toContain('t2、t3、t4');
  });

  it('重复激活已激活的名字会刷新最近性', async () => {
    const model = new RecordingModel({ name: 'activate_tools', args: { names: ['t1', 't2'] } });
    const agent = build(model, [dummy('t1'), dummy('t2'), dummy('t3'), dummy('t4')]);
    const config = { configurable: { thread_id: 'k' } };
    await agent.invoke({ messages: [{ role: 'human', content: '第一批' }] }, config);
    await agent.updateState(config, { activatedTools: ['t1'] }, '__start__');
    await agent.updateState(config, { activatedTools: ['t3', 't4'] }, '__start__');
    await agent.invoke({ messages: [{ role: 'human', content: '再激活后' }] }, config);
    const bound = model.boundNames.at(-1) ?? [];
    expect(bound).toContain('t1');
    expect(bound).not.toContain('t2');
    expect(model.systemTexts.at(-1)).toContain('t1、t3、t4');
  });

  it('同一次请求里的重复名字只占一个激活名额', async () => {
    const model = new RecordingModel({ name: 'activate_tools', args: { names: ['t1', 't1'] } });
    const agent = build(model, [dummy('t1'), dummy('t2')]);
    const config = { configurable: { thread_id: 'l' } };
    const result = await agent.invoke({ messages: [{ role: 'human', content: '你好' }] }, config);
    const snapshot: { values: { activatedTools?: string[] } } = await agent.getState(config);
    expect(snapshot.values.activatedTools).toEqual(['t1']);
    const texts = result.messages.map((m) => String(m.content)).join('\n');
    expect(texts).toContain('已激活：t1');
    expect(texts).not.toContain('t1、t1');
  });

  it('未知工具名在工具回执里点名', async () => {
    const model = new RecordingModel({ name: 'activate_tools', args: { names: ['nope', 'nada'] } });
    const agent = build(model, [dummy('t1')]);
    const config = { configurable: { thread_id: 'g' } };
    const result = await agent.invoke({ messages: [{ role: 'human', content: '你好' }] }, config);
    const texts = result.messages.map((m) => String(m.content)).join('\n');
    expect(texts).toContain('未知工具名');
    expect(texts).toContain('nope');
    expect(texts).toContain('nada');
    const snapshot: { values: { activatedTools?: string[] } } = await agent.getState(config);
    expect(snapshot.values.activatedTools).toEqual([]);
  });

  it('已常驻的名字回一句无需激活', async () => {
    const model = new RecordingModel({ name: 'activate_tools', args: { names: ['always_on'] } });
    const agent = build(model, [dummy('t1')]);
    const config = { configurable: { thread_id: 'h' } };
    const result = await agent.invoke({ messages: [{ role: 'human', content: '你好' }] }, config);
    expect(result.messages.map((m) => String(m.content)).join('\n')).toContain('已常驻，无需激活');
    const snapshot: { values: { activatedTools?: string[] } } = await agent.getState(config);
    expect(snapshot.values.activatedTools).toEqual([]);
  });

  it('激活元工具自身的名字也算已常驻', async () => {
    const model = new RecordingModel({ name: 'activate_tools', args: { names: ['activate_tools'] } });
    const agent = build(model, [dummy('t1')]);
    const result = await agent.invoke({ messages: [{ role: 'human', content: '你好' }] }, { configurable: { thread_id: 'j' } });
    const texts = result.messages.map((m) => String(m.content)).join('\n');
    expect(texts).toContain('已常驻');
    expect(texts).not.toContain('未知工具名');
  });

  it('尚未激活时系统提示明确说明', async () => {
    const model = new RecordingModel();
    const agent = build(model, [dummy('t1')]);
    await agent.invoke({ messages: [{ role: 'human', content: '你好' }] }, { configurable: { thread_id: 'i' } });
    expect(model.systemTexts[0]).toContain('尚未激活');
  });
});
