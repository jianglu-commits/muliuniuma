import { readFileSync } from 'node:fs';
import { A2A_PROTOCOL_VERSION, Role, TaskState } from '@a2a-js/sdk';
import type {
  AgentCard,
  Artifact,
  Message,
  Part,
  SendMessageResult,
  Task,
} from '@a2a-js/sdk';
import { describe, expect, it } from 'vitest';
import {
  buildAgentCard,
  buildTextMessage,
  extractResultText,
  extractText,
} from '../src/a2a/index.js';

function makePart(content: Part['content']): Part {
  return { content, metadata: undefined, filename: '', mediaType: 'text/plain' };
}

function makeMessage(parts: Part[]): Message {
  return {
    messageId: 'm-1',
    contextId: 'c-1',
    taskId: 't-1',
    role: Role.ROLE_AGENT,
    parts,
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

function makeArtifact(parts: Part[]): Artifact {
  return {
    artifactId: 'a-1',
    name: '结果',
    description: '结果描述',
    parts,
    metadata: undefined,
    extensions: [],
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't-1',
    contextId: 'c-1',
    status: undefined,
    artifacts: [],
    history: [],
    metadata: undefined,
    ...overrides,
  };
}

// 模拟远端返回的畸形数据：静态类型仍是 Task/Message，运行时缺字段。
function withUndefinedArtifacts(task: Task): Task {
  const copy: Task = { ...task };
  Object.assign(copy, { artifacts: undefined });
  return copy;
}

function withUndefinedParts(message: Message): Message {
  const copy: Message = { ...message };
  Object.assign(copy, { parts: undefined });
  return copy;
}

describe('buildTextMessage', () => {
  it('构造出可提取文本的 message', () => {
    const message = buildTextMessage({ text: '你好', contextId: 'c1', taskId: 't1' });
    expect(message.role).toBe(Role.ROLE_AGENT);
    expect(message.contextId).toBe('c1');
    expect(message.taskId).toBe('t1');
    expect(extractText(message)).toBe('你好');
  });

  it('默认 role 是 ROLE_AGENT', () => {
    const message = buildTextMessage({ text: 'hi' });
    expect(message.role).toBe(Role.ROLE_AGENT);
  });

  it('显式传 ROLE_USER 时角色正确', () => {
    const message = buildTextMessage({ text: 'hi', role: Role.ROLE_USER });
    expect(message.role).toBe(Role.ROLE_USER);
  });

  it('两次调用的 messageId 不同', () => {
    const first = buildTextMessage({ text: 'hi' });
    const second = buildTextMessage({ text: 'hi' });
    expect(first.messageId).not.toBe(second.messageId);
  });

  it('缺省 contextId 与 taskId 为空串，其余字段填全', () => {
    const message = buildTextMessage({ text: 'hi' });
    expect(message.contextId).toBe('');
    expect(message.taskId).toBe('');
    expect(message.metadata).toBeUndefined();
    expect(message.extensions).toEqual([]);
    expect(message.referenceTaskIds).toEqual([]);
  });

  it('part 填全 SDK 必填字段', () => {
    const message = buildTextMessage({ text: 'hi' });
    const part = message.parts[0];
    expect(part?.content).toEqual({ $case: 'text', value: 'hi' });
    expect(part?.metadata).toBeUndefined();
    expect(part?.filename).toBe('');
    expect(part?.mediaType).toBe('text/plain');
  });
});

describe('extractText', () => {
  it('没有文本 part 时返回空串', () => {
    const message = buildTextMessage({ text: '' });
    expect(extractText(message)).toBe('');
  });

  it('单个 text part 返回其文本', () => {
    const message = makeMessage([makePart({ $case: 'text', value: '你好' })]);
    expect(extractText(message)).toBe('你好');
  });

  it('多个 text part 直接拼接', () => {
    const message = makeMessage([
      makePart({ $case: 'text', value: '你' }),
      makePart({ $case: 'text', value: '好' }),
    ]);
    expect(extractText(message)).toBe('你好');
  });

  it('非文本 part 被忽略', () => {
    const message = makeMessage([
      makePart({ $case: 'url', value: 'https://example.com/a.txt' }),
      makePart({ $case: 'text', value: '正文' }),
      makePart({ $case: 'data', value: { a: 1 } }),
    ]);
    expect(extractText(message)).toBe('正文');
  });

  it('content 为 undefined 的 part 被忽略', () => {
    const message = makeMessage([
      makePart(undefined),
      makePart({ $case: 'text', value: '正文' }),
    ]);
    expect(extractText(message)).toBe('正文');
  });

  it('parts 为空数组时返回空串', () => {
    expect(extractText(makeMessage([]))).toBe('');
  });

  it('message 缺少 parts 时返回空串而不抛错', () => {
    expect(extractText(withUndefinedParts(makeMessage([])))).toBe('');
  });
});

describe('extractResultText', () => {
  it('从 Message 结果取文本', () => {
    const message = buildTextMessage({ text: 'answer' });
    expect(extractResultText(message)).toBe('answer');
  });

  it('Task 的 status.message 有文本时返回该文本', () => {
    const task = makeTask({
      status: {
        state: TaskState.TASK_STATE_COMPLETED,
        message: makeMessage([makePart({ $case: 'text', value: '进行中' })]),
        timestamp: undefined,
      },
    });
    expect(extractResultText(task)).toBe('进行中');
  });

  it('status 为 undefined 时不抛错并落到 artifacts', () => {
    const task = makeTask({
      status: undefined,
      artifacts: [makeArtifact([makePart({ $case: 'text', value: '产物' })])],
    });
    expect(extractResultText(task)).toBe('产物');
  });

  it('status.message 存在但无文本时落到 artifacts', () => {
    const task = makeTask({
      status: {
        state: TaskState.TASK_STATE_COMPLETED,
        message: makeMessage([makePart({ $case: 'url', value: 'https://example.com' })]),
        timestamp: undefined,
      },
      artifacts: [makeArtifact([makePart({ $case: 'text', value: '产物' })])],
    });
    expect(extractResultText(task)).toBe('产物');
  });

  it('多个 artifact 用换行连接', () => {
    const task = makeTask({
      artifacts: [
        makeArtifact([makePart({ $case: 'text', value: '第一段' })]),
        makeArtifact([makePart({ $case: 'text', value: '第二段' })]),
      ],
    });
    expect(extractResultText(task)).toBe('第一段\n第二段');
  });

  it('artifacts 缺失的畸形 Task 返回空串而不抛错', () => {
    const task = withUndefinedArtifacts(makeTask());
    expect(extractResultText(task)).toBe('');
  });

  it('status 与 artifacts 都无文本时返回空串', () => {
    const task = makeTask({
      status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: undefined },
      artifacts: [],
    });
    expect(extractResultText(task)).toBe('');
  });

  it('Message 与 Task 两种结果都能判别出类型', () => {
    const message: SendMessageResult = makeMessage([makePart({ $case: 'text', value: 'M' })]);
    const task: SendMessageResult = makeTask({
      artifacts: [makeArtifact([makePart({ $case: 'text', value: 'T' })])],
    });
    expect(extractResultText(message)).toBe('M');
    expect(extractResultText(task)).toBe('T');
  });
});

describe('buildAgentCard', () => {
  it('产出包含全部必填字段的卡片', () => {
    const card = buildAgentCard({
      name: 'demo-agent',
      description: '描述',
      publicUrl: 'http://localhost:4124',
      skills: [{ id: 's1', name: '技能一', description: '技能一的描述' }],
    });

    expect(card.name).toBe('demo-agent');
    expect(card.description).toBe('描述');
    expect(card.supportedInterfaces[0]?.url).toBe('http://localhost:4124');
    expect(card.supportedInterfaces[0]?.protocolBinding).toBe('JSONRPC');
    expect(card.skills[0]?.id).toBe('s1');
    expect(card.defaultInputModes).toContain('text/plain');
  });

  it('必填字段齐全', () => {
    const card = buildAgentCard({
      name: 'demo-agent',
      description: '描述',
      publicUrl: 'http://localhost:4124',
      skills: [{ id: 's1', name: '技能一', description: '技能一的描述' }],
    });

    expect(card.signatures).toEqual([]);
    expect(card.securitySchemes).toEqual({});
    expect(card.securityRequirements).toEqual([]);
    expect(card.defaultInputModes).toEqual(['text/plain']);
    expect(card.defaultOutputModes).toEqual(['text/plain']);
    expect(card.capabilities).toEqual({
      streaming: false,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    });
    expect(card.supportedInterfaces).toHaveLength(1);
    expect(card.skills).toHaveLength(1);
    expect(card.version).toBe('0.1.0');
  });

  it('protocolVersion 取自 SDK 常量', () => {
    const card = buildAgentCard({
      name: 'demo-agent',
      description: '描述',
      publicUrl: 'http://localhost:4124',
      skills: [],
    });
    expect(card.supportedInterfaces[0]?.protocolVersion).toBe(A2A_PROTOCOL_VERSION);
  });

  it('卡片源码不硬编码 protocolVersion 字面量', () => {
    const source = readFileSync(
      new URL('../src/a2a/card.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('A2A_PROTOCOL_VERSION');
    expect(source).not.toMatch(/protocolVersion:\s*['"]/);
  });

  it('skills[0] 的 inputModes 与 outputModes 和卡片默认一致', () => {
    const card = buildAgentCard({
      name: 'demo-agent',
      description: '描述',
      publicUrl: 'http://localhost:4124',
      skills: [{ id: 's1', name: '技能一', description: '技能一的描述' }],
    });
    expect(card.skills[0]?.inputModes).toEqual(card.defaultInputModes);
    expect(card.skills[0]?.outputModes).toEqual(card.defaultOutputModes);
  });

  it('未传 provider 时 card.provider 为 undefined', () => {
    const card = buildAgentCard({
      name: 'demo-agent',
      description: '描述',
      publicUrl: 'http://localhost:4124',
      skills: [],
    });
    expect(card.provider).toBeUndefined();
  });

  it('传入 provider 时写入卡片', () => {
    const card = buildAgentCard({
      name: 'demo-agent',
      description: '描述',
      publicUrl: 'http://localhost:4124',
      skills: [],
      provider: { url: 'https://example.com', organization: '示例组织' },
    });
    expect(card.provider).toEqual({
      url: 'https://example.com',
      organization: '示例组织',
    });
  });

  it('多个 skill 时数量与顺序正确', () => {
    const card = buildAgentCard({
      name: 'demo-agent',
      description: '描述',
      publicUrl: 'http://localhost:4124',
      skills: [
        { id: 's1', name: '技能一', description: '描述一' },
        { id: 's2', name: '技能二', description: '描述二' },
      ],
    });
    expect(card.skills.map((skill) => skill.id)).toEqual(['s1', 's2']);
  });

  it('卡片可 JSON 往返且关键字段不变', () => {
    const card = buildAgentCard({
      name: 'demo-agent',
      description: '描述',
      publicUrl: 'http://localhost:4124',
      skills: [{ id: 's1', name: '技能一', description: '技能一的描述' }],
    });

    const roundTripped: AgentCard = JSON.parse(JSON.stringify(card));
    expect(roundTripped.name).toBe(card.name);
    expect(roundTripped.description).toBe(card.description);
    expect(roundTripped.version).toBe(card.version);
    expect(roundTripped.supportedInterfaces[0]?.url).toBe(
      card.supportedInterfaces[0]?.url,
    );
    expect(roundTripped.supportedInterfaces[0]?.protocolVersion).toBe(
      A2A_PROTOCOL_VERSION,
    );
    expect(roundTripped.skills.map((skill) => skill.id)).toEqual(['s1']);
    expect(roundTripped.defaultInputModes).toEqual(['text/plain']);
  });
});
