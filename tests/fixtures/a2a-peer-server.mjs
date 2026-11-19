import { createServer } from 'node:http';

const AGENT_CARD_PATH = '/.well-known/agent-card.json';

function createTrackedServer(handler) {
  const sockets = new Set();
  const server = createServer(handler);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const close = () =>
    new Promise((resolve, reject) => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.close((error) => (error ? reject(error) : resolve()));
    });
  return { server, close };
}

function parseJson(body) {
  if (!body) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * 起一个真实的 A2A peer：GET /.well-known/agent-card.json 返回卡片，
 * POST / 走 JSON-RPC（方法名 SendMessage），result 下直接放 message。
 */
export async function startA2APeerServer(options = {}) {
  const replyText = options.replyText ?? 'pong-from-peer';
  const peerName = options.peerName ?? 'probe-peer';
  const requests = [];
  let baseUrl = '';

  const handler = (req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const parsed = parseJson(body);
      requests.push({ url: req.url, method: req.method, headers: req.headers, body: parsed });

      if (req.url === AGENT_CARD_PATH) {
        const card = {
          name: peerName,
          description: '本地测试用 A2A peer',
          version: '0.1.0',
          supportedInterfaces: [
            {
              url: baseUrl,
              protocolBinding: 'JSONRPC',
              tenant: '',
              protocolVersion: '1.0',
            },
          ],
          capabilities: { streaming: false, pushNotifications: false, extensions: [] },
          securitySchemes: {},
          securityRequirements: [],
          defaultInputModes: ['text/plain'],
          defaultOutputModes: ['text/plain'],
          skills: [],
          signatures: [],
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(card));
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: parsed && parsed.id !== undefined ? parsed.id : null,
          result: {
            message: {
              messageId: 'm1',
              contextId: 'c1',
              taskId: '',
              role: 'ROLE_AGENT',
              parts: [{ text: replyText, mediaType: 'text/plain' }],
              extensions: [],
              referenceTaskIds: [],
            },
          },
        }),
      );
    });
  };

  const { server, close } = createTrackedServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  return { baseUrl, port, requests, close };
}

/** 接受连接但永不响应，用来复现「peer 挂住」的启动路径阻塞。 */
export async function startHangingServer() {
  const { server, close } = createTrackedServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return { baseUrl: `http://127.0.0.1:${port}`, port, requests: [], close };
}
