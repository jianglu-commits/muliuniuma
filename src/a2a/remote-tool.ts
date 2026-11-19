import { tool } from 'langchain';
import { z } from 'zod';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { ConfigError } from '../shared/index.js';
import type { A2AClientHub } from './client.js';

function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function createRemoteAgentTools(hub: A2AClientHub): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = [];
  const owners = new Map<string, string>();

  for (const peer of hub.list()) {
    const sanitized = sanitizeToolName(peer.spec.name);
    if (sanitized.length === 0) {
      throw new ConfigError(
        `A2A peer "${peer.spec.name}" 的名称无法转换为合法工具名，已拒绝生成工具`,
      );
    }

    const toolName = `ask_${sanitized}`;
    const owner = owners.get(toolName);
    if (owner !== undefined) {
      // 重名工具会被模型当成同一个，后一个 peer 会被静默吞掉，必须当成配置错误暴露。
      throw new ConfigError(
        `A2A peer "${owner}" 与 "${peer.spec.name}" 映射到同一个工具名 "${toolName}"`,
      );
    }
    owners.set(toolName, peer.spec.name);

    tools.push(
      tool(async ({ message }) => await hub.ask(peer.spec.name, message), {
        name: toolName,
        description: peer.description,
        schema: z.object({ message: z.string().min(1) }),
      }),
    );
  }

  return tools;
}
