import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_CARD_PATH, Role } from '@a2a-js/sdk';
import type { SendMessageResult, Task } from '@a2a-js/sdk';
import { ClientFactory } from '@a2a-js/sdk/client';
import { buildTextMessage } from '../src/a2a/index.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 反应列表不可观测：在子进程里 spy Promise.prototype.then，按接收者统计 closedSignal 形态的挂载次数。
// tsx 会把 () => undefined 转译成 () => void 0，两种形态都认。
const THEN_PROBE = `data:text/javascript,${encodeURIComponent(String.raw`
import { writeSync } from 'node:fs';
const originalThen = Promise.prototype.then;
const counts = new Map();
Promise.prototype.then = function (onFulfilled, onRejected) {
  if (typeof onFulfilled === 'function' && onRejected == null) {
    const shape = String(onFulfilled).replace(/\s+/g, '');
    if (shape === '()=>void0' || shape === '()=>undefined') {
      counts.set(this, (counts.get(this) ?? 0) + 1);
    }
  }
  return originalThen.call(this, onFulfilled, onRejected);
};
process.on('exit', () => {
  let max = 0;
  for (const count of counts.values()) max = Math.max(max, count);
  writeSync(2, '[then-probe] max=' + max + '\n');
});
`)}`;

let child: ChildProcess | undefined;
let tempDir: string | undefined;
let slowLlm: Server | undefined;

// spawn 的子进程必须无条件杀掉并等待退出，否则 vitest 挂住或留下孤儿进程。
afterEach(async () => {
  const current = child;
  child = undefined;
  if (current) {
    const exited = new Promise<void>((resolve) => {
      if (current.exitCode !== null || current.signalCode !== null) resolve();
      else current.once('exit', () => resolve());
    });
    if (current.exitCode === null && current.signalCode === null) {
      current.kill('SIGKILL');
    }
    await exited;
  }
  const llm = slowLlm;
  slowLlm = undefined;
  if (llm) {
    llm.closeAllConnections();
    await new Promise<void>((resolve) => llm.close(() => resolve()));
  }
  const dir = tempDir;
  tempDir = undefined;
  if (dir) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function reservePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  if (address === null || typeof address !== 'object') {
    throw new Error('无法获取探针端口');
  }
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

// 显式构造 env，不继承 process.env 里的真实 key。
function baseEnv(dir: string, port: number): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LLM_PROVIDER: 'openai-compatible',
    LLM_MODEL: 'gpt-4o-mini',
    LLM_BASE_URL: 'https://example.invalid/v1',
    LLM_API_KEY: 'sk-dummy',
    LLM_TEMPERATURE: '0',
    SANDBOX_ROOT: join(dir, 'sandbox'),
    CHECKPOINT_DB: join(dir, 'data', 'checkpoints.sqlite'),
    SKILLS_DIR: join(REPO_ROOT, 'skills'),
    MCP_CONFIG: join(REPO_ROOT, 'config', 'mcp.servers.json'),
    A2A_PEERS: join(REPO_ROOT, 'config', 'a2a.peers.json'),
    A2A_PORT: String(port),
    A2A_PUBLIC_URL: `http://127.0.0.1:${port}`,
    A2A_AGENT_NAME: 'serve-smoke-agent',
    A2A_DESCRIPTION: '冒烟测试 agent',
    LOG_LEVEL: 'info',
  };
}

