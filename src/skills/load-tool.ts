import { tool } from 'langchain';
import { z } from 'zod';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { SkillRegistry } from './registry.js';

export function createLoadSkillTool(registry: SkillRegistry): StructuredToolInterface {
  return tool(async ({ name }) => registry.get(name).body, {
    name: 'load_skill',
    description: '按名称读取某个 skill 的完整说明正文。仅在需要该 skill 的具体用法时调用。',
    schema: z.object({ name: z.string().min(1) }),
  });
}
