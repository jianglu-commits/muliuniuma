import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import type { FakeChatInput, ToolSpec } from '@langchain/core/utils/testing';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { tool } from 'langchain';
import { z } from 'zod';
import type { StructuredTool, StructuredToolInterface } from '@langchain/core/tools';
import { loadConfig } from '../src/config/index.js';
import type { AppConfig } from '../src/config/index.js';
import { AgentRuntime, mergeToolGroups } from '../src/agent/index.js';
import { McpHub } from '../src/mcp/index.js';
import { LocalProcessSandbox } from '../src/sandbox/index.js';
import type { Logger } from '../src/shared/index.js';

interface SaverMockState {
  /** strict：第二次 close 抛错；failOnce：第一次 close 抛错。 */
  mode: 'strict' | 'failOnce';
  /** 记录每次 close 的调用顺序，便于断言「三个资源都被尝试关闭」。 */
  records: string[];
}

const saverMock = vi.hoisted((): SaverMockState => ({ mode: 'strict', records: [] }));

/**
 * dispose 的幂等守卫必须有可观测的失败才有判别力：
 * 真实 better-sqlite3 的 close() 本身是幂等的，重复关闭并不会抛错。
 * 这里用严格替身制造失败——strict 模式下第二次 close 抛错，
 * failOnce 模式下第一次 close 抛错——让守卫与重试路径都可观测。
 */
vi.mock('@langchain/langgraph-checkpoint-sqlite', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@langchain/langgraph-checkpoint-sqlite')>();

  class StrictSqliteSaver extends original.SqliteSaver {
    static override fromConnString(connStringOrLocalPath: string): StrictSqliteSaver {
      const base = original.SqliteSaver.fromConnString(connStringOrLocalPath);
      const db = base.db;
      let closes = 0;
      const close = db.close.bind(db);
      db.close = (): void => {
        closes += 1;
        saverMock.records.push('db');
        if (saverMock.mode === 'failOnce' && closes === 1) {
          throw new Error('模拟首次 close 失败');
        }
        if (saverMock.mode === 'strict' && closes > 1) {
          throw new Error('模拟重复 close 失败');
        }
        close();
      };
      return new StrictSqliteSaver(db);
    }
  }

  return { SqliteSaver: StrictSqliteSaver };
});

/**
 * 记录模型真正收到的 messages：FakeListChatModel.bindTools 会新建一个普通实例，
 * 绕开子类的 _generate，所以这里同时覆写 bindTools，把绑定后的模型换成自己
 * （假模型不消费工具 schema，故不再转绑）。
 */
class RecordingChatModel extends FakeListChatModel {
  constructor(
    params: FakeChatInput,
    private readonly recorder: BaseMessage[][],
  ) {
    super(params);
  }

  override async _generate(
    messages: BaseMessage[],
    options?: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    this.recorder.push(messages);
    return super._generate(messages, options, runManager);
  }

  override bindTools(
    tools: (StructuredTool | ToolSpec)[],
  ): ReturnType<FakeListChatModel['bindTools']> {
    return this.withConfig({});
  }
}

interface LogCall {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

function createRecordingLogger(): { logger: Logger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const record =
    (level: LogCall['level']) =>
    (message: string, ..._rest: unknown[]): void => {
      calls.push({ level, message });
    };
  const logger: Logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
  };
  return { logger, calls };
}

function makeTool(name: string): StructuredToolInterface {
  return tool(async () => name, {
    name,
    description: name,
    schema: z.object({}),
  });
}

function makeArtifactTool(name: string): StructuredToolInterface {
  return tool(async ({ value }): Promise<[string, { artifact: boolean }]> => [value, { artifact: true }], {
    name,
    description: name,
    schema: z.object({ value: z.string() }),
    responseFormat: 'content_and_artifact',
  });
}

