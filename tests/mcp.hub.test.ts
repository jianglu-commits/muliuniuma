import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpHub } from '../src/mcp/index.js';
import { ConfigError } from '../src/shared/index.js';
import type { Logger } from '../src/shared/index.js';

const fixture = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url));

interface LogCall {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  rest: unknown[];
}

function createRecordingLogger(): { logger: Logger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const record =
    (level: LogCall['level']) =>
    (message: string, ...rest: unknown[]): void => {
      calls.push({ level, message, rest });
    };
  const logger: Logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
  };
  return { logger, calls };
}

function goodServer(extraArgs: string[] = []): Record<string, unknown> {
  return {
    transport: 'stdio',
    command: process.execPath,
    args: [fixture, ...extraArgs],
    stderr: 'ignore',
  };
}

function brokenServer(): Record<string, unknown> {
  return {
    transport: 'stdio',
    command: 'definitely-not-a-real-binary',
    args: [],
    stderr: 'ignore',
  };
}

let dir = '';
let hub: McpHub | undefined;

async function writeConfig(content: unknown): Promise<string> {
  const file = join(dir, 'mcp.json');
  await writeFile(file, JSON.stringify(content));
  return file;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcp-hub-'));
});

afterEach(async () => {
  await hub?.close();
  hub = undefined;
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = '';
  }
});

describe('McpHub', () => {
  it('配置文件不存在时返回空工具集', async () => {
    hub = await McpHub.fromConfig(join(dir, 'missing.json'));
    expect(await hub.tools()).toEqual([]);
    await hub.close();
  });

  it('servers 为空时返回空工具集', async () => {
    const file = await writeConfig({ servers: {} });
    hub = await McpHub.fromConfig(file);
    expect(await hub.tools()).toEqual([]);
    await hub.close();
  });

  it('顶层为空对象（无 servers 键）时返回空工具集', async () => {
    const file = await writeConfig({});
    hub = await McpHub.fromConfig(file);
    expect(await hub.tools()).toEqual([]);
    await hub.close();
  });

  it('单个 server 连接失败不影响整体', async () => {
    const file = await writeConfig({ servers: { broken: brokenServer() } });
    const { logger, calls } = createRecordingLogger();

    hub = await McpHub.fromConfig(file, logger);
    expect(await hub.tools()).toEqual([]);
    await hub.close();

    const warns = calls.filter((call) => call.level === 'warn');
    expect(warns.length).toBeGreaterThan(0);
    expect(warns.some((call) => call.message.includes('broken'))).toBe(true);
    expect(warns.every((call) => call.rest.length > 0)).toBe(true);
  });

  it('坏 server 与好 server 共存时好 server 的工具仍在', async () => {
    const file = await writeConfig({
      servers: { broken: brokenServer(), good: goodServer() },
    });
    const { logger, calls } = createRecordingLogger();

    hub = await McpHub.fromConfig(file, logger);
    const tools = await hub.tools();
    expect(tools.map((tool) => tool.name)).toEqual(['good_ping']);

    const warns = calls.filter((call) => call.level === 'warn');
    expect(warns.length).toBeGreaterThan(0);
    expect(warns.every((call) => call.message.includes('broken'))).toBe(true);
    expect(warns.some((call) => call.message.includes('good'))).toBe(false);
  });

  it('工具名带 server 名前缀', async () => {
    const file = await writeConfig({ servers: { good: goodServer() } });
    hub = await McpHub.fromConfig(file);
    const tools = await hub.tools();
    expect(tools.map((tool) => tool.name)).toEqual(['good_ping']);
  });

  it('工具可以真实 invoke 往返', async () => {
    const file = await writeConfig({ servers: { good: goodServer() } });
    hub = await McpHub.fromConfig(file);
    const tools = await hub.tools();
    expect(tools).toHaveLength(1);
    const result = await tools[0]!.invoke({});
    expect(JSON.stringify(result)).toContain('pong');
  });

  it('JSON 畸形时抛含文件路径的 ConfigError', async () => {
    const file = join(dir, 'mcp.json');
    await writeFile(file, '{ 这不是合法 JSON');
    await expect(McpHub.fromConfig(file)).rejects.toThrow(ConfigError);
    await expect(McpHub.fromConfig(file)).rejects.toThrow(file);
    await expect(McpHub.fromConfig(file)).rejects.toThrow('JSON 解析失败');
    await expect(McpHub.fromConfig(file)).rejects.toMatchObject({
      cause: expect.any(Error),
    });
  });

  it('连接配置畸形时抛含文件路径的 ConfigError', async () => {
    const file = await writeConfig({ servers: { bad: { transport: 'stdio' } } });
    await expect(McpHub.fromConfig(file)).rejects.toThrow(ConfigError);
    await expect(McpHub.fromConfig(file)).rejects.toThrow(file);
    await expect(McpHub.fromConfig(file)).rejects.toMatchObject({
      cause: expect.any(Error),
    });
  });

  it('servers 是数组时抛含文件路径的 ConfigError', async () => {
    const file = await writeConfig({ servers: [] });
    await expect(McpHub.fromConfig(file)).rejects.toThrow(ConfigError);
    await expect(McpHub.fromConfig(file)).rejects.toThrow(file);
  });

  it('顶层是数组时抛含文件路径的 ConfigError', async () => {
    const file = await writeConfig([]);
    await expect(McpHub.fromConfig(file)).rejects.toThrow(ConfigError);
    await expect(McpHub.fromConfig(file)).rejects.toThrow(file);
  });

  it('server 的值不是对象时抛含路径与 server 名的 ConfigError', async () => {
    const file = await writeConfig({ servers: { bad: 'oops' } });
    await expect(McpHub.fromConfig(file)).rejects.toThrow(ConfigError);
    await expect(McpHub.fromConfig(file)).rejects.toThrow(file);
    await expect(McpHub.fromConfig(file)).rejects.toThrow('bad');
  });

  it('配置路径是目录时如实抛出读取错误而不是静默返回空', async () => {
    await expect(McpHub.fromConfig(dir)).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('close 幂等：连调两次不抛', async () => {
    const file = await writeConfig({ servers: { good: goodServer() } });
    hub = await McpHub.fromConfig(file);
    await hub.tools();
    await hub.close();
    await hub.close();

    const emptyFile = await writeConfig({ servers: {} });
    hub = await McpHub.fromConfig(emptyFile);
    await hub.close();
    await hub.close();
  });

  it('close 之后 tools 抛明确错误且不复活子进程', async () => {
    const file = await writeConfig({ servers: { good: goodServer() } });
    hub = await McpHub.fromConfig(file);
    await hub.tools();
    await hub.close();
    await expect(hub.tools()).rejects.toThrow('已关闭');
    await expect(hub.tools()).rejects.not.toBeInstanceOf(ConfigError);
  });

  it('同一 server 工具名碰撞时抛含路径与 SDK 指引的 ConfigError', async () => {
    const file = await writeConfig({
      servers: { dup: goodServer(['--duplicate-tools']) },
    });
    hub = await McpHub.fromConfig(file);
    await expect(hub.tools()).rejects.toThrow(ConfigError);
    await expect(hub.tools()).rejects.toThrow(file);
    await expect(hub.tools()).rejects.toThrow('more than once');
    await expect(hub.tools()).rejects.toThrow('Remove the duplicate on the server');
  });
});
