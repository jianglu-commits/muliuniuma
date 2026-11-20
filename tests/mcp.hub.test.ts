import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MCPAdapter } from '@langchain/mcp-adapters';
import { MCPClientError } from '@langchain/mcp-adapters';
import { McpHub } from '../src/mcp/index.js';
import type { McpAdapterLike } from '../src/mcp/index.js';
import { AppError, ConfigError, McpToolLoadError } from '../src/shared/index.js';
import type { Logger } from '../src/shared/index.js';

const fixture = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url));

// 编译期断言：SDK 适配器必须仍可赋给最小适配器面。
const _mcpAdapterSatisfiesLike: MCPAdapter extends McpAdapterLike ? true : false = true;

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
let stubAdapter: McpAdapterLike | undefined;

/** 注入替身适配器的 hub：只替换构造适配器这一步，其余行为与生产路径一致。 */
class StubHub extends McpHub {
  protected static override createAdapter(): McpAdapterLike {
    if (!stubAdapter) throw new Error('测试未注入替身适配器');
    return stubAdapter;
  }
}

/** 构造期直接抛出非 zod 错误的 hub，用来区分「配置校验失败」与「初始化失败」。 */
class ThrowingHub extends McpHub {
  protected static override createAdapter(): McpAdapterLike {
    throw new TypeError('SDK 内部失败，与用户配置无关');
  }
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function causeOf(value: unknown): unknown {
  return value instanceof Error ? value.cause : undefined;
}

function nameOf(value: unknown): string {
  return value instanceof Error ? value.name : '';
}

function codeOf(value: unknown): string | undefined {
  return value instanceof AppError ? value.code : undefined;
}

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
  stubAdapter = undefined;
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

  it('同一 server 工具名碰撞时抛含路径与 SDK 指引的 McpToolLoadError', async () => {
    const file = await writeConfig({
      servers: { dup: goodServer(['--duplicate-tools']) },
    });
    hub = await McpHub.fromConfig(file);
    const error = await hub.tools().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(McpToolLoadError);
    expect(messageOf(error)).toContain(file);
    expect(messageOf(error)).toContain('more than once');
    expect(messageOf(error)).toContain('Remove the duplicate on the server');
  });

  it('SDK 运行期失败按 MCPClientError 分流而不是 CONFIG_INVALID', async () => {
    const file = await writeConfig({
      servers: { dup: goodServer(['--duplicate-tools']) },
    });
    hub = await McpHub.fromConfig(file);

    const error = await hub.tools().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(McpToolLoadError);
    expect(error).not.toBeInstanceOf(ConfigError);
    expect(codeOf(error)).toBe('MCP_TOOL_LOAD_FAILED');
    expect(causeOf(error)).toBeInstanceOf(MCPClientError);
  });

  it('并发 close：两次调用共享同一次关闭，且都在底层关闭完成后才 resolve', async () => {
    let releaseClose: () => void = () => {};
    let closeCalls = 0;
    stubAdapter = {
      listTools: async () => [],
      close: async () => {
        closeCalls += 1;
        await new Promise<void>((resolve) => {
          releaseClose = resolve;
        });
      },
    };
    const file = await writeConfig({ servers: { good: goodServer() } });
    const { logger } = createRecordingLogger();
    hub = await StubHub.fromConfig(file, logger);

    const first = hub.close();
    const second = hub.close();
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondSettled).toBe(false);
    expect(closeCalls).toBe(1);

    releaseClose();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(closeCalls).toBe(1);
  });

  it('close 失败后可重试：第二次 close 真正再试一次并成功', async () => {
    let closeCalls = 0;
    stubAdapter = {
      listTools: async () => [],
      close: async () => {
        closeCalls += 1;
        if (closeCalls === 1) throw new Error('第一次关闭失败');
      },
    };
    const file = await writeConfig({ servers: { good: goodServer() } });
    const { logger } = createRecordingLogger();
    hub = await StubHub.fromConfig(file, logger);

    await expect(hub.close()).rejects.toThrow('第一次关闭失败');
    expect(closeCalls).toBe(1);
    await expect(hub.close()).resolves.toBeUndefined();
    expect(closeCalls).toBe(2);
  });

  it('构造期非 zod 错误不被说成「配置文件校验失败」', async () => {
    const file = await writeConfig({ servers: { good: goodServer() } });
    const error = await ThrowingHub.fromConfig(file).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect(messageOf(error)).toContain('初始化 MCP 客户端失败');
    expect(messageOf(error)).not.toContain('配置文件校验失败');
    expect(messageOf(error)).toContain(file);
    expect(causeOf(error)).toBeInstanceOf(TypeError);
  });

  it('zod 校验错误仍报「配置文件校验失败」并保留路径与 cause', async () => {
    const file = await writeConfig({ servers: { bad: { transport: 'stdio' } } });
    const error = await McpHub.fromConfig(file).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect(messageOf(error)).toContain('配置文件校验失败');
    expect(messageOf(error)).toContain(file);
    expect(nameOf(causeOf(error))).toBe('ZodError');
  });

  it('抛出带 message 的普通对象时错误消息保留该 message 而不是 [object Object]', async () => {
    stubAdapter = {
      listTools: async () => {
        throw { message: '普通对象里的失败原因' };
      },
      close: async () => {},
    };
    const file = await writeConfig({ servers: { good: goodServer() } });
    const { logger } = createRecordingLogger();
    hub = await StubHub.fromConfig(file, logger);

    const error = await hub.tools().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect(messageOf(error)).toContain('普通对象里的失败原因');
    expect(messageOf(error)).not.toContain('[object Object]');
  });
});
