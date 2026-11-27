import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createAgent } from 'langchain';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { START } from '@langchain/langgraph';
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
import { createLogger, renameTool } from '../shared/index.js';
import type { Logger } from '../shared/index.js';
import { mergeToolGroups } from './tools.js';
import {
  createSummaryMiddleware,
  extractSummaryText,
  planSummary,
} from './summary.js';
import type {
  SummaryMiddleware,
  SummaryOutcome,
  SummaryPolicy,
} from './summary.js';
import {
  ACTIVATE_TOOL_NAME,
  SEARCH_TOOL_NAME,
  estimateToolTokens,
  selectTier,
} from './tool-catalog.js';
import type { ToolLoadingPolicy } from './tool-catalog.js';
import { createToolLoadingMiddleware } from './tool-loading.js';
import { createToolClearingMiddleware } from './context-clearing.js';
import type { ToolClearingPolicy } from './context-clearing.js';

export interface AgentRuntimeDeps {
  model?: BaseChatModel;
  /** 摘要模型：默认与主模型同一个；测试可注入替身把摘要回合与主模型回合彻底分离。 */
  summaryModel?: BaseChatModel;
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

/**
 * ToolNode 按名字取首个匹配且静态工具排在中间件工具之前：与元工具同名的静态工具会顶掉
 * activate_tools/search_tools。改名须同时替换静态表与可延迟集，目录/检索/激活名单才一致。
 */
function reserveMetaToolNames(
  tools: StructuredToolInterface[],
  deferrable: StructuredToolInterface[],
  logger: Logger,
): { tools: StructuredToolInterface[]; deferrable: StructuredToolInterface[] } {
  const used = new Set(tools.map((t) => t.name));
  const renamed = new Map<StructuredToolInterface, StructuredToolInterface>();
  for (const item of deferrable) {
    if (item.name !== ACTIVATE_TOOL_NAME && item.name !== SEARCH_TOOL_NAME) continue;
    let suffix = 1;
    while (used.has(`${item.name}_${suffix}`)) suffix += 1;
    const name = `${item.name}_${suffix}`;
    used.add(name);
    logger.warn(`工具名与元工具冲突：工具 "${item.name}" 已重命名为 "${name}"`);
    renamed.set(item, renameTool(item, name));
  }
  if (renamed.size === 0) return { tools, deferrable };
  return {
    tools: tools.map((t) => renamed.get(t) ?? t),
    deferrable: deferrable.map((t) => renamed.get(t) ?? t),
  };
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
    private readonly summaryMiddleware: SummaryMiddleware | undefined,
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

      const builtinTools = [
        ...createSandboxTools(sandbox),
        createLoadSkillTool(skillRegistry),
      ];
      const toolGroups = [
        { source: 'builtin' as const, tools: builtinTools },
        { source: 'skill' as const, tools: await skillRegistry.loadTools() },
        { source: 'mcp' as const, tools: await mcpHub.tools() },
        { source: 'a2a' as const, tools: createRemoteAgentTools(a2aHub) },
      ];
      const tools = mergeToolGroups(toolGroups, appLogger.child('tools'));
      const alwaysOn = builtinTools.map((t) => t.name);
      const alwaysOnNames = new Set(alwaysOn);
      const deferrable = tools.filter((t) => !alwaysOnNames.has(t.name));

      await mkdir(dirname(config.checkpointDb), { recursive: true });
      checkpointer = SqliteSaver.fromConnString(config.checkpointDb);

      const prompt = [
        '你是一个可扩展 Agent 运行时的执行体。',
        skillRegistry.promptSection(),
      ]
        .filter((section) => section.length > 0)
        .join('\n\n');

      const agentLogger = appLogger.child('agent');
      const toolLoadingPolicy: ToolLoadingPolicy = { ...config.toolLoading };
      const deferrableTokens = deferrable.reduce(
        (sum, t) => sum + estimateToolTokens(t),
        0,
      );
      const tier = selectTier(deferrable.length, deferrableTokens, toolLoadingPolicy);
      const installLoading = toolLoadingPolicy.enabled && tier !== 'eager';
      // 仅在真要装中间件时让位元工具名：关闭/eager 档没有元工具，改名会破坏 SKILL.md 的调用名。
      const reserved = installLoading
        ? reserveMetaToolNames(tools, deferrable, agentLogger)
        : { tools, deferrable };
      const toolLoadingMiddleware = installLoading
        ? createToolLoadingMiddleware({
            tier,
            deferrable: reserved.deferrable,
            alwaysOn,
            policy: toolLoadingPolicy,
            logger: agentLogger,
          })
        : undefined;
      if (toolLoadingMiddleware === undefined) {
        // 关闭开关与真 eager 档都是全量绑定，但归因不同：文案不能把「已关闭」说成「档位 eager」。
        agentLogger.info(
          toolLoadingPolicy.enabled
            ? `工具加载档位 eager：可延迟工具 ${deferrable.length} 个 / ${deferrableTokens} token，全量绑定`
            : `工具加载已关闭：全量绑定（可延迟工具 ${deferrable.length} 个 / ${deferrableTokens} token）`,
        );
      }

      const toolClearingPolicy: ToolClearingPolicy = { ...config.toolClearing };
      const clearingMiddleware = toolClearingPolicy.enabled
        ? createToolClearingMiddleware(toolClearingPolicy, agentLogger)
        : undefined;

      const summaryPolicy: SummaryPolicy = {
        enabled: config.summary.enabled,
        triggerTokens: config.summary.triggerTokens,
        keepTokens: config.summary.keepTokens,
        trimTokens: config.summary.trimTokens,
      };
      // 摘要模型与主模型同一个；SDK 会忽略 runtime.context.model，只能在建中间件时定死。
      const summaryModel = deps.summaryModel ?? model;
      const summaryMiddleware = summaryPolicy.enabled
        ? createSummaryMiddleware(summaryModel, summaryPolicy, agentLogger)
        : undefined;

      const agent = createAgent({
        model,
        tools: reserved.tools,
        systemPrompt: prompt,
        checkpointer,
        // 顺序有意义：数组首个是最外层 wrapModelCall，清理必须在加载内层才能看到过滤后的绑定集。
        middleware: [
          ...(toolLoadingMiddleware ? [toolLoadingMiddleware] : []),
          ...(clearingMiddleware ? [clearingMiddleware] : []),
          ...(summaryMiddleware ? [summaryMiddleware.agentMiddleware] : []),
        ],
      });

      return new AgentRuntime(
        agent,
        sandbox,
        skillRegistry,
        mcpHub,
        a2aHub,
        checkpointer,
        prompt,
        agentLogger,
        summaryMiddleware,
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

  /**
   * 主动压缩当前会话的历史。
   *
   * 与自动路径共用同一个中间件实例与同一份保留预算，区别只是把触发条件换成强制触发。
   * 不要与 run() 并发作用于同一 thread：后写者可能覆盖前者。
   */
  async summarize(options: {
    threadId: string;
    signal?: AbortSignal;
    keepMessages?: number;
  }): Promise<SummaryOutcome> {
    const middleware = this.summaryMiddleware;
    if (middleware === undefined) {
      return { summarized: false, reason: 'disabled' };
    }

    const config = { configurable: { thread_id: options.threadId } };
    // getState 的声明返回类型是 never，必须显式标注变量类型才能取出 values。
    const snapshot: { values: { messages?: BaseMessage[] } } =
      await this.agent.getState(config);
    const messages = snapshot.values.messages ?? [];
    if (messages.length === 0) {
      return { summarized: false, reason: 'empty' };
    }

    const update = await planSummary(middleware, messages, {
      keepMessages: options.keepMessages,
      signal: options.signal,
      threadId: options.threadId,
    });
    if (update === undefined) {
      return { summarized: false, reason: 'not-needed' };
    }

    const summary = extractSummaryText(update);
    if (summary === undefined) {
      // 摘要失败时 SDK 会把错误文本当成摘要写进历史，这里不写回，历史保持原样。
      return { summarized: false, reason: 'failed' };
    }

    // asNode 必须显式给 START：省略时 langgraph 只能按 checkpoint 的版本记录去猜节点，
    // 猜不中就直接抛 Ambiguous update。
    await this.agent.updateState(config, { messages: update }, START);

    return {
      summarized: true,
      reason: 'ok',
      beforeMessages: messages.length,
      afterMessages: update.length - 1,
      preservedMessages: update.length - 2,
      summary,
    };
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
