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
import type { Logger } from '../shared/index.js';
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
 * 用 instanceof AIMessage 只是为了识别 AI 消息：AIMessage.isInstance 校验
 * type === 'ai'，反序列化后的消息依然成立；text 定义在 BaseMessage 上，
 * 任何消息类型都能直接读。
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

/** 清理失败不能顶替掉调用方真正关心的原始异常，但必须留下可观测痕迹。 */
async function ignoreFailure(
  close: () => Promise<void> | void,
  logger: Logger,
  label: string,
): Promise<void> {
  try {
    await close();
  } catch (error) {
    logger.warn(`${label}清理失败，已忽略`, error);
  }
}

export class AgentRuntime {
  private disposing: Promise<void> | undefined;

  private constructor(
    private readonly agent: ReturnType<typeof createAgent>,
    private readonly sandbox: Sandbox,
    private readonly skillRegistry: SkillRegistry,
    private readonly mcpHub: McpHub,
    private readonly a2aHub: A2AClientHub,
    private readonly checkpointer: SqliteSaver,
    private readonly prompt: string,
    private readonly logger: Logger,
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

    let checkpointer: SqliteSaver | undefined;
    let mcpHub: McpHub | undefined;
    try {
      const skillRegistry = new SkillRegistry(await loadSkills(config.skillsDir));
      mcpHub = await McpHub.fromConfig(config.mcpConfigPath, appLogger.child('mcp'));
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
      checkpointer = SqliteSaver.fromConnString(config.checkpointDb);

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
        appLogger.child('agent'),
      );
    } catch (error) {
      // 启动失败也要回收已建资源，否则每次失败都在 sandbox 根目录下留一个孤儿目录，
      // MCP 建连拉起的 stdio 子进程也会变成孤儿进程。
      const cleanupLogger = appLogger.child('agent');
      await ignoreFailure(() => mcpHub?.close(), cleanupLogger, 'MCP 连接');
      await ignoreFailure(() => sandbox.dispose(), cleanupLogger, '沙箱');
      const created = checkpointer;
      if (created !== undefined) {
        await ignoreFailure(() => created.db.close(), cleanupLogger, '检查点数据库');
      }
      throw error;
    }
  }

  async run(
    input: string,
    options: { threadId: string; signal?: AbortSignal },
  ): Promise<RunResult> {
    const result = await this.agent.invoke(
      { messages: [{ role: 'human', content: input }] },
      { configurable: { thread_id: options.threadId }, signal: options.signal },
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
    const pending = this.disposing;
    if (pending !== undefined) {
      await pending;
      return;
    }
    const attempt = this.closeResources();
    this.disposing = attempt;
    try {
      await attempt;
    } catch (error) {
      // 关闭失败必须清掉缓存，否则后续 dispose() 永远拿不到重试机会。
      if (this.disposing === attempt) this.disposing = undefined;
      throw error;
    }
  }

  /**
   * 三个资源都要关闭：其中一个失败不能跳过其余的；
   * 抛出的是第一个失败而不是最后一个，否则原始故障原因会被后续异常顶替。
   * 第一个失败之外的失败只记 warn，否则会被静默吞掉。
   */
  private async closeResources(): Promise<void> {
    let failed = false;
    let firstError: unknown;
    const closeOne = async (
      label: string,
      close: () => Promise<void> | void,
    ): Promise<void> => {
      try {
        await close();
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        } else {
          this.logger.warn(`${label}清理失败，已忽略`, error);
        }
      }
    };

    await closeOne('MCP 连接', () => this.mcpHub.close());
    await closeOne('沙箱', () => this.sandbox.dispose());
    await closeOne('检查点数据库', () => {
      this.checkpointer.db.close();
    });

    if (failed) throw firstError;
  }
}
