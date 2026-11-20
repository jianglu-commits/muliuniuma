import { summarizationMiddleware } from 'langchain';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { Logger } from '../shared/index.js';
import {
  SUMMARY_PREFIX,
  SUMMARY_PROMPT,
  SUMMARY_PROMPT_MARKER,
} from './summary-prompt.js';

/** 与 AppConfig.summary 同形。 */
export interface SummaryPolicy {
  enabled: boolean;
  triggerTokens: number;
  keepTokens: number;
  trimTokens: number;
}

export type SummaryReason = 'ok' | 'empty' | 'not-needed' | 'disabled' | 'failed';

export interface SummaryOutcome {
  summarized: boolean;
  reason: SummaryReason;
  beforeMessages?: number;
  afterMessages?: number;
  preservedMessages?: number;
  summary?: string;
}

export interface PlanSummaryOptions {
  /** 按条数覆盖保留预算（SDK 的 runtime.context.keep）。 */
  keepMessages?: number;
  signal?: AbortSignal;
  threadId?: string;
}

/** SDK 内置中间件的类型：包装它时必须保持同一个类型，否则 createAgent 的入参类型对不上。 */
type SummarizationMiddleware = ReturnType<typeof summarizationMiddleware>;
type SdkBeforeModelHook = NonNullable<SummarizationMiddleware['beforeModel']>;
type SdkBeforeModelHandler = Extract<
  SdkBeforeModelHook,
  (...args: never[]) => unknown
>;
type SdkState = Parameters<SdkBeforeModelHandler>[0];
type SdkRuntime = Parameters<SdkBeforeModelHandler>[1];

export interface SummaryMiddleware {
  /** 交给 createAgent 的中间件本体。 */
  readonly agentMiddleware: SummarizationMiddleware;
  /** 手动触发：跑一次 beforeModel，返回写回数组；无可摘要内容时返回 undefined。 */
  plan(
    messages: BaseMessage[],
    options?: PlanSummaryOptions,
  ): Promise<BaseMessage[] | undefined>;
}

/** SDK 在摘要失败时写进摘要正文的标记；命中即视为摘要失败。与 SDK 版本文案耦合，升级需复核。 */
const SUMMARY_FAILURE_MARKERS = [
  'Error generating summary:',
  'Previous conversation was too long to summarize.',
];

/** CJK 感知：CJK 字符一字一 token，其余四字符一 token。 */
function isCjk(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x20000 && code <= 0x3ffff)
  );
}

function countTextTokens(text: string): number {
  let cjk = 0;
  let rest = 0;
  for (const char of text) {
    if (isCjk(char.codePointAt(0) ?? 0)) cjk += 1;
    else rest += 1;
  }
  return cjk + Math.ceil(rest / 4);
}

function messageText(message: BaseMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  return JSON.stringify(content) ?? '';
}

/**
 * CJK 感知的近似 token 计数。
 *
 * SDK 默认的 countTokensApproximately 是 chars/4，对中文会低估 3–4 倍；
 * 工具 schema 不计入，这里补上 tool_calls 与 tool_call_id——它们同样占模型的输入窗口。
 */
export function countMessageTokens(messages: BaseMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += countTextTokens(messageText(message));
    if (message instanceof AIMessage && message.tool_calls?.length) {
      total += countTextTokens(JSON.stringify(message.tool_calls));
    }
    if (message instanceof ToolMessage) {
      total += countTextTokens(message.tool_call_id);
    }
  }
  return total;
}

/**
 * 判定「这是一次摘要调用」：仅 1 条 human 消息且内容含识别标记。
 *
 * 生产与测试共用同一份判定，避免测试里出现第二套判定逻辑而与真实调用脱节。
 */
export function looksLikeSummaryCall(messages: BaseMessage[]): boolean {
  if (messages.length !== 1) return false;
  const message = messages[0];
  if (message === undefined || message.getType() !== 'human') return false;
  return messageText(message).includes(SUMMARY_PROMPT_MARKER);
}

function hasMessages(value: object): value is { messages?: BaseMessage[] } {
  return 'messages' in value;
}