describe('mergeToolGroups', () => {
  it('同名工具按来源优先级保留并给后者加后缀', () => {
    const builtin = makeTool('dup');
    const mcp = makeTool('dup');
    const merged = mergeToolGroups([
      { source: 'mcp', tools: [mcp] },
      { source: 'builtin', tools: [builtin] },
    ]);

    expect(merged).toHaveLength(2);
    expect(merged.map((t) => t.name)).toEqual(['dup', 'dup_1']);
    expect(merged[0]).toBe(builtin);
    expect(merged[1]).not.toBe(mcp);
  });

  it('不同名工具保持原样', () => {
    const merged = mergeToolGroups([
      { source: 'builtin', tools: [makeTool('a')] },
      { source: 'skill', tools: [makeTool('b')] },
    ]);
    expect(merged.map((t) => t.name)).toEqual(['a', 'b']);
  });

  it('同源工具的相对顺序保持不变', () => {
    const merged = mergeToolGroups([
      { source: 'skill', tools: [makeTool('z_first'), makeTool('a_second')] },
      { source: 'skill', tools: [makeTool('m_third')] },
    ]);

    expect(merged.map((t) => t.name)).toEqual(['z_first', 'a_second', 'm_third']);
  });

  it('重命名后的工具仍可 invoke 且返回原值', async () => {
    const merged = mergeToolGroups([
      { source: 'builtin', tools: [makeTool('dup')] },
      { source: 'mcp', tools: [makeTool('dup')] },
    ]);

    const renamed = merged[1]!;
    expect(renamed.name).toBe('dup_1');
    expect(String(await renamed.invoke({}))).toBe('dup');
  });

  it('重命名后缀取当前未被占用的最小值', () => {
    const merged = mergeToolGroups([
      { source: 'builtin', tools: [makeTool('dup'), makeTool('dup_1')] },
      { source: 'mcp', tools: [makeTool('dup')] },
    ]);

    expect(merged.map((t) => t.name)).toEqual(['dup', 'dup_1', 'dup_2']);
  });

  it('四个来源齐全时最终顺序符合优先级', () => {
    const merged = mergeToolGroups([
      { source: 'a2a', tools: [makeTool('a')] },
      { source: 'mcp', tools: [makeTool('m')] },
      { source: 'skill', tools: [makeTool('s')] },
      { source: 'builtin', tools: [makeTool('b')] },
    ]);

    expect(merged.map((t) => t.name)).toEqual(['b', 's', 'm', 'a']);
  });

  it('改名后 own-property 描述符与 .name 一致', () => {
    const merged = mergeToolGroups([
      { source: 'builtin', tools: [makeTool('dup')] },
      { source: 'mcp', tools: [makeTool('dup')] },
    ]);

    const renamed = merged[1]!;
    expect(renamed.name).toBe('dup_1');
    expect(Object.getOwnPropertyDescriptor(renamed, 'name')?.value).toBe('dup_1');
    expect({ ...renamed }.name).toBe('dup_1');
  });

  it('改名后的工具写入 name 抛错且不污染原对象', () => {
    const original = makeTool('dup');
    const merged = mergeToolGroups([
      { source: 'builtin', tools: [makeTool('dup')] },
      { source: 'mcp', tools: [original] },
    ]);

    const renamed = merged[1]!;
    expect(() => {
      renamed.name = 'hacked';
    }).toThrow(/name/);
    expect(original.name).toBe('dup');
    expect(renamed.name).toBe('dup_1');
  });

  it('带 content_and_artifact 的工具改名后语义不变', async () => {
    const merged = mergeToolGroups([
      { source: 'builtin', tools: [makeTool('dup')] },
      { source: 'skill', tools: [makeArtifactTool('dup')] },
    ]);

    const renamed = merged[1]!;
    expect(renamed.name).toBe('dup_1');

    const message = await renamed.invoke({
      type: 'tool_call',
      id: 'call_1',
      name: 'dup_1',
      args: { value: 'hi' },
    });
    expect(message).toMatchObject({ content: 'hi', artifact: { artifact: true } });
    expect(Object.getOwnPropertyDescriptor(renamed, 'responseFormat')?.value).toBe(
      'content_and_artifact',
    );
  });

  it('工具名冲突时通过注入的 logger 告警且含原名与新名', () => {
    const { logger, calls } = createRecordingLogger();

    mergeToolGroups(
      [
        { source: 'builtin', tools: [makeTool('dup')] },
        { source: 'mcp', tools: [makeTool('dup')] },
      ],
      logger,
    );

    const warns = calls.filter((call) => call.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.message).toContain('dup');
    expect(warns[0]?.message).toContain('dup_1');
  });
});

function makeConfig(root: string, checkpointDb?: string): AppConfig {
  return loadConfig({
    LLM_PROVIDER: 'openai-compatible',
    LLM_MODEL: 'gpt-4o-mini',
    LLM_BASE_URL: 'https://example.com/v1',
    LLM_API_KEY: 'sk-test',
    SKILLS_DIR: join(root, 'skills'),
    CHECKPOINT_DB: checkpointDb ?? join(root, 'data', 'checkpoints.sqlite'),
    MCP_CONFIG: join(root, 'mcp.json'),
    A2A_PEERS: join(root, 'peers.json'),
    SANDBOX_ROOT: join(root, 'sandbox'),
  });
}

