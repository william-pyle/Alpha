import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createService } from '../server.mjs';

const record = (type, payload, at) => JSON.stringify({ type, payload, timestamp: new Date(at).toISOString() }) + '\n';
const start = (turnId, at) => record('event_msg', { type: 'task_started', turn_id: turnId }, at);
const complete = (turnId, at) => record('event_msg', { type: 'task_complete', turn_id: turnId }, at);
const input = (turnId, text, at) => record('response_item', {
  type: 'message', role: 'user', content: [{ type: 'input_text', text }],
  internal_chat_message_metadata_passthrough: {
    turn_id: turnId, content_item_kinds: ['user.text'], content_item_metadata: [{ provenance: { type: 'user' } }],
  },
}, at);

async function until(check) {
  for (let count = 0; count < 480; count++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail('Native events did not settle');
}

test('reopened Messages keeps Codex MCP bound to the native turn in either receipt order', async t => {
  for (const order of ['start-first', 'input-first', 'other-turn', 'completed', 'stale']) {
    await t.test(order, async () => {
      const repo = await mkdtemp(path.join(tmpdir(), 'alpha-worker-turn-'));
      const codexHome = path.join(repo, 'codex');
      const folder = path.join(codexHome, 'sessions', '2026', '11', '25');
      const previousHome = process.env.CODEX_HOME;
      process.env.CODEX_HOME = codexHome;
      let service, session, bridge;
      try {
        await mkdir(folder, { recursive: true });
        await writeFile(path.join(repo, 'workspace.json'), '{"entities":[]}');
        service = await createService({ repo, uiDir: repo, restoreSessions: false, checkUpdates: false, mcpOptions: { home: repo, env: {} } });
        const nativeId = randomUUID();
        const file = path.join(folder, `rollout-${nativeId}.jsonl`);
        // Use a real resume boundary and transcript watcher with a fake PTY.
        const startedAt = Date.now() - 10000;
        const history = record('session_meta', { id: nativeId }, startedAt - 10) +
          start('historic', startedAt - 9) + complete('historic', startedAt - 8);
        await writeFile(file, history);
        session = service.sessions.make({ id: randomUUID(), nativeId, agent: 'codex', name: 'Reopened fixture',
          cwd: repo, projectId: 'conversations', status: 'stopped', open: false, hasConversation: true });
        service.sessions.items.set(session.id, session);
        const thread = service.threads.observe(session);
        let draft = '', submitted = false, time = startedAt + 1000;
        service.sessions.launch = (item, resumeId, boundary) => {
          assert.equal(item, session);
          assert.equal(resumeId, nativeId);
          assert.deepEqual(boundary, { file, offset: Buffer.byteLength(history) });
          Object.assign(item, { status: 'running', startedAt, process: { write(value) {
            if (value === '\t') submitted = true;
            else draft = value.slice(6, -6).replaceAll('\r', '\n');
          } } });
          bridge = service.sessions.issueWorkerBridge(item);
          bridge.attach(item.process);
          service.sessions.watchNative(item, boundary.file, boundary.offset);
        };
        const post = (endpoint, body) => fetch(service.origin + endpoint, {
          method: 'POST', headers: { authorization: `Bearer ${service.token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const resumed = await post(`/api/threads/${thread.id}/resume`, {});
        assert.equal(resumed.status, 200);
        assert.equal((await resumed.json()).archived, false);
        service.sessions.submission.clock = () => time;
        service.sessions.submission.wait = async ms => { time += ms; await delay(ms); };
        service.sessions.submission.view = async () => ({
          lines: ['OpenAI Codex', '› ' + draft, '? for shortcuts'], cursorY: 1,
          cursorX: 2 + draft.length, bracketedPaste: true, startupSettled: true,
        });
        async function list(status) {
          const response = await fetch(service.origin + '/worker-request', {
            method: 'POST', headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ kind: 'capabilities' }),
          });
          assert.equal(response.status, status);
          if (status === 200) assert.equal((await response.json()).projectId, 'conversations');
        }
        await list(409);
        const messageId = randomUUID();
        const send = await post(`/api/threads/${thread.id}/input`, { id: messageId, text: 'List eligible actions only', target: 'work' });
        assert.equal(send.status, 202);
        await until(() => submitted);
        const [receipt] = session.submissions;
        const at = receipt.pastedAt + 1;
        if (order === 'input-first') {
          await appendFile(file, input('current', draft, at));
          await until(() => receipt.acceptance === 'observed');
          await list(409);
          service.sessions.nativeEvent(session, { kind: 'turn-started' });
          await list(409);
          await appendFile(file, start('current', Math.max(at + 1, Date.now() + 1)));
          await until(() => session.workerEvidence?.nativeTaskId === 'current');
          await list(200);
        } else if (order === 'stale') {
          await appendFile(file, input('historic', draft, startedAt - 1));
          await appendFile(file, start('current', at));
          await until(() => session.workerEvidence?.nativeTaskId === 'current');
          assert.equal(receipt.acceptance, 'unconfirmed');
          assert.equal(receipt.nativeTaskId, undefined);
          await list(200);
          await appendFile(file, input('current', draft, at + 1));
          await until(() => receipt.acceptance === 'observed');
        } else {
          await appendFile(file, start('current', at));
          await until(() => session.workerEvidence?.nativeTaskId === 'current');
          const before = session.workerEvidence;
          await list(200);
          if (order === 'completed') {
            await appendFile(file, complete('current', at + 1));
            await until(() => session.workerEvidence?.execution === 'finished');
          }
          await appendFile(file, input(order === 'other-turn' ? 'different' : 'current', draft, at + 2));
          await until(() => receipt.acceptance === 'observed');
          if (order === 'completed') await list(409);
          else {
            assert.equal(session.workerEvidence, before);
            await list(200);
          }
        }
        assert.equal(receipt.taskId, messageId);
        assert.equal(receipt.nativeTaskId, order === 'other-turn' ? 'different' : 'current');
        assert.equal(session.workerEvidence.taskId, 'current');
        assert.equal(session.workerEvidence.nativeTaskId, 'current');
        assert.equal(service.questions.list().length, 0);
      } finally {
        bridge?.revoke();
        if (session) {
          session.stopNativeWatch?.();
          session.stopNativeWatch = null;
          session.process = null;
        }
        await service?.close();
        if (previousHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousHome;
        await rm(repo, { recursive: true, force: true });
      }
    });
  }
});
