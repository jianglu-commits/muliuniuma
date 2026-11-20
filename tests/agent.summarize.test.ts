import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import type { FakeChatInput, ToolSpec } from '@langchain/core/utils/testing';
import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { StructuredTool } from '@langchain/core/tools';
import { CompiledStateGraph, START } from '@langchain/langgraph';
import { loadConfig } from '../src/config/index.js';
import type { AppConfig } from '../src/config/index.js';
import { AgentRuntime, looksLikeSummaryCall } from '../src/agent/index.js';
import { SUMMARY_PROMPT_MARKER } from '../src/agent/index.js';

/** 摘要模型的固定输出：短到不会把保留预算撑破，同时能断言内容。 */
const SUMMARY_TEXT = '## 任务目标\n- 摘要';

/** 60 个中文字符，CJK 感知计数器下正好 60 token。 */
function longText(marker: string): string {
  return `${marker}${'测'.repeat(59)}`;
}

function contentOf(message: BaseMessage | undefined): string {
  if (message === undefined) return '';
  return typeof message.content === 'string'
    ? message.content
    : JSON.stringify(message.content);
}

/**
 * 按消息形状分流的两条响应序列：
 * SDK 的摘要调用是 model.invoke(单个字符串 prompt)，落到模型层就是「一条 human 消息、内容是整段摘要 prompt」；
 * 主模型回合是「system + human(+ tool) 数组」。FakeListChatModel 只有一个 responses 队列，两种调用会抢位置。
 */
class ScriptedChatModel extends FakeListChatModel {
  readonly summaryPrompts: string[] = [];
  readonly mainCalls: BaseMessage[][] = [];
  private readonly mainResponses: string[];

  constructor(mainResponses: string[] = []) {
    super({ responses: [] } as FakeChatInput);
    this.mainResponses = [...mainResponses];
  }

  override async _generate(
    messages: BaseMessage[],
    options?: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    if (looksLikeSummaryCall(messages)) {
      this.summaryPrompts.push(contentOf(messages[0]));
      return {
        generations: [{ text: SUMMARY_TEXT, message: new AIMessage(SUMMARY_TEXT) }],
        llmOutput: {},
      };
    }
    this.mainCalls.push(messages);
    const text = this.mainResponses.shift() ?? '（没有更多回复）';
    return {
      generations: [{ text, message: new AIMessage(text) }],
      llmOutput: {},
    };
  }

  override bindTools(
    tools: (StructuredTool | ToolSpec)[],
  ): ReturnType<FakeListChatModel['bindTools']> {
    return this.withConfig({});
  }
}

/** 摘要模型故障时抛错的替身。 */
class ThrowingChatModel extends FakeListChatModel {
  constructor() {
    super({ responses: [] } as FakeChatInput);
  }

  override async _generate(): Promise<ChatResult> {
    throw new Error('模拟摘要模型故障');
  }

  override bindTools(
    tools: (StructuredTool | ToolSpec)[],
  ): ReturnType<FakeListChatModel['bindTools']> {
    return this.withConfig({});
  }
}

function makeConfig(root: string, summary: Record<string, string> = {}): AppConfig {
  return loadConfig({
    LLM_PROVIDER: 'openai-compatible',
    LLM_MODEL: 'gpt-4o-mini',
    LLM_BASE_URL: 'https://example.com/v1',
    LLM_API_KEY: 'sk-test',
    SKILLS_DIR: join(root, 'skills'),
    CHECKPOINT_DB: join(root, 'data', 'checkpoints.sqlite'),
    MCP_CONFIG: join(root, 'mcp.json'),
    A2A_PEERS: join(root, 'peers.json'),
    SANDBOX_ROOT: join(root, 'sandbox'),
    ...summary,
  });
}

