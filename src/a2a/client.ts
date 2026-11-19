import { readFile } from 'node:fs/promises';
import { Role } from '@a2a-js/sdk';
import { ClientFactory, ClientFactoryOptions, DefaultAgentCardResolver } from '@a2a-js/sdk/client';
import type { Client } from '@a2a-js/sdk/client';
import { A2APeerError, ConfigError, createLogger } from '../shared/index.js';
import type { Logger } from '../shared/index.js';
import { buildTextMessage, extractResultText } from './messages.js';

export interface PeerSpec {
  name: string;
  url: string;
  description?: string;
}

export interface Peer {
  spec: PeerSpec;
  client: Client;
  description: string;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsePeerSpec(entry: unknown, index: number, file: string): PeerSpec {
  if (!isPlainObject(entry)) {
    throw new ConfigError(`A2A peer 配置第 ${index} 项不是对象: ${file}`);
  }

  const { name, url, description } = entry;

  if (!isNonEmptyString(name)) {
    throw new ConfigError(`A2A peer 配置第 ${index} 项缺少非空的 "name": ${file}`);
  }
  if (!isNonEmptyString(url)) {
    throw new ConfigError(`A2A peer "${name}" 的 "url" 必须是非空字符串: ${file}`);
  }
  if (description !== undefined && typeof description !== 'string') {
    throw new ConfigError(`A2A peer "${name}" 的 "description" 必须是字符串: ${file}`);
  }

  const spec: PeerSpec = { name, url };
  if (description !== undefined) {
    spec.description = description;
  }
  return spec;
}

function parsePeerSpecs(raw: string, file: string): PeerSpec[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`A2A peer 配置 JSON 解析失败: ${file}`, { cause: error });
  }

  if (!isPlainObject(parsed)) {
    throw new ConfigError(`A2A peer 配置必须是 JSON 对象: ${file}`);
  }

  const peers = parsed.peers;
  if (peers === undefined) {
    return [];
  }
  if (!Array.isArray(peers)) {
    throw new ConfigError(`A2A peer 配置的 "peers" 必须是数组: ${file}`);
  }

  return peers.map((entry, index) => parsePeerSpec(entry, index, file));
}

async function loadPeerSpecs(file: string): Promise<PeerSpec[]> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    // 只有「文件不存在」可以静默降级成零个 peer，其余读取错误必须暴露。
    if (errorCode(error) === 'ENOENT') {
      return [];
    }
    throw error;
  }
  return parsePeerSpecs(raw, file);
}

/** agent card 的下载发生在启动路径上，必须有界，否则一个黑洞 peer 会拖住整个启动。 */
function createClientFactory(connectTimeoutMs: number): ClientFactory {
  const timedFetch: typeof fetch = (input, init) =>
    fetch(input, { ...init, signal: AbortSignal.timeout(connectTimeoutMs) });
  const resolver = new DefaultAgentCardResolver({ fetchImpl: timedFetch });
  return new ClientFactory({ ...ClientFactoryOptions.default, cardResolver: resolver });
}

export class A2AClientHub {
  private constructor(private readonly peers: Peer[]) {}

  static async fromConfig(
    file: string,
    logger: Logger = createLogger('info', 'a2a'),
    connectTimeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS,
  ): Promise<A2AClientHub> {
    const specs = await loadPeerSpecs(file);
    const factory = createClientFactory(connectTimeoutMs);
    const peers: Peer[] = [];

    for (const spec of specs) {
      try {
        const client = await factory.createFromUrl(spec.url);
        peers.push({
          spec,
          client,
          description: spec.description ?? `调用远程 agent ${spec.name}`,
        });
      } catch (error) {
        logger.warn(`跳过不可达的 peer "${spec.name}"`, error);
      }
    }

    return new A2AClientHub(peers);
  }

  list(): Peer[] {
    return [...this.peers];
  }

  async ask(name: string, text: string): Promise<string> {
    const peer = this.peers.find((candidate) => candidate.spec.name === name);
    if (!peer) {
      throw new A2APeerError(name, '未在 peers 配置中找到该 peer');
    }

    try {
      const result = await peer.client.sendMessage({
        tenant: '',
        message: buildTextMessage({ text, role: Role.ROLE_USER }),
        configuration: undefined,
        metadata: undefined,
      });
      return extractResultText(result);
    } catch (error) {
      throw new A2APeerError(name, errorMessage(error), { cause: error });
    }
  }
}
