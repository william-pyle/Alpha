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
      : body.kind === 'capabilities' ? { projectId: 'fixture', actions: ['create-report-tab'] }
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
    const actionTools = [
      ['create_project', { title: 'Fixture', template: 'research' }],
      ['update_project', { projectId: 'fixture', patch: { status: 'active', category: 'other', pinned: true } }],
      ['create_report_tab', { projectId: 'fixture', title: 'Fixture report' }],
      ['rename_report_tab', { projectId: 'fixture', tabId: 'step-3', title: 'Renamed' }],
      ['remove_report_tab', { projectId: 'fixture', tabId: 'legacy-' + 'a'.repeat(64) }],
      ['open_tab', { targetId }],
      ['activate_tab', { targetId }],
      ['close_tab', { targetId }],
      ['set_3d_view', { targetId, visible: true }],
      ['set_message_panel', { targetId, visible: false }],
      ['copy_file', { targetId, destinationProjectId: 'other-fixture', expectedRevision: 'a'.repeat(64) }],
      ['modify_file', { targetId, expectedRevision: 'b'.repeat(64), edit: 'ensure-final-newline' }],
      ['run_script', { scriptId: 'alpha-runtime-check', expectedRevision: 'c'.repeat(64) }],
      ['import_project_artifact', { sourceProjectId: 'fixture-source', kind: 'skill', artifactId: 'review-guide' }, 'import-artifact'],
    ];
    assert.deepEqual(tools.map(tool => tool.name),
      ['alpha_list_disposable_previews', 'alpha_request', 'alpha_request_result', 'alpha_list_session_actions', ...actionTools.map(([name]) => 'alpha_' + name)]);
    assert.ok(tools.every(tool => tool.inputSchema.additionalProperties === false));
    const invoke = (name, args = {}) => client.callTool({ name, arguments: args });
    const args = { requestKey: 'close-help', action: 'close-preview', targetId };
    assert.equal((await invoke('alpha_request', { ...args, sessionId: 'other-session' })).isError, true);
    assert.equal((await invoke('alpha_request', { ...args, action: 'run-command' })).isError, true);
    assert.equal((await invoke('alpha_request', { ...args, targetId: 'file:private' })).isError, true);
    assert.equal((await invoke('alpha_request', { ...args, requestKey: 'a'.repeat(65) })).isError, true);
    const base = { requestKey: 'typed-fixture' };
    assert.equal((await invoke('alpha_open_tab', { ...base, targetId, route: 'https://example.test/' })).isError, true);
    assert.equal((await invoke('alpha_set_3d_view', { ...base, targetId, visible: 'yes' })).isError, true);
    assert.equal((await invoke('alpha_create_project', { ...base, title: 'Fixture', template: 'arbitrary' })).isError, true);
    assert.equal((await invoke('alpha_update_project', { ...base, projectId: 'fixture', patch: { repo: 'elsewhere' } })).isError, true);
    assert.equal((await invoke('alpha_update_project', { ...base, projectId: 'fixture', patch: {} })).isError, true);
    assert.equal((await invoke('alpha_update_project', { ...base, projectId: '..\\outside', patch: { pinned: true } })).isError, true);
    assert.equal((await invoke('alpha_create_report_tab', { ...base, projectId: 'fixture', title: ' ' })).isError, true);
    assert.equal((await invoke('alpha_modify_file', { ...base, targetId, expectedRevision: 'b'.repeat(64), edit: 'replace-all', text: 'replacement' })).isError, true);
    assert.equal((await invoke('alpha_modify_file', { ...base, targetId, expectedRevision: 'b'.repeat(64), edit: 'trim-trailing-whitespace' })).isError, true);
    assert.equal((await invoke('alpha_run_script', { ...base, scriptId: 'alpha-runtime-check', expectedRevision: 'c'.repeat(64), args: ['fixture'] })).isError, true);
    assert.equal((await invoke('alpha_import_project_artifact', { ...base, sourceProjectId: 'fixture-source', kind: 'skill', artifactId: '../other' })).isError, true);
    assert.equal((await invoke('alpha_import_project_artifact', { ...base, sourceProjectId: 'fixture-source', kind: 'agent', artifactId: 'reviewer', destinationProjectId: 'other' })).isError, true);
    assert.equal(requests.length, 0);
    assert.equal((await invoke('alpha_list_disposable_previews')).structuredContent.targets[0].id, targetId);
    assert.deepEqual((await invoke('alpha_request', args)).structuredContent, { receiptId, status: 'pending' });
    assert.deepEqual((await invoke('alpha_request_result', { receiptId })).structuredContent, { receiptId, status: 'completed' });
    assert.deepEqual((await invoke('alpha_list_session_actions')).structuredContent, { projectId: 'fixture', actions: ['create-report-tab'] });
    const expandedBodies = [];
    for (const [name, values, action = name.replaceAll('_', '-')] of actionTools) {
      const requestKey = 'fixture-' + name;
      assert.deepEqual((await invoke('alpha_' + name, { requestKey, ...values })).structuredContent, { receiptId, status: 'pending' });
      const { targetId, ...args } = values;
      expandedBodies.push({ kind: 'request', action, requestKey, ...(targetId ? { targetId } : {}), ...(Object.keys(args).length ? { arguments: args } : {}) });
    }
    redirect = true;
    assert.equal((await invoke('alpha_list_disposable_previews')).isError, true);
    assert.deepEqual(requests.map(entry => entry.body), [
      { kind: 'targets' }, { kind: 'request', ...args }, { kind: 'result', receiptId }, { kind: 'capabilities' }, ...expandedBodies, { kind: 'targets' },
    ]);
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
