import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createAgent } from 'langchain';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import type { AppConfig } from '../config/index.js';
import { createChatModel } from '../llm/index.js';
import { createSandbox } from '../sandbox/index.js';
import type { Sandbox } from '../sandbox/index.js';
import { createSandboxTools } from '../tools/index.js';
import { SkillRegistry, createLoadSkillTool, loadSkills } from '../skills/index.js';
import type { SkillManifest } from '../skills/index.js';
import { McpHub } from '../mcp/index.js';
import { A2AClientHub, createRemoteAgentTools } from '../a2a/index.js';
import { createLogger } from '../shared/index.js';
import { mergeToolGroups } from './tools.js';

export interface AgentRuntimeDeps {
  model?: BaseChatModel;
}

export interface RunResult {
  text: string;
  messages: BaseMessage[];
}

/**
 * 取最后一个有非空文本的 AI 消息。
 *
 * 用 instanceof AIMessage 而不是 getType() === 'ai'：AIMessage.text 是类上的
 * getter，只有拿到具体类型才能直接读，且反序列化后的消息实例化类型依然成立。
 */
export function extractFinalText(messages: BaseMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message instanceof AIMessage) {
      const text = message.text;
      if (text.length > 0) return text;
    }
  }
  return '';
}

export class AgentRuntime {
  private disposed = false;

  private constructor(
    private readonly agent: ReturnType<typeof createAgent>,
    private readonly sandbox: Sandbox,
    private readonly skillRegistry: SkillRegistry,
    private readonly mcpHub: McpHub,
    private readonly a2aHub: A2AClientHub,
    private readonly checkpointer: SqliteSaver,
    private readonly prompt: string,
  ) {}

  static async create(
    config: AppConfig,
    deps: AgentRuntimeDeps = {},
  ): Promise<AgentRuntime> {
    const appLogger = createLogger(config.logLevel, 'app');
    const model = deps.model ?? (await createChatModel(config.model));

    // 沙箱 id 必须每实例唯一：dispose() 会递归删除 workdir，
    // 共享 id 会让一个 runtime 删掉另一个正在使用的目录。
    const sandbox = await createSandbox('local', {
      id: `default-${randomUUID()}`,
      root: config.sandbox.root,
      timeoutMs: config.sandbox.timeoutMs,
      maxOutputBytes: config.sandbox.maxOutputBytes,
    });

    const skillRegistry = new SkillRegistry(await loadSkills(config.skillsDir));
    const mcpHub = await McpHub.fromConfig(config.mcpConfigPath, appLogger.child('mcp'));
    const a2aHub = await A2AClientHub.fromConfig(config.a2aPeersPath, appLogger.child('a2a'));

    const tools = mergeToolGroups(
      [
        {
          source: 'builtin',
          tools: [...createSandboxTools(sandbox), createLoadSkillTool(skillRegistry)],
        },
        { source: 'skill', tools: await skillRegistry.loadTools() },
        { source: 'mcp', tools: await mcpHub.tools() },
        { source: 'a2a', tools: createRemoteAgentTools(a2aHub) },
      ],
      appLogger.child('tools'),
    );

    await mkdir(dirname(config.checkpointDb), { recursive: true });
    const checkpointer = SqliteSaver.fromConnString(config.checkpointDb);

    const prompt = [
      '你是一个可扩展 Agent 运行时的执行体。',
      skillRegistry.promptSection(),
    ]
      .filter((section) => section.length > 0)
      .join('\n\n');

    const agent = createAgent({
      model,
      tools,
      systemPrompt: prompt,
      checkpointer,
    });

    return new AgentRuntime(
      agent,
      sandbox,
      skillRegistry,
      mcpHub,
      a2aHub,
      checkpointer,
      prompt,
    );
  }

  async run(input: string, options: { threadId: string }): Promise<RunResult> {
    const result = await this.agent.invoke(
      { messages: [{ role: 'human', content: input }] },
      { configurable: { thread_id: options.threadId } },
    );

    const messages: BaseMessage[] = result.messages;
    return { text: extractFinalText(messages), messages };
  }

  listSkills(): SkillManifest[] {
    return this.skillRegistry.list();
  }

  systemPrompt(): string {
    return this.prompt;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.mcpHub.close();
    } finally {
      try {
        await this.sandbox.dispose();
      } finally {
        this.checkpointer.db.close();
      }
    }
  }
}
