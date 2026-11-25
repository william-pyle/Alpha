import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { childEnvironment } from '../agents.mjs';

const script = fileURLToPath(new URL('../worker-request-mcp.mjs', import.meta.url));
const token = 't'.repeat(43);
const targetId = 'ffa56b8e-c26e-4775-81a6-36deade37c7f';
const receiptId = '6f09ccbf-b0cd-438e-81ac-af0737e0fee4';

test('the Codex stdio adapter keeps identity out of typed requests and returns scoped results', async () => {
  const requests = [];
  let redirect = false;
  const host = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
    if (redirect) {
      response.writeHead(307, { Location: '/unexpected' });
      response.end();
      return;
    }
    const result = body.kind === 'targets' ? { targets: [{ id: targetId, title: 'Help' }] }
      : body.kind === 'request' ? { receiptId, status: 'pending' }
        : { receiptId, status: 'completed' };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(result));
  });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  const transport = new StdioClientTransport({ command: process.execPath, args: [script], env: {
    ALPHA_WORKER_REQUEST_ORIGIN: `http://127.0.0.1:${host.address().port}`, ALPHA_WORKER_REQUEST_TOKEN: token,
  } });
  const client = new Client({ name: 'alpha-worker-stdio-fixture', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ['alpha_list_disposable_previews', 'alpha_request', 'alpha_request_result']);
    assert.ok(tools.every(tool => tool.inputSchema.additionalProperties === false));
    const invoke = (name, args = {}) => client.callTool({ name, arguments: args });
    const args = { requestKey: 'close-help', action: 'close-preview', targetId };
    assert.equal((await invoke('alpha_request', { ...args, sessionId: 'other-session' })).isError, true);
    assert.equal((await invoke('alpha_request', { ...args, action: 'run-command' })).isError, true);
    assert.equal((await invoke('alpha_request', { ...args, targetId: 'file:private' })).isError, true);
    assert.equal((await invoke('alpha_request', { ...args, requestKey: 'a'.repeat(65) })).isError, true);
    assert.equal(requests.length, 0);
    assert.equal((await invoke('alpha_list_disposable_previews')).structuredContent.targets[0].id, targetId);
    assert.deepEqual((await invoke('alpha_request', args)).structuredContent, { receiptId, status: 'pending' });
    assert.deepEqual((await invoke('alpha_request_result', { receiptId })).structuredContent, { receiptId, status: 'completed' });
    redirect = true;
    assert.equal((await invoke('alpha_list_disposable_previews')).isError, true);
    assert.deepEqual(requests.map(entry => entry.body), [{ kind: 'targets' }, { kind: 'request', ...args }, { kind: 'result', receiptId }, { kind: 'targets' }]);
    assert.ok(requests.every(entry => entry.method === 'POST' && entry.url === '/worker-request' && entry.authorization === `Bearer ${token}`));
  } finally {
    await client.close();
    await new Promise(resolve => host.close(resolve));
  }
});

test('general child environments never pass on worker bridge credentials', () => {
  const key = 'ALPHA_WORKER_REQUEST_TOKEN';
  const origin = 'ALPHA_WORKER_REQUEST_ORIGIN';
  const previous = { [key]: process.env[key], [origin]: process.env[origin] };
  process.env[key] = token;
  process.env[origin] = 'http://127.0.0.1:12345';
  try {
    const env = childEnvironment();
    assert.equal(Object.hasOwn(env, key), false);
    assert.equal(Object.hasOwn(env, origin), false);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
