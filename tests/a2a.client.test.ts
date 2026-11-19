import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { A2AClientHub, DEFAULT_CALL_TIMEOUT_MS, createRemoteAgentTools } from '../src/a2a/index.js';
import { A2APeerError, ConfigError } from '../src/shared/index.js';
import type { Logger } from '../src/shared/index.js';
import { startA2APeerServer, startHangingServer } from './fixtures/a2a-peer-server.mjs';
import type { A2APeerServer } from './fixtures/a2a-peer-server.mjs';

let dir: string;
let peer: A2APeerServer | undefined;
let hanging: A2APeerServer | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'a2a-peer-'));
});

/** afterEach 依赖它无条件关闭两个夹具，重复调用也必须安全。 */
async function closeFixtures(): Promise<void> {
  await peer?.close();
  peer = undefined;
  await hanging?.close();
  hanging = undefined;
}

afterEach(async () => {
  await closeFixtures();
  await rm(dir, { recursive: true, force: true });
});

function createRecordingLogger(): {
  logger: Logger;
  warnings: { message: string; rest: unknown[] }[];
} {
  const warnings: { message: string; rest: unknown[] }[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string, ...rest: unknown[]) => {
      warnings.push({ message, rest });
    },
    error: () => undefined,
    child: () => logger,
  };
  return { logger, warnings };
}

