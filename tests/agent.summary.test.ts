import { describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage, RemoveMessage, ToolMessage } from '@langchain/core/messages';
import { REMOVE_ALL_MESSAGES } from '@langchain/langgraph';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import {
  SUMMARY_PREFIX,
  SUMMARY_PROMPT,
  SUMMARY_PROMPT_MARKER,
  countMessageTokens,
  createSummaryMiddleware,
  extractSummaryText,
  looksLikeSummaryCall,
  planSummary,
} from '../src/agent/index.js';
import type { SummaryPolicy } from '../src/agent/index.js';
import { createLogger } from '../src/shared/index.js';

const silentLogger = createLogger('silent', 'test');

const POLICY: SummaryPolicy = {
  enabled: true,
  triggerTokens: 100,
  keepTokens: 30,
  trimTokens: 1000,
};

/** 60 个中文字符 + 1 个 ASCII 数字，CJK 感知计数器下是 61 token（60 + ceil(1/4)）。 */
function longText(marker: string): string {
  return `${marker}${'测'.repeat(59)}`;
}

function history(): [HumanMessage, AIMessage, HumanMessage, AIMessage] {
  return [
    new HumanMessage(longText('问1')),
    new AIMessage(longText('答1')),
    new HumanMessage(longText('问2')),
    new AIMessage(longText('答2')),
  ];
}

describe('SUMMARY_PROMPT', () => {
  it('恰好含一处 {messages} 占位符', () => {
    expect(SUMMARY_PROMPT.split('{messages}').length - 1).toBe(1);
  });

  it('不含其它花括号，避免 SDK 的 replace 只替换第一处时漏改', () => {
    const withoutPlaceholder = SUMMARY_PROMPT.replace('{messages}', '');
    expect(withoutPlaceholder).not.toContain('{');
    expect(withoutPlaceholder).not.toContain('}');
  });

  it('含五个输出小节标题', () => {
    for (const heading of [
      '## 任务目标',
      '## 关键事实',
      '## 已完成的操作',
      '## 决策与约束',
      '## 未决事项与下一步',
    ]) {
      expect(SUMMARY_PROMPT).toContain(heading);
    }
  });

  it('含识别标记', () => {
    expect(SUMMARY_PROMPT).toContain(SUMMARY_PROMPT_MARKER);
  });

  it('前缀是中文且非空', () => {
    expect(SUMMARY_PREFIX.length).toBeGreaterThan(0);
    expect(SUMMARY_PREFIX).toContain('摘要');
  });
});

describe('countMessageTokens', () => {
  it('中文按一字一 token 计', () => {
    expect(countMessageTokens([new HumanMessage('你好世界')])).toBe(4);
  });

  it('ASCII 按四字符一 token 计', () => {
    expect(countMessageTokens([new HumanMessage('abcdefgh')])).toBe(2);
  });

  it('中英混合分别计数', () => {
    expect(countMessageTokens([new HumanMessage('你好abcd')])).toBe(3);
  });

  it('AI 消息的 tool_calls 也计入', () => {
    const plain = new AIMessage('调用工具');
    const withCalls = new AIMessage({
      content: '调用工具',
      tool_calls: [
        { name: 'sandbox_exec', args: { command: 'ls' }, id: 'call_1' },
      ],
    });

    expect(countMessageTokens([withCalls])).toBeGreaterThan(
      countMessageTokens([plain]),
    );
  });

  it('Tool 消息的 tool_call_id 也计入', () => {
    const withoutId = new ToolMessage({ content: 'ok', tool_call_id: '' });
    const withId = new ToolMessage({ content: 'ok', tool_call_id: 'call_123456' });

    expect(countMessageTokens([withId])).toBeGreaterThan(
      countMessageTokens([withoutId]),
    );
  });

  it('空历史返回 0', () => {
    expect(countMessageTokens([])).toBe(0);
  });
});

