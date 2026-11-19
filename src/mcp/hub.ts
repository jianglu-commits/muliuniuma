import { MCPAdapter } from '@langchain/mcp-adapters';
import type { MCPAdapterConfig } from '@langchain/mcp-adapters';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import { ConfigError, createLogger } from '../shared/index.js';
import type { Logger } from '../shared/index.js';
import { loadMcpServers } from './config.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class McpHub {
  private closed = false;

  private constructor(
    private readonly file: string,
    private readonly adapter: MCPAdapter | null,
    private readonly logger: Logger,
  ) {}

  static async fromConfig(
    file: string,
    logger: Logger = createLogger('info', 'mcp'),
  ): Promise<McpHub> {
    const servers = await loadMcpServers(file);

    if (Object.keys(servers).length === 0) {
      return new McpHub(file, null, logger);
    }

    let adapter: MCPAdapter;
    try {
      // 连接字段的权威校验在 MCPAdapter 构造器（即时 zod parse），此处只做结构校验。
      adapter = new MCPAdapter({
        servers: servers as MCPAdapterConfig['servers'],
        prefixToolNameWithServerName: true,
        onConnectionError: ({ serverName, error }) => {
          logger.warn(`MCP server "${serverName}" 连接失败，已跳过`, error);
        },
      });
    } catch (error) {
      throw new ConfigError(`MCP 配置文件校验失败: ${file} → ${errorMessage(error)}`, {
        cause: error,
      });
    }

    return new McpHub(file, adapter, logger);
  }

  async tools(): Promise<DynamicStructuredTool[]> {
    if (this.closed) {
      throw new Error('McpHub 已关闭，不能再调用 tools()');
    }
    if (!this.adapter) return [];
    try {
      return await this.adapter.listTools();
    } catch (error) {
      throw new ConfigError(`MCP 工具加载失败: ${this.file} → ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.adapter?.close();
  }
}