function spawnEntrypoint(entry: string, env: Record<string, string>, imports: string[] = []): ChildProcess {
  const current = spawn(
    process.execPath,
    ['--import', 'tsx', ...imports.flatMap((specifier) => ['--import', specifier]), join(REPO_ROOT, entry)],
    {
      cwd: REPO_ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  child = current;
  return current;
}

function capture(stream: NodeJS.ReadableStream | null): () => string {
  let buffer = '';
  stream?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
  });
  return () => buffer;
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function exitOf(current: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    if (current.exitCode !== null || current.signalCode !== null) {
      resolve({ code: current.exitCode, signal: current.signalCode });
      return;
    }
    current.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function expectDisposed(dir: string): Promise<void> {
  const entries = await readdir(join(dir, 'sandbox')).catch(() => []);
  expect(entries).toEqual([]);
}

function expectTask(result: SendMessageResult): Task {
  if (!('artifacts' in result)) {
    throw new Error('期望 Task 结果，实际拿到 Message');
  }
  return result;
}

async function waitServeReady(current: ChildProcess): Promise<string> {
  const stderr = capture(current.stderr);
  await waitFor(() => stderr().includes('A2A server 已启动'));
  return stderr();
}

describe('CLI 入口冒烟', () => {
  it('缺少 LLM_API_KEY 时以退出码 1 结束且 stderr 指出变量名', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cli-nokey-'));
    const port = await reservePort();
    const env = baseEnv(tempDir, port);
    delete env.LLM_API_KEY;
    const current = spawnEntrypoint('src/cli.ts', env);
    const stderr = capture(current.stderr);
    const { code } = await exitOf(current);
    expect(code).toBe(1);
    expect(stderr()).toContain('LLM_API_KEY');
  });

  it('SIGINT 时清理沙箱并以退出码 0 退出', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cli-sigint-'));
    const port = await reservePort();
    const current = spawnEntrypoint('src/cli.ts', baseEnv(tempDir, port));
    const stderr = capture(current.stderr);
    await waitFor(() => stderr().includes('会话已启动'));
    const exited = exitOf(current);
    current.kill('SIGINT');
    const { code, signal } = await exited;
    expect(signal).toBeNull();
    expect(code).toBe(0);
    await expectDisposed(tempDir);
  });

  it('输入 /exit 正常退出并清理沙箱', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cli-exit-'));
    const port = await reservePort();
    const current = spawnEntrypoint('src/cli.ts', baseEnv(tempDir, port));
    const stderr = capture(current.stderr);
    await waitFor(() => stderr().includes('会话已启动'));
    const exited = exitOf(current);
    current.stdin?.write('/exit\n');
    const { code, signal } = await exited;
    expect(signal).toBeNull();
    expect(code).toBe(0);
    await expectDisposed(tempDir);
  });

  it('stdin EOF（Ctrl+D）退出并清理沙箱', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cli-eof-'));
    const port = await reservePort();
    const current = spawnEntrypoint('src/cli.ts', baseEnv(tempDir, port));
    const stderr = capture(current.stderr);
    await waitFor(() => stderr().includes('会话已启动'));
    const exited = exitOf(current);
    current.stdin?.end();
    const { code, signal } = await exited;
    expect(signal).toBeNull();
    expect(code).toBe(0);
    await expectDisposed(tempDir);
  });

  it('输入 /summarize 在历史为空时提示无需压缩且不触发模型调用', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cli-summarize-'));
    const port = await reservePort();
    const current = spawnEntrypoint('src/cli.ts', baseEnv(tempDir, port));
    const stderr = capture(current.stderr);
    const stdout = capture(current.stdout);
    await waitFor(() => stderr().includes('会话已启动'));
    current.stdin?.write('/summarize\n');
    await waitFor(() => stdout().includes('当前历史无需压缩'));
    const exited = exitOf(current);
    current.stdin?.write('/exit\n');
    const { code, signal } = await exited;
    expect(signal).toBeNull();
    expect(code).toBe(0);
    await expectDisposed(tempDir);
  });

  it('REPL 多轮输入时 closedSignal 只挂载一个反应回调', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cli-reactions-'));
    const port = await reservePort();
    const current = spawnEntrypoint('src/cli.ts', baseEnv(tempDir, port), [THEN_PROBE]);
    const stderr = capture(current.stderr);
    const stdout = capture(current.stdout);
    await waitFor(() => stderr().includes('会话已启动'));
    const promptCount = (): number => stdout().split('> ').length - 1;
    const rounds = 5;
    for (let i = 0; i < rounds; i++) {
      current.stdin?.write('\n');
      await waitFor(() => promptCount() >= i + 2);
    }
    const exited = exitOf(current);
    current.stdin?.write('/exit\n');
    const { code, signal } = await exited;
    expect(signal).toBeNull();
    expect(code).toBe(0);
    await expectDisposed(tempDir);
    const marker = /\[then-probe\] max=(\d+)/.exec(stderr());
    expect(marker).not.toBeNull();
    expect(Number(marker?.[1])).toBe(1);
  });
});

