import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import { ClientFactory } from '@a2a-js/sdk/client';
import type { Client } from '@a2a-js/sdk/client';
import { AGENT_CARD_PATH, A2A_PROTOCOL_VERSION, Role, TaskState } from '@a2a-js/sdk';
import type { AgentCard, Message, SendMessageResult, Task } from '@a2a-js/sdk';
import {
  AgentEvent,
  DefaultExecutionEventBus,
  DefaultRequestHandler,
  InMemoryTaskStore,
  RequestContext,
  ServerCallContext,
} from '@a2a-js/sdk/server';
import type { AgentExecutionEvent, AgentExecutor } from '@a2a-js/sdk/server';
import { UserBuilder, agentCardHandler, jsonRpcHandler } from '@a2a-js/sdk/server/express';
import {
  A2AAgentExecutor,
  buildAgentCard,
  buildTextMessage,
  createA2AServer,
  extractResultText,
  extractText,
} from '../src/a2a/index.js';
import type { AgentRunner } from '../src/a2a/index.js';

interface RunCall {
  input: string;
  threadId: string;
}

let httpServer: Server | undefined;

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

async function listen(app: Express, port: number): Promise<void> {
  httpServer = await new Promise<Server>((resolve) => {
    const listening = app.listen(port, '127.0.0.1', () => resolve(listening));
  });
}

