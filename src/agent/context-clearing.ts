import { ClearToolUsesEdit, createMiddleware } from 'langchain';
import type { ContextEdit } from 'langchain';
import type { BaseMessage } from '@langchain/core/messages';
import type { Logger } from '../shared/index.js';
import { countMessageTokens } from './summary.js';
import { estimateToolTokens, isNamedTool } from './tool-catalog.js';

export interface ToolClearingPolicy {
  enabled: boolean;
  triggerTokens: number;
  keepMessages: number;
}

export const CLEARED_PLACEHOLDER = '[已清理的工具输出]';

/**
 * 复用 SDK 的 ClearToolUsesEdit 算法，但自建外壳：
 * SDK 的 contextEditingMiddleware 既不给 tokenCounter 注入口，也直接原地改
 * request.messages —— 而那个数组与 state.messages 同引用，会写脏 checkpoint。
 */
export function createToolClearingMiddleware(
  policy: ToolClearingPolicy,
  logger: Logger,
): ReturnType<typeof createMiddleware> {
  // 经 ContextEdit 接口省略 model：它只服务 fraction 口径（本策略不用），且 request.model 的类型对不上 BaseLanguageModel。
  const edit: ContextEdit = new ClearToolUsesEdit({
    trigger: { tokens: policy.triggerTokens },
    keep: { messages: policy.keepMessages },
    placeholder: CLEARED_PLACEHOLDER,
  });

  return createMiddleware({
    name: 'ToolOutputClearing',
    wrapModelCall: async (request, handler) => {
      if (request.messages.length === 0) return handler(request);

      const messages = [...request.messages];
      const schemaTokens = request.tools.reduce(
        (sum, item) => (isNamedTool(item) ? sum + estimateToolTokens(item) : sum),
        0,
      );
      const before = countMessageTokens(messages) + schemaTokens;

      await edit.apply({
        messages,
        countTokens: async (msgs: BaseMessage[]) => countMessageTokens(msgs) + schemaTokens,
      });

      const after = countMessageTokens(messages) + schemaTokens;
      if (after < before) {
        logger.info(`已清理旧工具输出：视图 token ${before} → ${after}（checkpoint 原文未改）`);
      }
      return handler({ ...request, messages });
    },
  });
}