describe('serve 入口冒烟', () => {
  it('启动后卡片端点可达且 name 为配置的 agent 名', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'serve-card-'));
    const port = await reservePort();
    const current = spawnEntrypoint('src/serve.ts', baseEnv(tempDir, port));
    await waitServeReady(current);
    const baseUrl = `http://127.0.0.1:${port}`;
    const response = await fetch(`${baseUrl}/${AGENT_CARD_PATH}`);
    expect(response.status).toBe(200);
    const card: unknown = await response.json();
    expect(card).toMatchObject({ name: 'serve-smoke-agent' });
    expect(card).toMatchObject({ skills: [{ id: 'hello-world' }] });
  });

  it('SIGTERM 时关闭 server、清理沙箱并以退出码 0 退出', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'serve-sigterm-'));
    const port = await reservePort();
    const current = spawnEntrypoint('src/serve.ts', baseEnv(tempDir, port));
    await waitServeReady(current);
    const exited = exitOf(current);
    current.kill('SIGTERM');
    const { code, signal } = await exited;
    expect(signal).toBeNull();
    expect(code).toBe(0);
    await expectDisposed(tempDir);
  });

  it('端口被占用时以非零码退出且 stderr 给出可读原因而非裸堆栈', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'serve-busy-'));
    const port = await reservePort();
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(port, resolve));
    try {
      const current = spawnEntrypoint('src/serve.ts', baseEnv(tempDir, port));
      const stderr = capture(current.stderr);
      const { code, signal } = await exitOf(current);
      expect(signal).toBeNull();
      expect(code).toBe(1);
      const output = stderr();
      expect(output).toContain('[error] serve:');
      expect(output).toContain('EADDRINUSE');
      expect(output).toContain(String(port));
      expect(output).not.toContain("Unhandled 'error' event");
      expect(output).not.toContain('HTTP server 关闭失败');
      await expectDisposed(tempDir);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('取消 A2A 任务时中止信号传播到底层模型调用', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'serve-signal-'));
    const port = await reservePort();

    let received = false;
    let aborted = false;
    const llm = createServer((req, res) => {
      received = true;
      req.socket.on('close', () => {
        if (!res.writableFinished) aborted = true;
      });
    });
    slowLlm = llm;
    await new Promise<void>((resolve) => llm.listen(0, '127.0.0.1', resolve));
    const llmAddress = llm.address();
    const llmPort = typeof llmAddress === 'object' && llmAddress ? llmAddress.port : 0;

    const env = baseEnv(tempDir, port);
    env.LLM_BASE_URL = `http://127.0.0.1:${llmPort}/v1`;
    const current = spawnEntrypoint('src/serve.ts', env);
    await waitServeReady(current);

    const baseUrl = `http://127.0.0.1:${port}`;
    const client = await new ClientFactory().createFromUrl(baseUrl);
    const submitted = expectTask(
      await client.sendMessage({
        tenant: '',
        message: buildTextMessage({ text: '慢慢跑', role: Role.ROLE_USER }),
        configuration: {
          acceptedOutputModes: [],
          taskPushNotificationConfig: undefined,
          returnImmediately: true,
        },
        metadata: undefined,
      }),
    );

    await waitFor(() => received);
    await client.cancelTask({ tenant: '', id: submitted.id, metadata: undefined });
    await waitFor(() => aborted, 8_000);
    expect(aborted).toBe(true);
  });
});