describe('looksLikeSummaryCall', () => {
  it('单条 human 消息且含识别标记时判定为摘要调用', () => {
    expect(looksLikeSummaryCall([new HumanMessage(SUMMARY_PROMPT)])).toBe(true);
  });

  it('普通 human 消息不算摘要调用', () => {
    expect(looksLikeSummaryCall([new HumanMessage('普通问题')])).toBe(false);
  });

  it('多于一条消息不算摘要调用', () => {
    expect(
      looksLikeSummaryCall([
        new HumanMessage(SUMMARY_PROMPT),
        new AIMessage('回答'),
      ]),
    ).toBe(false);
  });

  it('AI 消息即使含标记也不算摘要调用', () => {
    expect(looksLikeSummaryCall([new AIMessage(SUMMARY_PROMPT)])).toBe(false);
  });
});

describe('planSummary', () => {
  it('历史短于保留预算时不做任何事', async () => {
    const middleware = createSummaryMiddleware(
      new FakeListChatModel({ responses: ['摘要正文'] }),
      { ...POLICY, keepTokens: 2000 },
      silentLogger,
    );

    const update = await planSummary(middleware, [
      new HumanMessage('你好'),
      new AIMessage('你好'),
    ]);

    expect(update).toBeUndefined();
  });

  it('写回数组第一项是 REMOVE_ALL 的 RemoveMessage', async () => {
    const middleware = createSummaryMiddleware(
      new FakeListChatModel({ responses: ['摘要正文'] }),
      POLICY,
      silentLogger,
    );

    const update = await planSummary(middleware, history());

    expect(update).toBeDefined();
    const removal = update?.[0];
    expect(removal).toBeInstanceOf(RemoveMessage);
    expect(removal?.id).toBe(REMOVE_ALL_MESSAGES);
  });

  it('摘要以 HumanMessage 形态落库并带 lc_source 标记', async () => {
    const middleware = createSummaryMiddleware(
      new FakeListChatModel({ responses: ['摘要正文'] }),
      POLICY,
      silentLogger,
    );

    const update = await planSummary(middleware, history());

    const summary = update?.[1];
    expect(summary).toBeInstanceOf(HumanMessage);
    expect(summary?.additional_kwargs['lc_source']).toBe('summarization');
    expect(summary?.text).toContain(SUMMARY_PREFIX);
    expect(summary?.text).toContain('摘要正文');
  });

  it('按 token 预算保留最近的消息', async () => {
    const middleware = createSummaryMiddleware(
      new FakeListChatModel({ responses: ['摘要正文'] }),
      POLICY,
      silentLogger,
    );

    const update = await planSummary(middleware, history());

    // RemoveMessage + 摘要 + 保留的 1 条：保留预算 30 token 装不下任何一条 60 token 的消息
    expect(update).toHaveLength(3);
    expect(update?.[2]?.text).toContain('答2');
  });

  it('keepMessages 按条数覆盖保留预算', async () => {
    const middleware = createSummaryMiddleware(
      new FakeListChatModel({ responses: ['摘要正文'] }),
      POLICY,
      silentLogger,
    );

    const update = await planSummary(middleware, history(), { keepMessages: 3 });

    // RemoveMessage + 摘要 + 保留的 3 条
    expect(update).toHaveLength(5);
    expect(update?.[4]?.text).toContain('答2');
  });

  it('空历史不做任何事', async () => {
    const middleware = createSummaryMiddleware(
      new FakeListChatModel({ responses: ['摘要正文'] }),
      POLICY,
      silentLogger,
    );

    expect(await planSummary(middleware, [])).toBeUndefined();
  });
});

describe('extractSummaryText', () => {
  function summaryMessage(body: string): HumanMessage {
    return new HumanMessage({
      content: `${SUMMARY_PREFIX}\n\n${body}`,
      additional_kwargs: { lc_source: 'summarization' },
    });
  }

  it('正常摘要剥掉前缀后返回正文', () => {
    const update = [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), summaryMessage('## 任务目标\n- 摘要')];
    expect(extractSummaryText(update)).toBe('## 任务目标\n- 摘要');
  });

  it('SDK 的「生成摘要出错」标记视为失败', () => {
    const update = [summaryMessage('Error generating summary: 模拟故障')];
    expect(extractSummaryText(update)).toBeUndefined();
  });

  it('SDK 的「历史太长无法摘要」标记视为失败', () => {
    const update = [summaryMessage('Previous conversation was too long to summarize.')];
    expect(extractSummaryText(update)).toBeUndefined();
  });

  it('没有摘要消息时返回 undefined', () => {
    expect(extractSummaryText([new HumanMessage('普通消息')])).toBeUndefined();
  });
});
