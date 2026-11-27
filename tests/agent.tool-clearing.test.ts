import { describe, expect, it } from 'vitest';
import { createAgent, tool } from 'langchain';
import { MemorySaver } from '@langchain/langgraph';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import type { FakeChatInput, ToolSpec } from '@langchain/core/utils/testing';
import type { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  CLEARED_PLACEHOLDER,
  createToolClearingMiddleware,
} from '../src/agent/context-clearing.js';
import { createLogger } from '../src/shared/index.js';

const silentLogger = createLogger('silent', 'test');

/** 记录模型每次真实看到的消息，用于断言「视图被削、原文未动」。 */
class RecordingModel extends FakeListChatModel {
  readonly seen: BaseMessage[][] = [];

  constructor() {
    super({ responses: [] } as FakeChatInput);
  }

  override async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push([...messages]);
    return {
      generations: [{ text: '完成', message: new AIMessage('完成') }],
      llmOutput: {},
    };
  }

  override bindTools(tools: (StructuredTool | ToolSpec)[]): ReturnType<FakeListChatModel['bindTools']> {
    return this.withConfig({});
  }
}

const echo = tool(async () => 'ok', {
  name: 'big_output',
  description: '产出一大段输出',
  schema: z.object({}),
});

function toolTurn(id: string, body: string): [AIMessage, ToolMessage] {
  return [
    new AIMessage({ content: '', tool_calls: [{ name: 'big_output', args: {}, id }] }),
    new ToolMessage({ content: body, tool_call_id: id, name: 'big_output' }),
  ];
}

function build(model: RecordingModel, triggerTokens: number, keepMessages: number) {
  return createAgent({
    model,
    tools: [echo],
    checkpointer: new MemorySaver(),
    middleware: [
      createToolClearingMiddleware(
        { enabled: true, triggerTokens, keepMessages },
        silentLogger,
      ),
    ],
  });
}

function toolTexts(messages: BaseMessage[]): string[] {
  return messages
    .filter((m) => m.getType() === 'tool')
    .map((m) => String(m.content));
}

describe('工具输出清理中间件', () => {
  it('超阈值时把旧工具输出换成占位符', async () => {
    const model = new RecordingModel();
    const agent = build(model, 100, 1);
    const config = { configurable: { thread_id: 'c1' } };
    await agent.updateState(
      config,
      { messages: [...toolTurn('a', '测'.repeat(200)), ...toolTurn('b', '最近输出')] },
      '__start__',
    );
    await agent.invoke({ messages: [{ role: 'human', content: '继续' }] }, config);
    const seen = toolTexts(model.seen.at(-1) ?? []);
    expect(seen).toContain(CLEARED_PLACEHOLDER);
    expect(seen).toContain('最近输出');
  });

  it('未达阈值时不清理', async () => {
    const model = new RecordingModel();
    const agent = build(model, 100_000, 1);
    const config = { configurable: { thread_id: 'c2' } };
    await agent.updateState(
      config,
      { messages: [...toolTurn('a', '测'.repeat(200)), ...toolTurn('b', '最近输出')] },
      '__start__',
    );
    await agent.invoke({ messages: [{ role: 'human', content: '继续' }] }, config);
    expect(toolTexts(model.seen.at(-1) ?? [])).not.toContain(CLEARED_PLACEHOLDER);
  });

  it('checkpoint 里的原文一字不动', async () => {
    const model = new RecordingModel();
    const agent = build(model, 100, 1);
    const config = { configurable: { thread_id: 'c3' } };
    const original = '测'.repeat(200);
    await agent.updateState(
      config,
      { messages: [...toolTurn('a', original), ...toolTurn('b', '最近输出')] },
      '__start__',
    );
    await agent.invoke({ messages: [{ role: 'human', content: '继续' }] }, config);
    const snapshot: { values: { messages: BaseMessage[] } } = await agent.getState(config);
    const values = snapshot.values;
    expect(toolTexts(values.messages)).toContain(original);
    expect(toolTexts(values.messages)).not.toContain(CLEARED_PLACEHOLDER);
  });

  it('CJK 口径生效：同样字符数比 chars/4 更早触发', async () => {
    const model = new RecordingModel();
    // 300 个中文字符：CJK 口径约 300 token，chars/4 口径只有 75。阈值 200 只在前者下命中。
    const agent = build(model, 200, 1);
    const config = { configurable: { thread_id: 'c4' } };
    await agent.updateState(
      config,
      { messages: [...toolTurn('a', '测'.repeat(300)), ...toolTurn('b', '尾')] },
      '__start__',
    );
    await agent.invoke({ messages: [{ role: 'human', content: '继续' }] }, config);
    expect(toolTexts(model.seen.at(-1) ?? [])).toContain(CLEARED_PLACEHOLDER);
  });

  it('保留窗口内的输出不被清', async () => {
    const model = new RecordingModel();
    const agent = build(model, 100, 3);
    const config = { configurable: { thread_id: 'c5' } };
    await agent.updateState(
      config,
      {
        messages: [
          ...toolTurn('a', '测'.repeat(200)),
          ...toolTurn('b', '测'.repeat(200)),
          ...toolTurn('c', '测'.repeat(200)),
        ],
      },
      '__start__',
    );
    await agent.invoke({ messages: [{ role: 'human', content: '继续' }] }, config);
    expect(toolTexts(model.seen.at(-1) ?? [])).not.toContain(CLEARED_PLACEHOLDER);
  });

  it('重复调用幂等，不叠加清理', async () => {
    const model = new RecordingModel();
    const agent = build(model, 100, 1);
    const config = { configurable: { thread_id: 'c6' } };
    await agent.updateState(
      config,
      { messages: [...toolTurn('a', '测'.repeat(200)), ...toolTurn('b', '最近输出')] },
      '__start__',
    );
    await agent.invoke({ messages: [{ role: 'human', content: '第一次' }] }, config);
    await agent.invoke({ messages: [{ role: 'human', content: '第二次' }] }, config);
    const seen = toolTexts(model.seen.at(-1) ?? []);
    expect(seen.filter((t) => t === CLEARED_PLACEHOLDER)).toHaveLength(1);
  });

  it('工具 schema 的 token 计入判据：消息本身不超阈也会清理', async () => {
    const model = new RecordingModel();
    // 工具描述 500 个中文字符 ≈ 500 token；两条工具输出各 20 字符 ≈ 40 token。
    // 阈值 300：只数消息（40）不该触发，把 schema 计入（540）才该触发。
    const fatTool = tool(async () => 'ok', {
      name: 'big_output',
      description: '测'.repeat(500),
      schema: z.object({}),
    });
    const agent = createAgent({
      model,
      tools: [fatTool],
      checkpointer: new MemorySaver(),
      middleware: [
        createToolClearingMiddleware(
          { enabled: true, triggerTokens: 300, keepMessages: 1 },
          silentLogger,
        ),
      ],
    });
    const config = { configurable: { thread_id: 'c7' } };
    await agent.updateState(
      config,
      { messages: [...toolTurn('a', '测'.repeat(20)), ...toolTurn('b', '尾'.repeat(20))] },
      '__start__',
    );
    await agent.invoke({ messages: [{ role: 'human', content: '继续' }] }, config);
    expect(toolTexts(model.seen.at(-1) ?? [])).toContain(CLEARED_PLACEHOLDER);
  });
});