/** 从写回数组里取出摘要正文；命中 SDK 的失败标记时返回 undefined。 */
export function extractSummaryText(update: BaseMessage[]): string | undefined {
  for (const message of update) {
    if (message.additional_kwargs['lc_source'] !== 'summarization') continue;
    const text = messageText(message);
    for (const marker of SUMMARY_FAILURE_MARKERS) {
      if (text.includes(marker)) return undefined;
    }
    const prefix = `${SUMMARY_PREFIX}\n\n`;
    return text.startsWith(prefix) ? text.slice(prefix.length) : text;
  }
  return undefined;
}

/**
 * 包装 SDK 内置 summarizationMiddleware：机制全复用，只把摘要 prompt 换成中文、
 * token 计数换成 CJK 感知口径，并包一层 beforeModel 以记录压缩前后的条数。
 */
export function createSummaryMiddleware(
  model: BaseChatModel,
  policy: SummaryPolicy,
  logger: Logger,
): SummaryMiddleware {
  const sdk = summarizationMiddleware({
    model,
    // 不用 fraction：网关没有 model profile，SDK 会直接抛错。
    trigger: { tokens: policy.triggerTokens },
    // 用 token 预算而非条数：一条工具输出就可能 256 KB，条数 keep 挡不住该压缩的场景。
    keep: { tokens: policy.keepTokens },
    tokenCounter: countMessageTokens,
    summaryPrompt: SUMMARY_PROMPT,
    summaryPrefix: SUMMARY_PREFIX,
    trimTokensToSummarize: policy.trimTokens,
  });

  const contextSchema = sdk.contextSchema;
  if (contextSchema === undefined) {
    throw new Error('摘要中间件缺少 context schema');
  }

  const invoke = async (
    state: SdkState,
    runtime: SdkRuntime,
  ): Promise<BaseMessage[] | undefined> => {
    const hook = sdk.beforeModel;
    if (hook === undefined) return undefined;
    // beforeModel 既是函数也可能是 {hook} 形态，两种都要认。
    const handler = typeof hook === 'function' ? hook : hook.hook;
    const result = await handler(state, runtime);
    if (typeof result !== 'object' || result === null) return undefined;
    if (!hasMessages(result)) return undefined;
    return result.messages;
  };

  const agentMiddleware: SummarizationMiddleware = {
    ...sdk,
    beforeModel: async (state, runtime) => {
      const before = state.messages.length;
      const update = await invoke(state, runtime);
      if (update === undefined) return undefined;
      // SDK 会把摘要模型的异常当成摘要正文返回；放行就会用 REMOVE_ALL 把整段历史
      // 替换成错误文本。这里放弃本轮压缩：历史原样、模型照常调用，不丢数据。
      if (extractSummaryText(update) === undefined) {
        logger.warn('摘要生成失败，已放弃自动压缩，历史保持原样');
        return undefined;
      }
      logger.info(
        `已压缩上下文：${before} 条历史 → ${update.length - 1} 条（1 条摘要 + ${update.length - 2} 条保留）`,
      );
      return { messages: update };
    },
  };

  const plan = async (
    messages: BaseMessage[],
    options: PlanSummaryOptions = {},
  ): Promise<BaseMessage[] | undefined> => {
    // contextSchema.parse 会给 summaryPrompt 套上 SDK 的英文默认值，从而命中 SDK 的
    // 「context 里是默认值就改用 userOptions」特判，我们的中文 prompt 因此生效。
    // 这里只放 trigger 与可选 keep：keep 在 schema 里无默认值，不会覆盖我们配置的 token 预算。
    const context = contextSchema.parse({
      trigger: { messages: 1 },
      ...(options.keepMessages === undefined
        ? {}
        : { keep: { messages: options.keepMessages } }),
    });
    const runtime = {
      context,
      store: undefined,
      configurable:
        options.threadId === undefined
          ? undefined
          : { thread_id: options.threadId },
      writer: () => undefined,
      interrupt: () => {
        throw new Error('摘要路径不支持中断');
      },
      signal: options.signal,
    };
    return invoke({ messages }, runtime);
  };

  return { agentMiddleware, plan };
}

/**
 * 主动触发的核心：直接调中间件的 beforeModel 钩子并用 runtime.context 强制触发，
 * 返回写回数组；无可摘要内容时返回 undefined。
 */
export async function planSummary(
  middleware: SummaryMiddleware,
  messages: BaseMessage[],
  options: PlanSummaryOptions = {},
): Promise<BaseMessage[] | undefined> {
  return middleware.plan(messages, options);
}
