import { createMiddleware, tool } from 'langchain';
import { Command, ReducedValue, StateSchema } from '@langchain/langgraph';
import { ToolMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { Logger } from '../shared/index.js';
import {
  ACTIVATE_TOOL_NAME,
  SEARCH_TOOL_NAME,
  briefDescription,
  isNamedTool,
  renderCatalog,
  searchCatalog,
} from './tool-catalog.js';
import type { ToolLoadingPolicy } from './tool-catalog.js';

export interface ToolLoadingOptions {
  tier: 'catalog' | 'search';
  deferrable: StructuredToolInterface[];
  alwaysOn: string[];
  policy: ToolLoadingPolicy;
  logger: Logger;
}

function createActivateTool(
  known: Set<string>,
  resident: Set<string>,
  maxActive: number,
): StructuredToolInterface {
  return tool(
    ({ names }, config) => {
      // 同一请求内重复名字去重后再追加，否则会烧掉多个 FIFO 名额并渲染成「t1、t1」。
      const accepted = [...new Set(names.filter((name) => known.has(name)))];
      const alreadyOn = names.filter((name) => resident.has(name));
      const unknown = names.filter((name) => !known.has(name) && !resident.has(name));
      const lines: string[] = [];
      if (accepted.length > 0) lines.push(`已激活：${accepted.join('、')}`);
      if (alreadyOn.length > 0) lines.push(`已常驻，无需激活：${alreadyOn.join('、')}`);
      if (unknown.length > 0) lines.push(`未知工具名：${unknown.join('、')}`);
      lines.push(`同时激活上限 ${maxActive}，超出时最早激活的会被移出；当前生效清单见系统提示。`);
      return new Command({
        update: {
          activatedTools: accepted,
          messages: [
            new ToolMessage({
              content: lines.join('\n'),
              tool_call_id: config.toolCall?.id ?? '',
              name: ACTIVATE_TOOL_NAME,
            }),
          ],
        },
      });
    },
    {
      name: ACTIVATE_TOOL_NAME,
      description: '按名字激活工具。只有激活过的工具才能调用，可一次传多个名字。',
      schema: z.object({ names: z.array(z.string().min(1)).min(1) }),
    },
  );
}

function createSearchTool(
  deferrable: StructuredToolInterface[],
  topK: number,
): StructuredToolInterface {
  return tool(
    ({ query }) => {
      const matches = searchCatalog(deferrable, query, topK);
      if (matches.length === 0) {
        return `无匹配，请换个说法或用 ${ACTIVATE_TOOL_NAME} 直接指定名字。`;
      }
      return [
        `候选工具（尚未激活，需要用 ${ACTIVATE_TOOL_NAME} 激活后才能调用）:`,
        ...matches.map((m) => `- ${m.name}: ${briefDescription(m.description)}`),
      ].join('\n');
    },
    {
      name: SEARCH_TOOL_NAME,
      description: '按关键词检索可用工具，返回候选名字与简介。检索本身不会激活工具。',
      schema: z.object({ query: z.string().min(1) }),
    },
  );
}

export function createToolLoadingMiddleware(
  options: ToolLoadingOptions,
): ReturnType<typeof createMiddleware> {
  const { tier, deferrable, alwaysOn, policy, logger } = options;
  const deferrableNames = new Set(deferrable.map((t) => t.name));
  const maxActive = policy.maxActiveTools;

  const resident = new Set<string>(alwaysOn);
  const activate = createActivateTool(deferrableNames, resident, maxActive);
  const middlewareTools =
    tier === 'search'
      ? [createSearchTool(deferrable, policy.searchTopK), activate]
      : [activate];
  // 常驻名单从实际注册的 meta 工具推导（Set 按引用被闭包捕获），与 tools 列表不会漂移。
  for (const meta of middlewareTools) resident.add(meta.name);

  logger.info(
    `工具加载档位 ${tier}：可延迟工具 ${deferrable.length} 个，激活上限 ${maxActive}`,
  );

  return createMiddleware({
    name: 'ToolLoading',
    stateSchema: new StateSchema({
      activatedTools: new ReducedValue(z.array(z.string()).default(() => []), {
        // default 必须落在 inputSchema 上：SDK 的必填检查取 inputSchema || valueSchema。
        inputSchema: z.array(z.string()).default(() => []),
        reducer: (current: string[], next: string[]) => {
          const merged = current.filter((name) => !next.includes(name)).concat(next);
          return merged.length > maxActive ? merged.slice(merged.length - maxActive) : merged;
        },
      }),
    }),
    tools: middlewareTools,
    wrapModelCall: (request, handler) => {
      const active = new Set(request.state.activatedTools);
      const tools = request.tools.filter(
        (item) => !isNamedTool(item) || resident.has(item.name) || active.has(item.name),
      );
      const listed = [...active];
      const guide =
        tier === 'search'
          ? `共有 ${deferrable.length} 个工具可用，目录未列出。用 ${SEARCH_TOOL_NAME} 按关键词检索候选，再用 ${ACTIVATE_TOOL_NAME} 激活。`
          : renderCatalog(deferrable);
      const sections = [
        guide,
        listed.length > 0
          ? `当前已激活工具：${listed.join('、')}`
          : '当前尚未激活任何工具。',
      ].filter((section) => section.length > 0);
      return handler({
        ...request,
        tools,
        systemMessage: request.systemMessage.concat(`\n\n${sections.join('\n\n')}`),
      });
    },
  });
}
