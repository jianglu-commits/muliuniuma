import { tool } from 'langchain';
import { z } from 'zod';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { Sandbox } from '../sandbox/index.js';

export function createSandboxTools(sandbox: Sandbox): StructuredToolInterface[] {
  const execTool = tool(
    async ({ command, timeoutMs }) => {
      const result = await sandbox.exec(command, timeoutMs ? { timeoutMs } : {});
      return JSON.stringify(result);
    },
    {
      name: 'sandbox_exec',
      description:
        '在隔离沙箱中执行一条 shell 命令，返回 { stdout, stderr, exitCode, timedOut }。',
      schema: z.object({
        command: z.string().min(1),
        timeoutMs: z.number().int().positive().optional(),
      }),
    },
  );

  const writeTool = tool(
    async ({ path, content }) => {
      await sandbox.writeFile(path, content);
      return `已写入 ${path}`;
    },
    {
      name: 'sandbox_write_file',
      description: '在沙箱工作目录内写入一个文本文件。',
      schema: z.object({
        path: z.string().min(1),
        content: z.string(),
      }),
    },
  );

  return [execTool, writeTool];
}