async function writePeersFile(contents: unknown): Promise<string> {
  const file = join(dir, 'peers.json');
  await writeFile(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return file;
}

describe('A2AClientHub', () => {
  it('peers 为空时没有远程工具', async () => {
    const file = await writePeersFile({ peers: [] });
    const hub = await A2AClientHub.fromConfig(file);
    expect(hub.list()).toEqual([]);
    expect(createRemoteAgentTools(hub)).toEqual([]);
  });

  it('配置文件不存在时返回空 hub', async () => {
    const hub = await A2AClientHub.fromConfig(join(dir, 'missing.json'));
    expect(hub.list()).toEqual([]);
  });

  it('peer 不可达时被跳过而不是抛错', async () => {
    const file = await writePeersFile({
      peers: [{ name: 'ghost', url: 'http://127.0.0.1:1/' }],
    });
    const { logger, warnings } = createRecordingLogger();
    const hub = await A2AClientHub.fromConfig(file, logger);

    expect(hub.list()).toEqual([]);
    expect(warnings.some((entry) => entry.message.includes('ghost'))).toBe(true);
    expect(warnings[0]?.rest[0]).toBeInstanceOf(Error);
  });

  it('可达 peer 会被列出并能取回远端文本', async () => {
    peer = await startA2APeerServer({ replyText: 'pong-from-peer' });
    const file = await writePeersFile({
      peers: [{ name: 'probe-peer', url: peer.baseUrl }],
    });
    const hub = await A2AClientHub.fromConfig(file);

    expect(hub.list().map((entry) => entry.spec.name)).toEqual(['probe-peer']);
    expect(hub.list()[0]?.description).toBe('调用远程 agent probe-peer');
    expect(await hub.ask('probe-peer', '你好')).toBe('pong-from-peer');
  });

  it('发出的消息是 ROLE_USER 且携带提问文本', async () => {
    peer = await startA2APeerServer({ replyText: 'pong-from-peer' });
    const file = await writePeersFile({
      peers: [{ name: 'probe-peer', url: peer.baseUrl }],
    });
    const hub = await A2AClientHub.fromConfig(file);
    await hub.ask('probe-peer', '你在吗');

    const rpc = peer.requests.find((entry) => entry.body?.method === 'SendMessage');
    expect(rpc).toBeDefined();
    expect(rpc?.body?.method).toBe('SendMessage');
    expect(rpc?.body?.params?.message?.role).toBe('ROLE_USER');
    expect(rpc?.body?.params?.message?.parts?.[0]?.text).toBe('你在吗');
  });

  it('远程工具可以向远端 agent 提问', async () => {
    peer = await startA2APeerServer({ replyText: 'tool-answer' });
    const file = await writePeersFile({
      peers: [{ name: 'probe-peer', url: peer.baseUrl, description: '远程探针' }],
    });
    const hub = await A2AClientHub.fromConfig(file);
    const tools = createRemoteAgentTools(hub);

    expect(tools.map((entry) => entry.name)).toEqual(['ask_probe-peer']);
    expect(tools[0]?.description).toBe('远程探针');

    const askTool = tools[0];
    expect(askTool).toBeDefined();
    expect(await askTool!.invoke({ message: '有问题' })).toBe('tool-answer');
    await expect(askTool!.invoke({ message: '' })).rejects.toThrow();
  });

  it('peer 挂住时按超时跳过而不是拖住启动', async () => {
    const server = await startHangingServer();
    hanging = server;
    const file = await writePeersFile({
      peers: [{ name: 'slow-peer', url: server.baseUrl }],
    });

    const startedAt = Date.now();
    const hub = await A2AClientHub.fromConfig(file, undefined, { connectTimeoutMs: 200 });
    const elapsed = Date.now() - startedAt;

    expect(hub.list()).toEqual([]);
    expect(elapsed).toBeLessThan(5_000);
  });

  it('远端挂住时工具调用在超时内被中止', async () => {
    const server = await startA2APeerServer({ replyText: 'never', hangOnCall: true });
    peer = server;
    const file = await writePeersFile({
      peers: [{ name: 'stuck-peer', url: server.baseUrl }],
    });
    const hub = await A2AClientHub.fromConfig(file, undefined, { callTimeoutMs: 300 });
    const tools = createRemoteAgentTools(hub);
    const askTool = tools[0];
    expect(askTool).toBeDefined();

    const startedAt = Date.now();
    const error: unknown = await askTool!
      .invoke({ message: '在吗' })
      .catch((caught: unknown) => caught);
    const elapsed = Date.now() - startedAt;

    expect(error).toBeInstanceOf(A2APeerError);
    expect((error as A2APeerError).message).toContain('超时');
    expect((error as A2APeerError).message).toContain('stuck-peer');
    expect((error as A2APeerError).message).toContain('300');
    expect(elapsed).toBeLessThan(5_000);
  });

  it('调用超时默认有界（120 秒）而不是无限等待', () => {
    expect(DEFAULT_CALL_TIMEOUT_MS).toBe(120_000);
  });

  it('peers 配置 JSON 畸形时报 ConfigError', async () => {
    const file = await writePeersFile('{ 不是合法 JSON');

    await expect(A2AClientHub.fromConfig(file)).rejects.toBeInstanceOf(ConfigError);
    await expect(A2AClientHub.fromConfig(file)).rejects.toThrow(/peers\.json/);
  });

  it('peers 不是数组时报 ConfigError', async () => {
    const file = await writePeersFile({ peers: { name: 'x' } });

    await expect(A2AClientHub.fromConfig(file)).rejects.toBeInstanceOf(ConfigError);
    await expect(A2AClientHub.fromConfig(file)).rejects.toThrow(/peers\.json/);
  });

  it('peer 缺少 name 时报 ConfigError', async () => {
    const file = await writePeersFile({ peers: [{ url: 'http://127.0.0.1:9/' }] });

    await expect(A2AClientHub.fromConfig(file)).rejects.toBeInstanceOf(ConfigError);
    await expect(A2AClientHub.fromConfig(file)).rejects.toThrow(/peers\.json/);
  });

  it('peer 的 url 不是字符串时报 ConfigError', async () => {
    const file = await writePeersFile({ peers: [{ name: 'bad', url: 123 }] });

    await expect(A2AClientHub.fromConfig(file)).rejects.toBeInstanceOf(ConfigError);
    await expect(A2AClientHub.fromConfig(file)).rejects.toThrow(/bad/);
  });

  it('配置文件路径是目录时抛错而不是静默降级', async () => {
    const directory = join(dir, 'peers-dir');
    await mkdir(directory);

    await expect(A2AClientHub.fromConfig(directory)).rejects.toBeInstanceOf(Error);
  });

  it('list() 返回副本，改动它不影响 hub 内部状态', async () => {
    peer = await startA2APeerServer({ replyText: 'ok' });
    const file = await writePeersFile({
      peers: [{ name: 'probe-peer', url: peer.baseUrl }],
    });
    const hub = await A2AClientHub.fromConfig(file);

    const listed = hub.list();
    listed.pop();

    expect(hub.list()).toHaveLength(1);
    expect(hub.list()).not.toBe(listed);
  });

  it('未知 peer 名时抛 A2APeerError', async () => {
    const file = await writePeersFile({ peers: [] });
    const hub = await A2AClientHub.fromConfig(file);

    const error: unknown = await hub.ask('nobody', 'hi').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(A2APeerError);
    expect((error as A2APeerError).code).toBe('A2A_PEER_UNREACHABLE');
    expect((error as A2APeerError).message).toContain('nobody');
  });

  it('远端返回失败时抛 A2APeerError 并保留原因', async () => {
    peer = await startA2APeerServer({ replyText: 'ok' });
    const file = await writePeersFile({
      peers: [{ name: 'probe-peer', url: peer.baseUrl }],
    });
    const hub = await A2AClientHub.fromConfig(file);
    await peer.close();
    peer = undefined;

    const error: unknown = await hub.ask('probe-peer', 'hi').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(A2APeerError);
    expect((error as A2APeerError).message).toContain('probe-peer');
  });
});

describe('createRemoteAgentTools', () => {
  it('工具名冲突时报 ConfigError', async () => {
    peer = await startA2APeerServer({ replyText: 'ok' });
    const file = await writePeersFile({
      peers: [
        { name: 'a b', url: peer.baseUrl },
        { name: 'a_b', url: peer.baseUrl },
      ],
    });
    const hub = await A2AClientHub.fromConfig(file);

    expect(() => createRemoteAgentTools(hub)).toThrow(ConfigError);
    expect(() => createRemoteAgentTools(hub)).toThrow(/a b/);
    expect(() => createRemoteAgentTools(hub)).toThrow(/a_b/);
  });
});

describe('测试夹具生命周期', () => {
  it('afterEach 使用的清理逻辑会关闭挂起的服务器', async () => {
    const server = await startHangingServer();
    hanging = server;

    await closeFixtures();

    expect(server.isClosed()).toBe(true);
    expect(hanging).toBeUndefined();
  });

  it('夹具的 close() 可以重复调用而不抛错', async () => {
    const server = await startA2APeerServer({ replyText: 'ok' });

    await server.close();
    await expect(server.close()).resolves.toBeUndefined();
    await expect(server.close()).resolves.toBeUndefined();
    expect(server.isClosed()).toBe(true);
  });
});