describe('AgentRuntime 上下文压缩', () => {
  let root: string | undefined;
  let runtime: AgentRuntime | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'summarize-'));
  });

  afterEach(async () => {
    if (runtime !== undefined) {
      await runtime.dispose();
      runtime = undefined;
    }
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it('历史超阈值时自动压缩成一条摘要', async () => {
    const model = new ScriptedChatModel([
      longText('答1'),
      longText('答2'),
      longText('答3'),
    ]);
    runtime = await AgentRuntime.create(
      makeConfig(root!, {
        SUMMARY_ENABLED: 'true',
        SUMMARY_TRIGGER_TOKENS: '200',
        SUMMARY_KEEP_TOKENS: '100',
        SUMMARY_TRIM_TOKENS: '1000',
      }),
      { model },
    );

    await runtime.run(longText('问1'), { threadId: 'auto' });
    await runtime.run(longText('问2'), { threadId: 'auto' });
    const third = await runtime.run(longText('问3'), { threadId: 'auto' });

    expect(third.messages).toHaveLength(3);
    expect(third.messages[0]?.additional_kwargs['lc_source']).toBe('summarization');
    expect(third.messages[1]?.text).toContain('问3');
    expect(third.messages[2]?.getType()).toBe('ai');
  });

  it('摘要走的是中文 prompt 且包含被压缩掉的原文', async () => {
    const model = new ScriptedChatModel([
      longText('答1'),
      longText('答2'),
      longText('答3'),
    ]);
    runtime = await AgentRuntime.create(
      makeConfig(root!, {
        SUMMARY_TRIGGER_TOKENS: '200',
        SUMMARY_KEEP_TOKENS: '100',
        SUMMARY_TRIM_TOKENS: '1000',
      }),
      { model },
    );

    await runtime.run(longText('问1'), { threadId: 'prompt' });
    await runtime.run(longText('问2'), { threadId: 'prompt' });
    await runtime.run(longText('问3'), { threadId: 'prompt' });

    expect(model.summaryPrompts).toHaveLength(1);
    expect(model.summaryPrompts[0]).toContain(SUMMARY_PROMPT_MARKER);
    expect(model.summaryPrompts[0]).toContain('问1');
    expect(model.summaryPrompts[0]).toContain('答2');
  });

  it('压缩后的 HumanMessage 摘要不会污染最终回答文本', async () => {
    const model = new ScriptedChatModel([
      longText('答1'),
      longText('答2'),
      longText('答3'),
    ]);
    runtime = await AgentRuntime.create(
      makeConfig(root!, {
        SUMMARY_TRIGGER_TOKENS: '200',
        SUMMARY_KEEP_TOKENS: '100',
        SUMMARY_TRIM_TOKENS: '1000',
      }),
      { model },
    );

    await runtime.run(longText('问1'), { threadId: 'text' });
    await runtime.run(longText('问2'), { threadId: 'text' });
    const third = await runtime.run(longText('问3'), { threadId: 'text' });

    expect(third.text).toContain('答3');
    expect(third.text).not.toContain('## 任务目标');
  });

  it('未达阈值时不压缩', async () => {
    const model = new ScriptedChatModel([longText('答1'), longText('答2')]);
    runtime = await AgentRuntime.create(
      makeConfig(root!, {
        SUMMARY_TRIGGER_TOKENS: '100000',
        SUMMARY_KEEP_TOKENS: '100',
      }),
      { model },
    );

    await runtime.run(longText('问1'), { threadId: 'small' });
    const second = await runtime.run(longText('问2'), { threadId: 'small' });

    expect(model.summaryPrompts).toHaveLength(0);
    expect(second.messages[0]?.additional_kwargs['lc_source']).toBeUndefined();
  });

  it('可以主动触发压缩并写回 checkpoint', async () => {
    const model = new ScriptedChatModel([longText('答1'), longText('答2')]);
    runtime = await AgentRuntime.create(
      makeConfig(root!, {
        SUMMARY_TRIGGER_TOKENS: '100000',
        SUMMARY_KEEP_TOKENS: '160',
        SUMMARY_TRIM_TOKENS: '1000',
      }),
      { model },
    );

    await runtime.run(longText('问1'), { threadId: 'manual' });
    await runtime.run(longText('问2'), { threadId: 'manual' });

    const outcome = await runtime.summarize({ threadId: 'manual' });

    expect(outcome.summarized).toBe(true);
    expect(outcome.reason).toBe('ok');
    expect(outcome.beforeMessages).toBe(4);
    expect(outcome.preservedMessages).toBe(2);
    expect(outcome.afterMessages).toBe(3);
    expect(outcome.summary).toContain('任务目标');
  });

  it('主动触发后模型看到的是压缩后的历史', async () => {
    const model = new ScriptedChatModel([
      longText('答1'),
      longText('答2'),
      longText('答3'),
    ]);
    runtime = await AgentRuntime.create(
      makeConfig(root!, {
        SUMMARY_TRIGGER_TOKENS: '100000',
        SUMMARY_KEEP_TOKENS: '160',
        SUMMARY_TRIM_TOKENS: '1000',
      }),
      { model },
    );

    await runtime.run(longText('问1'), { threadId: 'after' });
    await runtime.run(longText('问2'), { threadId: 'after' });
    await runtime.summarize({ threadId: 'after' });
    await runtime.run(longText('问3'), { threadId: 'after' });

    const lastCall = model.mainCalls.at(-1);
    const summarySeen = (lastCall ?? []).some(
      (message) => message.additional_kwargs['lc_source'] === 'summarization',
    );
    expect(summarySeen).toBe(true);
  });

  it('写回 checkpoint 时显式指定 asNode = START', async () => {
    const model = new ScriptedChatModel([longText('答1'), longText('答2')]);
    runtime = await AgentRuntime.create(
      makeConfig(root!, {
        SUMMARY_TRIGGER_TOKENS: '100000',
        SUMMARY_KEEP_TOKENS: '160',
        SUMMARY_TRIM_TOKENS: '1000',
      }),
      { model },
    );

    await runtime.run(longText('问1'), { threadId: 'asnode' });
    await runtime.run(longText('问2'), { threadId: 'asnode' });

    const spy = vi.spyOn(CompiledStateGraph.prototype, 'updateState');
    try {
      const outcome = await runtime.summarize({ threadId: 'asnode' });
      expect(outcome.reason).toBe('ok');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[2]).toBe(START);
    } finally {
      spy.mockRestore();
    }
  });

  it('重复触发是幂等 no-op', async () => {
    const model = new ScriptedChatModel([longText('答1'), longText('答2')]);
    runtime = await AgentRuntime.create(
      makeConfig(root!, {
        SUMMARY_TRIGGER_TOKENS: '100000',
        SUMMARY_KEEP_TOKENS: '160',
        SUMMARY_TRIM_TOKENS: '1000',
      }),
      { model },
    );

    await runtime.run(longText('问1'), { threadId: 'idem' });
    await runtime.run(longText('问2'), { threadId: 'idem' });

    const first = await runtime.summarize({ threadId: 'idem' });
    const second = await runtime.summarize({ threadId: 'idem' });

    expect(first.reason).toBe('ok');
    expect(second.summarized).toBe(false);
    expect(second.reason).toBe('not-needed');
  });

  it('空 thread 不触发任何模型调用', async () => {
    const model = new ScriptedChatModel();
    runtime = await AgentRuntime.create(makeConfig(root!), { model });

    const outcome = await runtime.summarize({ threadId: 'empty' });

    expect(outcome.summarized).toBe(false);
    expect(outcome.reason).toBe('empty');
    expect(model.summaryPrompts).toHaveLength(0);
  });

  it('总开关关闭时不装中间件且主动触发返回 disabled', async () => {
    const model = new ScriptedChatModel([
      longText('答1'),
      longText('答2'),
      longText('答3'),
    ]);
    runtime = await AgentRuntime.create(
      makeConfig(root!, {
        SUMMARY_ENABLED: 'false',
        SUMMARY_TRIGGER_TOKENS: '10',
        SUMMARY_KEEP_TOKENS: '10',
      }),
      { model },
    );

    await runtime.run(longText('问1'), { threadId: 'off' });
    await runtime.run(longText('问2'), { threadId: 'off' });
    const third = await runtime.run(longText('问3'), { threadId: 'off' });

    expect(model.summaryPrompts).toHaveLength(0);
    expect(third.messages[0]?.additional_kwargs['lc_source']).toBeUndefined();

    const outcome = await runtime.summarize({ threadId: 'off' });
    expect(outcome.summarized).toBe(false);
    expect(outcome.reason).toBe('disabled');
  });

  it('注入的 summaryModel 承担摘要调用', async () => {
    const mainModel = new ScriptedChatModel([longText('答1'), longText('答2')]);
    const summaryModel = new ScriptedChatModel();
    runtime = await AgentRuntime.create(
      makeConfig(root!, {
        SUMMARY_TRIGGER_TOKENS: '100000',
        SUMMARY_KEEP_TOKENS: '160',
        SUMMARY_TRIM_TOKENS: '1000',
      }),
      { model: mainModel, summaryModel },
    );

    await runtime.run(longText('问1'), { threadId: 'inject' });
    await runtime.run(longText('问2'), { threadId: 'inject' });
    const outcome = await runtime.summarize({ threadId: 'inject' });

    expect(outcome.reason).toBe('ok');
    expect(summaryModel.summaryPrompts).toHaveLength(1);
    expect(mainModel.summaryPrompts).toHaveLength(0);
  });

  it('摘要失败时不写回、历史保持原样', async () => {
    const mainModel = new ScriptedChatModel([longText('答1'), longText('答2')]);
    const summaryModel = new ThrowingChatModel();
    runtime = await AgentRuntime.create(
      makeConfig(root!, {
        SUMMARY_TRIGGER_TOKENS: '100000',
        SUMMARY_KEEP_TOKENS: '160',
        SUMMARY_TRIM_TOKENS: '1000',
      }),
      { model: mainModel, summaryModel },
    );

    await runtime.run(longText('问1'), { threadId: 'fail' });
    await runtime.run(longText('问2'), { threadId: 'fail' });
    const outcome = await runtime.summarize({ threadId: 'fail' });

    expect(outcome.summarized).toBe(false);
    expect(outcome.reason).toBe('failed');

    await runtime.run(longText('问3'), { threadId: 'fail' });
    const lastCall = mainModel.mainCalls.at(-1) ?? [];
    const summarySeen = lastCall.some(
      (message) => message.additional_kwargs['lc_source'] === 'summarization',
    );
    expect(summarySeen).toBe(false);
  });

  it('keepMessages 按条数覆盖保留预算', async () => {
    const model = new ScriptedChatModel([longText('答1'), longText('答2')]);
    runtime = await AgentRuntime.create(
      makeConfig(root!, {
        SUMMARY_TRIGGER_TOKENS: '100000',
        SUMMARY_KEEP_TOKENS: '160',
        SUMMARY_TRIM_TOKENS: '1000',
      }),
      { model },
    );

    await runtime.run(longText('问1'), { threadId: 'keep' });
    await runtime.run(longText('问2'), { threadId: 'keep' });
    const outcome = await runtime.summarize({ threadId: 'keep', keepMessages: 1 });

    expect(outcome.reason).toBe('ok');
    expect(outcome.preservedMessages).toBe(1);
    expect(outcome.afterMessages).toBe(2);
  });
});
