import { readFile } from 'node:fs/promises';
import { ConfigError } from '../shared/index.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 只有「文件不存在」（ENOENT）会被静默忽略；文件存在但读不了（权限不足、
 * 路径是目录等）会继续抛出，避免把「配置读不到」误报成「配置缺失」。
 */
export async function loadMcpServers(file: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`MCP 配置文件 JSON 解析失败: ${file}`, { cause: error });
  }

  if (!isPlainObject(parsed)) {
    throw new ConfigError(`MCP 配置文件顶层必须是对象: ${file}`);
  }

  const servers = parsed.servers;
  if (servers === undefined) {
    return {};
  }
  if (!isPlainObject(servers)) {
    throw new ConfigError(`MCP 配置文件的 servers 必须是对象: ${file}`);
  }

  for (const [name, connection] of Object.entries(servers)) {
    if (!isPlainObject(connection)) {
      throw new ConfigError(`MCP 配置文件中 server "${name}" 的值必须是对象: ${file}`);
    }
  }

  return servers;
}