async function writeSkill(
  root: string,
  folder: string,
  name: string,
  description: string,
  body: string,
): Promise<void> {
  const skillDir = join(root, 'skills', folder);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, 'SKILL.md'),
    ['---', `name: ${name}`, `description: ${description}`, '---', body].join('\n'),
  );
}

/** 暴露一个名为 exec 的 MCP 工具：server 名 sandbox + 工具名 exec → sandbox_exec，与内置工具同名。 */
const MCP_EXEC_SERVER_SOURCE = [
  "import { createInterface } from 'node:readline';",
  '',
  "const rl = createInterface({ input: process.stdin, terminal: false });",
  '',
  'function send(msg) {',
  "  process.stdout.write(`${JSON.stringify(msg)}\\n`);",
  '}',
  '',
  'const execTool = {',
  "  name: 'exec',",
  "  description: 'MCP 侧的同名工具',",
  "  inputSchema: { type: 'object', properties: { command: { type: 'string' } } },",
  '};',
  '',
  "rl.on('line', (line) => {",
  '  const trimmed = line.trim();',
  '  if (trimmed.length === 0) return;',
  '  let req;',
  '  try {',
  '    req = JSON.parse(trimmed);',
  '  } catch {',
  '    return;',
  '  }',
  "  if (req.method === 'initialize') {",
  '    send({',
  '      jsonrpc: "2.0",',
  '      id: req.id,',
  '      result: {',
  '        protocolVersion: req.params?.protocolVersion ?? "2025-06-18",',
  '        capabilities: { tools: {} },',
  '        serverInfo: { name: "probe-server", version: "0.0.1" },',
  '      },',
  '    });',
  '    return;',
  '  }',
  "  if (req.method === 'tools/list') {",
  '    send({ jsonrpc: "2.0", id: req.id, result: { tools: [execTool] } });',
  '    return;',
  '  }',
  "  if (req.method === 'tools/call') {",
  '    send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "mcp-exec" }] } });',
  '    return;',
  '  }',
  '  if (req.id !== undefined) {',
  '    send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "method not found" } });',
  '  }',
  '});',
  '',
].join('\n');

