import { createMiddleware, tool } from 'langchain';
import { Command, ReducedValue, StateSchema } from '@langchain/langgraph';
import { ToolMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { Logger } from '../shared/index.js';
import {
  ACTIVATE_TOOL_NAME,
  isNamedTool,
  renderCatalog,
} from './tool-catalog.js';
import type { ToolLoadingPolicy } from './tool-catalog.js';

export interface ToolLoadingOptions {
  tier: 'catalog';
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
      const accepted = names.filter((name) => known.has(name));
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

export function createToolLoadingMiddleware(
  options: ToolLoadingOptions,
): ReturnType<typeof createMiddleware> {
  const { deferrable, alwaysOn, policy, logger } = options;
  const deferrableNames = new Set(deferrable.map((t) => t.name));
  const maxActive = policy.maxActiveTools;

  const resident = new Set<string>(alwaysOn);
  const activate = createActivateTool(deferrableNames, resident, maxActive);
  const metaTools = [activate];
  // 常驻名单从实际注册的 meta 工具推导（Set 按引用被闭包捕获），与 tools 列表不会漂移。
  for (const meta of metaTools) resident.add(meta.name);

  logger.info(
    `工具加载档位 catalog：可延迟工具 ${deferrable.length} 个，激活上限 ${maxActive}`,
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
    tools: metaTools,
    wrapModelCall: (request, handler) => {
      const active = new Set(request.state.activatedTools);
      const tools = request.tools.filter(
        (item) => !isNamedTool(item) || resident.has(item.name) || active.has(item.name),
      );
      const listed = [...active];
      const sections = [
        renderCatalog(deferrable),
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
