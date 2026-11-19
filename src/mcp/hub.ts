import { MCPAdapter } from '@langchain/mcp-adapters';
import type { MCPAdapterConfig } from '@langchain/mcp-adapters';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import { ConfigError, createLogger } from '../shared/index.js';
import type { Logger } from '../shared/index.js';
import { loadMcpServers } from './config.js';

/** McpHub 依赖的最小适配器面：只有工具发现与关闭两个能力，SDK 适配器天然满足。 */
export interface McpAdapterLike {
  listTools(): Promise<DynamicStructuredTool[]>;
  close(): Promise<void>;
}

function hasMessage(value: unknown): value is { message: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'message' in value &&
    typeof value.message === 'string'
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (hasMessage(error)) return error.message;
  return String(error);
}

/** zod v4 的 ZodError 满足 name === 'ZodError'（已在 zod@4.6.7 实测）。 */
function isZodError(error: unknown): boolean {
  return error instanceof Error && error.name === 'ZodError';
}

export class McpHub {
  private closed = false;
  private closing: Promise<void> | undefined;

  protected constructor(
    private readonly file: string,
    private readonly adapter: McpAdapterLike | null,
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

    let adapter: McpAdapterLike;
    try {
      // 连接字段的权威校验在 MCPAdapter 构造器（即时 zod parse），此处只做结构校验。
      adapter = this.createAdapter({
        servers: servers as MCPAdapterConfig['servers'],
        prefixToolNameWithServerName: true,
        onConnectionError: ({ serverName, error }) => {
          logger.warn(`MCP server "${serverName}" 连接失败，已跳过`, error);
        },
      });
    } catch (error) {
      const kind = isZodError(error)
        ? 'MCP 配置文件校验失败'
        : '初始化 MCP 客户端失败';
      throw new ConfigError(`${kind}: ${file} → ${errorMessage(error)}`, {
        cause: error,
      });
    }

    return new McpHub(file, adapter, logger);
  }

  /** 构造适配器的唯一可替换点：生产走 SDK 适配器，测试可注入替身覆盖失败路径。 */
  protected static createAdapter(config: MCPAdapterConfig): McpAdapterLike {
    return new MCPAdapter(config);
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
    this.closed = true;
    const pending = this.closing;
    if (pending) return pending;
    const attempt = (async () => {
      await this.adapter?.close();
    })();
    this.closing = attempt;
    try {
      await attempt;
    } catch (error) {
      // 关闭失败必须清掉缓存，否则后续 close() 永远拿不到重试机会。
      if (this.closing === attempt) this.closing = undefined;
      throw error;
    }
  }
}