// fetch/undici 会保持 keep-alive 连接，不主动销毁会让 server.close() 一直等待。
afterEach(async () => {
  const server = httpServer;
  httpServer = undefined;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function makeCard(baseUrl: string): AgentCard {
  return buildAgentCard({
    name: 'test-agent',
    description: '测试用 agent',
    publicUrl: baseUrl,
    skills: [],
  });
}

function createRecordingRunner(): { runner: AgentRunner; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const runner: AgentRunner = {
    run: async (input, options) => {
      calls.push({ input, threadId: options.threadId });
      return { text: `echo: ${input}` };
    },
  };
  return { runner, calls };
}

async function startAgentServer(runner: AgentRunner): Promise<{ baseUrl: string; client: Client }> {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const app = createA2AServer({ cardProvider: () => makeCard(baseUrl), runner });
  await listen(app, port);
  const client = await new ClientFactory().createFromUrl(baseUrl);
  return { baseUrl, client };
}

function userMessage(text: string, contextId?: string): Message {
  return buildTextMessage({ text, role: Role.ROLE_USER, contextId });
}

function expectTask(result: SendMessageResult): Task {
  if (!('artifacts' in result)) {
    throw new Error('期望 Task 结果，实际拿到 Message');
  }
  return result;
}

describe('A2A HTTP server', () => {
  it('对外提供内容正确的 agent card', async () => {
    const { runner } = createRecordingRunner();
    const { baseUrl } = await startAgentServer(runner);

    const response = await fetch(`${baseUrl}/${AGENT_CARD_PATH}`);
    expect(response.status).toBe(200);
    const card: unknown = await response.json();
    expect(card).toMatchObject({
      name: 'test-agent',
      supportedInterfaces: [{ url: baseUrl, protocolVersion: A2A_PROTOCOL_VERSION }],
    });
  });

  it('message/send 往返并返回正确回复文本', async () => {
    const { runner } = createRecordingRunner();
    const { client } = await startAgentServer(runner);

    const result = await client.sendMessage({
      tenant: '',
      message: userMessage('你好'),
      configuration: undefined,
      metadata: undefined,
    });

    expect(extractResultText(result)).toContain('echo: 你好');
  });

  it('畸形 JSON 请求返回 JSON-RPC 错误而不是通用 400', async () => {
    const { runner } = createRecordingRunner();
    const { baseUrl } = await startAgentServer(runner);

    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ 不是合法 JSON',
    });

    expect(response.headers.get('content-type')).toContain('application/json');
    const body: unknown = await response.json();
    expect(body).toMatchObject({ jsonrpc: '2.0', error: { code: -32700 } });
  });

  it('executor 把用户文本作为输入并传入非空 threadId', async () => {
    const { runner, calls } = createRecordingRunner();
    const { client } = await startAgentServer(runner);

    await client.sendMessage({
      tenant: '',
      message: userMessage('你好世界'),
      configuration: undefined,
      metadata: undefined,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('你好世界');
    expect(calls[0]?.threadId).toBeTruthy();
  });

  it('回复消息是 ROLE_AGENT 且带回请求的 contextId', async () => {
    const { runner } = createRecordingRunner();
    const { client } = await startAgentServer(runner);

    const result = await client.sendMessage({
      tenant: '',
      message: userMessage('在吗', 'ctx-reply'),
      configuration: undefined,
      metadata: undefined,
    });

    const reply = expectTask(result).status?.message;
    if (!reply) {
      throw new Error('回复缺少 status.message');
    }
    expect(reply.role).toBe(Role.ROLE_AGENT);
    expect(reply.contextId).toBe('ctx-reply');
    expect(extractText(reply)).toContain('echo: 在吗');
  });

  it('同一 contextId 的多轮请求复用同一个 threadId', async () => {
    const { runner, calls } = createRecordingRunner();
    const { client } = await startAgentServer(runner);

    await client.sendMessage({
      tenant: '',
      message: userMessage('第一轮', 'ctx-multi'),
      configuration: undefined,
      metadata: undefined,
    });
    await client.sendMessage({
      tenant: '',
      message: userMessage('第二轮', 'ctx-multi'),
      configuration: undefined,
      metadata: undefined,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.threadId).toBe('ctx-multi');
    expect(calls[1]?.threadId).toBe('ctx-multi');
    expect(calls[0]?.threadId).toBe(calls[1]?.threadId);
  });

  it('不带 contextId 时每个请求开启新会话', async () => {
    const { runner, calls } = createRecordingRunner();
    const { client } = await startAgentServer(runner);

    await client.sendMessage({
      tenant: '',
      message: userMessage('甲'),
      configuration: undefined,
      metadata: undefined,
    });
    await client.sendMessage({
      tenant: '',
      message: userMessage('乙'),
      configuration: undefined,
      metadata: undefined,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.threadId).toBeTruthy();
    expect(calls[1]?.threadId).toBeTruthy();
    expect(calls[0]?.threadId).not.toBe(calls[1]?.threadId);
  });

  it('executor 的首个事件是 task 或 message', async () => {
    const { runner } = createRecordingRunner();
    const executor = new A2AAgentExecutor(runner);
    const bus = new DefaultExecutionEventBus();
    const events: AgentExecutionEvent[] = [];
    bus.on('event', (event) => {
      events.push(event);
    });
    const requestContext = new RequestContext(
      { tenant: '', message: userMessage('你好'), configuration: undefined, metadata: undefined },
      'task-unit',
      'ctx-unit',
      new ServerCallContext(),
    );

    await executor.execute(requestContext, bus);

    expect(events.length).toBeGreaterThan(0);
    expect(['task', 'message']).toContain(events[0]?.kind);
  });

  it('服务端拒绝以 statusUpdate 开头的执行流', async () => {
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const badExecutor: AgentExecutor = {
      execute: async (_requestContext, eventBus) => {
        eventBus.publish(
          AgentEvent.statusUpdate({
            taskId: 'bad-task',
            contextId: 'bad-context',
            status: {
              state: TaskState.TASK_STATE_WORKING,
              message: undefined,
              timestamp: new Date().toISOString(),
            },
            metadata: undefined,
          }),
        );
      },
      cancelTask: async () => {},
    };
    const app = express();
    const card = makeCard(baseUrl);
    app.use(
      `/${AGENT_CARD_PATH}`,
      agentCardHandler({ agentCardProvider: { getAgentCard: async () => card } }),
    );
    app.use(
      jsonRpcHandler({
        requestHandler: new DefaultRequestHandler(card, new InMemoryTaskStore(), badExecutor),
        userBuilder: UserBuilder.noAuthentication,
      }),
    );
    await listen(app, port);
    const client = await new ClientFactory().createFromUrl(baseUrl);

    await expect(
      client.sendMessage({
        tenant: '',
        message: userMessage('你好'),
        configuration: undefined,
        metadata: undefined,
      }),
    ).rejects.toThrow();
  });

  it('Client.cancelTask 触发 executor 取消并发布终态 canceled statusUpdate', async () => {
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const calls: RunCall[] = [];
    const runner: AgentRunner = {
      run: async (input, options) => {
        calls.push({ input, threadId: options.threadId });
        await gate;
        return { text: `echo: ${input}` };
      },
    };
    const { client } = await startAgentServer(runner);

    const submitted = expectTask(
      await client.sendMessage({
        tenant: '',
        message: userMessage('慢慢跑'),
        configuration: {
          acceptedOutputModes: [],
          taskPushNotificationConfig: undefined,
          returnImmediately: true,
        },
        metadata: undefined,
      }),
    );
    expect(submitted.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    expect(calls).toHaveLength(1);

    const canceled = await client.cancelTask({ tenant: '', id: submitted.id, metadata: undefined });

    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    const cancelText = canceled.status?.message ? extractText(canceled.status.message) : '';
    expect(cancelText).toContain(submitted.id);
    expect(cancelText).toContain('已取消');
    releaseGate();
  });
});