import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, terminal: false });
const duplicateTools = process.argv.includes('--duplicate-tools');

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const pingTool = {
  name: 'ping',
  description: '探针工具',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (req.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: req.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'probe-server', version: '0.0.1' },
      },
    });
    return;
  }
  if (req.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        tools: duplicateTools ? [pingTool, pingTool] : [pingTool],
      },
    });
    return;
  }
  if (req.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'pong' }] } });
    return;
  }
  if (req.id !== undefined) {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } });
  }
});