describe('AgentRuntime', () => {
  let root: string | undefined;
  let runtime: AgentRuntime | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'runtime-'));
    saverMock.mode = 'strict';
    saverMock.records.length = 0;
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

  it('用注入的 fake model 跑通一轮并返回文本', async () => {
    runtime = await AgentRuntime.create(makeConfig(root!), {
      model: new FakeListChatModel({ responses: ['模型回答'] }),
    });

    const result = await runtime.run('你好', { threadId: 't1' });
    expect(result.text).toBe('模型回答');
  });

  it('run 把已 abort 的 signal 转发给 agent 并拒绝', async () => {
    runtime = await AgentRuntime.create(makeConfig(root!), {
      model: new FakeListChatModel({ responses: ['模型回答'] }),
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      runtime.run('你好', { threadId: 't-abort', signal: controller.signal }),
    ).rejects.toThrow(/aborted/i);
  });

  it('同一 threadId 的第二次调用能看到历史消息', async () => {
    runtime = await AgentRuntime.create(makeConfig(root!), {
      model: new FakeListChatModel({ responses: ['第一轮', '第二轮'] }),
    });

    const first = await runtime.run('第一问', { threadId: 'same' });
    const second = await runtime.run('第二问', { threadId: 'same' });

    expect(first.messages).toHaveLength(2);
    expect(second.messages.length).toBeGreaterThan(first.messages.length);
    expect(second.messages.length).toBeGreaterThan(2);
    expect(
      second.messages.some(
        (message) =>
          message.getType() === 'human' && String(message.content).includes('第一问'),
      ),
    ).toBe(true);
  });

  it('不同 threadId 的会话互不影响', async () => {
    runtime = await AgentRuntime.create(makeConfig(root!), {
      model: new FakeListChatModel({ responses: ['第一轮', '第二轮'] }),
    });

    await runtime.run('第一问', { threadId: 'same' });
    const other = await runtime.run('第二问', { threadId: 'other' });

    expect(other.messages).toHaveLength(2);
  });

  it('system prompt 含 skill 的 name 与 description、不含 body', async () => {
    await writeSkill(root!, 'demo', 'demo', '演示技能', '这是正文里的秘密');

    runtime = await AgentRuntime.create(makeConfig(root!), {
      model: new FakeListChatModel({ responses: ['模型回答'] }),
    });

    const prompt = runtime.systemPrompt();
    expect(prompt).toContain('demo');
    expect(prompt).toContain('演示技能');
    expect(prompt).not.toContain('这是正文里的秘密');
  });

  it('无 skill 时 system prompt 不含 skill 段落', async () => {
    runtime = await AgentRuntime.create(makeConfig(root!), {
      model: new FakeListChatModel({ responses: ['模型回答'] }),
    });

    const prompt = runtime.systemPrompt();
    expect(prompt).not.toContain('可用 skill');
    expect(prompt).toContain('你是一个可扩展 Agent 运行时的执行体。');
  });

  it('listSkills 返回已加载的 skill', async () => {
    await writeSkill(root!, 'demo', 'demo', '演示技能', '正文');
    await writeSkill(root!, 'other', 'other', '另一个技能', '正文');

    runtime = await AgentRuntime.create(makeConfig(root!), {
      model: new FakeListChatModel({ responses: ['模型回答'] }),
    });

    expect(runtime.listSkills().map((skill) => skill.name)).toEqual(['demo', 'other']);
  });

  it('dispose 可重复调用', async () => {
    runtime = await AgentRuntime.create(makeConfig(root!), {
      model: new FakeListChatModel({ responses: ['模型回答'] }),
    });

    await runtime.dispose();
    await runtime.dispose();
    runtime = undefined;
  });

  it('关闭失败后可重试，且三个资源都被尝试关闭', async () => {
    saverMock.mode = 'failOnce';
    const mcpError = new Error('mcp 关闭失败');
    let mcpAttempts = 0;

    const mcpSpy = vi
      .spyOn(McpHub.prototype, 'close')
      .mockImplementation(async (): Promise<void> => {
        mcpAttempts += 1;
        saverMock.records.push('mcp');
        if (mcpAttempts === 1) throw mcpError;
      });

    const originalSandboxDispose = LocalProcessSandbox.prototype.dispose;
    const sandboxSpy = vi
      .spyOn(LocalProcessSandbox.prototype, 'dispose')
      .mockImplementation(async function (this: LocalProcessSandbox): Promise<void> {
        saverMock.records.push('sandbox');
        await originalSandboxDispose.call(this);
      });

    try {
      const created = await AgentRuntime.create(makeConfig(root!), {
        model: new FakeListChatModel({ responses: ['模型回答'] }),
      });
      runtime = created;

      // 第一个失败是 mcp 的异常：即使后面的 db close 也失败，抛出的仍应是它。
      await expect(created.dispose()).rejects.toBe(mcpError);
      expect(saverMock.records).toEqual(['mcp', 'sandbox', 'db']);

      // 关闭失败后必须留下重试机会：第二次 dispose 真正再跑一遍并成功。
      await created.dispose();
      expect(saverMock.records).toEqual(['mcp', 'sandbox', 'db', 'mcp', 'sandbox', 'db']);
    } finally {
      mcpSpy.mockRestore();
      sandboxSpy.mockRestore();
      runtime = undefined;
    }
  });

  it('并发 dispose 共享同一次关闭', async () => {
    const mcpSpy = vi
      .spyOn(McpHub.prototype, 'close')
      .mockImplementation(async (): Promise<void> => {
        saverMock.records.push('mcp');
      });
    const sandboxSpy = vi
      .spyOn(LocalProcessSandbox.prototype, 'dispose')
      .mockImplementation(async (): Promise<void> => {
        saverMock.records.push('sandbox');
      });

    try {
      const created = await AgentRuntime.create(makeConfig(root!), {
        model: new FakeListChatModel({ responses: ['模型回答'] }),
      });
      runtime = created;

      await Promise.all([created.dispose(), created.dispose()]);
      expect(saverMock.records).toEqual(['mcp', 'sandbox', 'db']);
    } finally {
      mcpSpy.mockRestore();
      sandboxSpy.mockRestore();
      runtime = undefined;
    }
  });

  it('system prompt 作为系统消息真的送进了模型', async () => {
    await writeSkill(root!, 'demo', 'demo', '演示技能', '这是正文里的秘密');

    const recorder: BaseMessage[][] = [];
    const created = await AgentRuntime.create(makeConfig(root!), {
      model: new RecordingChatModel({ responses: ['模型回答'] }, recorder),
    });
    runtime = created;

    await created.run('你好', { threadId: 't1' });

    const systemMessages = recorder
      .flat()
      .filter((message) => message.getType() === 'system');
    expect(systemMessages).toHaveLength(1);
    const prompt = systemMessages[0]!.text;
    expect(prompt).toContain('demo');
    expect(prompt).toContain('演示技能');
    expect(prompt).not.toContain('这是正文里的秘密');
  });

  it('启动失败时回收已建的沙箱目录', async () => {
    await writeFile(
      join(root!, 'mcp.json'),
      JSON.stringify({ servers: { broken: 'not-an-object' } }),
    );

    await expect(
      AgentRuntime.create(makeConfig(root!), {
        model: new FakeListChatModel({ responses: ['模型回答'] }),
      }),
    ).rejects.toThrow(/broken/);

    const sandboxRoot = join(root!, 'sandbox');
    expect(existsSync(sandboxRoot)).toBe(true);
    expect(await readdir(sandboxRoot)).toEqual([]);
  });

  it('MCP 建连后启动失败时关闭 MCP 连接', async () => {
    const serverPath = join(root!, 'mcp-exec-server.mjs');
    await writeFile(serverPath, MCP_EXEC_SERVER_SOURCE);
    await writeFile(
      join(root!, 'mcp.json'),
      JSON.stringify({
        servers: {
          sandbox: {
            transport: 'stdio',
            command: process.execPath,
            args: [serverPath],
            stderr: 'ignore',
          },
        },
      }),
    );

    // checkpoint 目录的父路径是一个普通文件 → mkdir 必然 ENOTDIR；
    // 该步骤排在 MCP 建连之后，用来验证已拉起的 MCP 子进程也会被回收。
    const blocker = join(root!, 'blocker');
    await writeFile(blocker, 'not-a-dir');

    const closeSpy = vi.spyOn(McpHub.prototype, 'close');
    try {
      await expect(
        AgentRuntime.create(
          makeConfig(root!, join(blocker, 'checkpoints.sqlite')),
          { model: new FakeListChatModel({ responses: ['模型回答'] }) },
        ),
      ).rejects.toThrow(/EEXIST|ENOTDIR/);

      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
    }
  });

  it('启动清理失败时留下 warn 日志', async () => {
    await writeFile(
      join(root!, 'mcp.json'),
      JSON.stringify({ servers: { broken: 'not-an-object' } }),
    );

    const sandboxSpy = vi
      .spyOn(LocalProcessSandbox.prototype, 'dispose')
      .mockImplementation(async (): Promise<void> => {
        throw new Error('模拟沙箱清理失败');
      });

    const lines: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });

    try {
      await expect(
        AgentRuntime.create(makeConfig(root!), {
          model: new FakeListChatModel({ responses: ['模型回答'] }),
        }),
      ).rejects.toThrow(/broken/);
    } finally {
      stderrSpy.mockRestore();
      sandboxSpy.mockRestore();
    }

    const warn = lines.find((line) => line.includes('[warn] app:agent:'));
    expect(warn).toBeDefined();
    expect(warn).toContain('沙箱');
    expect(warn).toContain('模拟沙箱清理失败');
  });

  it('MCP 连接失败走注入的 logger', async () => {
    await writeFile(
      join(root!, 'mcp.json'),
      JSON.stringify({
        servers: {
          broken: {
            transport: 'stdio',
            command: 'definitely-not-a-real-binary',
            args: [],
            stderr: 'ignore',
          },
        },
      }),
    );

    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });

    try {
      runtime = await AgentRuntime.create(makeConfig(root!), {
        model: new FakeListChatModel({ responses: ['模型回答'] }),
      });
    } finally {
      spy.mockRestore();
    }

    const warn = lines.find((line) => line.includes('[warn] app:mcp:'));
    expect(warn).toBeDefined();
    expect(warn).toContain('broken');
  });

  it('MCP 工具与内置工具同名时按优先级改名并通过 app:tools logger 告警', async () => {
    const serverPath = join(root!, 'mcp-exec-server.mjs');
    await writeFile(serverPath, MCP_EXEC_SERVER_SOURCE);
    await writeFile(
      join(root!, 'mcp.json'),
      JSON.stringify({
        servers: {
          sandbox: {
            transport: 'stdio',
            command: process.execPath,
            args: [serverPath],
            stderr: 'ignore',
          },
        },
      }),
    );

    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });

    try {
      runtime = await AgentRuntime.create(makeConfig(root!), {
        model: new FakeListChatModel({ responses: ['模型回答'] }),
      });
    } finally {
      spy.mockRestore();
    }

    const warn = lines.find((line) => line.includes('[warn] app:tools:'));
    expect(warn).toBeDefined();
    expect(warn).toContain('sandbox_exec');
    expect(warn).toContain('sandbox_exec_1');
  });
});
